// @vitest-environment jsdom
/* 一键配置可靠性回归测试（对应 2026-10-30 排查修复的几个真实缺陷）：
 *   1. traeui.taskkillArgs：/IM 的值必须紧跟其后。旧实现 ['/IM','/T',name] 在
 *      Windows 上是非法语法（taskkill 直接报 Invalid syntax、命令不执行），
 *      Trae 系客户端运行中时永远关不掉 → 一键配置干等 24 秒后必然失败。
 *      除断言参数顺序外，还在真实 Windows 上跑一次 taskkill 验证语法可被接受。
 *   2. writers.pickDefaultModel：默认模型必须落在模型清单内，否则客户端静默
 *      回落到自家内置模型（「配置成功却没效果」）。
 *   3. 渲染层一键配置流程：
 *      a) profile 网络错误不再被当成「登录已过期」强制登出（服务端登录失效的
 *         固定文案是「未登录或登录已过期」，网络错误文案不含这两词）；
 *      b) 本地代理（Qoder CN / Cursor MITM）启动失败要浮出到摘要区，
 *         不再静默吞掉（此前显示「已配置并启动」但请求全部发不出去）；
 *      c) 平台密钥获取失败时给出真实原因，不再进写入器报「缺少 API Key」；
 *      d) 模型列表拉取失败时退回本地缓存继续配置（写入是纯本地操作）；
 *      e) applyConfig IPC 异常不再把卡片永远卡在「配置中…」。
 * 运行：npx vitest run test/oneclick-reliability.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const { taskkillArgs } = require('../electron/lib/traeui');
const { pickDefaultModel } = require('../electron/lib/writers');

/* ---------- 1. taskkill 参数顺序 ---------- */

describe('traeui.taskkillArgs（关闭客户端）', () => {
	it('优雅关闭：/IM 的值必须紧跟其后', () => {
		expect(taskkillArgs('Trae CN.exe', false)).toEqual(['/IM', 'Trae CN.exe', '/T']);
	});

	it('强制终止：/F /T 为开关、/IM 与值相邻', () => {
		expect(taskkillArgs('Trae CN.exe', true)).toEqual(['/F', '/T', '/IM', 'Trae CN.exe']);
	});

	/* 旧实现的两种顺序在真实 Windows 上均报语法错误、命令不执行（2026-10-30 实测）。
	 * taskkill 的输出是 OEM 代码页（中文系统为 GBK），用 utf8 解码会乱码、不能按
	 * 文本匹配；改用与区域设置无关的退出码断言：
	 *   128 = 语法被接受但进程不存在；1 = 语法错误（命令整体未执行） */
	(process.platform === 'win32' ? it : it.skip)('真实 taskkill 接受这两种参数（语法有效性）', () => {
		for (const force of [false, true]) {
			const r = spawnSync('taskkill', taskkillArgs('ccb-probe-not-exist.exe', force), {
				encoding: 'utf8', timeout: 10000, windowsHide: true,
			});
			expect(r.status).toBe(128); /* 语法 OK，只是进程不存在 */
		}
	});

	(process.platform === 'win32' ? it : it.skip)('旧实现的错误顺序确实被 taskkill 拒绝（钉死回归背景）', () => {
		const r = spawnSync('taskkill', ['/IM', '/T', 'ccb-probe-not-exist.exe'], {
			encoding: 'utf8', timeout: 10000, windowsHide: true,
		});
		expect(r.status).toBe(1); /* 语法错误：命令整体未执行 */
	});
});

/* ---------- 2. 默认模型取值 ---------- */

describe('writers.pickDefaultModel', () => {
	it('defaultModel 在清单内：原样使用', () => {
		expect(pickDefaultModel({ defaultModel: 'glm-5.3', models: ['glm-5.3', 'kimi-k6'] })).toBe('glm-5.3');
	});

	it('defaultModel 不在清单内（如 CodeBuddy 映射名漂移）：退回清单第一个', () => {
		expect(pickDefaultModel({ defaultModel: 'platform-id-x', models: ['cb-alias-a', 'cb-alias-b'] })).toBe('cb-alias-a');
	});

	it('未传 defaultModel：取清单第一个', () => {
		expect(pickDefaultModel({ models: ['a', 'b'] })).toBe('a');
	});

	it('空清单返回空串（不产生 undefined 写进配置）', () => {
		expect(pickDefaultModel({ models: [] })).toBe('');
		expect(pickDefaultModel({})).toBe('');
	});
});

