/* Cursor 后端协议端点实现（模仿 cursor-agent 的 proxy_ca/handlers）
 *
 * 接管的端点（清单来自 cursor-agent 二进制逆向）：
 *   /aiserver.v1.AiService/AvailableModels                    —— 伪造 CCB 模型目录
 *   /aiserver.v1.BidiService/BidiAppend                       —— 接收聊天请求体（按 requestId 缓存）
 *   /aiserver.v1.ChatService/StreamUnifiedChatWithToolsSSE    —— 新版聊天主链路（拉流）
 *   /aiserver.v1.ChatService/StreamUnifiedChat                —— 旧版聊天链路（直接带请求体）
 *   /aiserver.v1.ToolCallEventService/SubmitToolCallEvents    —— 遥测，吞掉
 *   /aiserver.v1.ChatRequestEventService/SubmitChatRequestEvents —— 遥测，吞掉
 * 其余端点由 cursorproxy.js 转发真实后端。
 *
 * protobuf schema：lib/proto/aiserver.proto（提取自最新版 Cursor，
 * 来源 github.com/unkn0wncode/extract-cursor-protos）。
 */
const path = require('path');
const fs = require('fs');
const protobuf = require('protobufjs');
const upstreamAdapter = require('./cursorupstream');
const { compressMessages } = require('./cursorcompress');

let root = null;
const T = {}; /* 消息类型缓存 */

/* 提取的 proto 合并了 agent.v1 / aiserver.v1 多个注册表，顶层存在重名定义
 * （protobufjs 拒绝重复名）。预处理：顶层块按名去重，保留首次出现。 */
function dedupeProto(text) {
	const lines = text.split('\n');
	const seen = new Set();
	const out = [];
	const declRe = /^(message|enum|service)\s+(\w+)\s*\{/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = declRe.exec(line);
		if (!m) {
			out.push(line);
			continue;
		}
		const name = m[2];
		if (!seen.has(name)) {
			seen.add(name);
			out.push(line);
			continue;
		}
		/* 跳过重名块（含嵌套大括号） */
		let depth = 0;
		let j = i;
		for (; j < lines.length; j++) {
			depth += (lines[j].match(/\{/g) || []).length;
			depth -= (lines[j].match(/\}/g) || []).length;
			if (depth <= 0) break;
		}
		out.push(`// [dedupe] dropped duplicate ${m[1]} ${name}`);
		i = j;
	}
	return out.join('\n');
}

function loadProto(log) {
	if (root) return root;
	const file = path.join(__dirname, 'proto', 'aiserver.proto');
	const text = dedupeProto(fs.readFileSync(file, 'utf8'));
	root = protobuf.parse(text, { keepCase: false }).root;
	for (const name of [
		'AvailableModelsRequest',
		'AvailableModelsResponse',
		'BidiAppendRequest',
		'BidiAppendResponse',
		'BidiRequestId',
		'StreamUnifiedChatRequest',
		'StreamUnifiedChatRequestWithTools',
		'StreamUnifiedChatResponse',
		'StreamUnifiedChatResponseWithTools',
		'SubmitToolCallEventsResponse',
		'SubmitChatRequestEventsResponse',
	]) {
		try {
			T[name] = root.lookupType(`aiserver.v1.${name}`);
		} catch (e) {
			log(`proto 类型缺失 aiserver.v1.${name}：${e.message}`);
		}
	}
	/* agent.v1 消息在提取的 proto 里被拍平到 aiserver.v1 包下（文件只有单 package 声明） */
	for (const name of ['AgentClientMessage', 'AgentServerMessage']) {
		try {
			T[name] = root.lookupType(`aiserver.v1.${name}`);
		} catch (e) {
			log(`proto 类型缺失 ${name}：${e.message}`);
		}
	}
	return root;
}

function encode(type, obj) {
	return Buffer.from(type.encode(type.fromObject(obj)).finish());
}

function decode(type, buf) {
	return type.decode(buf instanceof Buffer ? buf : Buffer.from(buf));
}

