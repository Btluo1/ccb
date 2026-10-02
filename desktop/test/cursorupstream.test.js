import { createRequire } from 'node:module';
import { describe, it, expect, vi, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const up = require('../electron/lib/cursorupstream.js');

/** 把字符串片段拼成一个 ReadableStream，模拟上游 SSE 响应体 */
function streamOf(chunks) {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			for (const s of chunks) c.enqueue(enc.encode(s));
			c.close();
		},
	});
}

function jsonResponse(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.fetch;
});

describe('cursorupstream.normalize', () => {
	it('补齐缺省值（OpenAI 兼容 + Authorization + 600s + 200k + 压缩开）', () => {
		const n = up.normalize({ baseUrl: 'https://code.btluo.com/v1/', apiKey: 'sk-ccb-x' });
		expect(n.baseUrl).toBe('https://code.btluo.com/v1');
		expect(n.apiKeyHeader).toBe('Authorization');
		expect(n.apiFormat).toBe('openai');
		expect(n.timeout).toBe(600000);
		expect(n.contextTokenLimit).toBe(200000);
		expect(n.compression).toEqual({
			enabled: true,
			threshold: 0.8,
			tailTurns: 20,
			summaryMaxCharsPerChunk: 30000,
			summaryMaxTokens: 2048,
		});
	});

	it('保留显式配置的值', () => {
		const n = up.normalize({
			baseUrl: 'https://x/v1',
			apiKey: 'k',
			apiKeyHeader: 'X-API-Key',
			apiFormat: 'anthropic',
			maxTokens: 4096,
			temperature: 0.3,
			timeout: 30000,
			contextTokenLimit: 128000,
			compression: { enabled: false, tailTurns: 5 },
		});
		expect(n.apiKeyHeader).toBe('X-API-Key');
		expect(n.apiFormat).toBe('anthropic');
		expect(n.maxTokens).toBe(4096);
		expect(n.temperature).toBe(0.3);
		expect(n.timeout).toBe(30000);
		expect(n.contextTokenLimit).toBe(128000);
		expect(n.compression.enabled).toBe(false);
		expect(n.compression.tailTurns).toBe(5);
	});

	it('未知 apiFormat 归一到 openai', () => {
		expect(up.normalize({ apiFormat: 'gemini' }).apiFormat).toBe('openai');
	});
});

describe('cursorupstream.authHeaders', () => {
	it('Authorization 带 Bearer 前缀', () => {
		expect(up.authHeaders({ apiKey: 'k', apiKeyHeader: 'Authorization' })).toEqual({
			Authorization: 'Bearer k',
		});
	});

	it('自定义头裸填密钥（cursor-agent 的 X-API-Key 用法）', () => {
		expect(up.authHeaders({ apiKey: 'k', apiKeyHeader: 'X-API-Key' })).toEqual({ 'X-API-Key': 'k' });
	});

	it('无密钥时不产生认证头', () => {
		expect(up.authHeaders({ apiKey: '', apiKeyHeader: 'Authorization' })).toEqual({});
	});
});