/* ---------- 3. 渲染层一键配置流程 ---------- */
const html = fs.readFileSync(path.join(here, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(here, '..', 'renderer', 'app.js'), 'utf8');
const { JSDOM } = require('jsdom');

const CLIENT = {
	id: 'zcode', name: 'ZCode', variant: '', vendor: '智谱',
	writer: 'zcode', provider: 'openai', installed: true, evidence: [], details: {},
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

/** 按用例定制 ccb 桩；overrides 里可放 profile/models/currentKey/verifyKey/applyConfig。
 *  profileAfter：init() 也会调一次 profile（自动登录校验），所以「写入时的 profile
 *  行为」用 profileAfter 表达——首调成功（让应用进主界面），之后按它返回 */
function makeCcb(overrides = {}) {
	const calls = { applyConfig: [], launchClient: [] };
	let profileCalls = 0;
	return {
		calls,
		ccb: {
			appInfo: async () => ({ version: '0.0.0-test', platform: 'win32' }),
			auth: {
				status: async () => ({ loggedIn: true }),
				login: async () => ({}),
				register: async () => ({}),
				logout: async () => ({}),
			},
			api: {
				profile: async () => {
					profileCalls += 1;
					if (profileCalls > 1 && overrides.profileAfter) return overrides.profileAfter();
					return { user: { username: 'tester', credits: 10 } };
				},
				models: overrides.models || (async () => ({ models: [{ id: 'glm-5.3' }] })),
				currentKey:
					overrides.currentKey ||
					(async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' })),
				redeem: async () => ({}),
			},
			detectClients: async () => [CLIENT],
			applyConfig: async (id, cfg) => {
				calls.applyConfig.push({ id, cfg });
				if (overrides.applyConfig) return overrides.applyConfig(id, cfg);
				return { ok: true, log: ['已写入'] };
			},
			launchClient: async (id) => {
				calls.launchClient.push(id);
				return { status: 'launched', message: '已启动' };
			},
			pickClientPath: async () => null,
			setCustomPath: async () => ({ ok: false }),
			clearCustomPath: async () => ({ ok: true }),
			verifyKey: overrides.verifyKey || (async () => ({ ok: true, models: ['glm-5.3'] })),
			rollbackConfig: async () => ({ ok: true, log: [] }),
			getState: async () => ({
				apiBaseUrl: 'https://code.btluo.com/v1',
				models: [{ id: 'cached-model' }],
			}),
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
		},
	};
}

async function mount(overrides = {}) {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	window.HTMLElement.prototype.scrollIntoView = function () {};
	const stub = makeCcb(overrides);
	window.ccb = stub.ccb;
	dom.calls = stub.calls;
	/* toast 是单例元素，后一次提示会覆盖前一次文本；用 MutationObserver 收集
	 * 全部历史提示，才能断言流程中间出现过的文案 */
	dom.toasts = [];
	const toastEl = window.document.querySelector('#toast');
	new window.MutationObserver(() => {
		const t = (toastEl.textContent || '').trim();
		if (t && dom.toasts[dom.toasts.length - 1] !== t) dom.toasts.push(t);
	}).observe(toastEl, { childList: true, characterData: true, subtree: true });
	window.eval(appJs);
	await waitFor(() => window.document.querySelector('#viewMain').hidden === false);
	return dom;
}

async function clickApplyAll(dom) {
	const { window } = dom;
	window.document.querySelector('#applyAllBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

const summaryText = (dom) =>
	(dom.window.document.querySelector('#allSummary').textContent || '').replace(/\s+/g, ' ').trim();

const badgeText = (dom) => {
	const badge = dom.window.document.querySelector('.client-card .badge');
	return badge ? badge.textContent.trim() : '';
};

describe('一键配置：profile 校验不再把网络错误当成登录过期', () => {
	it('网络错误：提示检查网络、不强制登出、不进写入流程', async () => {
		const dom = await mount({
			profileAfter: async () => ({ error: '网络错误，请检查网络连接' }),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.toasts.some((t) => t.includes('网络错误')));
		/* 未被登出：仍停留在主视图 */
		expect(dom.window.document.querySelector('#viewAuth').hidden).toBe(true);
		expect(dom.window.document.querySelector('#viewMain').hidden).toBe(false);
		/* 没有走到写入 / 启动 */
		expect(dom.calls.applyConfig.length).toBe(0);
		expect(dom.calls.launchClient.length).toBe(0);
		dom.window.close();
	});

	it('登录态失效（服务端固定文案）：登出并提示重新登录', async () => {
		const dom = await mount({
			profileAfter: async () => ({ error: '未登录或登录已过期' }),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#viewAuth').hidden === false);
		expect(dom.toasts.some((t) => t.includes('登录已过期'))).toBe(true);
		expect(dom.calls.applyConfig.length).toBe(0);
		dom.window.close();
	});
});

describe('一键配置：本地代理启动失败必须浮出来', () => {
	it('写入成功但代理失败：摘要区出现失败行，不再显示「打开即可使用」', async () => {
		const dom = await mount({
			applyConfig: async () => ({
				ok: true,
				log: ['vscdb：已写入 21 个 CCB 模型'],
				proxy: { ok: false, error: '端口 9183 被占用' },
			}),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#allSummary').style.display !== 'none');
		const text = summaryText(dom);
		expect(text).toContain('本地代理启动失败');
		expect(text).toContain('端口 9183 被占用');
		/* 代理失败按失败行展示，而不是「已写入全部模型并启动，打开即可使用」 */
		expect(text).not.toContain('打开即可使用');
		/* toast 也给出代理失败提示（详情面板日志里同样可见） */
		await waitFor(() => dom.toasts.some((t) => t.includes('本地代理启动失败')));
		dom.window.close();
	});

	it('代理正常启动：维持原有成功文案', async () => {
		const dom = await mount({
			applyConfig: async () => ({ ok: true, log: ['已写入'], proxy: { ok: true, mode: 'inprocess' } }),
		});
		await clickApplyAll(dom);
		await waitFor(() => summaryText(dom).includes('打开即可使用'));
		dom.window.close();
	});
});

describe('一键配置：平台密钥获取失败给出真实原因', () => {
	it('密钥接口网络失败：不进写入器，结果区给出「获取平台密钥失败」', async () => {
		const dom = await mount({
			currentKey: async () => ({ error: '请求超时，请检查网络' }),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#allSummary').style.display !== 'none');
		const text = summaryText(dom);
		expect(text).toContain('获取平台密钥失败');
		expect(text).toContain('请求超时');
		expect(dom.calls.applyConfig.length).toBe(0);
		dom.window.close();
	});

	it('登录过期导致密钥拿不到：提示重新登录而不是「缺少 API Key」', async () => {
		const dom = await mount({
			currentKey: async () => ({ error: '未登录或登录已过期' }),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#allSummary').style.display !== 'none');
		expect(summaryText(dom)).toContain('登录已过期');
		expect(dom.calls.applyConfig.length).toBe(0);
		dom.window.close();
	});
});

describe('一键配置：模型列表拉取失败退回本地缓存', () => {
	it('服务端列表为空且校验失败：用缓存模型完成配置', async () => {
		const dom = await mount({
			models: async () => ({ models: [] }),
			verifyKey: async () => ({ ok: false, error: '连接超时' }),
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#allSummary').style.display !== 'none');
		/* 用缓存里的模型继续写入 */
		expect(dom.calls.applyConfig.length).toBe(1);
		expect(dom.calls.applyConfig[0].cfg.models).toEqual(['cached-model']);
		expect(summaryText(dom)).toContain('打开即可使用');
		await waitFor(() => dom.toasts.some((t) => t.includes('本地缓存的模型列表')));
		dom.window.close();
	});
});

describe('一键配置：applyConfig 抛异常不再卡死在「配置中…」', () => {
	it('IPC 异常：记入结果，卡片状态离开「配置中」', async () => {
		const dom = await mount({
			applyConfig: async () => {
				throw new Error('IPC exploded');
			},
		});
		await clickApplyAll(dom);
		await waitFor(() => dom.window.document.querySelector('#allSummary').style.display !== 'none');
		expect(summaryText(dom)).toContain('配置过程出错');
		expect(summaryText(dom)).toContain('IPC exploded');
		/* 状态徽标不再是「配置中…」 */
		await waitFor(() => badgeText(dom) !== '配置中…');
		expect(['失败 · 点详情', '已配置 ✓']).toContain(badgeText(dom));
		dom.window.close();
	});
});
