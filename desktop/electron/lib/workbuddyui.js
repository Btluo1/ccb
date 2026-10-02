/**
 * WorkBuddy 系「把默认模型设成 CCB」——通过 CDP 写客户端 renderer 自己的 localStorage
 *
 * 为什么必须走这条路（逐条取证）：
 *   1) models.json 只负责「把模型注册进列表」，它不决定界面默认用哪个。
 *   2) 界面上的「当前/新任务默认模型」存在 renderer 的 localStorage 里，键为
 *      `cb-newtask:model:<账号 uid>`，值形如 {"id":"custom-local:glm-5.3","isThinking":false}
 *      （逆向自 renderer 打包产物的 use-model-selector.ts：getModelKey / saveNewTaskModel /
 *      loadNewTaskModel）。没有这个键时客户端用自己的内置档位（界面显示「快速」）。
 *   3) settings.json 的 model 字段只有 CLI/headless 读，界面不读——实测写入 glm-5.3 后
 *      界面依然显示内置的「快速」，所以「一键配置」看起来生效了、实际聊天走的还是内置模型。
 *   4) localStorage 由 Chromium 自己落盘（LevelDB，运行中独占锁），外部手写既有格式风险
 *      又会被运行中的实例回写覆盖，所以必须让客户端自己写。
 *
 * 实测（WorkBuddy 5.5.6 / Windows，2026-09-24）：
 *   - `--remote-debugging-port` 可用，能连上 renderer 并求值；
 *   - 写入键值 + 刷新页面后，模型选择器从「快速」变为「glm-5.3」；
 *   - 硬杀进程（taskkill /F /T）再重启，键值仍在，说明确实落了盘。
 *
 * 约束：客户端必须已登录（uid 取自 URL 的 accountSnapshot；未登录时取不到，会明确报错）。
 * 界面结构由版本决定，选择器集中在下面的常量里，便于版本变更时修。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Cdp, findFreePort } = require('./traeui');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 界面 / 存储常量 ---------- */

/** 模型选择器触发器（实测自 WorkBuddy 5.5.6 的 renderer） */
const SELECTOR = '.cr-model-selector__trigger';
/** 「新任务默认模型」在 localStorage 里的键前缀，后面接账号 uid */
const CHOICE_KEY_PREFIX = 'cb-newtask:model:';
/** 自定义模型在客户端内部的 id 前缀（productFeatures.CustomModelIdPrefix 打开时由客户端自己加） */
const CUSTOM_LOCAL_PREFIX = 'custom-local:';

/* ---------- 页面脚本 ---------- */

/** 从 URL 的 accountSnapshot 里取账号 uid；未登录时返回 null */
const UID_SCRIPT = `(function(){
	var m=/accountSnapshot=([^&]+)/.exec(location.search);
	if(!m) return null;
	try{ return JSON.parse(decodeURIComponent(decodeURIComponent(m[1]))).uid || null }catch(e){ return null }
})()`;

/** 主界面是否已经渲染出内容（刷新期间会短暂求值失败，由 waitFor 吞掉） */
const READY_SCRIPT = `document.readyState === 'complete' && (document.body.innerText||'').trim().length > 0`;

/** 枚举 localStorage 里所有「新任务默认模型」键。
 *  账号 uid 是键的一部分：换号/重登后客户端只读新账号的键，旧键全部失明，
 *  界面会静默回落到客户端内置模型——用户看到的就是「一键配置后不生效」。 */
const LIST_KEYS_SCRIPT = `(function(){
	try{
		var out=[];
		for(var i=0;i<localStorage.length;i++){
			var k=localStorage.key(i);
			if(k && k.indexOf(${JSON.stringify(CHOICE_KEY_PREFIX)})===0) out.push(k);
		}
		return JSON.stringify(out);
	}catch(e){ return 'ERR:'+(e&&e.message) }
})()`;

/** 模型选择器当前显示的文字。
 *  首选实测的固定选择器；拿不到时退而扫描 class 含 model-select 的元素——
 *  首页等视图里选择器的挂载点和聊天视图不同，单一选择器会漏（实测读到空）。 */
const TRIGGER_TEXT = `(function(){
	var read=function(t){ return t ? (t.innerText||'').trim() : '' };
	var s=read(document.querySelector(${JSON.stringify(SELECTOR)}));
	if(s) return s;
	var els=document.querySelectorAll('button,[role=button],div,span');
	for(var i=0;i<els.length;i++){
		var cls='';
		try{ cls=els[i].className&&els[i].className.toString?els[i].className.toString():'' }catch(e){}
		if(/model-select/i.test(cls)){
			var v=read(els[i]);
			if(v) return v;
		}
	}
	return '';
})()`;

/**
 * 写入「新任务默认模型」的脚本。
 * 值一律走 JSON.stringify，避免模型名里的引号/反斜杠把脚本拼坏。
 */
