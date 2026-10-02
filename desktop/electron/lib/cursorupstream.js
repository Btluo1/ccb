/* Cursor 代理 → 上游中转：请求构造 + 流式解析 + 单次补全
 *
 * 对应 cursor-agent proxy_ca_config.json 的 upstream 段（apiKeyHeader / apiFormat /
 * maxTokens / temperature / timeout），CCB 默认走 OpenAI 兼容 + Authorization: Bearer。
 * 单独成模块是为了可单测：端点模块只负责协议，不掺上游细节。
 */

const DEFAULT_API_KEY_HEADER = 'Authorization';
const DEFAULT_API_FORMAT = 'openai';
const DEFAULT_TIMEOUT = 600000;
const DEFAULT_CONTEXT_LIMIT = 200000;

/** 把上游配置补齐成完整形态（缺省值全部在这里，端点模块不再散落 ?? 兜底） */
function normalize(upstream = {}) {
	const format = String(upstream.apiFormat || DEFAULT_API_FORMAT).toLowerCase();
	const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
	const compression = upstream.compression && typeof upstream.compression === 'object'
		? upstream.compression
		: {};
	return {
		baseUrl: String(upstream.baseUrl || '').replace(/\/+$/, ''),
		apiKey: String(upstream.apiKey || ''),
		apiKeyHeader: String(upstream.apiKeyHeader || DEFAULT_API_KEY_HEADER),
		apiFormat: format === 'anthropic' ? 'anthropic' : 'openai',
		models: Array.isArray(upstream.models) ? upstream.models.map(String).filter(Boolean) : [],
		defaultModel: String(upstream.defaultModel || ''),
		maxTokens: num(upstream.maxTokens, 0),
		temperature: Number.isFinite(Number(upstream.temperature)) ? Number(upstream.temperature) : null,
		timeout: num(upstream.timeout, DEFAULT_TIMEOUT),
		contextTokenLimit: num(upstream.contextTokenLimit, DEFAULT_CONTEXT_LIMIT),
		compression: {
			enabled: compression.enabled !== false,
			threshold: num(compression.threshold, 0.8),
			tailTurns: num(compression.tailTurns, 20),
			summaryMaxCharsPerChunk: num(compression.summaryMaxCharsPerChunk, 30000),
			summaryMaxTokens: num(compression.summaryMaxTokens, 2048),
		},
	};
}

/** 认证头：Authorization 用 Bearer 前缀，其它自定义头（如 cursor-agent 的 X-API-Key）裸填 */
function authHeaders(up) {
	const name = up.apiKeyHeader || DEFAULT_API_KEY_HEADER;
	if (!up.apiKey) return {};
	return { [name]: name.toLowerCase() === 'authorization' ? `Bearer ${up.apiKey}` : up.apiKey };
}

function chatUrl(up) {
	return up.apiFormat === 'anthropic' ? `${up.baseUrl}/messages` : `${up.baseUrl}/chat/completions`;
}

/** 构造上游请求 { url, headers, body } */
function chatRequest(up, { model, messages, stream = true, maxTokens = 0 }) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: stream ? 'text/event-stream' : 'application/json',
		...authHeaders(up),
	};
	const limit = maxTokens || up.maxTokens || 0;
	if (up.apiFormat === 'anthropic') {
		/* Anthropic：system 提到顶层，messages 只留 user/assistant，max_tokens 必填 */
		const system = messages
			.filter((m) => m.role === 'system')
			.map((m) => String(m.content || ''))
			.filter(Boolean)
			.join('\n\n');
		const body = {
			model,
			messages: messages
				.filter((m) => m.role !== 'system')
				.map((m) => ({ role: m.role, content: String(m.content || '') })),
			max_tokens: limit || 8192,
			stream,
		};
		if (system) body.system = system;
		if (up.temperature !== null) body.temperature = up.temperature;
		return { url: chatUrl(up), headers, body };
	}
	const body = { model, messages, stream };
	if (limit) body.max_tokens = limit;
	if (up.temperature !== null) body.temperature = up.temperature;
	return { url: chatUrl(up), headers, body };
}

/** 把外部 signal 与超时合并成一个 signal（超时后 abort 并给出可读原因） */
function withTimeout(signal, ms) {
	const ac = new AbortController();
	const relay = () => ac.abort(signal && signal.reason ? signal.reason : new Error('客户端已取消'));
	if (signal) {
		if (signal.aborted) relay();
		else signal.addEventListener('abort', relay, { once: true });
	}
	const timer = setTimeout(() => ac.abort(new Error(`上游请求超时（${ms}ms）`)), ms);
	if (timer.unref) timer.unref();
	return {
		signal: ac.signal,
		done() {
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', relay);
		},
	};
}

