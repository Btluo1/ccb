/* Cursor 代理的长上下文压缩（对应 cursor-agent proxy_ca_config.json 的 compression 段）
 *
 * 场景：Cursor 的会话会把历史不断带上，很快超过上游模型/中转的上下文上限，表现为
 * 上游 400 或回复被截断。做法与 cursor-agent 一致：当估算 token 超过
 * contextTokenLimit × threshold 时，把「较早的轮次」交给上游模型摘要成一段，
 * 只保留最近 tailTurns 轮原文。
 *
 * token 估算用「字符数 ÷ 4」的粗略口径：不引 tokenizer 依赖。压缩只求别爆，
 * 阈值本身留了 20% 余量，几十 token 的误差不影响效果。
 */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
	return Math.ceil(String(text == null ? '' : text).length / CHARS_PER_TOKEN);
}

/** 消息数组的估算 token（每条另加 4 作为角色/分隔开销） */
function countTokens(messages) {
	let n = 0;
	for (const m of messages || []) n += estimateTokens(m && m.content) + 4;
	return n;
}

/** 切分：system 永远保留；非 system 里最后 tailTurns 条留原文，其余进 older */
function planCompression(messages, tailTurns) {
	const systems = [];
	const rest = [];
	for (const m of messages || []) {
		if (m && m.role === 'system') systems.push(m);
		else rest.push(m);
	}
	if (rest.length <= tailTurns) return null;
	return { systems, older: rest.slice(0, rest.length - tailTurns), tail: rest.slice(rest.length - tailTurns) };
}

/** 按字符上限把消息切成若干块（不拆单条消息） */
function chunkByChars(messages, maxChars) {
	const chunks = [];
	let cur = [];
	let len = 0;
	for (const m of messages) {
		const l = String((m && m.content) || '').length;
		if (cur.length && len + l > maxChars) {
			chunks.push(cur);
			cur = [];
			len = 0;
		}
		cur.push(m);
		len += l;
	}
	if (cur.length) chunks.push(cur);
	return chunks;
}

function renderChunk(messages) {
	return messages
		.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '')}`)
		.join('\n\n');
}

const SUMMARY_SYSTEM =
	'你是对话压缩器。把给定的多轮编程对话压缩成一段简明摘要，必须保留：任务目标、已确认的结论与决策、涉及的文件路径与关键代码要点、尚未解决的问题、用户明确提出的约束与偏好。不要编造原文没有的信息，不要输出与摘要无关的寒暄。';

const SUMMARY_USER_PREFIX = '以下是需要压缩的对话片段：\n\n';
const SUMMARY_USER_SUFFIX = '\n\n请输出摘要（不要复述原文）。';

/**
 * 需要时压缩 messages；返回 { messages, compressed, tokens, after }
 * 任何一步失败都退回原始 messages —— 压缩是优化，不能因为它把聊天搞挂。
 */
async function compressMessages({ messages, upstream, model, log = () => {}, signal }) {
	const cfg = (upstream && upstream.compression) || {};
	const limit = (upstream && upstream.contextTokenLimit) || 200000;
	const before = countTokens(messages);
	if (cfg.enabled === false) return { messages, compressed: false, tokens: before, after: before };
	if (before <= limit * (cfg.threshold || 0.8)) {
		return { messages, compressed: false, tokens: before, after: before };
	}

	const plan = planCompression(messages, cfg.tailTurns || 20);
	if (!plan) return { messages, compressed: false, tokens: before, after: before };

	const { completeOnce } = require('./cursorupstream');
	const chunks = chunkByChars(plan.older, cfg.summaryMaxCharsPerChunk || 30000);
	log(`上下文约 ${before} token，超过阈值 ${Math.round(limit * (cfg.threshold || 0.8))}，开始压缩 ${plan.older.length} 条历史（${chunks.length} 块）`);

	try {
		const parts = [];
		for (const chunk of chunks) {
			const text = await completeOnce(upstream, {
				model,
				messages: [
					{ role: 'system', content: SUMMARY_SYSTEM },
					{ role: 'user', content: SUMMARY_USER_PREFIX + renderChunk(chunk) + SUMMARY_USER_SUFFIX },
				],
				maxTokens: cfg.summaryMaxTokens || 2048,
				signal,
			});
			if (text && text.trim()) parts.push(text.trim());
		}
		let summary = parts.join('\n\n').trim();
		if (!summary) {
			log('压缩未产生摘要，按原文转发');
			return { messages, compressed: false, tokens: before, after: before };
		}
		/* 多块摘要拼起来仍超预算 → 再压一轮 */
		if (chunks.length > 1 && estimateTokens(summary) > (cfg.summaryMaxTokens || 2048)) {
			const merged = await completeOnce(upstream, {
				model,
				messages: [
					{ role: 'system', content: SUMMARY_SYSTEM },
					{ role: 'user', content: SUMMARY_USER_PREFIX + summary + SUMMARY_USER_SUFFIX },
				],
				maxTokens: cfg.summaryMaxTokens || 2048,
				signal,
			});
			if (merged && merged.trim()) summary = merged.trim();
		}

		const out = [
			...plan.systems,
			{ role: 'system', content: `【早前对话摘要（已压缩 ${plan.older.length} 条消息）】\n${summary}` },
			...plan.tail,
		];
		const after = countTokens(out);
		log(`上下文压缩完成：${before} → ${after} token（保留最近 ${plan.tail.length} 条原文）`);
		return { messages: out, compressed: true, tokens: before, after };
	} catch (e) {
		log(`上下文压缩失败（按原文转发）：${e.message}`);
		return { messages, compressed: false, tokens: before, after: before };
	}
}

module.exports = { estimateTokens, countTokens, planCompression, chunkByChars, compressMessages };