function buildChoiceScript(key, modelId) {
	return `(function(){
		try{
			localStorage.setItem(${JSON.stringify(key)}, JSON.stringify({id:${JSON.stringify(modelId)},isThinking:false}));
			return localStorage.getItem(${JSON.stringify(key)});
		}catch(e){ return 'ERR:'+(e&&e.message) }
	})()`;
}

/** 读取「新任务默认模型」当前值；键不存在时返回 null */
function buildReadScript(key) {
	return `(function(){
		try{ return localStorage.getItem(${JSON.stringify(key)}) }catch(e){ return 'ERR:'+(e&&e.message) }
	})()`;
}

/** 把「新任务默认模型」写成一段原始字符串（回滚用，值来自写入前的快照） */
function buildRawSetScript(key, raw) {
	return `(function(){
		try{ localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(raw)}); return 'OK' }catch(e){ return 'ERR:'+(e&&e.message) }
	})()`;
}

/** 删除「新任务默认模型」键，让客户端回到自己的内置档位（回滚用） */
function buildRemoveScript(key) {
	return `(function(){
		try{ localStorage.removeItem(${JSON.stringify(key)}); return 'OK' }catch(e){ return 'ERR:'+(e&&e.message) }
	})()`;
}

/**
 * 客户端内部看到的模型 id 候选。
 * 第一个（带 custom-local: 前缀）是实证格式：客户端保存自定义模型选择时就带它
 * （逆向 use-model-selector.ts + 写入后硬杀重启键值仍在）。裸 id 只是国际版可能
 * 未开 CustomModelIdPrefix 时的备选，且**只在界面明确显示了别的模型**时才启用
 * （见 selectDefaultModel：界面读不到选择器时绝不能换候选）。
 */