/* ---------- 聊天请求缓存：BidiAppend 先存，SSE 再取 ---------- */
const pendingChats = new Map(); /* requestId -> { raw: Buffer, at } */
const PENDING_TTL = 5 * 60 * 1000;

function cacheChat(requestId, raw) {
	pendingChats.set(requestId, { raw, at: Date.now() });
	/* 顺手清理过期项 */
	for (const [k, v] of pendingChats) {
		if (Date.now() - v.at > PENDING_TTL) pendingChats.delete(k);
	}
}

/* ---------- Cursor 请求 → OpenAI 消息 ---------- */
function toOpenAiMessages(req) {
	const conv = (req && req.conversation) || [];
	const msgs = [];
	for (const m of conv) {
		const text = typeof m.text === 'string' ? m.text : '';
		if (!text.trim()) continue;
		/* MessageType: 1=HUMAN 2=AI */
		const role = m.type === 1 ? 'user' : m.type === 2 ? 'assistant' : null;
		if (!role) continue;
		msgs.push({ role, content: text });
	}
	return msgs;
}

/* 简版 Cursor 风格 system prompt（cursor-agent 内置了官方完整模板，后续可对齐） */
function systemPrompt(model) {
	return (
		`You are an AI coding assistant, powered by ${model}. You operate in Cursor.\n` +
		'You are pair programming with a USER to solve their coding task.\n' +
		'Each time the USER sends a message, we may automatically attach some information about their current state, ' +
		'such as what files they have open, where their cursor is, recently viewed files, edit history, linter errors, and more.\n' +
		'Use the information to produce a helpful, accurate coding answer. When outputting code blocks, include the language identifier.'
	);
}

function pickModel(req, upstream) {
	const want =
		req && req.modelDetails && typeof req.modelDetails.modelId === 'string'
			? req.modelDetails.modelId
			: '';
	const pool = (upstream && upstream.models) || [];
	if (want && pool.includes(want)) return want;
	if (upstream && upstream.defaultModel) return upstream.defaultModel;
	return want || pool[0] || 'default';
}

/* ---------- 调上游中转（格式 / 认证头 / 超时由 cursorupstream 统一处理） ----------
 * 5xx 重试：中转站熔断器是 isolate 级内存状态，重试可能落到健康 isolate；
 * 上游瞬时限流也可能在几秒内恢复。仅对 5xx 重试（4xx 是请求/余额问题，重试无意义）。 */
const MAX_ATTEMPTS = 3;

async function streamUpstreamChat({ upstream, model, messages, log, signal }) {
	let lastErr = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (signal && signal.aborted) throw new Error('客户端已取消');
		let res;
		let release;
		try {
			({ res, release } = await upstreamAdapter.postChat(
				upstream,
				{ model, messages, stream: true },
				{ signal },
			));
		} catch (e) {
			if (signal && signal.aborted) throw e;
			lastErr = e; /* 网络错误/超时也值得重试一次 */
			if (attempt < MAX_ATTEMPTS) {
				log(`中转网络错误（第 ${attempt} 次）：${e.message}，1.5s 后重试`);
				await new Promise((r) => setTimeout(r, 1500));
				continue;
			}
			throw e;
		}
		if (res.ok && res.body) return { body: res.body, release }; /* release 由调用方读完流后调用 */
		const t = await res.text().catch(() => '');
		release();
		lastErr = new Error(`中转返回 HTTP ${res.status}：${t.slice(0, 300)}`);
		if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
			const waitMs = attempt * 1500;
			log(`中转 5xx（第 ${attempt} 次）：HTTP ${res.status}，${waitMs}ms 后重试`);
			await new Promise((r) => setTimeout(r, waitMs));
			continue;
		}
		throw lastErr;
	}
	throw lastErr;
}

