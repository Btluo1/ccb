/* 渲染层 MITM 区块 jsdom 冒烟测试：
 * 加载真实 index.html + app.js，stub window.ccb（已登录），进入 Cursor 详情面板，
 * 断言：接入模式区块渲染 → 切换 MITM → 代理状态填充 → 一键写入带 cursorMitm 参数。
 * 运行：node desktop/test/renderer-mitm-smoke.js（jsdom 在根 node_modules，npm i -D jsdom）
 */
process.env.NODE_PATH = 'F:\\ccb\\node_modules';
require('module').Module._initPaths();
const fs = require('fs');
const { JSDOM } = require('jsdom');

const out = [];
const say = (m) => out.push(m);
const flush = () =>
	fs.writeFileSync('F:\\ccb\\.workbuddy\\renderer-mitm-result.txt', out.join('\n'), 'utf8');

process.on('unhandledRejection', (e) => {
	say('UNHANDLED REJECTION: ' + (e && e.stack || e));
	flush();
	process.exit(2);
});
process.on('uncaughtException', (e) => {
	say('UNCAUGHT: ' + (e && e.stack || e));
	flush();
	process.exit(3);
});

const html = fs.readFileSync('F:\\ccb\\desktop\\renderer\\index.html', 'utf8');
const appJs = fs.readFileSync('F:\\ccb\\desktop\\renderer\\app.js', 'utf8');

const cursorClient = {
	id: 'cursor',
	name: 'Cursor',
	vendor: 'Anysphere',
	provider: 'openai',
	installed: true,
	appDirs: ['Cursor'],
	details: {},
	evidence: [],
};

const mitmStatus = {
	running: true,
	port: 9182,
	caInstalled: true,
	stats: { intercepted: 3, tunneled: 5, passthrough: 8 },
};

let savedCursorMode = 'byok';

const ccb = {
	appInfo: async () => ({ version: '9.9.9-test', platform: 'win32' }),
	auth: {
		status: async () => ({ loggedIn: true }),
		login: async () => ({}),
		register: async () => ({}),
		logout: async () => ({}),
	},
	api: {
		profile: async () => ({ user: { username: 'tester', credits: 10 } }),
		models: async () => ({ models: [{ id: 'ccb-model-a' }, { id: 'ccb-model-b' }] }),
		currentKey: async () => ({ key: { apiKey: 'sk-ccb-testkey' }, baseUrl: 'https://code.btluo.com/v1' }),
		redeem: async () => ({}),
	},
	detectClients: async () => [cursorClient],
	launchClient: async () => ({ status: 'launched' }),
	pickClientPath: async () => null,
	setCustomPath: async () => ({ ok: false }),
	clearCustomPath: async () => ({ ok: true }),
	verifyKey: async () => ({ ok: true, models: ['ccb-model-a'] }),
	applyConfig: async (id, cfg) => {
		say(`applyConfig ${id} cursorMitm=${JSON.stringify(cfg.cursorMitm)}`);
		return { ok: true, log: ['已写入 Cursor 代理配置（http://127.0.0.1:9182，override，禁用 HTTP/2）'] };
	},
	rollbackConfig: async () => ({ ok: true, log: ['已移除 Cursor 代理配置'] }),
	getState: async () => ({
		apiBaseUrl: 'https://code.btluo.com/v1',
		models: [{ id: 'ccb-model-a' }, { id: 'ccb-model-b' }],
		defaultModel: 'ccb-model-a',
		cursorMode: savedCursorMode,
	}),
	saveState: (p) => {
		if ('cursorMode' in p) {
			savedCursorMode = p.cursorMode;
			say(`saveState cursorMode=${p.cursorMode}`);
		}
		return {};
	},
	cursorProxy: {
		status: async () => mitmStatus,
		start: async (cfg) => {
			say(`proxy start apiKey=${cfg.apiKey} models=${(cfg.models || []).join(',')}`);
			return { ok: true, port: 9182 };
		},
		stop: async () => ({ ok: true }),
		installCa: async () => ({ ok: true }),
		uninstallCa: async () => ({ ok: true }),
	},
	revealPath: async () => {},
	openExternal: async () => {},
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
	const { window } = dom;
	window.ccb = ccb;
	window.HTMLElement.prototype.scrollIntoView = function () {}; /* jsdom 未实现 */
	say('pre-eval: title=' + window.document.title + ' viewAuth=' + !!window.document.querySelector('#viewAuth') + ' bodyLen=' + window.document.body.innerHTML.length);
	try {
		window.eval(appJs);
	} catch (e) {
		say('EVAL ERROR: ' + e.message);
	}
	say('post-eval: viewAuth=' + !!window.document.querySelector('#viewAuth'));
	await sleep(600); /* 等 init + 自动登录 */

	const $ = (s) => window.document.querySelector(s);
	const $$ = (s) => [...window.document.querySelectorAll(s)];

	say('viewAuth hidden=' + $('#viewAuth').hidden);
	say('viewMain hidden=' + $('#viewMain').hidden);
	say('clientGrid cards=' + $$('.client-card').length);

	/* 1. 打开 Cursor 详情 */
	const detailBtn = $('.detail-btn[data-detail="cursor"]');
	say('detail btn=' + !!detailBtn);
	detailBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(300);

	/* 2. 接入模式区块（BYOK 默认） */
	say('mitmblock=' + !!$('.mitmblock'));
	say('mode pills=' + $$('.mode-pill').length);
	say('mitmStatus(before switch)=' + !!$('#mitmStatus'));

	/* 3. 切换 MITM */
	const radio = $('input[name="cursorMode"][value="mitm"]');
	radio.checked = true;
	radio.dispatchEvent(new window.Event('change', { bubbles: true }));
	await sleep(400);
	say('after switch: mitmStatus=' + !!$('#mitmStatus'));
	say('after switch: caInstallBtn=' + !!$('#caInstallBtn'));
	say('after switch: proxyToggleBtn=' + text($('#proxyToggleBtn')));
	function text(el) { return el ? el.textContent.trim() : '(missing)'; }
	say('mitmStatus html=' + ($('#mitmStatus') ? $('#mitmStatus').innerHTML.replace(/\s+/g, ' ').slice(0, 200) : '(missing)'));

	/* 4. 点「重新写入配置」→ 应带 cursorMitm.enabled=true */
	const applyBtn = $('#applyBtn');
	say('applyBtn disabled=' + (applyBtn && applyBtn.disabled));
	applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(400);

	/* 5. 切回 BYOK 再写入 → cursorMitm.enabled=false */
	const radio2 = $('input[name="cursorMode"][value="byok"]');
	radio2.checked = true;
	radio2.dispatchEvent(new window.Event('change', { bubbles: true }));
	await sleep(300);
	$('#applyBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(400);

	say('DONE');
	flush();
}

main().catch((e) => {
	say('FATAL: ' + e.stack);
	flush();
});
