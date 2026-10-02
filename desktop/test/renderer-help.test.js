// @vitest-environment jsdom
/* 渲染层「帮助文档区」测试：加载真实 index.html + app.js（stub window.ccb），
 * 断言页面底部「遇到问题？」区块：
 *   - 常见问题条目渲染（问题标题 + 解决办法），默认收起
 *   - 搜索框按关键词过滤、命中条目自动展开；无结果给空状态
 *   - 「清除」恢复全部条目
 *   - 页脚「常见问题」按钮滚动到帮助区
 * 运行：npx vitest run test/renderer-help.test.js
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

function makeCcb() {
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
			models: async () => ({ models: [{ id: 'codeb-auto' }] }),
			currentKey: async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' }),
			redeem: async () => ({}),
		},
		detectClients: async () => [
			{ id: 'zcode', name: 'ZCode', variant: '', vendor: '智谱', writer: 'zcode', provider: 'openai', installed: true, evidence: [], details: {} },
		],
		applyConfig: async () => ({ ok: true, log: [] }),
		launchClient: async () => ({ status: 'launched', message: '已启动' }),
		rollbackConfig: async () => ({ ok: true, log: [] }),
		pickClientPath: async () => null,
		setCustomPath: async () => ({ ok: false }),
		clearCustomPath: async () => ({ ok: true }),
		verifyKey: async () => ({ ok: true, models: ['codeb-auto'] }),
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

/** 起一个真实渲染层（已登录）；dom.scrolled 记录 scrollIntoView 调用过的元素 id */
async function mount() {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	dom.scrolled = [];
	window.HTMLElement.prototype.scrollIntoView = function () { dom.scrolled.push(this.id || ''); };
	window.ccb = makeCcb();
	window.eval(appJs);
	await waitFor(() => window.document.querySelector('#viewMain').hidden === false);
	return dom;
}

const qaList = (dom) => Array.from(dom.window.document.querySelectorAll('#helpList .qa'));
const qaText = (el) => el.textContent.replace(/\s+/g, ' ').trim();

function typeSearch(dom, kw) {
	const { window } = dom;
	const input = window.document.querySelector('#helpSearch');
	input.value = kw;
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

describe('帮助文档区（页面底部「遇到问题？」）', () => {
	it('渲染常见问题条目，默认收起，页脚有入口', async () => {
		const dom = await mount();
		const doc = dom.window.document;
		const items = qaList(dom);
		expect(items.length).toBeGreaterThanOrEqual(8);
		for (const it of items) {
			expect(it.querySelector('.qa-q').textContent.trim().length).toBeGreaterThan(0);
			expect(it.querySelector('.qa-a').textContent.trim().length).toBeGreaterThan(0);
			expect(it.hasAttribute('open')).toBe(false);
		}
		/* 覆盖关键场景：登录、余额、路径、回滚 */
		const all = items.map(qaText).join('\n');
		for (const kw of ['登录', '余额', '路径', '回滚', '证书']) expect(all).toContain(kw);
		expect(doc.querySelector('#helpBtn')).not.toBe(null);
		dom.window.close();
	});

	it('搜索关键词只保留匹配条目并自动展开', async () => {
		const dom = await mount();
		const doc = dom.window.document;
		const total = qaList(dom).length;
		typeSearch(dom, '余额');
		const hit = qaList(dom);
		expect(hit.length).toBeGreaterThan(0);
		expect(hit.length).toBeLessThan(total);
		for (const it of hit) {
			expect(it.hasAttribute('open')).toBe(true);
			expect(qaText(it)).toContain('余额');
		}
		expect(doc.querySelector('#helpEmpty').hidden).toBe(true);
		expect(doc.querySelector('#helpClear').hidden).toBe(false);
		dom.window.close();
	});

	it('无匹配时显示空状态', async () => {
		const dom = await mount();
		const doc = dom.window.document;
		typeSearch(dom, 'zzz不存在的关键词');
		expect(qaList(dom).length).toBe(0);
		expect(doc.querySelector('#helpEmpty').hidden).toBe(false);
		dom.window.close();
	});

	it('点「清除」恢复全部条目并清空输入框', async () => {
		const dom = await mount();
		const doc = dom.window.document;
		const total = qaList(dom).length;
		typeSearch(dom, '余额');
		doc.querySelector('#helpClear').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		expect(doc.querySelector('#helpSearch').value).toBe('');
		expect(qaList(dom).length).toBe(total);
		expect(doc.querySelector('#helpClear').hidden).toBe(true);
		expect(doc.querySelector('#helpEmpty').hidden).toBe(true);
		dom.window.close();
	});

	it('页脚「常见问题」滚动到帮助区', async () => {
		const dom = await mount();
		const doc = dom.window.document;
		doc.querySelector('#helpBtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		expect(dom.scrolled).toContain('helpCard');
		dom.window.close();
	});
});