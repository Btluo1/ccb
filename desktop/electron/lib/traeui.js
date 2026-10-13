/**
 * Trae 系「一键添加自定义模型」——通过 CDP 驱动客户端自带的「添加模型」界面
 *
 * 为什么必须这么做（逐条取证见 clients.js / writers.js 的说明）：
 * Trae / TRAE CN / TraeWork 的模型列表 `AI.agent.model.model_list_map` 只是**服务端
 * 模型目录的本地缓存**，客户端启动即整表重取覆盖——本地文件写入必被清掉（实测写入
 * 171 条后启动客户端即归零、内容字节级还原）。自定义模型的权威存储是 Trae 账号
 * （服务端 RPC add_custom_model），本地无任何可写入口。
 *
 * 因此这里复用客户端**自己的**界面与网络层：带 `--remote-debugging-port` 启动客户端，
 * 用 CDP 真实点击「模型选择器 → 添加模型 → 自定义模型」表单并提交。客户端会用它自己
 * 的登录态调用 add_custom_model，配置落到账号上，重启也不会丢。
 *
 * 2026-10-10 方案 A 上线：优先在页面内直调客户端自己的 ModelAPIService RPC
 * （addCustomModel，见「RPC 直调」一节的逆向记录），零 UI 点击；RPC 链路不可用时
 * 自动降级回下方 UI 点击路径（保留作兜底，UI 改版时也是逃生通道）。
 *
 * 实测（TraeWork CN，2026-09-23；TRAE CN 3.4 合并版沿用同一套界面）：
 *   提交后服务端返回的条目形如
 *     { name: 'custom_openai_compatible//glm-5.3', provider: 'custom_openai_compatible',
 *       display_name: 'CCB glm-5.3', base_url: '<我们的地址>/chat/completions',
 *       ak: '<服务端加密>', custom_model_id: '2786682114', config_source: 3,
 *       is_custom_base_url: true, use_remote_service: false }
 *   `use_remote_service: false` 表示请求由客户端本地发起，故自建地址无需公网可达。
 *
 * 2026-10-10 TRAE CN 3.4.1（appVersion，tronBuildVersion 2.3.90452）全链路实测：
 *   - 表单占位符加了「请输入 / 例如」前缀（如「请输入模型展示名称」），按
 *     indexOf 前缀匹配的定位逻辑无需改动即兼容；
 *   - 选择器命中的是「旧代」.core-model-select-*（3.4 把两代前缀又换回去了），
 *     逗号多选择器天然覆盖；
 *   - 主窗口是 solo-lite.html（SOLO 形态），调试目标里另有一个常驻的
 *     floatingButton.html 浮窗排在 /json/list 第一位——固定连 pages[0] 会
 *     永远等不到选择器，waitForWorkbench 已改为全目标池扫描（见其注释）。
 *
 * 约束：
 *   - 客户端必须已登录 Trae 账号（未登录时无法提交自定义模型；
 *     注意冷启动时顶栏会先短暂渲染「登录」按钮再恢复会话，判定要防抖，见 waitForWorkbench）
 *   - 启动期间不能已有同产品实例在跑（单实例，新进程只会激活旧窗口，不会开调试端口）
 *   - 界面结构由 Trae 版本决定，选择器全部集中在下面 SEL 常量里，便于版本变更时修
 */

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const { isRunning } = require('./proc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 界面选择器 ----------
 * Trae 系有两代模型选择器 UI（其余结构两代完全一致，逐项实测）：
 *   旧版（TraeWork CN 1.107.1）：触发器 .core-model-select-trigger，
 *         菜单 .core-model-select-portal，菜单底部入口 .core-model-select-footer-action
 *   新版（TraeCode CN 2026-09 实测）：触发器 .icd-model-select-trigger，
 *         菜单 .icube-model-select-portal，菜单底部入口 .icube-model-select-portal-footer
 * querySelector 支持逗号多选择器，一份选择器同时覆盖两代。设置页表格
 * table.icd-accordion-table、弹窗 .icd-modal-overlay.add-model-dialog、提交按钮
 * .add-model-connect-button 与四个表单占位符（indexOf 前缀匹配）在新版均原样保留
 * （新版的「完整 URL」复选框默认不勾，行为与旧版一致：客户端自动拼 /chat/completions）。 */
const SEL = {
	modelTrigger: '.core-model-select-trigger, .icd-model-select-trigger',
	modelMenu: '.core-model-select-portal, .icube-model-select-portal',
	menuFooterAdd: '.core-model-select-footer-action, .icube-model-select-portal-footer',
	settingsTable: 'table.icd-accordion-table',
	dialog: '.icd-modal-overlay.add-model-dialog',
	dialogSubmit: '.add-model-connect-button',
	dialogSave: '.add-model-save-button',
	phBase: 'api.openai.com',
	phModelId: '输入模型 ID',
	phDisplay: '模型展示名称',
	phApiKey: 'API Key',
	textAddModel: '添加模型',
	textCustom: '自定义模型',
};

/* ---------- 端口 / 进程 ---------- */

function findFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

/** 关闭同产品所有实例（单实例客户端不关掉就开不出调试端口） */
async function killRunning(exeNames, log) {
	const names = (exeNames || []).filter((n) => isRunning(n));
	if (!names.length) return true;
	log(`检测到 ${names.join('、')} 正在运行，先关闭以便带调试端口重启…`);

	const waitGone = async (ms) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (!names.some((n) => isRunning(n))) return true;
			await sleep(700);
		}
		return !names.some((n) => isRunning(n));
	};

	/* 先礼貌关闭（给客户端保存状态的机会），超时再强制结束 */
	for (const n of names) spawn('taskkill', ['/IM', n], { stdio: 'ignore', windowsHide: true });
	if (await waitGone(12000)) {
		await sleep(1200);
		return true;
	}
	for (const n of names) spawn('taskkill', ['/F', '/IM', n], { stdio: 'ignore', windowsHide: true });
	const gone = await waitGone(12000);
	await sleep(1500);
	return gone;
}

