// @vitest-environment jsdom
/* 渲染层「用量显示」测试：
 *   /api/user/profile 返回 { user, usage: { today, total } }（北京时间口径），
 *   Step 1「账户余额」卡片并排展示「今日用量 / 累计用量」。
 *   覆盖：正常渲染（4 位小数）、0 值、旧服务端无 usage 字段的向后兼容、兑换后同步刷新。
 * 运行：npx vitest run test/renderer-usage.test.js
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

/** profile：/api/user/profile 的返回值（可传函数以模拟「每次调用返回不同值」） */
async function mount({ profile }) {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	window.ccb = {
		appInfo: async () => ({ version: '0.0.0-test', platform: 'win32' }),
		auth: {
			status: async () => ({ loggedIn: true }),
			login: async () => ({}),
			register: async () => ({}),
			logout: async () => ({}),
		},
		api: {
			profile: async () => (typeof profile === 'function' ? profile() : profile),
			models: async () => ({ models: [] }),
			currentKey: async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' }),
			redeem: async () => ({ credits: 5 }),
		},
		detectClients: async () => [],
		applyConfig: async () => ({ ok: true, log: [] }),
		launchClient: async () => ({ status: 'launched', message: '已启动' }),
		rollbackConfig: async () => ({ ok: true, log: [] }),
		pickClientPath: async () => null,
		setCustomPath: async () => ({ ok: false }),
		clearCustomPath: async () => ({ ok: true }),
		verifyKey: async () => ({ ok: true, models: [] }),
		getState: async () => ({ apiBaseUrl: 'https://code.btluo.com/v1', models: [] }),
		saveState: () => ({}),
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
	return dom;
}

const $ = (dom, sel) => dom.window.document.querySelector(sel);

describe('用量显示', () => {
	it('自动登录后展示今日 / 累计用量（4 位小数）', async () => {
		const dom = await mount({
			profile: { user: { username: 'tester', credits: 19.99 }, usage: { today: 0.0034, total: 19.9993 } },
		});
		expect($(dom, '#balanceValue').textContent).toBe('$19.99');
		expect($(dom, '#usageToday').textContent).toBe('$0.0034');
		expect($(dom, '#usageTotal').textContent).toBe('$19.9993');
		dom.window.close();
	});

	it('用量为 0 显示 $0.00；profile 无 usage 字段时显示「—」（向后兼容）', async () => {
		const zero = await mount({
			profile: { user: { username: 'tester', credits: 1 }, usage: { today: 0, total: 0 } },
		});
		expect($(zero, '#usageToday').textContent).toBe('$0.00');
		expect($(zero, '#usageTotal').textContent).toBe('$0.00');
		zero.window.close();

		const legacy = await mount({
			profile: { user: { username: 'tester', credits: 1 } },
		});
		expect($(legacy, '#usageToday').textContent).toBe('—');
		expect($(legacy, '#usageTotal').textContent).toBe('—');
		legacy.window.close();
	});

	it('兑换成功后刷新 profile，用量随之更新', async () => {
		const dom = await mount({
			profile: { user: { username: 'tester', credits: 14.99 }, usage: { today: 0.0034, total: 5.01 } },
		});
		/* 兑换后服务端返回新的用量（今日用量涨了） */
		dom.window.ccb.api.profile = async () => ({
			user: { username: 'tester', credits: 19.99 },
			usage: { today: 0.0088, total: 5.0156 },
		});
		const input = $(dom, '#redeemInput');
		input.value = 'CCB-CARD-XXXX';
		$(dom, '#redeemBtn').click();
		await waitFor(() => $(dom, '#usageToday').textContent === '$0.0088');
		expect($(dom, '#usageTotal').textContent).toBe('$5.0156');
		expect($(dom, '#balanceValue').textContent).toBe('$19.99');
		dom.window.close();
	});
});
