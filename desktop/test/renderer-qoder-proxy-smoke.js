/* 渲染层 Qoder CN 代理区块 jsdom 冒烟测试：
 * 加载真实 index.html + app.js，stub window.ccb（已登录），进入 Qoder CN IDE 详情面板，
 * 断言：MITM 代理区块渲染（默认开）→ 状态填充 → 一键写入带 qoderMitm 参数 →
 * 关掉开关后写入带 qoderMitm.enabled=false 且状态块消失。
 * 运行：node desktop/test/renderer-qoder-proxy-smoke.js（jsdom 在根 node_modules，npm i -D jsdom）
 */
process.env.NODE_PATH = 'F:\\ccb\\node_modules';
require('module').Module._initPaths();
const fs = require('fs');
const { JSDOM } = require('jsdom');

const out = [];
const say = (m) => out.push(m);
const flush = () =>
	fs.writeFileSync('F:\\ccb\\.workbuddy\\renderer-qoder-proxy-result.txt', out.join('\n'), 'utf8');

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

const qoderClient = {
	id: 'qoder-cn',
	name: 'Qoder CN IDE',
	variant: '中国版',
	vendor: '阿里巴巴',
	provider: 'openai',
	installed: true,
	appDirs: ['QoderCN'],
	details: {},
	evidence: [],
};

const proxyStatus = {
	running: true,
	port: 9183,
	caInstalled: true,
	models: 21,
	stats: { intercepted: 2, tunneled: 7, injected: 1 },
};

let savedQoderProxy = true;

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
	detectClients: async () => [qoderClient],
	launchClient: async () => ({ status: 'launched' }),
	pickClientPath: async () => null,
	setCustomPath: async () => ({ ok: false }),
	clearCustomPath: async () => ({ ok: true }),
	verifyKey: async () => ({ ok: true, models: ['ccb-model-a'] }),
	applyConfig: async (id, cfg) => {
		say(`applyConfig ${id} qoderMitm=${JSON.stringify(cfg.qoderMitm)}`);
		return { ok: true, log: ['已写入 Qoder 代理设置（manual → http://127.0.0.1:9183）'] };
	},
	rollbackConfig: async () => ({ ok: true, log: ['已移除 Qoder 代理设置'] }),
	getState: async () => ({
		apiBaseUrl: 'https://code.btluo.com/v1',
		models: [{ id: 'ccb-model-a' }, { id: 'ccb-model-b' }],
		defaultModel: 'ccb-model-a',
		qoderProxy: savedQoderProxy,
	}),
	saveState: (p) => {
		if ('qoderProxy' in p) {
			savedQoderProxy = p.qoderProxy;
			say(`saveState qoderProxy=${p.qoderProxy}`);
		}
		return {};
	},
	qoderProxy: {
		status: async () => proxyStatus,
		start: async (cfg) => {
			say(`qoder proxy start baseUrl=${cfg.baseUrl} models=${(cfg.models || []).join(',')}`);
			return { ok: true, port: 9183 };
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
	try {
		window.eval(appJs);
	} catch (e) {
		say('EVAL ERROR: ' + e.message);
	}
	await sleep(600); /* 等 init + 自动登录 */

	const $ = (s) => window.document.querySelector(s);
	const $$ = (s) => [...window.document.querySelectorAll(s)];
	const text = (el) => (el ? el.textContent.trim() : '(missing)');

	say('viewMain hidden=' + $('#viewMain').hidden);

	/* 1. 打开 Qoder CN 详情 */
	const detailBtn = $('.detail-btn[data-detail="qoder-cn"]');
	say('detail btn=' + !!detailBtn);
	detailBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(400);

	/* 2. MITM 区块（默认开） */
	say('mitmblock=' + !!$('.mitmblock'));
	say('qoderProxyEnabled checked=' + ($('#qoderProxyEnabled') && $('#qoderProxyEnabled').checked));
	say('qmitmStatus=' + !!$('#qmitmStatus'));
	say('qProxyToggleBtn=' + text($('#qProxyToggleBtn')));
	say('qCaInstallBtn=' + text($('#qCaInstallBtn')));
	say('qmitmStatus html=' + ($('#qmitmStatus') ? $('#qmitmStatus').innerHTML.replace(/\s+/g, ' ').slice(0, 220) : '(missing)'));

	/* 3. 点「重新写入配置」→ 应带 qoderMitm.enabled=true */
	$('#applyBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(400);

	/* 4. 关掉开关 → 状态块消失，写入带 enabled=false */
	const cb = $('#qoderProxyEnabled');
	cb.checked = false;
	cb.dispatchEvent(new window.Event('change', { bubbles: true }));
	await sleep(300);
	say('after off: qmitmStatus=' + !!$('#qmitmStatus'));
	$('#applyBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await sleep(400);

	say('DONE');
	flush();
}

main().catch((e) => {
	say('FATAL: ' + e.stack);
	flush();
});
