/**
 * ZCode「把默认模型设成 CCB」——通过 CDP 写客户端 renderer 自己的 localStorage
 *
 * 为什么必须走这条路（逐条取证，2026-09-24 实测 ZCode Windows 桌面版）：
 *   1) ~/.zcode/v2/config.json 的 provider.ccb 只负责「把供应商与模型注册进列表」；
 *      ~/.zcode/cli/config.json 的 model 字段是 CLI 的当前模型，GUI 不读。
 *   2) GUI 的当前模型存在 renderer 的 localStorage，键为
 *      `zcode-last-agent-config:<agent>:<scope>`（当前只有 glm:__global__ 一个），
 *      值形如 {"schemaVersion":1,"model":"custom:<providerId>:<modelId>","thoughtLevel":null}。
 *      实测：只写文件时界面仍显示用户旧供应商（如「中转1/glm-5.3」），聊天走旧供应商；
 *      写该键 + 刷新后界面弹出「模型已切换 … → CCB/glm-5.3」，聊天走 CCB。
 *   3) localStorage 由 Chromium 自己落盘（LevelDB，运行中独占锁），外部手写既有格式
 *      风险又会被运行中的实例回写覆盖，所以必须让客户端自己写。
 *
 * 约束：无需登录（键名不含账号）。界面结构由版本决定，选择器集中在常量里便于修。
 */

const path = require('path');
const { Cdp, findFreePort } = require('./traeui');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 界面 / 存储常量 ---------- */

/** 「上次选中模型」在 localStorage 里的键前缀，后接 <agent>:<scope> */
const CONFIG_KEY_PREFIX = 'zcode-last-agent-config:';
/** 聊天输入框（会话视图打开时才存在；ZCode 重启会自动恢复上次会话） */
const COMPOSER_SELECTOR = '[data-testid="v4-composer-input"]';

/* ---------- 页面脚本 ---------- */

const READY_SCRIPT = `document.readyState === 'complete' && (document.body.innerText||'').trim().length > 0`;

/** 枚举全部 agent-config 键及其当前值（快照用） */
const SNAPSHOT_SCRIPT = `(function(){
	try{
		var out=[];
		for(var i=0;i<localStorage.length;i++){
			var k=localStorage.key(i);
			if(k && k.indexOf(${JSON.stringify(CONFIG_KEY_PREFIX)})===0){
				out.push({key:k,value:localStorage.getItem(k)});
			}
		}
		return JSON.stringify(out);
	}catch(e){ return 'ERR:'+(e&&e.message) }
})()`;

/** 把全部 agent-config 键写成我们的模型引用，返回写入后的首键值 */
function buildWriteScript(providerId, modelId) {
	return `(function(){
		try{
			var ref='custom:'+${JSON.stringify(providerId)}+':'+${JSON.stringify(modelId)};
			var first=null;
			for(var i=0;i<localStorage.length;i++){
				var k=localStorage.key(i);
				if(k && k.indexOf(${JSON.stringify(CONFIG_KEY_PREFIX)})===0){
					var v=JSON.stringify({schemaVersion:1,model:ref,thoughtLevel:null});
					localStorage.setItem(k,v);
					if(first===null) first=localStorage.getItem(k);
				}
			}
			if(first===null) return 'NOKEY';
			return first;
		}catch(e){ return 'ERR:'+(e&&e.message) }
	})()`;
}

/** 模型指示器当前显示的文字（composer 附近形如「CCB/glm-5.3」） */
const INDICATOR_SCRIPT = `(function(){
	try{
		var els=document.querySelectorAll('button,[role=button],div,span');
		for(var i=0;i<els.length;i++){
			var v=(els[i].innerText||'').trim();
			if(v && v.length<40 && /\\//.test(v) && /glm|gpt|claude|deepseek|qwen|kimi|grok/i.test(v) && els[i].offsetWidth){
				return v;
			}
		}
		return '';
	}catch(e){ return '' }
})()`;