/* ---------- 流式聊天公共处理 ---------- */
async function handleChatStream(ctx, unifiedReq) {
	const { res, log, encodeFrame } = ctx;
	const upstream = upstreamAdapter.normalize(ctx.upstream || {});
	if (!upstream.baseUrl || !upstream.apiKey) {
		return ctx.connectError(res, 'failed_precondition', 'CCB 代理未配置中转地址或密钥');
	}
	const model = pickModel(unifiedReq, upstream);
	let messages = [{ role: 'system', content: systemPrompt(model) }, ...toOpenAiMessages(unifiedReq)];
	if (!messages.length || messages[messages.length - 1].role !== 'user') {
		log('警告：聊天请求没有用户消息，仍按原样转发中转');
	}

	const ac = new AbortController();
	/* 监听响应侧断开（客户端取消）；req 的 close 在请求体读完就会触发，不能用 */
	res.on('close', () => ac.abort());
	/* 压缩放在开流之前：摘要本身要调上游，先写 200 会让客户端干等首帧 */
	messages = (await compressMessages({ messages, upstream, model, log, signal: ac.signal })).messages;
	log(`聊天请求 → 模型 ${model}，消息 ${messages.length} 条`);

	res.writeHead(200, {
		'Content-Type': 'application/connect+proto',
		'Connect-Protocol-Version': '1',
	});

	const sendText = (text) => {
		const msg = encode(T.StreamUnifiedChatResponseWithTools, {
			streamUnifiedChatResponse: { text },
		});
		res.write(encodeFrame(msg));
	};
	const sendEnd = (err) => {
		const tail = err ? { error: { code: 'internal', message: String(err) } } : {};
		res.write(encodeFrame(Buffer.from(JSON.stringify(tail)), { endStream: true }));
		res.end();
	};

	try {
		const { body, release } = await streamUpstreamChat({
			upstream,
			model,
			messages,
			log,
			signal: ac.signal,
		});
		try {
			for await (const delta of upstreamAdapter.deltas(upstream.apiFormat, body)) sendText(delta);
		} finally {
			release();
		}
		sendEnd(null);
	} catch (e) {
		log(`中转调用失败：${e.message}`);
		sendEnd(e.message);
	}
}

/* ---------- 极简 protobuf wire 读取器（绕开缺失类型） ----------
 * 提取的 proto 缺 457 个类型，完整 decode AgentClientMessage 必炸（FileStateStructure 等）。
 * 但我们只需要 run_request 里的 model_id 和 user text，按字段号走路径即可，未知字段全跳过。 */
function wireFields(buf) {
	const fields = [];
	let p = 0;
	const readVarint = () => {
		let r = 0;
		let shift = 0;
		for (;;) {
			if (p >= buf.length) throw new Error('varint 越界');
			const b = buf[p++];
			r += (b & 0x7f) * 2 ** shift;
			shift += 7;
			if (!(b & 0x80)) break;
		}
		return r;
	};
	while (p < buf.length) {
		const tag = readVarint();
		const no = Math.floor(tag / 8);
		const wire = tag & 7;
		if (wire === 0) {
			readVarint();
			fields.push({ no, wire });
		} else if (wire === 2) {
			const len = readVarint();
			fields.push({ no, wire, bytes: buf.subarray(p, p + len) });
			p += len;
		} else if (wire === 1) {
			p += 8;
		} else if (wire === 5) {
			p += 4;
		} else {
			throw new Error(`非法 wire type ${wire} @${p}`);
		}
	}
	return fields;
}

function wireFirst(buf, no) {
	for (const f of wireFields(buf)) if (f.no === no) return f;
	return null;
}

function wireStr(buf, no) {
	const f = wireFirst(buf, no);
	return f && f.bytes ? f.bytes.toString('utf8') : '';
}

/* AgentClientMessage 字段路径：
 *   f1 run_request → f2 action → f1 user_message_action → f1 user_message → f1 text（f8 rich_text 兜底）
 *   run_request → f3 model_details → f1 model_id
 *   顶层 f7 = client_heartbeat；f4 conversation_action → f3 = cancel_action */
