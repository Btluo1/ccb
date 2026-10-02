import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../electron/lib/store', () => ({
	load: () => ({ accountApiBase: 'https://ccb.btluo.com', token: null }),
	save: vi.fn(),
}));

import api from '../electron/lib/api';

function mockFetch(handler) {
	global.fetch = vi.fn(handler);
}

describe('后端 API 客户端', () => {
	beforeEach(() => {
		api.setToken(null);
	});

	it('getProfile：GET /api/user/profile 且带 Bearer Token', async () => {
		mockFetch(async (url, opts) => {
			expect(url).toBe('https://ccb.btluo.com/api/user/profile');
			expect(opts.method).toBe('GET');
			expect(opts.headers.Authorization).toBe('Bearer jwt-abc');
			return { ok: true, status: 200, json: async () => ({ user: { username: 'u', credits: 5 } }) };
		});
		api.setToken('jwt-abc');
		const r = await api.getProfile();
		expect(r.user.credits).toBe(5);
	});

	it('redeem：POST /api/user/redeem 携带卡密', async () => {
		mockFetch(async (url, opts) => {
			expect(url).toBe('https://ccb.btluo.com/api/user/redeem');
			expect(opts.method).toBe('POST');
			expect(JSON.parse(opts.body)).toEqual({ code: 'CARD-123' });
			return { ok: true, status: 200, json: async () => ({ credits: 10 }) };
		});
		const r = await api.redeem('CARD-123');
		expect(r.credits).toBe(10);
	});

	it('getCurrentKey：provider 走查询参数并解析 key/baseUrl', async () => {
		mockFetch(async (url) => {
			expect(url).toBe('https://ccb.btluo.com/api/user/current-key?provider=codebuddy');
			return { ok: true, status: 200, json: async () => ({ key: { apiKey: 'cb-xxx' }, baseUrl: 'https://code.btluo.com/v1' }) };
		});
		const r = await api.getCurrentKey('codebuddy');
		expect(r.key.apiKey).toBe('cb-xxx');
		expect(r.baseUrl).toBe('https://code.btluo.com/v1');
	});

	it('login：POST /api/auth/login 并带桌面客户端标识（服务端据此免 Turnstile）', async () => {
		mockFetch(async (url, opts) => {
			expect(url).toBe('https://ccb.btluo.com/api/auth/login');
			expect(opts.method).toBe('POST');
			expect(opts.headers['X-CCB-Client']).toBe('ccb-desktop');
			expect(JSON.parse(opts.body)).toEqual({ username: 'alice', password: 'secret123' });
			return { ok: true, status: 200, json: async () => ({ token: 'jwt-1', user: { username: 'alice' } }) };
		});
		const r = await api.login('alice', 'secret123');
		expect(r.token).toBe('jwt-1');
	});

	it('register：POST /api/auth/register 且不含邮箱字段', async () => {
		mockFetch(async (url, opts) => {
			expect(url).toBe('https://ccb.btluo.com/api/auth/register');
			expect(opts.headers['X-CCB-Client']).toBe('ccb-desktop');
			expect(JSON.parse(opts.body)).toEqual({ username: 'bob', password: 'secret123' });
			return { ok: true, status: 200, json: async () => ({ token: 'jwt-2', user: { username: 'bob' } }) };
		});
		const r = await api.register('bob', 'secret123');
		expect(r.token).toBe('jwt-2');
	});

	it('服务端返回错误：透传 error 字段', async () => {
		mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: '卡密无效' }) }));
		const r = await api.redeem('bad');
		expect(r.error).toBe('卡密无效');
	});

	it('网络异常：返回友好错误', async () => {
		mockFetch(async () => { throw new TypeError('fail to fetch'); });
		const r = await api.getProfile();
		expect(r.error).toContain('网络错误');
	});
});