/** 读回指定键的原始值 */
function buildReadScript(key) {
	return `(function(){ try{ return localStorage.getItem(${JSON.stringify(key)}) }catch(e){ return 'ERR:'+(e&&e.message) } })()`;
}

/** 把键写成一段原始字符串（回滚用，值来自写入前的快照） */
function buildRawSetScript(key, raw) {
	return `(function(){ try{ localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(raw)}); return 'OK' }catch(e){ return 'ERR:'+(e&&e.message) } })()`;
}

/** 删除键（键原本不存在时回滚用） */
function buildRemoveScript(key) {
	return `(function(){ try{ localStorage.removeItem(${JSON.stringify(key)}); return 'OK' }catch(e){ return 'ERR:'+(e&&e.message) } })()`;
}

/* ---------- 驱动 ---------- */

function launchWithDebugPort(exePath, port) {
	const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
		detached: true,
		stdio: 'ignore',
		cwd: path.dirname(exePath),
		env: process.env,
	});
	child.unref();
}

/** 轮询求值；页面正在导航时求值会失败，按「还没好」处理，不算错误 */
async function waitFor(cdp, expr, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await cdp.evaluate(expr)) return true;
		} catch {}
		if (Date.now() >= deadline) throw new Error(`等待「${what}」超时`);
		await sleep(500);
	}
}

/**
 * 让 ZCode 把「当前模型」设成 CCB 的模型。
 *
 * 与 WorkBuddy 同理：以调试模式启动客户端、让 renderer 自己写 localStorage、随后由
 * 调用方关掉调试实例（调试端口开着时本机任何进程都能接入，不能留在用户机器上）。
 *
 * @param {object} opts
 * @param {string} opts.exePath 客户端可执行文件
 * @param {string} opts.providerId 供应商 id（v2/config.json 里的 key，本产品恒为 ccb）
 * @param {string} opts.modelId 目标模型 id（不带前缀）
 * @param {string} [opts.label] 日志用的产品名
 * @param {(msg:string)=>void} opts.log
 * @returns {Promise<{ok:boolean, error?:string, model?:string, unverified?:boolean,
 *                    entries?:Array<{key:string, value:string|null}>}>}
 *          entries 是写入前各键的原始值（键不存在则为 null），供回滚精确还原。
 */
