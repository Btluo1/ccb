// @vitest-environment jsdom
/* 渲染层「模型列表自动刷新」回归测试：
 *   - v1.0.13 及之前 loadModelsSilently() 第一行是 `if (state.models.length) return;`，
 *     只要本地存过模型就永不请求 → 服务端新增模型永远进不了界面，
 *     老用户会一直停在首次配置时的旧目录（如 21 个）
 *   - 修复后：每次启动静默刷新并覆盖本地缓存；仅在请求失败时回退到本地缓存
 * 运行：npx vitest run test/renderer-models-refresh.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(here, '..', 'renderer', 'app.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 5000) {
	const end = Date.now() + timeout;
	for (;;) {
		let v = null;
		try {
			v = fn();
		} catch {
			v = null;
		}
		if (v) return v;
		if (Date.now() > end) throw new Error('waitFor 超时');
		await sleep(30);
	}
}

/** cached = 本地持久化（旧）模型列表；server = 服务端返回；fail = 让 models() 抛错 */
async function mount({ cached, server, fail }) {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	const saved = [];
	window.ccb = {
		appInfo: async () => ({ version: '0.0.0-test', platform: 'win32' }),
		auth: {
			status: async () => ({ loggedIn: true }),
			login: async () => ({}),
			register: async () => ({}),
			logout: async () => ({}),
		},
		api: {
			profile: async () => ({ user: { username: 'tester', credits: 10 } }),
			models: async () => {
				if (fail) throw new Error('Network connection lost.');
				return { models: server };
			},
			currentKey: async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' }),
			redeem: async () => ({}),
		},
		detectClients: async () => [],
		applyConfig: async () => ({ ok: true, log: [] }),
		launchClient: async () => ({ status: 'launched', message: '已启动' }),
		rollbackConfig: async () => ({ ok: true, log: [] }),
		pickClientPath: async () => null,
		setCustomPath: async () => ({ ok: false }),
		clearCustomPath: async () => ({ ok: true }),
		verifyKey: async () => ({ ok: true, models: [] }),
		getState: async () => ({ apiBaseUrl: 'https://code.btluo.com/v1', models: cached }),
		saveState: (p) => {
			saved.push(p);
			return {};
		},
		update: {
			onState: () => {},
			state: async () => ({ status: 'idle', current: '0.0.0-test' }),
			check: async () => ({ ok: true, hasUpdate: false, current: '0.0.0-test' }),
			download: async () => ({ ok: true }),
			install: async () => ({ ok: true }),
		},
		cursorProxy: {
			status: async () => ({ running: false, port: 9182, caInstalled: true, stats: {} }),
			start: async () => ({ ok: true, port: 9182 }),
			stop: async () => ({ ok: true }),
			installCa: async () => ({ ok: true }),
			uninstallCa: async () => ({ ok: true }),
		},
		openExternal: async () => {},
	};
	window.eval(appJs);
	await waitFor(() => window.document.querySelector('#viewMain').hidden === false);
	dom.saved = saved;
	return dom;
}

const cnt = (dom) => dom.window.document.querySelector('#modelCnt2').textContent;
const chips = (dom) => Array.from(dom.window.document.querySelectorAll('#modelChips .chip')).map((el) => el.textContent);

describe('模型列表自动刷新', () => {
	it('本地已缓存旧列表时，启动仍会重新拉取并覆盖（回归 v1.0.13 缺陷）', async () => {
		const dom = await mount({
			cached: [{ id: 'glm-5.2' }],
			server: [
				{ id: 'codeb-auto' },
				{ id: 'glm-5.2' },
				{ id: 'claude-opus-5-5' },
				{ id: 'gemini-3.8-flash' },
				{ id: 'unavailable-model', available: false },
			],
		});
		await waitFor(() => cnt(dom) === '4');
		expect(cnt(dom)).toBe('4');
		expect(chips(dom)).toContain('claude-opus-5-5');
		expect(chips(dom)).toContain('gemini-3.8-flash');
		/* available:false 的模型不进入可用列表 */
		expect(chips(dom)).not.toContain('unavailable-model');
		/* 刷新结果写回本地，下次启动前也是最新的 */
		expect(dom.saved.length).toBeGreaterThan(0);
		expect(dom.saved[dom.saved.length - 1].models.map((m) => m.id)).toContain('gemini-3.8-flash');
		dom.window.close();
	});

	it('服务端不可达时回退到本地缓存列表，不清空', async () => {
		const dom = await mount({
			cached: [{ id: 'glm-5.2' }, { id: 'codeb-auto' }],
			server: null,
			fail: true,
		});
		await sleep(120);
		expect(cnt(dom)).toBe('2');
		expect(chips(dom)).toContain('glm-5.2');
		dom.window.close();
	});
});