function launchWithDebugPort(exePath, port) {
	const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
		detached: true,
		stdio: 'ignore',
		cwd: path.dirname(exePath),
		env: process.env,
	});
	child.unref();
}

/* ---------- CDP ---------- */

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		ws.addEventListener('message', (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			const p = msg.id && this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				p(msg);
			}
		});
	}

	static async listPages(port) {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
		const list = await res.json();
		return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
	}

	static async open(wsUrl) {
		const ws = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error('调试通道连接失败')), { once: true });
			setTimeout(() => reject(new Error('调试通道连接超时')), 8000);
		});
		const cdp = new Cdp(ws);
		await cdp.send('Runtime.enable', {});
		await cdp.send('Page.enable', {});
		return cdp;
	}

	static async connect(port, timeoutMs) {
		if (typeof WebSocket !== 'function') throw new Error('当前运行时缺少 WebSocket 支持');
		const deadline = Date.now() + timeoutMs;
		let lastErr = '等待客户端启动';
		while (Date.now() < deadline) {
			try {
				const pages = await Cdp.listPages(port);
				if (pages.length) return await Cdp.open(pages[0].webSocketDebuggerUrl);
				lastErr = '客户端主窗口尚未就绪';
			} catch (e) {
				lastErr = e.message || String(e);
			}
			await sleep(1000);
		}
		throw new Error(`未能连上客户端调试端口：${lastErr}`);
	}

	send(method, params, timeoutMs = 20000) {
		return new Promise((resolve, reject) => {
			const id = ++this.seq;
			this.pending.set(id, resolve);
			this.ws.send(JSON.stringify({ id, method, params: params || {} }));
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`));
			}, timeoutMs);
		});
	}

	/** 在页面里求值；表达式异常时抛出 */
	async evaluate(expression) {
		const r = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (r.result?.exceptionDetails) {
			throw new Error('页面脚本异常：' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200));
		}
		return r.result?.result?.value;
	}

	/** 长超时求值：RPC 直调的页面脚本在凭证/云连接未就绪时会挂起等待，
	 *  默认 20s 不够（TRAE CN 3.4.1 实测启动后 ~35s 才就绪，见 RPC_FIND_SERVICE 注释） */
	async evaluateLong(expression, timeoutMs = 60000) {
		const r = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		}, timeoutMs);
		if (r.result?.exceptionDetails) {
			throw new Error('页面脚本异常：' + (r.result.exceptionDetails.exception?.description || '').slice(0, 200));
		}
		return r.result?.result?.value;
	}

	/** 真实鼠标点击（React 的合成事件只认真实指针事件，element.click() 不生效） */
	async clickAt(x, y) {
		for (const type of ['mousePressed', 'mouseReleased']) {
			await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	}

	async pressEscape() {
		for (const type of ['keyDown', 'keyUp']) {
			await this.send('Input.dispatchKeyEvent', {
				type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
			});
		}
	}

	close() {
		try {
			this.ws.close();
		} catch {}
	}
}

/* ---------- 页面脚本片段 ---------- */

/** 按文本找元素并返回中心坐标（取最深匹配，避免命中整块容器）。
 *  先 scrollIntoView：菜单项可能在滚动区外，坐标会落到视口外导致点击落空。 */
function rectByText(scopeExpr, text) {
	return `(function(){
		var scope=${scopeExpr};
		if(!scope) return null;
		var hits=[];
		scope.querySelectorAll('*').forEach(function(el){
			if((el.innerText||'').trim()===${JSON.stringify(text)}) hits.push(el);
		});
		if(!hits.length) return null;
		hits.sort(function(a,b){return a.querySelectorAll('*').length-b.querySelectorAll('*').length});
		var el=hits[0];
		try{ el.scrollIntoView({block:'center'}) }catch(e){}
		var r=el.getBoundingClientRect();
		if(r.width<=0||r.height<=0) return null;
		return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
	})()`;
}

const RECT_TRIGGER = `(function(){
	var t=document.querySelector(${JSON.stringify(SEL.modelTrigger)});
	if(!t) return null;
	var r=t.getBoundingClientRect();
	if(r.width<=0||r.height<=0) return null;
	return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
})()`;

/* 未登录判定：顶栏账号区会渲染一个精确文案为「登录」的按钮；登录后该位置换为
 * 头像/用户名，不会再出现。未登录时模型选择器永远不出现，干等 120 秒只会让
 * 用户看到一条莫名其妙的「等待主界面超时」，所以等主界面时同时盯这个按钮。
 * 2026-10-10 TRAE CN 3.4.1 实测补充：新版（SOLO 形态）主页在**已登录**状态
 * 下也常驻一个「登录」入口（main.log 同时有 getUserInfo/ide_user_ent_usage
 * 服务器调用），按钮与登录态不再互斥。因此加了门控：页面上只要存在任何
 * model-select 标记（聊天组件已渲染），该按钮就与登录态无关，不判未登录。 */
const LOGIN_VISIBLE = `(function(){
	if (document.querySelector('[class*="model-select"]')) return '';
	var els=document.querySelectorAll('button,[role=button]');
	for(var i=0;i<els.length;i++){
		if((els[i].innerText||'').trim()==='登录' && els[i].offsetWidth) return '1';
	}
	return '';
})()`;

const MENU_OPEN = `(function(){
	var p=document.querySelector(${JSON.stringify(SEL.modelMenu)});
	return !!(p && (p.innerText||'').trim().length>10);
})()`;

const DIALOG_OPEN = `!!document.querySelector(${JSON.stringify(SEL.dialog)})`;

const SETTINGS_READY = `(function(){
	return !!document.querySelector(${JSON.stringify(SEL.settingsTable)});
})()`;

/* 表格是异步渲染的。TRAE CN 3.4.1 实测（2026-10-10）：冷启动点进「模型管理」后
 * 列表要从服务端拉取，加载指示器 .icd-accordion-table-loading 会转 20 多秒；
 * 加载完成后有数据行则数据行出现，没数据则渲染 .icd-accordion-no-data-element
 * （文案「暂无自定义模型，你可以在这里添加自定义模型」）。三个坑：
 * ① 表格不是 <td> 结构（div 模拟），只能按行内文本判断；
 * ② 页面上有多个同 class 的折叠表（外层 header-only 表 + 每个折叠区一张 tbody 表），
 *    必须全扫一遍再合并；
 * ③ 空账号下表格只有 thead，数据行判据和文案判据都可能迟迟不成立——
 *    加载指示器的类名才是可靠的「还在转」信号，要等它消失（见 TABLE_SETTLED）。 */
const ROW_NAMES = `(function(){
	var tables=document.querySelectorAll(${JSON.stringify(SEL.settingsTable)});
	if(!tables.length) return null;
	var out=[];
	[].slice.call(tables).forEach(function(t){
		[].slice.call(t.querySelectorAll('tr')).forEach(function(tr){
			var lines=(tr.innerText||'').split('\\n').map(function(s){return s.trim()}).filter(Boolean);
			if(lines.length && lines[0]!=='模型' && lines[0]!=='服务商') out.push(lines[0]);
		});
	});
	return out;
})()`;

const TABLE_SETTLED = `(function(){
	var tables=document.querySelectorAll(${JSON.stringify(SEL.settingsTable)});
	if(!tables.length) return false;
	/* 加载指示器还在转就不算完（3.4 冷启动要转 20 多秒，12 秒超时会误杀） */
	if(document.querySelector('.icd-accordion-table-loading')) return false;
	var names=${ROW_NAMES};
	if(names && names.length) return true;
	if(document.querySelector('.icd-accordion-no-data-element')) return true;
	return (document.body.innerText||'').indexOf('暂无自定义模型')>=0;
})()`;

const DIALOG_TEXT = `(function(){
	var d=document.querySelector(${JSON.stringify(SEL.dialog)});
	return d?(d.innerText||'').replace(/\\s+/g,' ').slice(0,300):'';
})()`;

const buildFillScript = (base, modelId, displayName, apiKey) => `(function(){
	function setVal(el, value){
		var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
		setter.call(el, value);
		el.dispatchEvent(new Event('input', {bubbles:true}));
		el.dispatchEvent(new Event('change', {bubbles:true}));
		el.dispatchEvent(new Event('blur', {bubbles:true}));
	}
	var dlg=document.querySelector(${JSON.stringify(SEL.dialog)});
	if(!dlg) return 'no-dialog';
	var ins=[].slice.call(dlg.querySelectorAll('input'));
	var byPh=function(ph){return ins.filter(function(el){return (el.placeholder||'').indexOf(ph)>=0})[0]};
	var urlEl=byPh(${JSON.stringify(SEL.phBase)});
	var idEl=byPh(${JSON.stringify(SEL.phModelId)});
	var nameEl=byPh(${JSON.stringify(SEL.phDisplay)});
	var keyEl=byPh(${JSON.stringify(SEL.phApiKey)});
	if(!urlEl||!idEl||!nameEl||!keyEl) return 'missing-field';
	setVal(urlEl, ${JSON.stringify(base)});
	setVal(idEl, ${JSON.stringify(modelId)});
	setVal(nameEl, ${JSON.stringify(displayName)});
	setVal(keyEl, ${JSON.stringify(apiKey)});
	return 'ok';
})()`;

const SUBMIT_RECT = `(function(){
	var b=document.querySelector(${JSON.stringify(SEL.dialogSubmit)});
	if(!b||b.disabled) return null;
	var r=b.getBoundingClientRect();
	if(r.width<=0||r.height<=0) return null;
	return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
})()`;

/* 「直接保存」按钮（跳过连通性测试直接入库）：只在测试失败后的弹窗里出现 */
const SAVE_BTN_RECT = `(function(){
	var b=document.querySelector(${JSON.stringify(SEL.dialogSave)});
	if(!b||b.disabled) return null;
	var r=b.getBoundingClientRect();
	if(r.width<=0||r.height<=0) return null;
	return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
})()`;

/* 「完整 URL」开关归一化：失败提交后客户端会把表单缓存成「完整 URL」模式——URL 被自动
 * 补全成 …/chat/completions 且开关拨到 ON（2026-09-25 Trae 国际版实测）。恢复态下若把裸
 * base 填进去，请求会直接 POST 到 base 本身（HTTP 405，整批交替失败）。填表前必须拨回
 * 「拼接 /chat/completions」模式；开关是隐藏的 checkbox，对它 .click() 即可切换 React 状态。 */
const ENSURE_APPEND_MODE = `(function(){
	var dlg=document.querySelector(${JSON.stringify(SEL.dialog)});
	if(!dlg) return 'no-dialog';
	var sw=dlg.querySelector('.add-model-switch-input');
	if(!sw) return 'no-switch';
	if(sw.checked){ sw.click(); return 'toggled-off'; }
	return 'already-off';
})()`;

/* ---------- 步骤 ---------- */

/** 轮询求值；页面正在导航时求值会失败，按「还没好」处理，不算错误 */
async function waitFor(cdp, expr, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await cdp.evaluate(expr)) return true;
		} catch {}
		if (Date.now() >= deadline) throw new Error(`等待「${what}」超时`);
		await sleep(400);
	}
}

/** 等主界面（模型选择器）就绪，同时防两类「已登录却被判失败」的误判：
 *  1) 冷启动竞态：客户端被我们重启后，顶栏会先渲染「登录」按钮，会话恢复后才换成头像；
 *     若把「登录按钮出现了一瞬」当定论，登录用户会被误报未登录（慢机器/慢网络必现）。
 *     因此登录按钮只在**持续**存在（默认 30 秒）时才判未登录，瞬时出现一律继续等选择器。
 *  2) 新版 TRAE CN（3.4+，2026-10-10 实测）是 SOLO 形态：调试目标里除主窗口
 *     （solo-lite.html）外还有一个**常驻的 floatingButton.html 浮窗**，且它排在
 *     /json/list 的第一位。固定连 pages[0] 的话，浮窗 socket 一直健康但永远没有
 *     模型选择器，旧逻辑只在 socket 断开时才换目标 → 120 秒干等到超时。
 *     因此这里维护一个「目标池」：每轮把全部 page 目标都探测一遍，谁先出现
 *     「可见的」模型选择器（RECT_TRIGGER 要求宽高非零，浮窗里隐藏的同名标记
 *     不算数）就用谁继续后面的流程。
 * @returns {Promise<{cdp:Cdp, error?:string}>} error 非空表示失败（含未登录与超时两种文案）
 */
async function waitForWorkbench(cdp, port, label, log, opts = {}) {
	const deadlineMs = opts.deadlineMs || 120000;
	const loginGraceMs = opts.loginGraceMs || 30000;
	const pollMs = opts.pollMs || 500;
	const notLoggedIn = () => ({ cdp, error: `${label} 未登录，请先登录后重新配置` });
	const pool = new Map(); /* webSocketDebuggerUrl -> Cdp */
	if (cdp && cdp.ws.readyState === 1) pool.set(cdp.ws.url, cdp);
	const deadline = Date.now() + deadlineMs;
	let loginSince = 0;
	for (;;) {
		/* 目标列表随窗口开合变化（splash 关掉、浮窗常驻、主窗口出现），每轮重拉；
		 * 端口暂时不可用时保留现有池继续探测，不算失败 */
		let pages = [];
		try { pages = await Cdp.listPages(port); } catch {}
		for (const p of pages) {
			if (!pool.has(p.webSocketDebuggerUrl)) {
				try {
					pool.set(p.webSocketDebuggerUrl, await Cdp.open(p.webSocketDebuggerUrl));
					log('发现新的客户端窗口，纳入探测…');
				} catch {}
			}
		}
		let login = false;
		for (const [url, c] of pool) {
			if (c.ws.readyState !== 1) { pool.delete(url); continue; }
			let triggered = false;
			try { triggered = !!(await c.evaluate(RECT_TRIGGER)); } catch {}
			if (triggered) return { cdp: c };
			try { if (await c.evaluate(LOGIN_VISIBLE)) login = true; } catch {}
		}
		if (login) {
			if (!loginSince) {
				loginSince = Date.now();
				log(`看到「登录」按钮，先等 ${label} 恢复登录会话（冷启动时顶栏会短暂显示登录态）…`);
			} else if (Date.now() - loginSince >= loginGraceMs) {
				log(`「登录」按钮持续 ${Math.round(loginGraceMs / 1000)} 秒未消失，判定 ${label} 未登录。`);
				return notLoggedIn();
			}
		} else {
			/* 按钮消失 = 会话恢复完成，重新计时 */
			loginSince = 0;
		}
		if (Date.now() >= deadline) {
			return loginSince ? notLoggedIn() : { cdp, error: `${label} 主界面等待超时：模型选择器一直没出现，请确认客户端窗口已打开后重试` };
		}
		await sleep(pollMs);
	}
}

/** 打开「模型」设置页（含模型管理表格） */
async function openModelSettings(cdp, log) {
	if (await cdp.evaluate(SETTINGS_READY)) return;

	await cdp.pressEscape();
	await sleep(500);

	let opened = false;
	for (let i = 0; i < 3 && !opened; i++) {
		/* 选择器可能因界面重渲染瞬时缺席：轮询等它回来，而不是一票否决 */
		let trig = null;
		try {
			trig = await waitForRect(cdp, RECT_TRIGGER, i === 0 ? 20000 : 5000, '模型选择器');
		} catch {}
		if (!trig) throw new Error('界面上找不到模型选择器，请确认客户端已打开主界面后重试');
		const { x, y } = JSON.parse(trig);
		await cdp.clickAt(x, y);
		await sleep(1400);
		opened = await cdp.evaluate(MENU_OPEN);
		if (!opened) {
			await cdp.pressEscape();
			await sleep(500);
		}
	}
	if (!opened) throw new Error('模型选择器打不开，请手动点开一次模型列表后重试');

	const footer = await cdp.evaluate(rectByText(`document.querySelector(${JSON.stringify(SEL.modelMenu)})`, SEL.textAddModel));
	if (!footer) throw new Error('模型列表里没有找到「添加模型」入口');
	const { x, y } = JSON.parse(footer);
	await cdp.clickAt(x, y);
	await waitFor(cdp, SETTINGS_READY, 15000, '模型设置页');
	/* 列表要从服务端拉取：3.4 冷启动加载指示器实测要转 20 多秒，留足余量 */
	await waitFor(cdp, TABLE_SETTLED, 60000, '已有模型列表加载');
	log('已打开「设置 → 模型 → 模型管理」');
}

/** 读取「模型管理」表格里已有的模型名（用于跳过重复添加） */
async function readExisting(cdp) {
	try {
		return (await cdp.evaluate(ROW_NAMES)) || [];
	} catch {
		return [];
	}
}

/** 轮询一个「返回坐标 JSON 的表达式」直到非空（求值失败按「还没好」处理） */
async function waitForRect(cdp, expr, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const r = await cdp.evaluate(expr);
			if (r) return r;
		} catch {}
		if (Date.now() >= deadline) throw new Error(`${what}不可用`);
		await sleep(400);
	}
}

/** 添加单个自定义模型 */
async function addOne(cdp, item, log) {
	/* 打开「添加模型」弹窗（设置页里的按钮，不在模型选择器菜单里） */
	const btn = await cdp.evaluate(
		rectByText(`document.querySelector(${JSON.stringify(SEL.settingsTable)}) && document.body`, SEL.textAddModel),
	);
	if (!btn) throw new Error('设置页里找不到「添加模型」按钮');
	const b = JSON.parse(btn);
	await cdp.clickAt(b.x, b.y);
	await waitFor(cdp, DIALOG_OPEN, 12000, '添加模型弹窗');

	/* 选「自定义模型」 */
	const custom = await cdp.evaluate(rectByText(`document.querySelector(${JSON.stringify(SEL.dialog)})`, SEL.textCustom));
	if (!custom) throw new Error('弹窗里找不到「自定义模型」选项');
	const c = JSON.parse(custom);
	await cdp.clickAt(c.x, c.y);
	await sleep(900);

	/* 表单可能是上次失败后缓存的「完整 URL」模式（URL 已被补全 + 开关 ON），
	 * 拨回拼接模式再填表，否则裸 base 会被当完整 URL 直接 POST（HTTP 405） */
	await cdp.evaluate(ENSURE_APPEND_MODE);
	await sleep(500);

	/* 填表 */
	const filled = await cdp.evaluate(buildFillScript(item.base, item.modelId, item.displayName, item.apiKey));
	if (filled !== 'ok') throw new Error(`表单填写失败（${filled}）`);
	await sleep(600);

	/* 提交按钮可能处于禁用态（上一次提交触发的连通性测试还在后台跑），轮询等它恢复 */
	const submit = await waitForRect(cdp, SUBMIT_RECT, 35000, '「添加模型」提交按钮');
	const s = JSON.parse(submit);
	await cdp.clickAt(s.x, s.y);

	/* 新版 UI 点提交后先跑「连通性测试」：通过则弹窗自动关闭（实测有效模型约 8 秒）；
	 * 失败则弹窗不关、底部多出「直接保存」按钮（实测无效模型约 27 秒才出结果）。
	 * 测试失败时点「直接保存」跳过测试照样入库——中转服务偶发抖动不该挡住配置，
	 * 错误摘要写进日志，用户能看见。 */
	const deadline = Date.now() + 75000;
	while (Date.now() < deadline) {
		if (!(await cdp.evaluate(DIALOG_OPEN))) return;
		const save = await cdp.evaluate(SAVE_BTN_RECT);
		if (save) {
			const why = await cdp.evaluate(DIALOG_TEXT);
			log(`连通性测试未通过${why ? '：' + why.slice(-120) : ''}`);
			log('改用「直接保存」跳过测试入库…');
			const sv = JSON.parse(save);
			await cdp.clickAt(sv.x, sv.y);
			const saveDeadline = Date.now() + 10000;
			while (Date.now() < saveDeadline) {
				if (!(await cdp.evaluate(DIALOG_OPEN))) return;
				await sleep(400);
			}
			break;
		}
		await sleep(500);
	}
	const why = await cdp.evaluate(DIALOG_TEXT);
	throw new Error(`提交被拦下：${why || '弹窗未关闭'}`);
}

/**
 * 把当前模型切到指定展示名的模型（用户要求：配好即用，不必再手动切一次）。
 * 通过界面点击完成，比手写 <uid>:AI.agent.model.recent_user_selection_by_agent_label
 * 更可靠：服务端自定义模型的 modelId 形如
 *   solo_work_lite_3_custom_openai_compatible_custom_openai_compatible//glm-5.3_2786682114
 * （agentLabel + config_source + provider + name + custom_model_id），
 * 其中 custom_model_id 只有服务端知道，本地拼不出来。
 * 用户从未手动选过模型也没关系：点击会由客户端自己创建选中记录，落点与手动选完全一致。
 */
async function selectModel(cdp, displayName, log) {
	await cdp.pressEscape();
	await sleep(800);

	/* 刚通过 RPC 添加的模型要等服务端目录刷新后才会出现在菜单里，轮询至多 60 秒
	 * （整批添加后目录同步明显变慢，30 秒不够——Trae 国际版实测 7 个模型加完
	 * 后 30 秒内菜单一条 CCB 都没有） */
	const deadline = Date.now() + 60000;
	for (let attempt = 0; attempt < 3; attempt++) {
		/* 模型全部添加完成后，任何一步失败都不该把整个配置判为失败：
		 * 选择器瞬时缺席（设置页关闭后的重渲染）只降级为「请手动选一次」 */
		let trig = null;
		try {
			trig = await waitForRect(cdp, RECT_TRIGGER, 15000, '模型选择器');
		} catch {}
		if (!trig) {
			log('模型选择器暂时不可见，跳过默认模型切换。');
			return false;
		}
		const t = JSON.parse(trig);
		await cdp.clickAt(t.x, t.y);
		await sleep(1400);
		if (!(await cdp.evaluate(MENU_OPEN))) {
			await cdp.pressEscape();
			await sleep(500);
			continue;
		}
		let item = null;
		while (Date.now() < deadline) {
			item = await cdp.evaluate(rectByText(`document.querySelector(${JSON.stringify(SEL.modelMenu)})`, displayName));
			if (item) break;
			if (!(await cdp.evaluate(MENU_OPEN))) break; /* 菜单被关掉就重开再找 */
			await sleep(1500);
		}
		if (!item) {
			if (Date.now() < deadline) continue;
			log(`模型菜单里暂时没看到 ${displayName}，跳过默认模型切换。`);
			await cdp.pressEscape();
			return false;
		}
		const i = JSON.parse(item);
		await cdp.clickAt(i.x, i.y);
		await sleep(1200);
		const current = await cdp.evaluate(
			`(function(){var t=document.querySelector(${JSON.stringify(SEL.modelTrigger)});return t?(t.innerText||'').trim():''})()`,
		);
		if (current === displayName) {
			log(`已把当前模型切到 ${displayName}。`);
			return true;
		}
		await cdp.pressEscape();
		await sleep(500);
	}
	log(`未能自动切换到 ${displayName}，请在模型列表里手动选一次。`);
	return false;
}

/* ---------- RPC 直调（免 UI 表单，方案 A） ----------
 * 背景（2026-10-10 TRAE CN 3.4.1 逆向 + 实测，证据链见 test/trae-rpc-add.js）：
 * 「添加模型」UI 只是表象，真正落库的是渲染层一行
 *   TransportManager.executeRequest(model, add_custom_model)
 *   → ahaRpcClient → 原生 ttnet 签名网络栈（外部无法复刻签名）。
 * 但 ModelAPIService（addCustomModel/getModelList）是 chat bundle 自己的 DI 单例，
 * 服务 ID 是 Symbol.for('aiAgent.IAiNativeModelService')（Symbol.for 走全局注册表，
 * 跨 bundle 可复现）——在页面里直接调它就等于借客户端自己的登录态 + 签名网络栈：
 *   - 零 UI 点击：40 个模型从 ~6 分钟 → 约 30 秒（实测单条 RPC 仅 ~145ms）
 *   - 对 UI 改版免疫：只依赖 RPC 协议，协议比界面稳定得多
 *
 * 页面内取服务实例的实测链路（probe1-6 摸出来的唯一可行路径）：
 *   React fiber → chat 组件 context → workbench 全局 serviceCollection
 *   （437 entry，key 是 decorator 函数本体，按 key.toString() 匹配拿 entry）
 *   → instantiationService.resolveSingletonInstance 解析 IICubeAiChatModuleManager
 *   → prepareModule() → 补 _instantiationService → injectServiceCollection()
 *   → bootstrap()（这三步就是 app 打开 chat 视图时的懒初始化，幂等）
 *   → mgr._loadedModule = chat bundle 真身 ESM 实例
 *     （自己 import 会拿到全新模块实例、内部状态为空，必须用真身）
 *   → mod.default.Container.getInstance() → container.resolve(token) = ModelAPIService。
 *
 * 三个实测踩坑（新版本排查时优先对照）：
 *   ① 凭证/云连接未就绪时 RPC 挂起且返回空列表——启动后 ~35s 才就绪，
 *      求值超时必须放宽（evaluateLong 60s+），列表就绪要轮询重试；
 *   ② 成功响应 message==='success'；服务层 catch 吞错返回 {code:0,message:<异常串>}，
 *      不能把「message 非空」当成功（第一轮实测 29 个全成功却被误判失败）；
 *   ③ UI 表单 → 请求字段映射（bundle 逆向）：provider='custom_openai_compatible'、
 *      base_url=裸 base + '/chat/completions'（等价 UI 的「拼接」模式）、
 *      auth_type=0(API_KEY)、thinking_enable=0(FollowDefault)。
 */

/** 页面侧：解析 ModelAPIService 实例并挂到 window.__CCB_MODEL_SVC（只找服务，不发 RPC） */
const RPC_FIND_SERVICE = `(async function(){
	var out = {};
	var seen = new Set();
	var colls = [];
	function scanValue(v, depth) {
		if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
		seen.add(v);
		try { if (v.serviceCollection) colls.push(v.serviceCollection); } catch (e) {}
		if (depth >= 2) return;
		try {
			var ks = Object.keys(v);
			for (var j = 0; j < ks.length && j < 40; j++) scanValue(v[ks[j]], depth + 1);
		} catch (e) {}
	}
	function walkFiber(f, depth) {
		if (!f || depth > 200 || seen.size > 200000) return;
		var t = f.type;
		if (t && t._context && t._context._currentValue) scanValue(t._context._currentValue, 0);
		if (f.pendingProps && f.pendingProps.value) scanValue(f.pendingProps.value, 0);
		walkFiber(f.child, depth + 1);
		walkFiber(f.sibling, depth);
	}
	var roots = [];
	var all = document.querySelectorAll('*');
	for (var i = 0; i < all.length && roots.length < 12; i++) {
		for (var k in all[i]) {
			if (k.indexOf('__reactContainer') === 0 || k.indexOf('__reactFiber') === 0) { roots.push(all[i][k]); break; }
		}
	}
	for (var r = 0; r < roots.length; r++) walkFiber(roots[r], 0);
	var sc = colls[0] || null;
	if (!sc) return JSON.stringify({ ok: false, err: 'no-serviceCollection' });
	var ents = [];
	try { ents = Array.from(sc.getEntries()); } catch (e) { try { ents = Array.from(sc._entries); } catch (e2) {} }
	function entry(name) {
		for (var i = 0; i < ents.length; i++) {
			try { if (String(ents[i][0]) === name) return { dec: ents[i][0], val: ents[i][1] }; } catch (e) {}
		}
		return null;
	}
	var ie = entry('instantiationService');
	function resolveSvc(name) {
		var e = entry(name);
		if (!e || !e.val) return null;
		if (e.val.ctor) {
			if (ie && ie.val && typeof ie.val.resolveSingletonInstance === 'function') {
				try { return ie.val.resolveSingletonInstance(e.dec, e.val); } catch (err) { return null; }
			}
			return null;
		}
		return e.val;
	}
	var mgr = resolveSvc('IICubeAiChatModuleManager');
	if (!mgr) return JSON.stringify({ ok: false, err: 'no-module-manager' });
	var mod = null;
	try { mod = await mgr.prepareModule(); } catch (e) {}
	if (!mgr._instantiationService && ie && ie.val) mgr._instantiationService = ie.val;
	try { mgr.injectServiceCollection(); out.injected = true; } catch (e) { out.injectErr = String(e).slice(0, 150); }
	try { await mgr.bootstrap(); out.bootstrapped = !!mgr._bootstrapped; } catch (e) { out.bootstrapErr = String(e).slice(0, 150); }
	if (!mod) mod = mgr._loadedModule;
	if (!mod || !mod.default || !mod.default.Container) return JSON.stringify({ ok: false, err: 'no-chat-module', out: out });
	var c = null;
	try { c = mod.default.Container.getInstance(); } catch (e) { return JSON.stringify({ ok: false, err: 'no-container', out: out }); }
	var svc = null;
	var tries = [Symbol.for('aiAgent.IAiNativeModelService'), 'aiAgent.IAiNativeModelService'];
	for (var t = 0; t < tries.length && !svc; t++) {
		try {
			var v = c.resolve(tries[t]);
			if (v && typeof v.getModelList === 'function' && typeof v.addCustomModel === 'function') svc = v;
		} catch (e) {}
	}
	if (!svc) return JSON.stringify({ ok: false, err: 'no-model-api-service', out: out });
	window.__CCB_MODEL_SVC = svc;
	return JSON.stringify({ ok: true, out: out });
})()`;

/** 页面侧：只读拉取模型列表（custom 条目按 name|display 输出） */
const RPC_LIST = `(async function(){
	try {
		var r = await window.__CCB_MODEL_SVC.getModelList();
		var list = (r && r.model_list) || [];
		return JSON.stringify({ ok: true, total: list.length,
			custom: list.filter(function (m) { return m.provider === 'custom_openai_compatible'; })
				.map(function (m) { return (m.name || '') + '|' + (m.display_name || ''); }) });
	} catch (e) { return JSON.stringify({ ok: false, err: String(e).slice(0, 200) }); }
})()`;

/** UI 表单 → RPC 请求字段的完整映射（与客户端提交 handler 逐字段对齐，见本节注释 ③） */
const buildRpcPayload = (cfg, modelId) => ({
	provider: 'custom_openai_compatible',
	model_name: modelId,
	ak: cfg.apiKey,
	is_custom: true,
	auth_type: 0,
	base_url: String(cfg.apiBase || '').replace(/\/+$/, '') + '/chat/completions',
	config_detail: { multimodal: true, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 },
	display_name: displayNameOf(modelId),
});

/** 成功判据：code===0 且 message 为空或 'success'。
 *  服务层 catch 会吞错返回 {code:0, message:<异常字符串>}，message 非空 ≠ 成功（注释 ②）。 */
const isRpcAddSuccess = (r) => !!r && !r.err && r.code === 0 && (!r.message || r.message === 'success');

/** 等模型列表就绪：服务内部 catch 会把 RPC 失败吞成空列表（凭证/云连接未就绪的
 *  表现），轮询 + reset 重试直到拿到非空列表或超时。 */
async function rpcWaitModelList(cdp, log, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let r;
		try {
			r = JSON.parse(await cdp.evaluateLong(RPC_LIST, 60000));
		} catch (e) {
			if (Date.now() >= deadline) throw new Error(`模型列表 RPC 不可用：${e.message}`);
			await sleep(3000);
			continue;
		}
		if (r.ok && r.total > 0) return r;
		if (Date.now() >= deadline) {
			throw new Error(r.ok ? '模型列表超时未就绪（凭证/云连接没准备好）' : `getModelList 失败：${r.err || '未知原因'}`);
		}
		try { await cdp.evaluate('window.__CCB_MODEL_SVC.reset && window.__CCB_MODEL_SVC.reset()'); } catch {}
		await sleep(3000);
	}
}

/** RPC 添加单个模型（长超时：凭证未就绪时请求会挂起等待） */
async function rpcAddOne(cdp, cfg, modelId) {
	const payload = buildRpcPayload(cfg, modelId);
	const expr = `(async function(){
		try {
			var r = await window.__CCB_MODEL_SVC.addCustomModel(${JSON.stringify(payload)});
			var d = r && r.data;
			return JSON.stringify({ code: r && r.code, message: r && r.message, name: d && d.name, id: d && d.custom_model_id });
		} catch (e) { return JSON.stringify({ err: String(e).slice(0, 200) }); }
	})()`;
	return JSON.parse(await cdp.evaluateLong(expr, 75000));
}

/**
 * RPC 直调批量添加（对结构失败抛错，由调用方降级 UI 路径；单条失败不抛，进 failed）。
 * 幂等：服务端 name 形如 custom_openai_compatible//<modelId>，按 name 与展示名双重去重。
 * @returns {Promise<{added:number, skipped:number, failed:string[]}>}
 */
async function addModelsViaRpc(cdp, cfg, log, opts = {}) {
	const probe = JSON.parse(await cdp.evaluateLong(RPC_FIND_SERVICE, 90000));
	if (!probe.ok) throw new Error(`页面内找不到模型服务（${probe.err || '未知'}）`);
	log('已定位客户端内部模型服务，走 RPC 直调（无需界面操作）…');

	const ml = await rpcWaitModelList(cdp, log, opts.listTimeoutMs);
	log(`账号模型列表：共 ${ml.total} 个，其中 CCB 条目 ${(ml.custom || []).length} 个`);

	const existing = new Set(
		(ml.custom || []).flatMap((s) => {
			const [name, disp] = s.split('|');
			return [
				(name.split('//').pop() || '').trim(),
				(disp || '').trim().replace(/^CCB /, ''),
			].filter(Boolean);
		}),
	);
	const pending = cfg.models.filter((m) => !existing.has(m));
	if (!pending.length) {
		return { added: 0, skipped: cfg.models.length, failed: [] };
	}
	log(`本次需添加 ${pending.length} 个模型（跳过已有 ${cfg.models.length - pending.length} 个）`);

	let added = 0;
	const failed = [];
	for (const modelId of pending) {
		const r = await rpcAddOne(cdp, cfg, modelId);
		if (isRpcAddSuccess(r)) {
			added++;
			log(`已添加 ${displayNameOf(modelId)}（${added}/${pending.length}）`);
		} else {
			const why = r.err ? r.err : `code=${r.code} ${r.message || ''}`;
			failed.push(`${modelId}: ${why}`);
			log(`添加 ${modelId} 失败：${why}`);
		}
		await sleep(200);
	}
	return { added, skipped: cfg.models.length - pending.length, failed };
}

/* ---------- 对外入口 ---------- */

/**
 * 把 cfg.models 全部添加进 Trae 账号（跳过已存在的）
 * @param {object} opts
 * @param {string} opts.exePath   客户端可执行文件
 * @param {string[]} opts.exeNames 同产品的进程名（用于关旧实例）
 * @param {string} opts.label     日志用的产品名
 * @param {object} opts.cfg       { apiBase, apiKey, models }
 * @param {(msg:string)=>void} opts.log
 * @param {object} [opts.rpcOpts] 传给 addModelsViaRpc 的选项（如列表就绪超时）
 * @param {boolean} [opts.rpc]   置 false 可强制走 UI 点击路径（默认 RPC 优先）
 */
async function addCustomModels({ exePath, exeNames, label, cfg, log, rpcOpts, rpc }) {
	const port = await findFreePort();

	if (!(await killRunning(exeNames, log))) {
		return { ok: false, error: `请先完全退出 ${label} 后重试` };
	}

	log(`正在以调试模式启动 ${label} …`);
	launchWithDebugPort(exePath, port);

	let cdp = null;
	try {
		cdp = await Cdp.connect(port, 120000);
		const wb = await waitForWorkbench(cdp, port, label, log);
		cdp = wb.cdp; /* 等待期间可能已改连别的窗口，后续步骤要用新的连接 */
		if (wb.error) {
			return { ok: false, error: wb.error };
		}

		/* 方案 A（2026-10-10 实测）：优先页面内直调 add_custom_model RPC——零 UI 点击、
		 * 40 个模型约 30 秒配完（UI 路径要 ~6 分钟），且对 UI 改版免疫。
		 * RPC 链路依赖客户端内部结构（DI 服务 Symbol），版本不匹配/凭证迟迟不就绪时
		 * 自动降级回 UI 点击路径（下方原有流程，逐条幂等）。 */
		if (rpc !== false) {
			try {
				const r = await addModelsViaRpc(cdp, cfg, log, rpcOpts || {});
				const wanted = displayNameOf(cfg.defaultModel || cfg.models[0]);
				if (!r.added && r.failed.length) {
					return { ok: false, error: `模型未能添加：${r.failed[0]}` };
				}
				if (r.added) log(`已把 ${r.added} 个模型添加到 ${label} 账号（RPC 直调），重启后依然有效。`);
				else log('全部模型都已添加，无需重复操作。');
				await selectModel(cdp, wanted, log);
				return {
					ok: true,
					added: r.added,
					skipped: r.skipped,
					failed: r.failed.length ? r.failed : undefined,
					viaRpc: true,
				};
			} catch (e) {
				log(`RPC 直调不可用（${e.message}），改用界面点击方式…`);
			}
		}

		await openModelSettings(cdp, log);

		const existing = await readExisting(cdp);
		/* 新版设置页的表格把预置模型也列出来（TraeWork 旧版只列自定义），计数仅作参考；
		 * 跳过判断按展示名精确匹配，预置模型不会与 CCB 前缀条目撞名 */
		log(`模型管理里已有 ${existing.length} 个模型`);

		const pending = cfg.models.filter((m) => !existing.includes(displayNameOf(m)));
		const wanted = displayNameOf(cfg.defaultModel || cfg.models[0]);
		if (!pending.length) {
			log('全部模型都已添加，无需重复操作。');
			await selectModel(cdp, wanted, log);
			return { ok: true, added: 0, skipped: cfg.models.length };
		}
		log(`本次需要添加 ${pending.length} 个模型（已跳过 ${cfg.models.length - pending.length} 个）`);

		let added = 0;
		const failed = [];
		for (const modelId of pending) {
			try {
				await addOne(cdp, {
					base: cfg.apiBase.replace(/\/+$/, ''),
					modelId,
					displayName: displayNameOf(modelId),
					apiKey: cfg.apiKey,
				}, log);
				added++;
				log(`已添加 ${displayNameOf(modelId)}（${added}/${pending.length}）`);
			} catch (e) {
				failed.push(`${modelId}: ${e.message}`);
				log(`添加 ${modelId} 失败：${e.message}`);
				await cdp.pressEscape();
				await sleep(600);
			}
		}

		if (!added) {
			return { ok: false, error: `模型未能添加：${failed[0] || '未知原因'}` };
		}
		log(`已把 ${added} 个模型添加到 ${label} 账号，重启后依然有效。`);
		await selectModel(cdp, wanted, log);
		return { ok: true, added, failed };
	} finally {
		if (cdp) cdp.close();
	}
}

/** 展示名加 CCB 前缀：Trae 的模型列表里混着同名预置模型，不区分会看不懂 */
const displayNameOf = (modelId) => `CCB ${modelId}`;

module.exports = { addCustomModels, displayNameOf, findFreePort, buildFillScript, Cdp, SEL, waitFor, waitForWorkbench, waitForRect, LOGIN_VISIBLE, ENSURE_APPEND_MODE, openModelSettings, readExisting, addOne, selectModel, RPC_FIND_SERVICE, RPC_LIST, buildRpcPayload, isRpcAddSuccess, rpcWaitModelList, rpcAddOne, addModelsViaRpc };
