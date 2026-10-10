// @vitest-environment jsdom
/* 渲染层「后续步骤」提示测试：加载真实 index.html + app.js（stub window.ccb），
 * 点一键配置后断言按客户端差异给出的醒目提示：
 *   - Trae 系写入失败（客户端未登录）→ 红底步骤块：先登录 → 回来重跑一键配置
 *   - WorkBuddy 写入成功但界面默认模型没设上 → 黄底步骤块：登录 / 手动选 CCB 模型
 *   - ZCode 打开即用（无 warning）→ 不出步骤块
 * 运行：npx vitest run test/renderer-nextsteps.test.js（jsdom 在根 node_modules）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(here, '..', 'renderer', 'app.js'), 'utf8');

const CLIENTS = {
	'trae-cn': {
		id: 'trae-cn', name: 'TRAE CN', variant: '', vendor: '字节跳动',
		writer: 'traeui', provider: 'openai', installed: true, evidence: [], details: {},
	},
	'wb-cn': {
		id: 'wb-cn', name: 'WorkBuddy', variant: '中国版', vendor: '腾讯',
		writer: 'workbuddy', provider: 'codebuddy', installed: true, evidence: [], details: {},
	},
	zcode: {
		id: 'zcode', name: 'ZCode', variant: '', vendor: '智谱',
		writer: 'zcode', provider: 'openai', installed: true, evidence: [], details: {},
	},
};

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

function makeCcb(client, applyResult) {
	return {
		appInfo: async () => ({ version: '0.0.0-test', platform: 'win32' }),
		auth: {
			status: async () => ({ loggedIn: true }),
			login: async () => ({}),
			register: async () => ({}),
			logout: async () => ({}),
		},
		api: {
			profile: async () => ({ user: { username: 'tester', credits: 10 } }),
			models: async () => ({ models: [{ id: 'codeb-auto' }, { id: 'glm-5.3' }] }),
			currentKey: async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' }),
			redeem: async () => ({}),
		},
		detectClients: async () => [client],
		applyConfig: async () => applyResult,
		launchClient: async () => ({ status: 'launched', message: '已启动' }),
		pickClientPath: async () => null,
		setCustomPath: async () => ({ ok: false }),
		clearCustomPath: async () => ({ ok: true }),
		verifyKey: async () => ({ ok: true, models: ['codeb-auto'] }),
		rollbackConfig: async () => ({ ok: true, log: [] }),
		getState: async () => ({ apiBaseUrl: 'https://code.btluo.com/v1', models: [{ id: 'codeb-auto' }] }),
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
}

/** 起一个真实渲染层（已登录、检测到一个客户端），返回 { dom, window, summary } */
async function mount(clientId, applyResult) {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	window.HTMLElement.prototype.scrollIntoView = function () {};
	window.ccb = makeCcb(CLIENTS[clientId], applyResult);
	window.eval(appJs);
	await waitFor(() => window.document.querySelector('#viewMain').hidden === false);
	return dom;
}

async function applyAll(dom) {
	const { window } = dom;
	window.document.querySelector('#applyAllBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await waitFor(() => window.document.querySelector('#allSummary').style.display !== 'none');
	return window.document.querySelector('#allSummary');
}

const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '(missing)');

describe('一键配置完成后的后续步骤提示', () => {
	it('Trae 系未登录写入失败：提示先登录再重跑一键配置', async () => {
		const dom = await mount('trae-cn', {
			ok: false,
			log: ['开始写入自定义模型…'],
			error: 'TRAE CN 未登录，请先登录后重新配置',
		});
		const summary = await applyAll(dom);
		const box = await waitFor(() => summary.querySelector('.as-steps.fail'));
		const text = textOf(box);
		expect(text).toContain('先在客户端登录');
		expect(text).toContain('Trae 账号');
		expect(text).toContain('一键配置并启动');
		dom.window.close();
	});

	it('Trae 系非未登录失败（如主界面超时）：显示真实原因与重试指引，不再误导已登录的用户去登录', async () => {
		const dom = await mount('trae-cn', {
			ok: false,
			log: ['正在以调试模式启动 TRAE CN…', '看到「登录」按钮，先等 TRAE CN 恢复登录会话…'],
			error: 'TRAE CN 主界面等待超时：模型选择器一直没出现，请确认客户端窗口已打开后重试',
		});
		const summary = await applyAll(dom);
		const box = await waitFor(() => summary.querySelector('.as-steps.fail'));
		const text = textOf(box);
		expect(text).toContain('配置未完成');
		expect(text).toContain('主界面等待超时');
		expect(text).not.toContain('先在客户端登录');
		dom.window.close();
	});

	it('Trae 系已登录写入成功：明确说明不用再手动切模型', async () => {
		const dom = await mount('trae-cn', { ok: true, log: ['已写入全部模型与默认模型'] });
		const summary = await applyAll(dom);
		const box = await waitFor(() => summary.querySelector('.as-steps.ok'));
		expect(textOf(box)).toContain('不需要再手动切换');
		dom.window.close();
	});

	it('WorkBuddy 未登录：模型已写入但默认模型没设上，给出登录/手选两条路', async () => {
		const dom = await mount('wb-cn', {
			ok: true,
			log: ['已写入 models.json'],
			warning: '读不到 WorkBuddy 的账号信息，请先在 WorkBuddy 里登录，再点一次一键配置',
		});
		const summary = await applyAll(dom);
		const box = await waitFor(() => summary.querySelector('.as-steps.warn'));
		const text = textOf(box);
		expect(text).toContain('WorkBuddy 账号');
		expect(text).toContain('登录');
		expect(text).toContain('模型选择器里选一次带 CCB 的模型');
		expect(text).toContain('读不到 WorkBuddy 的账号信息');
		dom.window.close();
	});

	it('ZCode 打开即用：不出后续步骤块', async () => {
		const dom = await mount('zcode', { ok: true, log: ['已将 ZCode 当前模型设为 ccb/codeb-auto'] });
		const summary = await applyAll(dom);
		await sleep(150);
		expect(summary.querySelector('.as-steps')).toBe(null);
		expect(textOf(summary)).toContain('打开即可使用');
		dom.window.close();
	});
});