import { createRequire } from 'node:module';
import { describe, it, expect, vi, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const up = require('../electron/lib/cursorupstream.js');
const comp = require('../electron/lib/cursorcompress.js');

function jsonResponse(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** 上游返回固定摘要文本（供压缩调用的非流式补全） */
function mockSummary(text) {
	globalThis.fetch = vi.fn(async () => jsonResponse({ choices: [{ message: { content: text } }] }));
}

/** 20 轮问答 + 1 条 system，足够触发小阈值下的压缩 */
function longConversation() {
	const msgs = [{ role: 'system', content: 'SYS' }];
	for (let i = 0; i < 20; i++) {
		msgs.push({ role: 'user', content: `问题 ${i} ` + 'x'.repeat(40) });
		msgs.push({ role: 'assistant', content: `回答 ${i} ` + 'y'.repeat(40) });
	}
	return msgs;
}

const smallLimit = (over = {}) =>
	up.normalize({
		baseUrl: 'https://x/v1',
		apiKey: 'k',
		contextTokenLimit: 100,
		compression: { threshold: 0.8, tailTurns: 4, ...over },
	});

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.fetch;
});

describe('cursorcompress 估算与切分', () => {
	it('estimateTokens 按 4 字符 1 token 上取整，空值算 0', () => {
		expect(comp.estimateTokens('')).toBe(0);
		expect(comp.estimateTokens('abcd')).toBe(1);
		expect(comp.estimateTokens('abcde')).toBe(2);
		expect(comp.estimateTokens(null)).toBe(0);
		expect(comp.estimateTokens(undefined)).toBe(0);
	});

	it('countTokens 每条另加 4 作为角色开销', () => {
		expect(comp.countTokens([])).toBe(0);
		expect(comp.countTokens(null)).toBe(0);
		expect(comp.countTokens([{ role: 'user', content: 'abcd' }])).toBe(5);
		expect(
			comp.countTokens([
				{ role: 'user', content: 'abcd' },
				{ role: 'assistant', content: 'abcd' },
			]),
		).toBe(10);
	});

	it('planCompression：system 全保留、最近 tailTurns 条留原文', () => {
		const messages = [
			{ role: 'system', content: 'S' },
			{ role: 'user', content: 'u1' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'user', content: 'u2' },
			{ role: 'assistant', content: 'a2' },
			{ role: 'user', content: 'u3' },
		];
		const plan = comp.planCompression(messages, 2);
		expect(plan.systems.map((m) => m.content)).toEqual(['S']);
		expect(plan.older.map((m) => m.content)).toEqual(['u1', 'a1', 'u2']);
		expect(plan.tail.map((m) => m.content)).toEqual(['a2', 'u3']);
	});

	it('planCompression：非 system 条数不超过 tailTurns 时返回 null（无需压缩）', () => {
		const messages = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
		];
		expect(comp.planCompression(messages, 2)).toBe(null);
		expect(comp.planCompression([{ role: 'system', content: 'S' }], 2)).toBe(null);
	});

	it('chunkByChars：按字符上限切块且不拆单条消息', () => {
		const msgs = [
			{ role: 'user', content: 'a'.repeat(10) },
			{ role: 'assistant', content: 'b'.repeat(10) },
			{ role: 'user', content: 'c'.repeat(10) },
		];
		expect(comp.chunkByChars(msgs, 15).map((c) => c.length)).toEqual([1, 1, 1]);
		expect(comp.chunkByChars(msgs, 25).map((c) => c.length)).toEqual([2, 1]);
		/* 单条超上限也自成一块，不被拆开 */
		const big = comp.chunkByChars([{ role: 'user', content: 'x'.repeat(100) }], 10);
		expect(big).toHaveLength(1);
		expect(big[0][0].content).toHaveLength(100);
		expect(comp.chunkByChars([], 10)).toEqual([]);
	});
});

describe('cursorcompress.compressMessages', () => {
	it('显式关闭压缩时原样返回，且不调上游', async () => {
		globalThis.fetch = vi.fn();
		const upstream = smallLimit({ enabled: false });
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });
		expect(r.compressed).toBe(false);
		expect(r.messages).toBe(messages);
		expect(r.after).toBe(r.tokens);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('未超阈值时原样返回，且不调上游', async () => {
		globalThis.fetch = vi.fn();
		const upstream = up.normalize({ baseUrl: 'https://x/v1', apiKey: 'k', contextTokenLimit: 100000 });
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });
		expect(r.compressed).toBe(false);
		expect(r.messages).toBe(messages);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('超阈值时摘要旧轮次、保留最近 tailTurns 条原文，且摘要请求走非流式', async () => {
		mockSummary('SUMMARY');
		const upstream = smallLimit({ tailTurns: 4 });
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });

		expect(r.compressed).toBe(true);
		expect(r.after).toBeLessThan(r.tokens);
		/* system 原文保留 → 摘要 system → 尾部原文 */
		expect(r.messages[0]).toEqual({ role: 'system', content: 'SYS' });
		expect(r.messages[1].role).toBe('system');
		expect(r.messages[1].content).toContain('SUMMARY');
		expect(r.messages[1].content).toContain('已压缩');
		expect(r.messages.slice(2)).toEqual(messages.slice(-4));

		const [, init] = globalThis.fetch.mock.calls[0];
		expect(JSON.parse(init.body).stream).toBe(false);
	});

	it('摘要调用失败时按原文转发，不抛错', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('boom');
		});
		const upstream = smallLimit();
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });
		expect(r.compressed).toBe(false);
		expect(r.messages).toBe(messages);
	});

	it('上游返回非 2xx 时按原文转发', async () => {
		globalThis.fetch = vi.fn(async () => new Response('overloaded', { status: 503 }));
		const upstream = smallLimit();
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });
		expect(r.compressed).toBe(false);
		expect(r.messages).toBe(messages);
	});

	it('摘要返回空白文本时按原文转发', async () => {
		mockSummary('   ');
		const upstream = smallLimit();
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });
		expect(r.compressed).toBe(false);
		expect(r.messages).toBe(messages);
	});

	it('多块摘要拼接后仍超预算时再压一轮', async () => {
		/* 每块摘要都很长 → 拼起来超 summaryMaxTokens，触发合并压缩 */
		mockSummary('S'.repeat(200));
		const upstream = smallLimit({ summaryMaxCharsPerChunk: 60, summaryMaxTokens: 5 });
		const messages = longConversation();
		const r = await comp.compressMessages({ messages, upstream, model: 'm' });

		expect(r.compressed).toBe(true);
		/* 至少两块摘要 + 一次合并调用 */
		expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(1);
		expect(r.messages[1].content).toContain('S'.repeat(200));
	});

	it('日志回调收到压缩前后 token 数', async () => {
		mockSummary('SUMMARY');
		const logs = [];
		const upstream = smallLimit();
		const r = await comp.compressMessages({
			messages: longConversation(),
			upstream,
			model: 'm',
			log: (m) => logs.push(m),
		});
		expect(r.compressed).toBe(true);
		expect(logs.some((l) => l.includes('开始压缩'))).toBe(true);
		expect(logs.some((l) => l.includes('上下文压缩完成'))).toBe(true);
	});
});