function extractAgentClient(raw) {
	const runReq = wireFirst(raw, 1);
	if (runReq && runReq.bytes) {
		const modelDetails = wireFirst(runReq.bytes, 3);
		const requestedModel = wireFirst(runReq.bytes, 9); /* requested_model 兜底 */
		const action = wireFirst(runReq.bytes, 2);
		let text = '';
		if (action && action.bytes) {
			const uma = wireFirst(action.bytes, 1);
			if (uma && uma.bytes) {
				const um = wireFirst(uma.bytes, 1);
				if (um && um.bytes) text = wireStr(um.bytes, 1) || wireStr(um.bytes, 8);
			}
		}
		return {
			kind: 'run_request',
			modelId:
				(modelDetails && modelDetails.bytes && wireStr(modelDetails.bytes, 1)) ||
				(requestedModel && requestedModel.bytes && wireStr(requestedModel.bytes, 1)) ||
				'',
			text,
		};
	}
	if (wireFirst(raw, 7)) return { kind: 'heartbeat' };
	const conv = wireFirst(raw, 4);
	if (conv && conv.bytes) {
		if (wireFirst(conv.bytes, 3)) return { kind: 'cancel' };
		return { kind: 'conversation_action' };
	}
	return { kind: 'other', fields: wireFields(raw).map((f) => f.no) };
}

/* ---------- 各端点 ---------- */

/** unary：伪造模型目录 */
let sniffedRealCatalog = false;
async function availableModels(ctx) {
	const { res, upstream } = ctx;
	const names = (upstream && upstream.models && upstream.models.length
		? upstream.models
		: [(upstream && upstream.defaultModel) || 'default']
	).map(String);
	const def = (upstream && upstream.defaultModel) || names[0];
	const models = names.map((name) => ({
		name,
		defaultOn: true,
		isLongContextOnly: false,
		isChatOnly: false,
		supportsAgent: true,
		supportsThinking: false,
		supportsImages: false,
		supportsAutoContext: true,
		autoContextMaxTokens: 128000,
		supportsMaxMode: false,
		supportsNonMaxMode: true,
		contextTokenLimit: 128000,
		/* Cursor 选择器会美化显示名（"grok-4.6" → "Cursor Grok 4.6 Medium"），
		 * 加 CCB 前缀让用户能认出是中转模型 */
		clientDisplayName: `CCB ${name}`,
		inputboxShortModelName: name,
		serverModelName: name,
		isUserAdded: false,
		supportsCmdK: true,
		/* 关键：客户端选择器只显示 namedModelSectionIndex 有定义的模型
		 * （真实目录全部为 1）。缺这个字段时下拉里只剩当前选中项 */
		namedModelSectionIndex: 1,
		visibleInRoutedModelView: true,
	}));
	const featCfg = { defaultModel: def, fallbackModels: names.filter((n) => n !== def) };
	const out = encode(T.AvailableModelsResponse, {
		models,
		modelNames: names,
		composerModelConfig: featCfg,
		cmdKModelConfig: featCfg,
		quickAgentModelConfig: featCfg,
	});
	res.writeHead(200, { 'Content-Type': 'application/proto' });
	res.end(out);
	ctx.log(`已下发 CCB 模型目录（${names.length} 个）`);

	/* 一次性抓包：把客户端请求原样转给真实后端，dump 真实模型目录字节，
	 * 用于分析新版字段（namedModelSectionIndex 等）的字段号 */
	if (!sniffedRealCatalog) {
		sniffedRealCatalog = true;
		sniffRealCatalog(ctx).catch((e) => ctx.log(`目录抓包失败：${e.message}`));
	}
}