async function selectDefaultModel({ exePath, providerId, modelId, label, log }) {
	const name = label || 'ZCode';
	const port = await findFreePort();

	log(`正在以调试模式启动 ${name}，把界面上的当前模型设为 CCB 的…`);
	launchWithDebugPort(exePath, port);

	let cdp = null;
	try {
		cdp = await Cdp.connect(port, 120000);
		await waitFor(cdp, READY_SCRIPT, 120000, '主界面');

		/* 写入前快照：回滚要把用户原本选的模型放回去（键不存在就删掉） */
		const snap = await cdp.evaluate(SNAPSHOT_SCRIPT);
		if (typeof snap !== 'string' || snap.startsWith('ERR:')) {
			return { ok: false, error: `读取 ${name} 现有模型选择失败` };
		}
		let entries = [];
		try {
			const parsed = JSON.parse(snap);
			if (Array.isArray(parsed)) entries = parsed;
		} catch {}

		const written = await cdp.evaluate(buildWriteScript(providerId, modelId));
		if (written === 'NOKEY') {
			/* 从没用过 ZCode 的模型选择：没有可写的键，客户端发新消息时会用 cli/config.json
			 * 的 model（我们已写为 ccb/<model>），这里补一个全局键保证 GUI 也用上 */
			const seeded = await cdp.evaluate(buildRawSetScript(CONFIG_KEY_PREFIX + 'glm:__global__', JSON.stringify({ schemaVersion: 1, model: `custom:${providerId}:${modelId}`, thoughtLevel: null })));
			if (typeof seeded === 'string' && seeded.startsWith('ERR:')) {
				return { ok: false, error: `写入默认模型失败：${seeded.slice(4)}`, entries: [] };
			}
			entries.push({ key: CONFIG_KEY_PREFIX + 'glm:__global__', value: null });
		} else if (typeof written !== 'string' || written.startsWith('ERR:')) {
			return { ok: false, error: `写入默认模型失败：${String(written).slice(4)}`, entries };
		}

		/* 刷新让界面按新值重渲染，然后从界面确认 */
		try {
			await cdp.evaluate('(window.__ccbMark = 1, 1)');
		} catch {}
		await cdp.send('Page.reload', {});
		await waitFor(cdp, `typeof window.__ccbMark === 'undefined'`, 60000, '页面刷新');
		await waitFor(cdp, READY_SCRIPT, 90000, '主界面（刷新后）');

		/* 会话视图（composer）打开时轮询读模型指示器；没有会话视图就无法直观确认 */
		let verified = false;
		let shown = '';
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const hasComposer = await cdp.evaluate(`!!document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})`).catch(() => false);
			if (hasComposer) {
				shown = (await cdp.evaluate(INDICATOR_SCRIPT)) || '';
				if (shown) break;
			} else {
				shown = '';
			}
			await sleep(1000);
		}
		if (shown && shown.includes(modelId)) {
			log(`默认模型已生效：${name} 当前使用「${shown}」`);
			return { ok: true, model: shown, entries };
		}
		/* 指示器读不到（没恢复出会话视图等）：localStorage 值是权威的（下次发消息即生效），
		 * 再读回确认一次 */
		const back = entries.length
			? await cdp.evaluate(buildReadScript(entries[0].key))
			: await cdp.evaluate(buildReadScript(CONFIG_KEY_PREFIX + 'glm:__global__'));
		const ok = typeof back === 'string' && back.includes(modelId);
		if (ok) log('默认模型已写入（当前界面没有会话视图，未能直观确认），打开客户端发一条消息即可验证。');
		return { ok, model: ok ? '' : shown, unverified: true, entries };
	} catch (e) {
		return { ok: false, error: e.message || String(e) };
	} finally {
		if (cdp) cdp.close();
	}
}

/**
 * 回滚：把模型选择还原成写入前的快照（键原本不存在则删除）。
 * @param {object} opts
 * @param {string} opts.exePath
 * @param {Array<{key:string, value:string|null}>} opts.entries 写入时留下的快照
 * @param {string} [opts.label]
 * @param {(msg:string)=>void} opts.log
 */
async function restoreDefaultModel({ exePath, entries, label, log }) {
	const name = label || 'ZCode';
	const list = (entries || []).filter((e) => e && typeof e.key === 'string' && e.key.startsWith(CONFIG_KEY_PREFIX));
	if (!list.length) return { ok: true, skipped: true };

	const port = await findFreePort();
	log(`正在以调试模式启动 ${name}，还原界面上的当前模型…`);
	launchWithDebugPort(exePath, port);

	let cdp = null;
	try {
		cdp = await Cdp.connect(port, 120000);
		await waitFor(cdp, READY_SCRIPT, 120000, '主界面');
		for (const e of list) {
			const script = e.value == null ? buildRemoveScript(e.key) : buildRawSetScript(e.key, e.value);
			const out = await cdp.evaluate(script);
			if (typeof out === 'string' && out.startsWith('ERR:')) {
				return { ok: false, error: `还原界面默认模型失败：${out.slice(4)}` };
			}
		}
		log('界面当前模型已还原。');
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e.message || String(e) };
	} finally {
		if (cdp) cdp.close();
	}
}

module.exports = {
	selectDefaultModel,
	restoreDefaultModel,
	buildWriteScript,
	buildReadScript,
	buildRawSetScript,
	buildRemoveScript,
	CONFIG_KEY_PREFIX,
	COMPOSER_SELECTOR,
	INDICATOR_SCRIPT,
	SNAPSHOT_SCRIPT,
};