describe('cursorupstream.chatRequest', () => {
	const base = () => up.normalize({ baseUrl: 'https://x/v1', apiKey: 'k' });

	it('OpenAI：/chat/completions，未配 maxTokens/temperature 时不带这两个字段', () => {
		const r = up.chatRequest(base(), {
			model: 'glm-5.3',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		expect(r.url).toBe('https://x/v1/chat/completions');
		expect(r.body).toEqual({
			model: 'glm-5.3',
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});
		expect(r.headers.Authorization).toBe('Bearer k');
	});

	it('OpenAI：配了 maxTokens/temperature 就带上', () => {
		const u = up.normalize({
			baseUrl: 'https://x/v1',
			apiKey: 'k',
			maxTokens: 4096,
			temperature: 0.5,
		});
		const r = up.chatRequest(u, { model: 'm', messages: [], stream: true });
		expect(r.body.max_tokens).toBe(4096);
		expect(r.body.temperature).toBe(0.5);
	});

	it('Anthropic：/messages，system 提到顶层，max_tokens 必填', () => {
		const u = up.normalize({ baseUrl: 'https://a/v1', apiKey: 'k', apiFormat: 'anthropic' });
		const r = up.chatRequest(u, {
			model: 'claude-x',
			messages: [
				{ role: 'system', content: 'SYS' },
				{ role: 'user', content: 'U' },
			],
			stream: true,
		});
		expect(r.url).toBe('https://a/v1/messages');
		expect(r.body.system).toBe('SYS');
		expect(r.body.messages).toEqual([{ role: 'user', content: 'U' }]);
		expect(r.body.max_tokens).toBe(8192);
	});
});

describe('cursorupstream 流式解析', () => {
	it('openaiEvents 分离思考与正文，交错思考也保序', async () => {
		const s = streamOf([
			'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"答一半"}}]}\n\n',
			'data: {"choices":[{"delta":{"reasoning_content":"再想"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"答完"}}]}\n\n',
			'data: [DONE]\n\n',
		]);
		const out = [];
		for await (const ev of up.events('openai', s)) out.push(ev);
		expect(out).toEqual([
			{ type: 'reasoning', text: '先想' },
			{ type: 'text', text: '答一半' },
			{ type: 'reasoning', text: '再想' },
			{ type: 'text', text: '答完' },
		]);
	});

	it('openaiEvents 兼容 reasoning 字段名并在 [DONE] 停止', async () => {
		const s = streamOf([
			'data: {"choices":[{"delta":{"reasoning":"R"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
			'data: [DONE]\n\n',
			'data: {"choices":[{"delta":{"content":"NEVER"}}]}\n\n',
		]);
		const out = [];
		for await (const ev of up.openaiEvents(s)) out.push(ev);
		expect(out).toEqual([
			{ type: 'reasoning', text: 'R' },
			{ type: 'text', text: 'He' },
			{ type: 'text', text: 'llo' },
		]);
	});

	it('anthropicEvents 取 thinking/text 两种 delta，遇 message_stop 停止', async () => {
		const s = streamOf([
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"X"}}\n\n',
		]);
		const out = [];
		for await (const ev of up.anthropicEvents(s)) out.push(ev);
		expect(out).toEqual([
			{ type: 'reasoning', text: '想' },
			{ type: 'text', text: '你' },
			{ type: 'text', text: '好' },
		]);
	});

	it('deltas 只产出正文（旧聊天链路兼容）', async () => {
		const s = streamOf([
			'data: {"choices":[{"delta":{"reasoning_content":"忽略我"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
		]);
		const out = [];
		for await (const d of up.deltas('openai', s)) out.push(d);
		expect(out.join('')).toBe('A');
	});
});

describe('cursorupstream.completeOnce（摘要用的非流式补全）', () => {
	it('OpenAI：解析 choices[0].message.content，且请求 stream=false', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ choices: [{ message: { content: 'SUM' } }] }),
		);
		const text = await up.completeOnce(up.normalize({ baseUrl: 'https://x/v1', apiKey: 'k' }), {
			model: 'm',
			messages: [{ role: 'user', content: 'x' }],
		});
		expect(text).toBe('SUM');
		const [, init] = globalThis.fetch.mock.calls[0];
		expect(JSON.parse(init.body).stream).toBe(false);
		expect(init.headers.Authorization).toBe('Bearer k');
	});

	it('Anthropic：拼接 content[].text', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ content: [{ text: 'A' }, { text: 'B' }] }),
		);
		const text = await up.completeOnce(
			up.normalize({ baseUrl: 'https://a/v1', apiKey: 'k', apiFormat: 'anthropic' }),
			{ model: 'm', messages: [] },
		);
		expect(text).toBe('AB');
	});

	it('非 2xx 抛错并带上响应片段', async () => {
		globalThis.fetch = vi.fn(async () => new Response('balance not enough', { status: 402 }));
		await expect(
			up.completeOnce(up.normalize({ baseUrl: 'https://x/v1', apiKey: 'k' }), {
				model: 'm',
				messages: [],
			}),
		).rejects.toThrow(/402/);
	});
});