async function sniffRealCatalog(ctx) {
	const https = require('https');
	const os = require('os');
	const headers = { ...ctx.req.headers, host: ctx.host };
	delete headers['proxy-authorization'];
	delete headers['accept-encoding'];
	delete headers['connection'];
	headers['content-length'] = String(ctx.rawBody.length);
	const buf = await new Promise((resolve, reject) => {
		const rq = https.request(
			{ host: ctx.host, port: 443, method: ctx.req.method, path: ctx.path, headers, timeout: 20000 },
			(rs) => {
				const chunks = [];
				rs.on('data', (c) => chunks.push(c));
				rs.on('end', () => resolve(Buffer.concat(chunks)));
			},
		);
		rq.on('error', reject);
		rq.on('timeout', () => rq.destroy(new Error('timeout')));
		rq.write(ctx.rawBody);
		rq.end();
	});
	const file = path.join(os.homedir(), '.ccb', 'availablemodels-real.bin');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, buf);
	ctx.log(`真实模型目录已抓包（${buf.length} 字节）→ ${file}`);
}

/** unary：接收聊天请求体（Cursor 3.18：data 是 hex 字符串，内容是 AgentClientMessage） */
async function bidiAppend(ctx) {
	const { res, log } = ctx;
	try {
		const req = decode(T.BidiAppendRequest, ctx.rawBody);
		const id = req.requestId && req.requestId.requestId;
		/* Cursor 3.18 双模：dataBinary(bytes，h2 通道) 或 data(明文的 hex 字符串)。
		 * 之前误用 base64 解 hex 字符串，解出一堆垃圾还以为是加密。 */
		let raw = Buffer.alloc(0);
		if (req.dataBinary && req.dataBinary.length) raw = Buffer.from(req.dataBinary);
		else if (typeof req.data === 'string' && req.data) raw = Buffer.from(req.data, 'hex');
		if (!id || !raw.length) {
			log(`BidiAppend：无数据（id=${id || '无'} seqno=${req.appendSeqno}）`);
		} else {
			/* wire walker 提取（完整 decode 会因缺失类型失败）。只缓存 run_request，
			 * 心跳（每 5s 一条）不缓存、不刷屏 */
			try {
				const info = extractAgentClient(raw);
				if (info.kind === 'run_request') {
					cacheChat(id, raw);
					log(
						`BidiAppend：已缓存聊天请求 ${id}（${raw.length} 字节）模型=${info.modelId || '?'} 用户消息=${JSON.stringify(info.text.slice(0, 60))}`,
					);
				} else if (info.kind === 'cancel') {
					pendingChats.delete(id);
					log(`BidiAppend：客户端取消 ${id}`);
				} else if (info.kind !== 'heartbeat') {
					log(`BidiAppend：${id} seqno=${req.appendSeqno} kind=${info.kind} fields=${(info.fields || []).join('/')}（${raw.length} 字节）`);
				}
			} catch (e2) {
				log(`BidiAppend：wire 解析失败 ${id}：${e2.message} head=${raw.subarray(0, 48).toString('hex')}`);
			}
		}
	} catch (e) {
		log(`BidiAppend 解析失败：${e.message} body(${ctx.rawBody.length}B)=${ctx.rawBody.subarray(0, 96).toString('hex')}`);
	}
	res.writeHead(200, { 'Content-Type': 'application/proto' });
	res.end(encode(T.BidiAppendResponse, {}));
}