function modelIdCandidates(modelId) {
	const bare = String(modelId || '').replace(/^custom-local:/, '');
	return [CUSTOM_LOCAL_PREFIX + bare, bare];
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
 * 刷新页面并读回模型选择器上的文字。
 *
 * 必须用「打标记」的方式判断新文档是否接管：Page.reload 之后旧文档会短暂继续应答，
 * 直接查选择器会读到刷新前的旧值（曾因此把「没生效」误判成生效）。
 */
async function reloadAndRead(cdp) {
	try {
		await cdp.evaluate('(window.__ccbMark = 1, 1)');
	} catch {}
	await cdp.send('Page.reload', {});
	await waitFor(cdp, `typeof window.__ccbMark === 'undefined'`, 60000, '页面刷新');
	await waitFor(cdp, READY_SCRIPT, 90000, '主界面（刷新后）');
	/* 模型目录是异步拉的，选择器要等目录回来才会显示自定义模型名（实测要好几秒），
	 * 轮询到有文字为止；到超时仍是空串说明当前视图压根没有选择器 */
	const deadline = Date.now() + 15000;
	for (;;) {
		const text = (await cdp.evaluate(TRIGGER_TEXT)) || '';
		if (text) return text;
		if (Date.now() >= deadline) return '';
		await sleep(800);
	}
}

/** 汇总要写入的键：当前账号 + localStorage 里已有的账号（历史上登录并选过模型）+
 *  调用方从账号数据目录发现的账号。去重保序。 */
function collectChoiceKeys(uid, listedKeys, extraUids) {
	const keys = new Set([CHOICE_KEY_PREFIX + uid]);
	for (const k of listedKeys || []) {
		if (typeof k === 'string' && k.startsWith(CHOICE_KEY_PREFIX)) keys.add(k);
	}
	for (const u of extraUids || []) {
		if (typeof u === 'string' && u) keys.add(u.startsWith(CHOICE_KEY_PREFIX) ? u : CHOICE_KEY_PREFIX + u);
	}
	return [...keys];
}

/**
 * 让 WorkBuddy 把「新任务默认模型」设成我们的模型。
 *
 * 注意：本函数会以调试模式启动客户端，且**不负责关掉它**——调用方写完配置后会立刻把
 * 这个调试实例关掉（调试端口开着时本机任何进程都能接入并读取客户端凭据）。
 *
 * 默认模型键按账号 uid 存（cb-newtask:model:<uid>）。只写当前账号的话，用户换号/重登后
 * 新账号没有键，界面静默回落到内置模型（实测：账号从 A 换到 B 后聊天全部走平台模型）。
 * 所以这里为「当前账号 + localStorage 里出现过的账号 + extraUids」一次写全。
 *
 * @param {object} opts
 * @param {string} opts.exePath 客户端可执行文件
 * @param {string} opts.modelId 目标模型（models.json 里的 id，不带 custom-local: 前缀）
 * @param {string} [opts.label] 日志用的产品名
 * @param {string[]} [opts.extraUids] 额外要覆盖的账号 uid（来自客户端的账号数据目录）
 * @param {(msg:string)=>void} opts.log
 * @returns {Promise<{ok:boolean, error?:string, model?:string, unverified?:boolean,
 *                    entries?:Array<{key:string, value:string|null}>}>}
 *          entries 是各键写入前的原始值（键不存在则为 null），供回滚精确还原。
 */
async function selectDefaultModel({ exePath, modelId, label, log, extraUids }) {
	const name = label || 'WorkBuddy';
	const port = await findFreePort();

	log(`正在以调试模式启动 ${name}，把界面上的默认模型设为 CCB 的…`);
	launchWithDebugPort(exePath, port);

	let cdp = null;
	try {
		cdp = await Cdp.connect(port, 120000);
		await waitFor(cdp, READY_SCRIPT, 120000, '主界面');

		const uid = await cdp.evaluate(UID_SCRIPT);
		if (!uid) {
			return { ok: false, error: `读不到 ${name} 的账号信息，请先在 ${name} 里登录，再点一次一键配置` };
		}

		const listed = await cdp.evaluate(LIST_KEYS_SCRIPT);
		if (typeof listed === 'string' && listed.startsWith('ERR:')) {
			return { ok: false, error: `枚举 ${name} 已有默认模型键失败：${listed.slice(4)}` };
		}
		let listedKeys = [];
		try { listedKeys = JSON.parse(String(listed || '[]')); } catch {}
		const keyList = collectChoiceKeys(uid, listedKeys, extraUids);

		/* 写入前先留快照：回滚要能把用户原本选的模型放回去（原本没有这个键就删掉） */
		const entries = [];
		for (const key of keyList) {
			const prev = await cdp.evaluate(buildReadScript(key));
			if (typeof prev === 'string' && prev.startsWith('ERR:')) {
				return { ok: false, error: `读取 ${name} 现有默认模型失败：${prev.slice(4)}`, entries };
			}
			entries.push({ key, value: prev == null ? null : String(prev) });
		}
		if (keyList.length > 1) {
			log(`检测到 ${keyList.length} 个在本机登录过的账号，已为每个账号都写入默认模型（换号后依然生效）。`);
		}

		const candidates = modelIdCandidates(modelId);
		let shown = '';
		for (let i = 0; i < candidates.length; i++) {
			let failed = null;
			for (const key of keyList) {
				const written = await cdp.evaluate(buildChoiceScript(key, candidates[i]));
				if (typeof written === 'string' && written.startsWith('ERR:')) {
					failed = `写入默认模型失败：${written.slice(4)}`;
					break;
				}
			}
			if (failed) return { ok: false, error: failed, entries };
			shown = await reloadAndRead(cdp);
			if (shown && shown.includes(candidates[i].replace(CUSTOM_LOCAL_PREFIX, ''))) {
				log(`默认模型已生效：${name} 当前使用「${shown}」`);
				return { ok: true, model: shown, entries };
			}
			/* 界面上看不到选择器（首页等视图没有）→ 没法从界面确认，但写入本身已成功。
			 * 必须停在第一个候选：带 custom-local: 前缀才是客户端自己保存自定义模型的格式
			 * （逆向 use-model-selector.ts + 重启落盘实测），换成裸 id 反而把值改错。 */
			if (!shown) {
				return { ok: true, model: '', unverified: true, entries };
			}
			if (i === 0) log(`界面显示的是「${shown}」，改用不带前缀的模型名再试一次…`);
		}
		/* 两种格式都没能让界面显示我们的模型 → 退回第一种（有实证的格式），标记未确认 */
		for (const key of keyList) {
			await cdp.evaluate(buildChoiceScript(key, candidates[0]));
		}
		return { ok: true, model: shown, unverified: true, entries };
	} catch (e) {
		return { ok: false, error: e.message || String(e) };
	} finally {
		if (cdp) cdp.close();
	}
}

/**
 * 回滚：把「新任务默认模型」还原成写入前的快照（键原本不存在则删除）。
 *
 * 与写入一样只能让客户端自己写 localStorage，所以会以调试模式启动一次；
 * 调用方负责随后关掉这个调试实例。快照里带了完整的键名（含账号 uid），
 * 因此不需要用户重新登录也能还原。
 *
 * @param {object} opts
 * @param {string} opts.exePath
 * @param {Array<{key:string, value:string|null}>} opts.entries 写入时留下的快照
 * @param {string} [opts.label]
 * @param {(msg:string)=>void} opts.log
 */
async function restoreDefaultModel({ exePath, entries, label, log }) {
	const name = label || 'WorkBuddy';
	const list = (entries || []).filter((e) => e && typeof e.key === 'string' && e.key);
	if (!list.length) return { ok: true, skipped: true };

	const port = await findFreePort();
	log(`正在以调试模式启动 ${name}，还原界面上的默认模型…`);
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
		log('界面默认模型已还原。');
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
	buildChoiceScript,
	buildReadScript,
	buildRawSetScript,
	buildRemoveScript,
	modelIdCandidates,
	collectChoiceKeys,
	UID_SCRIPT,
	READY_SCRIPT,
	TRIGGER_TEXT,
	LIST_KEYS_SCRIPT,
	SELECTOR,
	CHOICE_KEY_PREFIX,
	CUSTOM_LOCAL_PREFIX,
};