/** 发起一次上游请求；返回 { res, release }。
 * release() 必须由调用方在响应体读完后调用，否则超时定时器会一直挂着
 * （流式响应在 fetch resolve 之后还在继续读，定时器要活到那时候才有意义）。 */
async function postChat(up, payload, { signal } = {}) {
	const req = chatRequest(up, payload);
	const guard = withTimeout(signal, up.timeout);
	try {
		const res = await fetch(req.url, {
			method: 'POST',
			headers: req.headers,
			body: JSON.stringify(req.body),
			signal: guard.signal,
		});
		return { res, release: () => guard.done() };
	} catch (e) {
		guard.done();
		/* 超时/取消时给调用方一个明确原因，而不是裸的 AbortError */
		if (guard.signal.aborted) throw guard.signal.reason || e;
		throw e;
	}
}

/* ---------- SSE 解析 ---------- */

async function* sseLines(stream) {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buf += dec.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				yield line;
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}

/** OpenAI 兼容：data: {"choices":[{"delta":{"content":"...","reasoning_content":"..."}}]}
 * 事件流把思考与正文分开产出——GLM/DeepSeek 系答到一半会再推理（交错思考），
 * 思考流若被丢弃，代理侧就出现长时间静默，客户端 ~10s 判超时丢掉整个回复。 */
async function* openaiEvents(stream) {
	for await (const line of sseLines(stream)) {
		if (!line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (data === '[DONE]') return;
		try {
			const j = JSON.parse(data);
			const d = j.choices && j.choices[0] && j.choices[0].delta;
			if (!d) continue;
			const reasoning = d.reasoning_content !== undefined ? d.reasoning_content : d.reasoning;
			if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };
			if (typeof d.content === 'string' && d.content) yield { type: 'text', text: d.content };
		} catch {}
	}
}

/** Anthropic：content_block_delta 的 thinking_delta / text_delta */
async function* anthropicEvents(stream) {
	for await (const line of sseLines(stream)) {
		if (!line.startsWith('data:')) continue;
		const data = line.slice(5).trim();
		if (!data) continue;
		try {
			const j = JSON.parse(data);
			if (j.type === 'content_block_delta' && j.delta) {
				if (j.delta.type === 'thinking_delta' && typeof j.delta.thinking === 'string' && j.delta.thinking) {
					yield { type: 'reasoning', text: j.delta.thinking };
				}
				if (j.delta.type === 'text_delta' && typeof j.delta.text === 'string' && j.delta.text) {
					yield { type: 'text', text: j.delta.text };
				}
			}
			if (j.type === 'message_stop') return;
		} catch {}
	}
}

function events(format, stream) {
	return format === 'anthropic' ? anthropicEvents(stream) : openaiEvents(stream);
}

/** 只取正文的便捷包装（旧聊天链路与压缩摘要不需要思考流） */
async function* deltas(format, stream) {
	for await (const ev of events(format, stream)) {
		if (ev.type === 'text') yield ev.text;
	}
}

/** 非流式单次补全（供上下文压缩做摘要用）；返回纯文本 */
async function completeOnce(up, { model, messages, maxTokens = 0, signal } = {}) {
	const { res, release } = await postChat(
		up,
		{ model, messages, stream: false, maxTokens },
		{ signal },
	);
	try {
		if (!res.ok) {
			const t = await res.text().catch(() => '');
			throw new Error(`上游 HTTP ${res.status}：${t.slice(0, 200)}`);
		}
		const j = await res.json();
		if (up.apiFormat === 'anthropic') {
			return (Array.isArray(j.content) ? j.content : [])
				.map((c) => (typeof c.text === 'string' ? c.text : ''))
				.join('');
		}
		const msg = j.choices && j.choices[0] && j.choices[0].message;
		return (msg && typeof msg.content === 'string' ? msg.content : '') || '';
	} finally {
		release();
	}
}

module.exports = {
	normalize,
	authHeaders,
	chatRequest,
	chatUrl,
	postChat,
	withTimeout,
	deltas,
	events,
	openaiEvents,
	anthropicEvents,
	completeOnce,
	DEFAULT_API_KEY_HEADER,
	DEFAULT_API_FORMAT,
	DEFAULT_TIMEOUT,
	DEFAULT_CONTEXT_LIMIT,
};