/* RunSSE 拉流可能先于 BidiAppend 到达（长连接先开），轮询等请求体 */
async function waitForChat(id, timeoutMs, log) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = pendingChats.get(id);
		if (hit) return hit;
		if (Date.now() > deadline) return null;
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** server streaming：Cursor 3.18 聊天主链路 agent.v1.AgentService/RunSSE */
async function agentRunSSE(ctx) {
	const { res, log } = ctx;
	const first = ctx.frames.find((f) => !f.endStream);
	if (!first) return ctx.connectError(res, 'invalid_argument', '缺少请求帧');
	let id = '';
	try {
		id = decode(T.BidiRequestId, first.data).requestId || '';
	} catch (e) {
		return ctx.connectError(res, 'invalid_argument', `BidiRequestId 解析失败：${e.message}`);
	}
	log(`RunSSE：客户端拉流 ${id}，等待请求体…`);
	const pending = await waitForChat(id, 30000, log);
	if (!pending) {
		log(`RunSSE：等待请求体超时 ${id}`);
		return ctx.connectError(res, 'not_found', '聊天请求体不存在或已过期');
	}
	pendingChats.delete(id);

	const upstream = upstreamAdapter.normalize(ctx.upstream || {});
	if (!upstream.baseUrl || !upstream.apiKey) {
		return ctx.connectError(res, 'failed_precondition', 'CCB 代理未配置中转地址或密钥');
	}

	let info = null;
	try {
		info = extractAgentClient(pending.raw);
	} catch (e) {
		return ctx.connectError(res, 'internal', `wire 解析失败：${e.message}`);
	}
	if (!info || info.kind !== 'run_request') {
		return ctx.connectError(res, 'internal', '缓存的请求体不含 run_request');
	}

	const pool = upstream.models;
	const model =
		info.modelId && pool.includes(info.modelId)
			? info.modelId
			: upstream.defaultModel || info.modelId || pool[0] || 'default';
	const userText = info.text || '';
	let messages = [
		{ role: 'system', content: systemPrompt(model) },
		{ role: 'user', content: userText || '（空消息）' },
	];
	log(`RunSSE：${id} → 模型 ${model}，用户消息 ${JSON.stringify(userText.slice(0, 80))}`);

	res.writeHead(200, {
		'Content-Type': 'application/connect+proto',
		'Connect-Protocol-Version': '1',
	});
	const send = (interactionUpdate, tag) => {
		if (tag) log(`帧[${tag}] ${Date.now() % 100000}`);
		res.write(ctx.encodeFrame(encode(T.AgentServerMessage, { interactionUpdate })));
	};
	const sendEnd = (err) => {
		const tail = err ? { error: { code: 'internal', message: String(err) } } : {};
		res.write(ctx.encodeFrame(Buffer.from(JSON.stringify(tail)), { endStream: true }));
		res.end();
	};
	/* 思考转发 + 全程空闲保活：
	 * - 上游思考流（reasoning_content）原样转成 thinking_delta，Cursor 显示思考块；
	 * - GLM 系答到一半会再推理（交错思考），这些事件被丢弃的话客户端 ~10s 判超时丢回复；
	 * - 全程兜底：>4s 无任何帧就补一帧 thinking_delta（首 token 前上游可能整体静默十几秒）。
	 * 不能用 HeartbeatUpdate——实测心跳帧会让 Cursor 丢弃整个回复并无限重试。 */
	let phase = 'start'; /* start | thinking | text */
	let thinkStart = Date.now();
	let lastFrameAt = Date.now();
	const hbTimer = setInterval(() => {
		if (Date.now() - lastFrameAt < 4000) return;
		try {
			if (phase !== 'thinking') {
				phase = 'thinking';
				thinkStart = Date.now();
			}
			send({ thinkingDelta: { text: '…' } }, 'keepalive');
		} catch {}
	}, 2000);

	try {
		const ac = new AbortController();
		res.on('close', () => ac.abort());
		send({ stepStarted: { stepId: 1 } }, 'stepStart');
		/* 压缩可能要先调上游做摘要，放在保活启动之后，客户端不会干等首帧 */
		messages = (await compressMessages({ messages, upstream, model, log, signal: ac.signal })).messages;
		const { body, release } = await streamUpstreamChat({
			upstream,
			model,
			messages,
			log,
			signal: ac.signal,
		});
		let chars = 0;
		try {
			for await (const ev of upstreamAdapter.events(upstream.apiFormat, body)) {
				lastFrameAt = Date.now();
				if (ev.type === 'reasoning') {
					if (phase !== 'thinking') {
						phase = 'thinking';
						thinkStart = Date.now();
					}
					send({ thinkingDelta: { text: ev.text } }, 'think');
				} else {
					if (phase === 'thinking') {
						send({ thinkingCompleted: { thinkingDurationMs: Date.now() - thinkStart } }, 'thinkDone');
					}
					phase = 'text';
					chars += ev.text.length;
					send({ textDelta: { text: ev.text } }, 'text:' + ev.text.length);
				}
			}
		} finally {
			clearInterval(hbTimer);
			release();
		}
		clearInterval(hbTimer);
		send({ stepCompleted: { stepId: 1 } }, 'stepDone');
		send({ turnEnded: {} }, 'turnEnd');
		sendEnd(null);
		log(`RunSSE：${id} 完成（${chars} 字符）`);
	} catch (e) {
		clearInterval(hbTimer);
		log(`RunSSE 中转失败：${e.message}`);
		/* 错误文本显示到聊天里，用户能看到原因而不是干等 */
		try {
			send({ textDelta: { text: `\n\n[CCB 代理] 中转调用失败：${e.message}\n` } });
			send({ stepCompleted: { stepId: 1 } });
			send({ turnEnded: {} });
		} catch {}
		sendEnd(null);
	}
}

/** 流式：新版聊天主链路（按 requestId 取回请求体） */
async function chatWithToolsSSE(ctx) {
	const { res, log } = ctx;
	const first = ctx.frames.find((f) => !f.endStream);
	if (!first) return ctx.connectError(res, 'invalid_argument', '缺少请求帧');
	let id = '';
	try {
		id = decode(T.BidiRequestId, first.data).requestId || '';
	} catch (e) {
		return ctx.connectError(res, 'invalid_argument', `BidiRequestId 解析失败：${e.message}`);
	}
	const pending = id && pendingChats.get(id);
	if (!pending) {
		log(`StreamUnifiedChatWithToolsSSE：未找到请求体 ${id}`);
		return ctx.connectError(res, 'not_found', '聊天请求体不存在或已过期');
	}
	pendingChats.delete(id);
	let wrapped;
	try {
		wrapped = decode(T.StreamUnifiedChatRequestWithTools, pending.raw);
	} catch (e) {
		log(`请求体解码失败（可能已加密）：${e.message}`);
		return ctx.connectError(res, 'internal', `请求体解码失败：${e.message}`);
	}
	return handleChatStream(ctx, wrapped.streamUnifiedChatRequest);
}

/** 流式：旧版聊天链路（body 直接是 StreamUnifiedChatRequest） */
async function streamUnifiedChat(ctx) {
	const { res } = ctx;
	const first = ctx.frames.find((f) => !f.endStream);
	if (!first) return ctx.connectError(res, 'invalid_argument', '缺少请求帧');
	let req;
	try {
		req = decode(T.StreamUnifiedChatRequest, first.data);
	} catch (e) {
		return ctx.connectError(res, 'invalid_argument', `请求解析失败：${e.message}`);
	}
	return handleChatStream(ctx, req);
}

/** unary：遥测吞掉 */
function blackhole(typeName) {
	return async (ctx) => {
		if (!T[typeName]) return ctx.connectError(ctx.res, 'unimplemented', 'proto 类型缺失');
		ctx.res.writeHead(200, { 'Content-Type': 'application/proto' });
		ctx.res.end(encode(T[typeName], {}));
	};
}

function register(handlers, deps = {}) {
	loadProto(deps.log || (() => {}));
	handlers.set('/aiserver.v1.AiService/AvailableModels', availableModels);
	handlers.set('/aiserver.v1.BidiService/BidiAppend', bidiAppend);
	handlers.set('/agent.v1.AgentService/RunSSE', agentRunSSE);
	handlers.set('/aiserver.v1.ChatService/StreamUnifiedChatWithToolsSSE', chatWithToolsSSE);
	handlers.set(
		'/aiserver.v1.ChatService/StreamUnifiedChatWithToolsIdempotentSSE',
		chatWithToolsSSE,
	);
	handlers.set('/aiserver.v1.ChatService/StreamUnifiedChat', streamUnifiedChat);
	handlers.set(
		'/aiserver.v1.ToolCallEventService/SubmitToolCallEvents',
		blackhole('SubmitToolCallEventsResponse'),
	);
	handlers.set(
		'/aiserver.v1.ChatRequestEventService/SubmitChatRequestEvents',
		blackhole('SubmitChatRequestEventsResponse'),
	);
}

module.exports = { register, loadProto };
