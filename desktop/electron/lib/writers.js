const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { webcrypto } = require('node:crypto');
const { getClient, regQueryUserEnv, APPDATA } = require('./clients');
const { runningAmong } = require('./proc');
const { findLaunchExe, stopClient } = require('./launcher');
const { addCustomModels } = require('./traeui');
/* 两个 UI 驱动模块同名导出，按客户端分路导入：WorkBuddy 系走 workbuddyui
 * （cb-newtask:model:<uid> 键、需登录取 uid），ZCode 走 zcodeui
 * （zcode-last-agent-config:<agent>:<scope> 键、无需登录）。接错线会把 A 产品的
 * localStorage 键写进 B 产品，界面默认模型静默不生效。 */
const {
	selectDefaultModel: selectWorkBuddyModel,
	restoreDefaultModel: restoreWorkBuddyModel,
} = require('./workbuddyui');
const {
	selectDefaultModel: selectZCodeModel,
	restoreDefaultModel: restoreZCodeModel,
} = require('./zcodeui');
const vscdb = require('./vscdb');
const { ensureQoderWorkBridge, removeQoderWorkBridge } = require('./qoderbridge');

const HOME = os.homedir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* CCB 托管条目的统一标识：写入各客户端后，靠它识别并清理上一轮写入的内容 */
const CCB_LABEL = 'CCB';

function readText(file) {
	return fs.readFileSync(file, 'utf8');
}

function writeText(file, content) {
	fs.writeFileSync(file, content, { encoding: 'utf8' });
}

function backup(file, log) {
	if (fs.existsSync(file)) {
		fs.copyFileSync(file, file + '.bak');
		log(`已备份 ${file} → ${path.basename(file)}.bak`);
		return true;
	}
	return false;
}

/** 从 .bak 恢复；无备份返回 false */
function restoreBackup(file, log) {
	const bak = file + '.bak';
	if (!fs.existsSync(bak)) return false;
	fs.copyFileSync(bak, file);
	log(`已恢复 ${file}`);
	return true;
}

/** 仅当尚无备份时才备份：保证 .bak 始终是「首次写入前」的原始状态，
 *  避免二次写入把已含 CCB 内容的快照覆盖上去，导致回滚不干净 */
function backupOnce(file, log) {
	if (!fs.existsSync(file)) return false;
	const bak = file + '.bak';
	if (fs.existsSync(bak)) return false;
	fs.copyFileSync(file, bak);
	log(`已备份 ${path.basename(file)} → ${path.basename(bak)}`);
	return true;
}

/* ---------- WorkBuddy / CodeBuddy（本地自定义模型 models.json） ----------
 * 腾讯系产品共用一套本地自定义模型机制：把模型写进用户主目录下的 models.json。
 * 读取路径（逆向自 app 内 main/module-base.js 的 getUserConfigPath）：
 *   产品名含 "workbuddy" → ~/.workbuddy/models.json
 *   否则（CodeBuddy 系） → ~/.codebuddy/models.json
 * WorkBuddy AI（国际版）用 product.json 的 customUserDataDir=.workbuddy-ai 覆盖为
 *   ~/.workbuddy-ai/models.json（对应 clients.js 里各自的 configDirs）。
 * models.json 支持顶层数组或 { models, availableModels }；模型项必填 id，
 * 可选 name/vendor/url/apiKey/maxInputTokens/maxOutputTokens/supportsToolCall 等；
 * 客户端读取时会自动补 tags:["custom"] 与 disabled:false，apiKey 明文存储。
 * 默认模型：CLI/headless 读 settings.json 的 model 字段（实测为裸 id，
 * 不带 custom-local: 前缀；客户端的白名单过滤会自行剥离该前缀）。
 */
function workbuddyModelEntries(cfg) {
	const chatUrl = cfg.apiBase.replace(/\/+$/, '') + '/chat/completions';
	return cfg.models.map((id) => ({
		id, name: id, vendor: 'CCB', url: chatUrl, apiKey: cfg.apiKey,
		maxInputTokens: 128000, maxOutputTokens: 8192,
		supportsToolCall: true, supportsImages: true,
		/* 客户端按模型 id 去匹配内置模型目录（enrichLanguageModelFromCatalog），撞名的模型
		 * （如 glm-5.3，目录里 thinkingLevelMap.off=null）会被归并成「不可关思考」，
		 * 用户一关深度思考就 REFUSAL「Current model does not support disabling thinking」。
		 * 显式声明 canDisableThinking=true 后该归并不再覆盖，关思考被放行
		 * （请求体不会附加思考参数，走上游默认行为）。 */
		reasoning: { canDisableThinking: true },
		/* 撞名 glm 目录条目还会继承 thinkingFormat:"zai"（请求管线 pickEntry 按 provider
		 * 优先级表命中 zai），开思考时会附加 thinking.clear_thinking 字段，GLM 上游直接
		 * 400「未知请求字段：thinking.clear_thinking」。条目自带 compat 可覆盖目录值：
		 * 改成 deepseek 格式后开思考发 thinking:{type:"enabled"}（reasoning_effort 档位
		 * 可共存，均实测 200）；关思考因继续继承目录 thinkingLevelMap.off=null 而不发
		 * 任何思考字段，同样 200（glm-5.3 上游已强制开思考，发 {type:"disabled"} 反而
		 * 400「当前模型必须开启深度思考」，故必须依赖 off=null 的「不发字段」路径）。
		 * 仅 glm 系覆盖：其他撞名模型（qwen/deepseek/kimi 等）维持目录原生格式，
		 * 避免破坏其上游真正接受的思考字段。 */
		...(id.startsWith('glm') ? { compat: { thinkingFormat: 'deepseek' } } : {}),
	}));
}

/** 写入单个配置目录的 models.json（保留用户自有模型，仅替换 CCB 条目）
 *
 *  格式必须按产品区分（实测）：
 *    - WorkBuddy 客户端自己用**顶层数组**重写 models.json，若我们写 `{models, availableModels}`
 *      这种对象形态，它读不出来，启动后会把整个文件替换成自己的空数组 `[]`（CCB 模型全丢）。
 *      改成顶层数组后实测存活。
 *    - CodeBuddy 保持对象形态即可（实测启动后未被改动）。
 */
function writeModelsJson(dir, cfg, log, asArray) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'models.json');
	let keep = [];
	if (fs.existsSync(file)) {
		/* 用 backupOnce：二次写入不得覆盖首次写入前的快照，否则回滚会把 CCB 条目还原回来 */
		backupOnce(file, log);
		try {
			const data = JSON.parse(readText(file));
			const arr = Array.isArray(data) ? data : data && Array.isArray(data.models) ? data.models : [];
			keep = arr.filter((m) => m && m.vendor !== 'CCB');
		} catch {
			log(`警告：${file} 解析失败，将覆盖写入（原文件已备份）`);
		}
	}
	const newModels = workbuddyModelEntries(cfg);
	const all = [...keep, ...newModels];
	const payload = asArray ? all : { models: all, availableModels: all.map((m) => m.id) };
	writeText(file, JSON.stringify(payload, null, 2));
	log(`已写入 ${file}（共 ${all.length} 个模型，其中 CCB ${newModels.length} 个）`);
}

/** 把默认模型写进 settings.json 的 model 字段（保留其余字段，如用户自己的 env 密钥） */
function writeDefaultModelField(dir, model, log) {
	const file = path.join(dir, 'settings.json');
	let data = {};
	if (fs.existsSync(file)) {
		backupOnce(file, log);
		try {
			data = JSON.parse(readText(file));
		} catch {
			log(`警告：${file} 解析失败，跳过默认模型写入（原文件已备份）`);
			return;
		}
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
	data.model = model;
	writeText(file, JSON.stringify(data, null, 2));
	log(`已将 ${path.basename(dir)}/settings.json 的默认模型设为 ${model}`);
}

/* 界面默认模型（localStorage）的原始值快照。文件名带 ccb 前缀，便于识别与清理。 */
const GUI_SNAPSHOT_FILES = {
	workbuddy: 'ccb-workbuddy-gui.json',
	zcode: 'ccb-zcode-gui.json',
};

/** 记下界面默认模型的原始值供回滚用。
 *  已记过的键不覆盖（与 backupOnce 同理）：二次写入时键里已是我们自己写的 CCB 模型，
 *  覆盖上去回滚就还原不回用户原本的选择了。多账号场景下新触达的键要补进快照，
 *  否则后来换的账号永远还原不掉。 */
function saveGuiChoice(dirs, fileName, entries, log) {
	for (const dir of dirs) {
		const file = path.join(dir, fileName);
		let existing = [];
		if (fs.existsSync(file)) {
			try {
				const d = JSON.parse(readText(file));
				if (d && Array.isArray(d.entries)) existing = d.entries;
			} catch { /* 解析失败按无快照处理，整体重建 */ }
		}
		const known = new Set(existing.map((e) => e && e.key).filter(Boolean));
		const merged = existing.concat((entries || []).filter((e) => e && e.key && !known.has(e.key)));
		if (merged.length === existing.length) continue;
		try {
			fs.mkdirSync(dir, { recursive: true });
			writeText(file, JSON.stringify({ entries: merged }, null, 2));
			log('已记下界面默认模型的原始值（回滚用）');
		} catch (e) {
			log(`警告：界面默认模型快照保存失败：${e.message}`);
		}
	}
}

/** 读取界面默认模型快照；返回 { entries, file }（无快照时 entries 为空数组） */
function loadGuiChoice(dirs, fileName, log) {
	const entries = [];
	const files = [];
	for (const dir of dirs) {
		const file = path.join(dir, fileName);
		if (!fs.existsSync(file)) continue;
		files.push(file);
		try {
			const d = JSON.parse(readText(file));
			if (d && Array.isArray(d.entries)) entries.push(...d.entries);
		} catch {
			log(`警告：${fileName} 解析失败，界面默认模型未还原`);
		}
	}
	return { entries, files };
}

/* 客户端按账号存数据的目录名是账号 uid（UUID）。默认模型键带 uid，换号后旧键失明，
 * 所以除了当前登录账号，把这些历史账号也一并写入，配置才能扛得住换号/重登。 */
const ACCOUNT_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountUidsUnder(dir) {
	try {
		return fs.readdirSync(dir).filter((n) => ACCOUNT_DIR_RE.test(n));
	} catch {
		return [];
	}
}

async function writeWorkBuddy(cfg, log, client, detected) {
	const dirs = (client && client.configDirs) || [];
	if (!dirs.length) return { ok: false, error: '未找到 WorkBuddy 配置目录' };
	for (const dir of dirs) writeModelsJson(dir, cfg, log, true);
	const model = cfg.defaultModel || cfg.models[0];
	for (const dir of dirs) writeDefaultModelField(dir, model, log);

	/* models.json 只负责「把模型登记进列表」，界面默认用哪个模型由客户端自己存在 renderer 的
	 * localStorage 里（settings.json 的 model 只有 CLI/headless 读）。不驱动界面的话，
	 * 一键配置看起来成功、聊天实际还走内置模型——这正是「配置后没效果」的根因。
	 * 取证与实现见 workbuddyui.js。 */
	const exe = findLaunchExe(client, detected);
	if (!exe) {
		log('未找到程序位置，无法自动设置界面默认模型。请点「详情」手动选择路径后重新配置。');
		log('完成。模型已写入，打开客户端后在模型列表里选带 CCB 的模型即可。');
		return { ok: true };
	}

	const extraUids = [...new Set(dirs.flatMap((d) => accountUidsUnder(d)))];
	const r = await selectWorkBuddyModel({ exePath: exe, modelId: model, label: client.name, log, extraUids });
	if (r.entries && r.entries.length) saveGuiChoice(dirs, GUI_SNAPSHOT_FILES.workbuddy, r.entries, log);

	/* selectDefaultModel 为了写 localStorage 会把客户端以「调试端口」方式拉起来。调试端口开着时
	 * 本机任何进程都能接入并读取客户端内的凭据，所以注入完立刻关掉：一键配置随后会正常
	 * 重新启动它，单点「重新写入配置」也不会在用户机器上留一个带调试端口的实例。
	 * 等待一小会儿是为了让 Chromium 把 localStorage 落盘（实测硬杀后仍存活，这里只是留余量）。 */
	await sleep(800);
	await stopClient(client);

	if (!r.ok) {
		/* 模型列表已经写好了，只是界面默认模型没设上（多数是还没登录，取不到账号 uid），
		 * 所以不算配置失败，但必须让用户知道还差一步。 */
		log(r.error);
		log('完成。模型已写入，但界面默认模型未能自动设置。');
		return { ok: true, warning: r.error };
	}
	if (r.unverified) log('界面默认模型已写入（当前界面看不到模型选择器，未能直观确认），打开客户端发一条消息即可验证。');
	log('完成。已写入全部模型与默认模型，点「启动 / 重启」打开即可使用。');
	return { ok: true };
}

/* CodeBuddy（VS Code 分支 IDE）的当前选中模型缓存在 state.vscdb 的
 * Tencent-Cloud.coding-copilot 里（字段 chatSelectedModelMapV2，模式 → modelId）。
 * 逐条取证（逆向 F:\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js）：
 *   - chatSelectedModelMapV2 / chatSelectedMode / chatModelThinkingMap 都在
 *     ConfigServiceImpl 的 WorkspaceStateKeys 里，读写走 extensionContext.workspaceState
 *     —— 即**每个工作区自己的** state.vscdb（User\workspaceStorage\<hash>\state.vscdb）。
 *     全局库里只有已废弃的 chatSelectedModelGlobalMap（GlobalStateClean 的清理对象），
 *     写全局库没有任何效果。
 *   - 发消息时 resolveCurrentModelId 先读会话自己的选择，新会话没有才回落到该 map；
 *     且 modelId 必须能在产品模型列表里找到，否则静默回退客户端默认。
 *   - CustomModelIdPrefix 特性开启时（本机全局库有 chatCustomModelIdPrefixMigrated
 *     迁移标记），models.json 的自定义模型 id 会被加上 custom-local: 前缀，
 *     界面保存自定义模型选择时存的也是带前缀的 id。
 * 所以这里把已有选择项全部重指向 CCB；用户从未选过模型时补种 craft / ask 两个模式键，
 * 保证打开任何项目聊天默认都走 CCB，不必再手动选一次。 */
const CODEBUDDY_ITEM_KEY = 'Tencent-Cloud.coding-copilot';
const CODEBUDDY_SELECT_FIELD = 'chatSelectedModelMapV2';
const CODEBUDDY_MODES = ['craft', 'ask'];
const CUSTOM_LOCAL_PREFIX = 'custom-local:';

function parseMaybeJson(v) {
	if (typeof v !== 'string') return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

/** 枚举一个产品数据目录下全部工作区的 state.vscdb */
function codebuddyWorkspaceDbs(appDataDir) {
	const ws = path.join(appDataDir, 'User', 'workspaceStorage');
	try {
		return fs
			.readdirSync(ws, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(ws, e.name, 'state.vscdb'))
			.filter((f) => fs.existsSync(f));
	} catch {
		return [];
	}
}

/** 把一个产品数据目录下所有工作区的选中模型指向 CCB；返回改写的工作区库数量 */
function repointCodeBuddySelection(appDataDir, model, log) {
	const prefixed = CUSTOM_LOCAL_PREFIX + model;
	let touched = 0;
	for (const file of codebuddyWorkspaceDbs(appDataDir)) {
		try {
			const raw = vscdb.readItem(file, CODEBUDDY_ITEM_KEY);
			const data = raw == null ? {} : parseMaybeJson(raw);
			if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

			/* 字段原本不存在时按扩展的规范编码（字符串化）写；原本是对象才保持对象 */
			const prev = data[CODEBUDDY_SELECT_FIELD];
			const asString = prev === undefined || typeof prev === 'string';
			let map = parseMaybeJson(prev);
			if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
			for (const mode of Object.keys(map)) map[mode] = prefixed;
			for (const mode of CODEBUDDY_MODES) {
				if (!(mode in map)) map[mode] = prefixed;
			}

			backupSqlite(file, log);
			data[CODEBUDDY_SELECT_FIELD] = asString ? JSON.stringify(map) : map;
			vscdb.writeItem(file, CODEBUDDY_ITEM_KEY, JSON.stringify(data));
			touched++;
		} catch (e) {
			log(`警告：跳过工作区库 ${path.basename(path.dirname(file))}：${e.message}`);
		}
	}
	if (touched) log(`已把 ${path.basename(appDataDir)} 的 ${touched} 个工作区默认模型指向 ${prefixed}`);
	return touched;
}

async function writeCodeBuddy(cfg, log, client) {
	const dirs = (client && client.configDirs) || [];
	if (!dirs.length) return { ok: false, error: '未找到 CodeBuddy 配置目录' };
	for (const dir of dirs) writeModelsJson(dir, cfg, log);

	const model = cfg.defaultModel || cfg.models[0];
	for (const dir of dirs) writeDefaultModelField(dir, model, log);

	let repointed = 0;
	for (const dir of (client && client.appDirs) || []) {
		repointed += repointCodeBuddySelection(path.join(APPDATA, dir), model, log);
	}
	if (!repointed) {
		log('提示：本机还没有任何已打开过的项目工作区，首次在 CodeBuddy 里打开项目后再重新写入一次配置，默认模型即可生效。');
	}

	log('完成。请完全退出 CodeBuddy 后重新打开。');
	return { ok: true };
}

/* ---------- Trae 系（UI 自动化写入） ----------
 * Trae / TraeCode / TraeWork 四端共用 @byted-icube/ai-modules-chat，模型列表键为
 * `AI.agent.model.model_list_map`。逐条取证（详见 clients.js 的 TRAE 说明）：
 *   - 该键由 storeModelListMap() 写入，客户端只把 getModelListMapFromCache() 当缓存读；
 *   - 真实来源是服务端 RPC（ModelService → model-list-service），启动即整表重取覆盖本地；
 *   - 实测：写入 171 条 CCB 条目，客户端启动后该键回到写入前的字节级内容（CCB 条目归零）；
 *   - 自定义模型有官方通道（客户端内「设置 → 模型 → 添加模型」，服务端 RPC add_custom_model），
 *     配置存在 Trae 账号下，因此**本地文件写入无效，必须走官方界面**。
 * 所以这里不复刻私有 RPC，而是用 CDP 驱动客户端自己的界面完成添加（见 traeui.js）。
 */
async function writeTraeUi(cfg, log, client, detected) {
	const exe = findLaunchExe(client, detected);
	if (!exe) return { ok: false, error: '未找到程序位置，请点击「详情」手动选择路径' };
	try {
		return await addCustomModels({
			exePath: exe,
			exeNames: client.exeNames,
			label: client.name,
			cfg,
			log,
		});
	} finally {
		/* addCustomModels 会带调试端口拉起客户端；调试端口开着时本机任何进程都能接入
		 * 并读取客户端内的凭据，所以和 WorkBuddy / ZCode 一样，流程结束（无论成败）立刻
		 * 关掉，用户点「启动 / 重启」再正常打开。稍等片刻是给客户端留落盘时间。 */
		await sleep(800);
		await stopClient(client);
	}
}

/** 回滚：Trae 的自定义模型存在账号里，本地无法代删，只能指路 */
async function rollbackTraeUi(log, client) {
	const label = (client && client.name) || 'Trae';
	log(`${label} 的自定义模型保存在你的 ${label} 账号里，本地无法代删。`);
	log(`请在客户端内打开「设置 → 模型 → 模型管理」，删除带「CCB 」前缀的条目即可。`);
	return { ok: true };
}

/* ---------- Cursor（state.vscdb） ----------
 * Cursor 使用自定义 OpenAI 兼容服务需要两处同时到位：
 *   1) reactive storage blob（ItemTable key 见下）
 *        openAIBaseUrl —— 自定义服务地址，必须带 /v1（Cursor 会自行拼 ${baseUrl}/chat/completions）
 *        useOpenAIKey  —— 必须为 true，否则 Cursor 忽略自定义 Key（默认 false，最易漏）
 *   2) ItemTable key cursorAuth/openAIKey —— API Key 明文位。
 *        新版 Cursor 启动时会把它迁移到 DPAPI 加密的 secret://cursorAuth/openAIKey 并删除明文，
 *        属「写一次即生效」；被迁移后 Cursor 侧仍保留该 Key，无需重复写入。
 */

const CURSOR_BLOB_KEY =
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const CURSOR_OPENAI_KEY_ITEM = 'cursorAuth/openAIKey';

/* ---------- Cursor MITM 代理模式（模仿 cursor-agent 4.x 的做法） ----------
 * cursor-agent 配置 Cursor 的核心不是改域名，而是把 Cursor 的 HTTP 流量导入本地
 * MITM 代理：settings.json 写 http.proxy=http://127.0.0.1:<port>、
 * http.proxySupport=override、cursor.general.disableHttp2=true（强制 HTTP/1.1，
 * 降低 MITM 难度），代理由 cursorproxy.js 实现 Cursor 后端协议并转发到 CCB 中转。
 * BYOK 与 MITM 互斥：MITM 开启时不再写 BYOK blob/key，并清理残留的 CCB BYOK 内容。 */
const CURSOR_PROXY_DEFAULT_PORT = 9182;

/** settings.json 是 JSONC（允许注释与尾逗号），解析前先做最小清洗 */
function parseJsonc(text) {
	let out = '';
	let inStr = false;
	let quote = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			out += ch;
			if (ch === '\\') {
				out += text[i + 1] || '';
				i++;
			} else if (ch === quote) {
				inStr = false;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			inStr = true;
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++;
			continue;
		}
		out += ch;
	}
	/* 尾逗号：},  ] 前的逗号 */
	out = out.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(out);
}

function cursorSettingsPath(appDataDir) {
	return path.join(appDataDir, 'User', 'settings.json');
}

/** 写入代理三件套；返回是否有改动 */
function writeCursorProxySettings(appDataDir, port, log) {
	const file = cursorSettingsPath(appDataDir);
	const proxyUrl = `http://127.0.0.1:${port || CURSOR_PROXY_DEFAULT_PORT}`;
	let settings = {};
	let existed = fs.existsSync(file);
	if (existed) {
		try {
			settings = parseJsonc(readText(file));
		} catch (e) {
			log(`警告：Cursor settings.json 解析失败（${e.message}），跳过代理配置写入`);
			return false;
		}
		if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
			log('警告：Cursor settings.json 不是对象，跳过代理配置写入');
			return false;
		}
	}
	const want = {
		'http.proxy': proxyUrl,
		'http.proxySupport': 'override',
		'cursor.general.disableHttp2': true,
	};
	const dirty = Object.entries(want).some(([k, v]) => settings[k] !== v);
	if (!dirty) {
		log('Cursor 代理配置已是最新，无需写入');
		return true;
	}
	if (existed) backupOnce(file, log);
	Object.assign(settings, want);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeText(file, JSON.stringify(settings, null, '\t') + '\n');
	log(`已写入 Cursor 代理配置（${proxyUrl}，override，禁用 HTTP/2）`);
	return true;
}

/** 回滚代理三件套：优先整体恢复 .bak，否则只摘除值与我们一致的三键 */
function rollbackCursorProxySettings(appDataDir, log) {
	const file = cursorSettingsPath(appDataDir);
	if (!fs.existsSync(file)) return 0;
	if (restoreBackup(file, log)) return 1;
	let settings;
	try {
		settings = parseJsonc(readText(file));
	} catch {
		return 0;
	}
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 0;
	let touched = false;
	if (typeof settings['http.proxy'] === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(settings['http.proxy'])) {
		delete settings['http.proxy'];
		touched = true;
	}
	if (settings['http.proxySupport'] === 'override') {
		delete settings['http.proxySupport'];
		touched = true;
	}
	if (settings['cursor.general.disableHttp2'] === true) {
		delete settings['cursor.general.disableHttp2'];
		touched = true;
	}
	if (touched) {
		writeText(file, JSON.stringify(settings, null, '\t') + '\n');
		log('已移除 Cursor 代理配置');
		return 1;
	}
	return 0;
}

/** Cursor settings.json 是否仍指向我们的本地代理（app 重启后据此决定是否自动恢复代理） */
function isCursorProxyActive(client) {
	for (const dir of (client && client.appDirs) || []) {
		const file = cursorSettingsPath(path.join(APPDATA, dir));
		if (!fs.existsSync(file)) continue;
		try {
			const settings = parseJsonc(readText(file));
			if (
				settings &&
				typeof settings === 'object' &&
				/^http:\/\/127\.0\.0\.1:\d+$/.test(String(settings['http.proxy'] || ''))
			) {
				return true;
			}
		} catch {}
	}
	return false;
}

/** MITM 开启前清理残留的 CCB BYOK 写入（两模式互斥；不整库恢复，只清我们写的内容） */
function cleanupCursorByokRemnants(file, log) {
	const blob = vscdb.readJson(file, CURSOR_BLOB_KEY);
	if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
		let touched = false;
		if (blob.useOpenAIKey === true) {
			blob.useOpenAIKey = false;
			touched = true;
		}
		if (typeof blob.openAIBaseUrl === 'string' && blob.openAIBaseUrl) {
			blob.openAIBaseUrl = null;
			touched = true;
		}
		if (touched) {
			vscdb.writeItem(file, CURSOR_BLOB_KEY, blob);
			log('已关闭残留的 BYOK 自定义服务地址（MITM 模式不再需要）');
		}
	}
	const key = vscdb.readItem(file, CURSOR_OPENAI_KEY_ITEM);
	if (key && key.startsWith('sk-ccb-') && vscdb.deleteItem(file, CURSOR_OPENAI_KEY_ITEM)) {
		log('已移除残留的 BYOK API Key');
	}
}

function writeCursorForDir(appDataDir, cfg, log) {
	const file = vscdb.stateDbPath(appDataDir);
	if (!fs.existsSync(file)) return false;

	/* MITM 模式（模仿 cursor-agent）：写 settings.json 代理三件套，
	 * 清掉残留 BYOK，不再走官方 BYOK 通道 */
	if (cfg.cursorMitm && cfg.cursorMitm.enabled) {
		cleanupCursorByokRemnants(file, log);
		return writeCursorProxySettings(appDataDir, cfg.cursorMitm.port, log);
	}

	/* BYOK 模式：与 MITM 互斥，先摘掉可能存在的代理三件套 */
	rollbackCursorProxySettings(appDataDir, log);

	backupOnce(file, log);

	const blob = vscdb.readJson(file, CURSOR_BLOB_KEY);
	if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
		blob.openAIBaseUrl = cfg.apiBase.replace(/\/+$/, ''); // 必须带 /v1
		blob.useOpenAIKey = true;

		const ai =
			blob.aiSettings && typeof blob.aiSettings === 'object' && !Array.isArray(blob.aiSettings)
				? blob.aiSettings
				: {};
		/* 自定义模型登记：Cursor 用 userAddedModels + modelOverrideEnabled 记录「用户手动添加的模型」，
		 * 后者让模型在 defaultOn=false 时也出现在选择器里。
		 * availableDefaultModels2 是 Cursor 服务端下发的目录（含服务端模型哈希），不能手写。 */
		const mergeIds = (arr) => [
			...new Set([...(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []), ...cfg.models]),
		];
		ai.userAddedModels = mergeIds(ai.userAddedModels);
		ai.modelOverrideEnabled = mergeIds(ai.modelOverrideEnabled);

		/* 默认模型：把各场景当前模型指向我们的默认模型（自定义模型不支持 maxMode） */
		const model = cfg.defaultModel || cfg.models[0];
		if (ai.modelConfig && typeof ai.modelConfig === 'object' && !Array.isArray(ai.modelConfig)) {
			for (const scene of Object.keys(ai.modelConfig)) {
				const cur = ai.modelConfig[scene];
				if (!cur || typeof cur !== 'object' || Array.isArray(cur)) continue;
				ai.modelConfig[scene] = {
					...cur,
					modelName: model,
					maxMode: false,
					selectedModels: [{ modelId: model, parameters: [] }],
				};
			}
		}
		blob.aiSettings = ai;
		vscdb.writeItem(file, CURSOR_BLOB_KEY, blob);
		log('已写入 Cursor 服务地址、开启自定义 Key、登记自定义模型，并把各场景默认模型指向 CCB');
	} else {
		log('警告：未找到 Cursor 设置存储，跳过服务地址写入（API Key 仍会写入）。');
	}

	vscdb.writeItem(file, CURSOR_OPENAI_KEY_ITEM, cfg.apiKey);
	log('已写入 Cursor API Key');
	return true;
}

function rollbackCursorForDir(appDataDir, log) {
	let changed = rollbackCursorProxySettings(appDataDir, log);
	const file = vscdb.stateDbPath(appDataDir);
	if (!fs.existsSync(file)) return changed;
	if (restoreBackup(file, log)) return changed + 1;

	const blob = vscdb.readJson(file, CURSOR_BLOB_KEY);
	if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
		let touched = false;
		if (blob.useOpenAIKey === true) {
			blob.useOpenAIKey = false;
			touched = true;
		}
		if (typeof blob.openAIBaseUrl === 'string' && blob.openAIBaseUrl) {
			blob.openAIBaseUrl = null; // Cursor 的默认值
			touched = true;
		}
		if (touched) {
			vscdb.writeItem(file, CURSOR_BLOB_KEY, blob);
			log('已关闭 Cursor 的自定义服务地址与自定义 Key 开关');
			changed++;
		}
	}
	const key = vscdb.readItem(file, CURSOR_OPENAI_KEY_ITEM);
	if (key && key.startsWith('sk-ccb-') && vscdb.deleteItem(file, CURSOR_OPENAI_KEY_ITEM)) {
		log('已移除 Cursor 中 CCB 写入的 API Key');
		changed++;
	}
	return changed;
}

async function writeCursor(cfg, log, client) {
	const mitm = cfg.cursorMitm && cfg.cursorMitm.enabled;
	let hits = 0;
	for (const dir of (client && client.appDirs) || []) {
		if (writeCursorForDir(path.join(APPDATA, dir), cfg, log)) hits++;
	}
	if (!hits) return { ok: false, error: '未找到 Cursor 配置库，请先启动一次 Cursor 再重试' };
	if (mitm) {
		log('完成。请重启 Cursor：流量将经由本机 CCB 代理转发（需保持 CCB 代理运行）。');
	} else {
		log('完成。启动 Cursor 后，在 Settings → Models 中即可选择 CCB 模型。');
	}
	return { ok: true };
}

async function rollbackCursor(log, client) {
	let changed = 0;
	for (const dir of (client && client.appDirs) || []) {
		changed += rollbackCursorForDir(path.join(APPDATA, dir), log);
	}
	log(changed ? '回滚完成。请重启 Cursor。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- Qoder（~/.qoder） ----------
 * Qoder 的自定义模型（BYOK）有两个写入点，我们两个都写，互为兜底：
 *   1) ~/.qoder/settings.json 的 modelConfigs.customModels[] —— 明文 JSON，官方 settings 结构，
 *      重启后生效，不受 Qoder 内部加密格式变化影响（主路径）。
 *   2) ~/.qoder/.models/<uid>/customs —— AES-256-GCM 加密文件，启动时读取，免重启即时生效。
 * 加密格式（逆向自 Qoder 内置的 qoder_auth_wasm，src/model_cache_crypto.rs）：
 *   base64( "QMC" + 0x01 + nonce[12] + AES-256-GCM 密文 + tag[16] )
 *   密钥 = HKDF-SHA256(ikm = .auth/machine_id 内容, salt="qoder-model-cache-enc",
 *                      info="model-cache-v1", L=32) → AES-256-GCM key
 * 该格式带版本头，可能随 Qoder 版本变化，故加密写入失败只告警、不影响 settings.json 生效。
 */

const QODER_KEY_PREFIX = 'ccb/';
const QODER_MAGIC = 'QMC';
const QODER_SALT = 'qoder-model-cache-enc';
const QODER_INFO = 'model-cache-v1';
const QODER_DEFAULT_MAX_INPUT = 128000;

/** Qoder 系的产品数据目录：Qoder IDE 为 ~/.qoder，Qoder CN IDE 为 ~/.qoder-cn */
function qoderRoot(client) {
	return path.join(HOME, (client && client.homeDir) || '.qoder');
}

/** 当前 uid：优先取 .models/default 的 uid，回退到 .models 下唯一的目录名 */
function qoderUid(root) {
	const modelsDir = path.join(root, '.models');
	try {
		const def = JSON.parse(readText(path.join(modelsDir, 'default')));
		if (def && typeof def.uid === 'string' && def.uid) return def.uid;
	} catch {
		/* 无 default 文件或格式变化，走目录扫描 */
	}
	try {
		const dirs = fs
			.readdirSync(modelsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
		return dirs[0] || null;
	} catch {
		return null;
	}
}

function qoderMachineId(root) {
	try {
		return readText(path.join(root, '.auth', 'machine_id')).trim();
	} catch {
		return null;
	}
}

/** HKDF-SHA256 派生 AES-256-GCM 密钥 */
async function qoderCacheKey(ikm) {
	const base = await webcrypto.subtle.importKey('raw', Buffer.from(ikm, 'utf8'), 'HKDF', false, [
		'deriveBits',
	]);
	const bits = await webcrypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: Buffer.from(QODER_SALT, 'utf8'),
			info: Buffer.from(QODER_INFO, 'utf8'),
		},
		base,
		256
	);
	return webcrypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function qoderEncrypt(plaintext, ikm) {
	const key = await qoderCacheKey(ikm);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const ct = await webcrypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		Buffer.from(plaintext, 'utf8')
	);
	// Web Crypto 的 AES-GCM 输出即「密文 + 16 字节 tag」，与 Qoder 的文件布局一致
	return Buffer.concat([
		Buffer.from(QODER_MAGIC, 'ascii'),
		Buffer.from([1]),
		Buffer.from(iv),
		Buffer.from(ct),
	]).toString('base64');
}

/** 解密（用于回滚时读回用户原有内容）；格式不符返回 null */
async function qoderDecrypt(text, ikm) {
	let raw;
	try {
		raw = Buffer.from(String(text).trim(), 'base64');
	} catch {
		return null;
	}
	if (
		raw.length < 4 + 12 + 16 ||
		raw.subarray(0, 3).toString('ascii') !== QODER_MAGIC ||
		raw[3] !== 1
	) {
		return null;
	}
	try {
		const key = await qoderCacheKey(ikm);
		const pt = await webcrypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: raw.subarray(4, 16) },
			key,
			raw.subarray(16)
		);
		return Buffer.from(pt).toString('utf8');
	} catch {
		return null;
	}
}

/** 构造 Qoder 自定义模型条目（snake_case 用于 customs，camelCase 用于 settings.json） */
function qoderEntries(cfg) {
	return cfg.models.map((model) => ({
		key: QODER_KEY_PREFIX + model,
		model,
		apiKey: cfg.apiKey,
		url: cfg.apiBase.replace(/\/+$/, ''),
		maxInputTokens: QODER_DEFAULT_MAX_INPUT,
	}));
}

function toQoderCustoms(e, provider = 'custom') {
	/* provider 按 Qoder 两系客户端分别取值（来源不同，不能混用）：
	 * - Qoder IDE / Qoder CN IDE（v4）：必须是 'custom'，与 qoderproxy 注入到
	 *   /api/v2/byok/config 的自定义 provider key 一致；v3 的 'ccb' / 挂 'deepseek'
	 *   均已实证失败（网关对非 custom provider 按官方端点鉴权 sk-ccb → 认证失败 /
	 *   'ccb' 无路由 → 10408）。'custom' 是唯一透传条目 url 的通道；
	 * - QoderWork（Node worker runtime）：同样是 'custom'（或空）——worker 的 SDI
	 *   模型解析里 Zxn(provider, url) 只对空/'custom' 透传条目 url，其它 provider 值
	 *   一律丢弃 url → 直连桥拿不到中转地址（2026-10-01 实测 missing custom model url）。
	 */
	return {
		key: e.key,
		display_name: e.model,
		provider,
		model: e.model,
		parameters: { api_key: e.apiKey },
		url: e.url,
		format: 'openai',
		is_vl: false,
		is_reasoning: false,
		max_input_tokens: e.maxInputTokens,
	};
}

function toQoderSettings(e) {
	/* provider 与 toQoderCustoms 保持同源（'custom'），指向 qoderproxy 注入的 BYOK provider */
	return {
		key: e.key,
		displayName: e.model,
		provider: 'custom',
		model: e.model,
		apiKey: e.apiKey,
		baseURL: e.url,
		format: 'openai',
		isVl: false,
		isReasoning: false,
		maxInputTokens: e.maxInputTokens,
	};
}

const isOursQoder = (m) => m && typeof m.key === 'string' && m.key.startsWith(QODER_KEY_PREFIX);

/** 把默认模型指向我们的模型：改 .models/default 的 key（保留 uid/scene 等原有字段）
 *  scene 各产品不同：Qoder IDE 为 app，QoderWork 为 assistant */
function writeQoderDefaultModel(root, model, log, scene, label) {
	const file = path.join(root, '.models', 'default');
	let data = {};
	if (fs.existsSync(file)) {
		backupOnce(file, log);
		try {
			data = JSON.parse(readText(file));
		} catch {
			data = {};
		}
	} else {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {};
	data.key = QODER_KEY_PREFIX + model;
	if (!data.uid) {
		const uid = qoderUid(root);
		if (uid) data.uid = uid;
	}
	if (!data.scene) data.scene = scene;
	data.updatedAt = Date.now();
	writeText(file, JSON.stringify(data));
	log(`已将 ${label} 默认模型设为 ${model}`);
}

/** 写加密 customs（免重启即时生效，尽力而为）；返回是否成功。
 *  provider：默认 'custom'（Qoder 系唯一透传条目 url 的通道，详见 toQoderCustoms
 *  注释；QoderWork 侧此前已实证，IDE 侧 2026-10-01 v4 起同样取 'custom'）。 */
async function writeQoderCustoms(root, cfg, log, provider = 'custom') {
	const uid = qoderUid(root);
	const machineId = qoderMachineId(root);
	if (!uid || !machineId) {
		log('提示：未找到 uid 或 machine_id，跳过加密缓存写入；重启后配置同样生效。');
		return false;
	}
	const dir = path.join(root, '.models', uid);
	const customsPath = path.join(dir, 'customs');
	try {
		fs.mkdirSync(dir, { recursive: true });
		let kept = [];
		if (fs.existsSync(customsPath)) {
			backupOnce(customsPath, log);
			const plain = await qoderDecrypt(readText(customsPath), machineId);
			if (plain) {
				try {
					const arr = JSON.parse(plain);
					if (Array.isArray(arr)) kept = arr.filter((m) => !isOursQoder(m));
				} catch {
					log('警告：原有 customs 明文解析失败，将保留为空数组（原文件已备份）');
				}
			} else {
				log('警告：原有 customs 格式无法识别（可能已升级加密格式），仅重写 CCB 条目（原文件已备份）');
			}
		}
		const payload = [...kept, ...qoderEntries(cfg).map((e) => toQoderCustoms(e, provider))];
		writeText(customsPath, await qoderEncrypt(JSON.stringify(payload, null, 2), machineId));
		log(`已写入 ${customsPath}（免重启即时生效）`);
		return true;
	} catch (e) {
		log(`提示：加密缓存写入失败（${e.message}），已跳过；重启后配置同样生效。`);
		return false;
	}
}

async function rollbackQoderCustoms(root, log) {
	const uid = qoderUid(root);
	const machineId = qoderMachineId(root);
	if (!uid || !machineId) return 0;
	const customsPath = path.join(root, '.models', uid, 'customs');
	if (!fs.existsSync(customsPath)) return 0;
	if (restoreBackup(customsPath, log)) return 1;
	try {
		const plain = await qoderDecrypt(readText(customsPath), machineId);
		const arr = plain ? JSON.parse(plain) : [];
		const kept = (Array.isArray(arr) ? arr : []).filter((m) => !isOursQoder(m));
		writeText(customsPath, await qoderEncrypt(JSON.stringify(kept, null, 2), machineId));
		log(`已从 ${customsPath} 移除 CCB 模型`);
		return 1;
	} catch (e) {
		log(`跳过加密缓存回滚：${e.message}`);
		return 0;
	}
}

/** 写 settings.json 的 modelConfigs.customModels（明文主路径，Qoder 系桌面端与 IDE 共用）。
 *  保留用户其它设置字段与用户自建的自定义模型，只替换我们前缀下的条目。 */
function writeQoderSettingsModels(root, cfg, log) {
	const settingsPath = path.join(root, 'settings.json');
	let settings = {};
	if (fs.existsSync(settingsPath)) {
		backupOnce(settingsPath, log);
		try {
			settings = JSON.parse(readText(settingsPath));
		} catch {
			log(`警告：${settingsPath} 解析失败，将重建配置对象（原文件已备份）`);
			settings = {};
		}
	}
	if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {};
	const mc =
		settings.modelConfigs && typeof settings.modelConfigs === 'object' && !Array.isArray(settings.modelConfigs)
			? settings.modelConfigs
			: {};
	const kept = (Array.isArray(mc.customModels) ? mc.customModels : []).filter((m) => !isOursQoder(m));
	const entries = qoderEntries(cfg);
	settings.modelConfigs = { ...mc, customModels: [...kept, ...entries.map(toQoderSettings)] };
	writeText(settingsPath, JSON.stringify(settings, null, 4));
	log(`已写入 ${settingsPath}（${entries.length} 个 CCB 模型）`);
}

/** 回滚 settings.json：优先还原备份，否则只移除 CCB 条目；返回改动处数 */
function rollbackQoderSettingsModels(root, log) {
	const settingsPath = path.join(root, 'settings.json');
	if (!fs.existsSync(settingsPath)) return 0;
	if (restoreBackup(settingsPath, log)) return 1;
	try {
		const settings = JSON.parse(readText(settingsPath));
		if (settings && settings.modelConfigs && Array.isArray(settings.modelConfigs.customModels)) {
			const kept = settings.modelConfigs.customModels.filter((m) => !isOursQoder(m));
			if (kept.length !== settings.modelConfigs.customModels.length) {
				settings.modelConfigs.customModels = kept;
				writeText(settingsPath, JSON.stringify(settings, null, 4));
				log(`已从 ${settingsPath} 移除 CCB 模型`);
				return 1;
			}
		}
	} catch {}
	return 0;
}

/** 回滚 .models/default：优先还原备份；无备份且 key 是我们写入的则删除该缓存文件
 *  （它是 qodercli 的默认模型缓存，会自行重建；留着会指向已被移除的 CCB 模型） */
function rollbackQoderDefaultModel(root, log) {
	const file = path.join(root, '.models', 'default');
	if (!fs.existsSync(file)) return 0;
	if (restoreBackup(file, log)) return 1;
	try {
		const data = JSON.parse(readText(file));
		if (data && typeof data.key === 'string' && data.key.startsWith(QODER_KEY_PREFIX)) {
			fs.rmSync(file);
			log('已删除 .models/default（CCB 写入的默认模型缓存，客户端会自行重建）');
			return 1;
		}
	} catch {}
	return 0;
}

async function writeQoder(cfg, log, client) {
	const root = qoderRoot(client);
	if (!fs.existsSync(root)) {
		return { ok: false, error: `未找到 ${root} 目录，请先安装并启动一次 ${client.name}` };
	}

	/* 1) settings.json（明文，主路径） */
	writeQoderSettingsModels(root, cfg, log);

	/* 2) 加密 customs（免重启即时生效，尽力而为） */
	await writeQoderCustoms(root, cfg, log);

	/* 3) 默认模型指向 CCB，打开即为我们的模型 */
	writeQoderDefaultModel(root, cfg.defaultModel || cfg.models[0], log, 'app', client.name);

	/* 4) Qoder CN IDE 1.30+：vscdb 写入 + BYOK 配置注入（v4）。
	 *    官方架构：自定义模型存 state.vscdb（aicoding.customModels + v10 加密 apiKey secret），
	 *    推理请求（CosyClient 加密体）由 Go 客户端发往 Qoder 网关，网关按 provider 解析端点。
	 *    历史方案实证：
	 *      Plan A（provider='ccb'）：网关无 'ccb' 路由 → 10408；
	 *      Plan B/v3（挂 'deepseek'）：网关按 DeepSeek 官方端点鉴权 sk-ccb →
	 *              「自定义模型认证失败」（加密体 MITM 改不了）。
	 *    v4（当前方案）：provider='custom'（Qoder 官方「自定义服务商」通道，QoderWork
	 *    worker 同语义——只对空/'custom' 透传条目 url）：
	 *      a) qoderproxy 向 /api/v2/byok/config 注入 custom provider（source='custom'，
	 *         base_url 指向 CCB 中转，生产 https://code.btluo.com/v1）；
	 *      b) vscdb 条目 provider='custom' + baseUrl=中转地址，apiKey 写 sk-ccb-*
	 *         （safeStorage 加密，密文由 main.js 的 qoder-secret-helper 子进程生成，
	 *         经 cfg.qoderSecretBlob 传入）；
	 *      c) MITM 代理仍承担：byok/config 注入、user/status、user/plan 的 allow_byok=1
	 *         注入（IDE 必须认为 BYOK 可用），以及 qoder 域的流量管理。
	 *    已知问题对冲：IDE 退出时会清空外部写入的 customModels + secret（机制未定），
	 *    因此持久化一份参数（~/.ccb/qoder-apply.json），每次启动前由 reapplyQoderCn 重写。 */
	if (client && client.id === 'qoder-cn') {
		const vsc = writeQoderCnVscdbModels(client, cfg, log);
		if (!vsc.ok) {
			log(`注意：vscdb 写入失败（${vsc.error}），IDE 界面内暂不可用，CLI 通道仍有效。`);
		}
		/* Qoder 官方代理设置（User/settings.json 的 app.configAdvancedProxyMode）：
		 * IDE 会把它同步给内置 Go 客户端的 HTTP 栈——这样无论用户从哪里启动 IDE，
		 * sk-ccb 推理请求都会经过本地代理被重定向到中转站。仅靠启动按钮注入的
		 * HTTPS_PROXY 环境变量覆盖不了「用户用自己的快捷方式启动」的生产场景。 */
		const port = (cfg.qoderMitm && Number(cfg.qoderMitm.port)) || 9183;
		writeQoderCnProxySettings(client, port, log);
	}

	log(`完成。本地代理已在后台运行，从任意方式启动 ${client.name} 均可使用 CCB 模型。`);
	return { ok: true };
}

/* ---------- Qoder CN IDE vscdb 写入（Plan B） ---------- */
const QODER_CN_MODELS_KEY = 'aicoding.customModels';
const QODER_CN_SECRET_PREFIX = 'secret://aicoding.customModel.apiKey.';
const QODER_CN_SELECTED_KEY = 'aicoding.aicoding-agent';
/* 参数持久化：启动前重写 vscdb 用（对冲 IDE 退出清空） */
const QODER_CN_APPLY_FILE = () => path.join(HOME, '.ccb', 'qoder-apply.json');

function qoderCnStateDb(client) {
	/* client.stateDbPath：测试隔离用（指向临时库，避免 E2E 污染真机 state.vscdb） */
	if (client && typeof client.stateDbPath === 'string' && client.stateDbPath) return client.stateDbPath;
	const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
	const dir = (client && Array.isArray(client.appDirs) && client.appDirs[0]) || 'QoderCN';
	return path.join(appData, dir, 'User', 'globalStorage', 'state.vscdb');
}

/** vscdb 条目是否是我们写的（1.30+ Plan B）。
 *  按 displayName 'CCB ' 前缀判定：providerDisplayName 会被 IDE 归一化为服务端
 *  BYOK 配置里 provider 的 display_name（deepseek 时代是 'DeepSeek'），拿它判定
 *  永远匹配不上 → 旧条目不被替换、逐轮堆积（2026-10-01 实测 84 条 = 21 模型 × 4 轮）。 */
const isOursQoderCnModel = (m) =>
	m && typeof m === 'object' &&
	typeof m.displayName === 'string' && m.displayName.startsWith('CCB ');

function qoderCnGenId() {
	return `model_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 写 state.vscdb 的自定义模型 + 加密 apiKey secret + 选中模型。
 * cfg.qoderSecretBlob：base64(v10 blob)，由 main.js 经 safeStorage 子进程生成。
 */
function writeQoderCnVscdbModels(client, cfg, log) {
	const db = qoderCnStateDb(client);
	if (!fs.existsSync(db)) {
		return { ok: false, error: `未找到 ${db}（请先启动一次 Qoder CN IDE）` };
	}
	const blobB64 = cfg && cfg.qoderSecretBlob;
	if (!blobB64) {
		return { ok: false, error: '缺少加密密钥 blob（qoderSecretBlob）' };
	}
	const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : [];
	if (!models.length) return { ok: false, error: '模型列表为空' };

	vscdb.backupDb(db, log);
	const secretValue = JSON.stringify({ type: 'Buffer', data: Array.from(Buffer.from(blobB64, 'base64')) });

	/* 保留非 CCB 条目，替换我们的（旧条目的 secret 一并清掉，避免孤儿 key 堆积） */
	const existing = vscdb.readJson(db, QODER_CN_MODELS_KEY) || [];
	const staleOurs = existing.filter(isOursQoderCnModel);
	const kept = existing.filter((m) => !isOursQoderCnModel(m));
	for (const m of staleOurs) {
		if (m && m.id) vscdb.deleteItem(db, QODER_CN_SECRET_PREFIX + m.id);
	}
	const now = Date.now();
	const added = models.map((m) => ({
		id: qoderCnGenId(),
		/* v4：provider 用 'custom'（Qoder 官方「自定义服务商」通道）。v3 的 'deepseek'
		 * 已实证失败：推理请求（CosyClient 加密体）发到 Qoder 网关后按 DeepSeek 官方
		 * 端点鉴权 sk-ccb →「自定义模型认证失败」。'custom' 语义下端点由条目
		 * baseUrl / 注入的 byok 配置 base_url 决定（QoderWork worker 同语义），
		 * 指向 CCB 中转（生产 https://code.btluo.com/v1）。 */
		provider: cfg.qoderProvider || 'custom',
		byokTypeKey: 'pg',
		providerDisplayName: 'CCB',
		model: m,
		displayName: `CCB ${m}`,
		baseUrl: cfg.apiBase,
		visible: true,
		hasApiKey: true,
		is_vl: false,
		is_reasoning: false,
		max_input_tokens: QODER_DEFAULT_MAX_INPUT,
		createTime: now,
	}));
	vscdb.writeItem(db, QODER_CN_MODELS_KEY, JSON.stringify([...kept, ...added]));
	log(`vscdb：已写入 ${added.length} 个 CCB 模型（provider=${added[0] ? added[0].provider : 'custom'}，保留原有 ${kept.length} 条）`);

	/* 每个模型一条 apiKey secret（同一密钥）；顺带清扫孤儿 secret
	 * （模型条目已不存在但 secret 残留——IDE 清空 customModels 时可能只删一半，
	 * 以及本写入器旧版本替换条目时不删旧 secret 遗留的） */
	for (const m of added) vscdb.writeItem(db, QODER_CN_SECRET_PREFIX + m.id, secretValue);
	log(`vscdb：已写入 ${added.length} 条加密 apiKey secret`);
	try {
		const liveIds = new Set([...kept, ...added].map((m) => m && m.id).filter(Boolean));
		const allSecrets = vscdb.listKeys(db, QODER_CN_SECRET_PREFIX + '%');
		let swept = 0;
		for (const k of allSecrets) {
			const id = k.slice(QODER_CN_SECRET_PREFIX.length);
			if (!liveIds.has(id) && vscdb.deleteItem(db, k)) swept++;
		}
		if (swept) log(`vscdb：清扫 ${swept} 条孤儿 apiKey secret`);
	} catch {};

	/* 默认聊天模型指向 CCB */
	const want = cfg.defaultModel && models.includes(cfg.defaultModel) ? cfg.defaultModel : models[0];
	const target = added.find((m) => m.model === want);
	if (target) {
		const agentState = vscdb.readJson(db, QODER_CN_SELECTED_KEY) || {};
		agentState['globalstate-selected-models'] = {
			...(agentState['globalstate-selected-models'] || {}),
			chat: `custom:${target.id}`,
		};
		vscdb.writeItem(db, QODER_CN_SELECTED_KEY, JSON.stringify(agentState));
		log(`vscdb：默认聊天模型 → CCB ${want}`);
	}

	/* 持久化参数（启动前重写用；blob 与 QoderCN 的 DPAPI 密钥绑定，本机稳定）。
	 * cfg.qoderApplyFile / client.qoderApplyFile 可覆盖持久化目标（测试隔离用，
	 * 避免 E2E 污染真机 ~/.ccb/qoder-apply.json）。 */
	const applyFile = cfg.qoderApplyFile ||
		(client && typeof client.qoderApplyFile === 'string' && client.qoderApplyFile) ||
		QODER_CN_APPLY_FILE();
	try {
		fs.mkdirSync(path.dirname(applyFile), { recursive: true });
		fs.writeFileSync(applyFile, JSON.stringify({
			apiKey: cfg.apiKey,
			apiBase: cfg.apiBase,
			models,
			defaultModel: want,
			qoderSecretBlob: blobB64,
			qoderProvider: cfg.qoderProvider || 'custom',
			savedAt: now,
		}));
	} catch (e) {
		log(`参数持久化失败（不影响本次写入）：${e.message}`);
	}
	return { ok: true, added: added.length };
}

/** 启动前重写（对冲 IDE 退出清空 customModels 的问题）。参数来自 ~/.ccb/qoder-apply.json */
function reapplyQoderCn(client, log) {
	/* client.qoderApplyFile：测试隔离用（读临时参数文件而不是真机 ~/.ccb/qoder-apply.json） */
	const applyFile = (client && typeof client.qoderApplyFile === 'string' && client.qoderApplyFile) || QODER_CN_APPLY_FILE();
	let saved;
	try {
		saved = JSON.parse(fs.readFileSync(applyFile, 'utf8'));
	} catch {
		return false; /* 从未配置过，静默跳过 */
	}
	if (!saved || !saved.qoderSecretBlob || !Array.isArray(saved.models) || !saved.models.length) return false;
	const clientDef = client || { id: 'qoder-cn', appDirs: ['QoderCN'] };
	/* 若 IDE 没清空且条目完好，跳过重写（避免无谓的 id 变更导致选中模型失效） */
	try {
		const db = qoderCnStateDb(clientDef);
		const existing = vscdb.readJson(db, QODER_CN_MODELS_KEY) || [];
		const ours = existing.filter(isOursQoderCnModel);
		if (ours.length >= saved.models.length) return true;
	} catch {}
	writeQoderCnVscdbModels(clientDef, {
		apiKey: saved.apiKey,
		apiBase: saved.apiBase,
		models: saved.models,
		defaultModel: saved.defaultModel,
		qoderSecretBlob: saved.qoderSecretBlob,
		qoderProvider: saved.qoderProvider,
	}, log || (() => {}));
	return true;
}

/** vscdb 是否还有我们的模型（app 启动时据此恢复本地代理） */
function hasQoderCnModels(client) {
	try {
		const db = qoderCnStateDb(client || { appDirs: ['QoderCN'] });
		if (!fs.existsSync(db)) return false;
		const existing = vscdb.readJson(db, QODER_CN_MODELS_KEY) || [];
		return existing.some(isOursQoderCnModel);
	} catch {
		return false;
	}
}

/** 回滚 vscdb：移除我们的模型 + secret，恢复选中模型 */
function rollbackQoderCnVscdbModels(client, log) {
	const db = qoderCnStateDb(client);
	if (!fs.existsSync(db)) return 0;
	const existing = vscdb.readJson(db, QODER_CN_MODELS_KEY) || [];
	const ours = existing.filter(isOursQoderCnModel);
	if (!ours.length) return 0;
	const ourIds = new Set(ours.map((m) => m.id));
	const kept = existing.filter((m) => !isOursQoderCnModel(m));
	vscdb.writeItem(db, QODER_CN_MODELS_KEY, JSON.stringify(kept));
	for (const id of ourIds) vscdb.deleteItem(db, QODER_CN_SECRET_PREFIX + id);
	/* 选中模型若指向我们的条目则清除（IDE 回落到默认模型） */
	try {
		const agentState = vscdb.readJson(db, QODER_CN_SELECTED_KEY) || {};
		const sel = agentState['globalstate-selected-models'] || {};
		const m = /^custom:(.+)$/.exec(String(sel.chat || ''));
		if (m && ourIds.has(m[1])) {
			delete sel.chat;
			agentState['globalstate-selected-models'] = sel;
			vscdb.writeItem(db, QODER_CN_SELECTED_KEY, JSON.stringify(agentState));
		}
	} catch {}
	try { fs.rmSync(QODER_CN_APPLY_FILE()); } catch {}
	log(`vscdb：已移除 ${ours.length} 个 CCB 模型及对应 secret`);
	return 1;
}

/* ---------- Qoder CN IDE 1.30+ 本地 MITM 代理（qoderproxy） ----------
 * 1.30+ 的自定义模型存于 state.vscdb 的 aicoding.customModels，且 provider 必须存在于
 * 服务端 BYOK 配置（gateway.qoder.com.cn/api/v2/byok/config）中，否则模型被禁用
 * （provider_unavailable，发送按钮置灰）。配套方案：本地 MITM 代理（lib/qoderproxy.js，
 * 127.0.0.1:9183）拦截该接口注入 ccb provider。这里把 Qoder 的官方代理设置指向本地代理
 * （app.configAdvancedProxyMode/URL，IDE 会同步给内置 qoderclicn 的 HTTP 客户端）。 */
function qoderCnUserSettingsPath(client) {
	const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
	const dir = (client && Array.isArray(client.appDirs) && client.appDirs[0]) || 'QoderCN';
	return path.join(appData, dir, 'User', 'settings.json');
}

/** Qoder CN settings.json 是否仍指向我们的本地代理（app 重启后据此决定是否自动恢复代理）
 *  与 isCursorProxyActive 对称：只有 manual 模式 + 127.0.0.1:<port> 才算「还挂着我们的代理」 */
function isQoderProxyActive(client) {
	const file = qoderCnUserSettingsPath(client);
	if (!fs.existsSync(file)) return false;
	try {
		const settings = parseJsonc(readText(file));
		const app = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.app : null;
		if (!app || typeof app !== 'object' || Array.isArray(app)) return false;
		return (
			app.configAdvancedProxyMode === 'manual' &&
			/^http:\/\/127\.0\.0\.1:\d+$/.test(String(app.configAdvancedProxyURL || ''))
		);
	} catch {
		return false;
	}
}

function writeQoderCnProxySettings(client, port, log) {
	const file = qoderCnUserSettingsPath(client);
	const proxyUrl = `http://127.0.0.1:${port || 9183}`;
	let settings = {};
	const existed = fs.existsSync(file);
	if (existed) {
		try {
			settings = parseJsonc(readText(file)) || {};
		} catch {
			settings = {};
		}
	}
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
	if (existed) backupOnce(file, log);
	const app = settings.app && typeof settings.app === 'object' && !Array.isArray(settings.app) ? settings.app : {};
	app.configAdvancedProxyMode = 'manual';
	app.configAdvancedProxyURL = proxyUrl;
	settings.app = app;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeText(file, JSON.stringify(settings, null, '\t') + '\n');
	log(`已写入 Qoder 代理设置（manual → ${proxyUrl}）`);
	return true;
}

function rollbackQoderCnProxySettings(client, log) {
	const file = qoderCnUserSettingsPath(client);
	if (!fs.existsSync(file)) return 0;
	if (restoreBackup(file, log)) return 1;
	let settings;
	try {
		settings = parseJsonc(readText(file));
	} catch {
		return 0;
	}
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 0;
	const app = settings.app;
	if (!app || typeof app !== 'object' || Array.isArray(app)) return 0;
	let touched = false;
	if (app.configAdvancedProxyMode === 'manual') {
		delete app.configAdvancedProxyMode;
		touched = true;
	}
	if (
		typeof app.configAdvancedProxyURL === 'string' &&
		/^http:\/\/127\.0\.0\.1:\d+$/.test(app.configAdvancedProxyURL)
	) {
		delete app.configAdvancedProxyURL;
		touched = true;
	}
	if (touched) {
		writeText(file, JSON.stringify(settings, null, '\t') + '\n');
		log('已移除 Qoder 代理设置');
		return 1;
	}
	return 0;
}

async function rollbackQoder(log, client) {
	const root = qoderRoot(client);
	let changed = 0;

	/* settings.json：优先恢复备份，否则移除 CCB 条目 */
	changed += rollbackQoderSettingsModels(root, log);

	/* 加密 customs：优先恢复备份，否则移除 CCB 条目后重新加密 */
	changed += await rollbackQoderCustoms(root, log);

	/* 默认模型：优先从备份恢复，无备份则清掉我们写入的缓存 */
	changed += rollbackQoderDefaultModel(root, log);

	/* Qoder CN IDE 1.30+：移除 vscdb 里的 CCB 模型与 secret */
	if (client && client.id === 'qoder-cn') {
		changed += rollbackQoderCnVscdbModels(client, log);
		changed += rollbackQoderCnProxySettings(client, log);
	}

	log(changed ? '回滚完成。请重启 Qoder。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- Qoder CN 桌面版（~/.qoder-cn） ----------
 * 本写入器不写 main.sqlite —— 逐 bundle 取证结论（见下），写库在本版本是无效路径：
 *   1) 桌面版把内置 qodercli 的配置目录设为 ~/.qoder-cn（asar 内 product 配置
 *      cliConfigDirectoryName:".qoder-cn"，vD() 用 QODERCN_CONFIG_DIR / 主目录拼接，
 *      并作为 QODERCN_CONFIG_DIR 传给 CLI）。模型选择器的数据来自 CLI 的 get_models
 *      （platformModels），而 CLI 会把两处「本地 BYOK 声明」注入模型目录：
 *        a) settings.json 的 modelConfigs.customModels —— 官方 settings schema 字段
 *           （CLI 内 customModels 定义：provider/apiKey/model 必填，baseURL/format/
 *            displayName/isReasoning/isVl/maxInputTokens 可选，允许 format=openai）
 *        b) .models/<uid>/customs —— 加密文件（CLI 内 loadBYOKModels → model_cache_decrypt，
 *           与 QoderWork 的 customs 同一格式），运行时注入。
 *   2) main.sqlite 的 byok_model_profiles / byok_model_credentials 已是「旧版存储」：
 *      整个 bundle 里只有 migrateLegacyProfiles 读它，且迁移会先要求 CLI 具备
 *      byok_config_management_v1 能力（本机 qoderclicn 1.1.42 的能力清单里没有该能力，
 *      也没有 list_byok_configs / create_byok_config 命令）→ 迁移直接放弃。
 *      因此写库既不会被读取，也不会让模型出现在客户端里，故本写入器不写库。
 * 2026-10-01 补充：桌面版聊天走 @qoder-ai/qoder-cn-agent-sdk 的 Node worker（与 QoderWork
 *   同源），通过 qoderbridge.js 运行时补丁实现 CCB BYOK 直连：
 *   - provider='custom' 让 worker 的 Zxn 透传条目 url 到 CCB 中转；
 *   - reconcile 补丁让 worker 优先读 .models/default 作为默认模型（原逻辑目录默认优先）；
 *   - openCall guard 拦截 sk-ccb- 请求短路到中转，跳过服务端权益门禁。
 *   因此 CCB 模型现在可成为默认模型，.models/default 生效，无需手动选择。
 */
async function writeQoderAppCn(cfg, log, client) {
	const root = qoderRoot(client);
	const settingsPath = path.join(root, 'settings.json');
	/* 要求 settings.json 已存在：说明该客户端确实安装并启动过（否则会凭空造出配置目录） */
	if (!fs.existsSync(settingsPath)) {
		return {
			ok: false,
			error: `未找到 ${settingsPath}，请先安装并启动一次 ${client.name} 再重试`,
		};
	}

	/* 1) settings.json 的 modelConfigs.customModels（官方字段，重启后生效） */
	writeQoderSettingsModels(root, cfg, log);

	/* 2) 加密 customs（运行时注入，provider='custom' 让 worker 透传 url 到 CCB 中转；
	 *    与 QoderWork 同一套 worker 内核，'ccb' 会被 Zxn 丢 url） */
	await writeQoderCustoms(root, cfg, log, 'custom');

	/* 3) 默认模型：写 .models/default，worker reconcile 补丁启动时优先读此值，
	 *    否则 BYOK 模型永远解析回平台目录默认（与 QoderWork 同理） */
	writeQoderDefaultModel(root, cfg.defaultModel || cfg.models[0], log, 'assistant', client.name);

	/* 4) worker runtime 桥接补丁（关键链路）：Qoder CN 桌面版聊天走 @qoder-ai/qoder-cn-agent-sdk
	 *    的 Node worker（原生 gRPC → 网关），服务端按权益开关拒绝自定义模型。不打补丁配置必然
	 *    不可用，因此桥失败如实报整体失败。 */
	try {
		ensureQoderWorkBridge(client, log);
	} catch (e) {
		return { ok: false, error: `${client.name} runtime 桥接失败：${e.message}` };
	}

	log(`完成。启动 ${client.name} 后默认模型即为 CCB ${cfg.defaultModel || cfg.models[0]}，直接聊天即可。`);
	return { ok: true };
}

async function rollbackQoderAppCn(log, client) {
	const root = qoderRoot(client);
	let changed = 0;

	/* settings.json：优先恢复备份，否则移除 CCB 条目 */
	changed += rollbackQoderSettingsModels(root, log);

	/* 加密 customs：优先恢复备份，否则移除 CCB 条目后重新加密 */
	changed += await rollbackQoderCustoms(root, log);

	/* 默认模型：优先从备份恢复，无备份则清掉我们写入的缓存 */
	changed += rollbackQoderDefaultModel(root, log);

	/* runtime 桥：还原 worker runtime 补丁（失败只记日志，不让回滚整体失败） */
	if (removeQoderWorkBridge(client, log)) changed++;

	log(changed ? '回滚完成。请重启 Qoder CN。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- QoderWork（~/.qoderworkcn、~/.qoderwork） ----------
 * QoderWork 与 Qoder IDE 同源，共用同一套 .models 加密缓存（customs 格式一致），但：
 *   - 没有 settings.json 的 modelConfigs 通道；
 *   - 自定义模型的主存储是桌面端 SQLite：%APPDATA%\<userData>\data\agents.db 的
 *     byok_custom_models 表（字段来源：asar 内 drizzle 表定义 + rowToConfiguredModel）。
 *     api_key 存在 encrypted_parameters，客户端 encodeParameter 在 safeStorage 不可用时
 *     会回落到 plainBase64，decodeParameter 也支持该分支 → 我们写 plainBase64 即可被读取。
 *   - 默认模型：.models/default 的 key，scene 为 assistant。
 *   - url 是「完整端点」：openai 风格拼 /chat/completions（见 asar 内 j0e）。
 */
const QODERWORK_MAX_OUTPUT = 8192;

function qoderWorkDbPath(client) {
	const dir = ((client && client.appDirs) || [])[0];
	return dir ? path.join(APPDATA, dir, 'data', 'agents.db') : null;
}

/** SQLite 备份（连同 WAL/SHM），只在无备份时做一次 */
function backupSqlite(file, log) {
	if (!fs.existsSync(file) || fs.existsSync(file + '.bak')) return false;
	for (const suffix of ['', '-wal', '-shm']) {
		const src = file + suffix;
		if (fs.existsSync(src)) fs.copyFileSync(src, file + '.bak' + suffix);
	}
	log(`已备份数据库 ${path.basename(file)} → ${path.basename(file)}.bak`);
	return true;
}

function restoreSqlite(file, log) {
	const bak = file + '.bak';
	if (!fs.existsSync(bak)) return false;
	for (const suffix of ['', '-wal', '-shm']) {
		const src = bak + suffix;
		const dst = file + suffix;
		if (fs.existsSync(src)) fs.copyFileSync(src, dst);
		else if (suffix && fs.existsSync(dst)) fs.rmSync(dst);
	}
	log(`已从备份恢复 ${path.basename(file)}`);
	return true;
}

/** 构造 byok_custom_models 的一行（纯函数，便于测试字段名与编码格式） */
function qoderWorkRow(cfg, model, now) {
	const base = cfg.apiBase.replace(/\/+$/, '');
	return {
		key: QODER_KEY_PREFIX + model,
		source: 'byok',
		display_name: model,
		provider: null,
		type: null,
		url: base + '/chat/completions',
		style: 'openai',
		model,
		format: 'openai',
		is_vl: 0,
		is_reasoning: 0,
		max_input_tokens: QODER_DEFAULT_MAX_INPUT,
		max_output_tokens: QODERWORK_MAX_OUTPUT,
		encrypted_parameters: JSON.stringify({
			api_key: { encoding: 'plainBase64', value: Buffer.from(cfg.apiKey, 'utf8').toString('base64') },
		}),
		extra_params: JSON.stringify({
			baseUrl: base,
			displayName: model,
			maxInputTokensK: QODER_DEFAULT_MAX_INPUT / 1024,
			maxOutputTokensK: QODERWORK_MAX_OUTPUT / 1024,
		}),
		created_at: now,
		updated_at: now,
	};
}

function writeQoderWorkDb(client, cfg, log) {
	const file = qoderWorkDbPath(client);
	if (!file || !fs.existsSync(file)) {
		log('提示：未找到 QoderWork 数据库（请先启动一次 QoderWork），已跳过 BYOK 模型写入。');
		return false;
	}
	const { DatabaseSync } = require('node:sqlite');
	backupSqlite(file, log);
	const db = new DatabaseSync(file);
	try {
		const has = db
			.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='byok_custom_models'")
			.get();
		if (!has) {
			log('提示：当前 QoderWork 版本没有 byok_custom_models 表，已跳过 BYOK 模型写入。');
			return false;
		}
		db.prepare('DELETE FROM byok_custom_models WHERE key LIKE ?').run(QODER_KEY_PREFIX + '%');
		const stmt = db.prepare(
			`INSERT OR REPLACE INTO byok_custom_models
			 (key, source, display_name, provider, type, url, style, model, format,
			  is_vl, is_reasoning, max_input_tokens, max_output_tokens,
			  encrypted_parameters, extra_params, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
		);
		const now = Math.floor(Date.now() / 1000);
		for (const model of cfg.models) {
			const r = qoderWorkRow(cfg, model, now);
			stmt.run(
				r.key, r.source, r.display_name, r.provider, r.type, r.url, r.style, r.model, r.format,
				r.is_vl, r.is_reasoning, r.max_input_tokens, r.max_output_tokens,
				r.encrypted_parameters, r.extra_params, r.created_at, r.updated_at
			);
		}
		log(`已写入 ${file} 的 byok_custom_models（${cfg.models.length} 个 CCB 模型）`);
		return true;
	} finally {
		db.close();
	}
}

async function writeQoderWork(cfg, log, client) {
	const root = qoderRoot(client);
	/* 要求 .models 已存在：说明该客户端确实安装并登录过（否则会凭空造出配置目录） */
	if (!fs.existsSync(path.join(root, '.models'))) {
		return {
			ok: false,
			error: `未找到 ${path.join(root, '.models')}，请先安装、启动并登录一次 ${client.name} 再重试`,
		};
	}
	/* QoderWork 的 customs 条目 provider 用 'custom'：worker 的 SDI/Zxn 只对空/custom
	 * 透传 url（'ccb' 会被丢 url → 桥 missing custom model url）。IDE 链路不受影响
	 * （writeQoder 走默认 'ccb'），两者 customs 分属不同目录。 */
	await writeQoderCustoms(root, cfg, log, 'custom');
	writeQoderWorkDb(client, cfg, log);
	writeQoderDefaultModel(root, cfg.defaultModel || cfg.models[0], log, 'assistant', client.name);
	/* 关键链路：worker runtime 桥接补丁。QoderWork 聊天走 Node worker 的原生 gRPC，
	 * 服务端按权益开关拒绝自定义模型（FORBIDDEN 100406），不打补丁配置必然不可用，
	 * 因此桥失败要如实报整体失败（详见 qoderbridge.js 头注释）。 */
	try {
		ensureQoderWorkBridge(client, log);
	} catch (e) {
		return { ok: false, error: `QoderWork runtime 桥接失败：${e.message}` };
	}
	log(`完成。启动 ${client.name} 后即可在模型列表中选择 CCB 模型。`);
	return { ok: true };
}

async function rollbackQoderWork(log, client) {
	const root = qoderRoot(client);
	let changed = await rollbackQoderCustoms(root, log);

	const file = qoderWorkDbPath(client);
	if (file && fs.existsSync(file)) {
		if (restoreSqlite(file, log)) {
			changed++;
		} else {
			try {
				const { DatabaseSync } = require('node:sqlite');
				const db = new DatabaseSync(file);
				try {
					const r = db.prepare('DELETE FROM byok_custom_models WHERE key LIKE ?').run(QODER_KEY_PREFIX + '%');
					if (r && r.changes) {
						log(`已从 ${path.basename(file)} 移除 ${r.changes} 个 CCB 模型`);
						changed++;
					}
				} finally {
					db.close();
				}
			} catch (e) {
				log(`跳过数据库回滚：${e.message}`);
			}
		}
	}

	/* 默认模型：优先从备份恢复，无备份则清掉我们写入的缓存 */
	changed += rollbackQoderDefaultModel(root, log);

	/* runtime 桥：还原 worker runtime 补丁（失败只记日志，不让回滚整体失败） */
	if (removeQoderWorkBridge(client, log)) changed++;

	log(changed ? '回滚完成。请重启 QoderWork。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- ZCode（~/.zcode） ----------
 * 两处写入：
 *   1) ~/.zcode/v2/config.json 的 provider.<key> —— 自定义供应商注册表。
 *      source:"custom" 且 key 不带 builtin: 前缀即被识别为「自定义供应商」；
 *      kind: "openai-compatible" → 客户端自动拼 /chat/completions；
 *      apiKey 明文放在 options.apiKey。
 *   2) ~/.zcode/cli/config.json 的 model = "<providerId>/<modelId>" —— 桌面端判定
 *      「当前模型」的权威来源（逆向自 tZe()：读 config.model 与 provider.<id>.options.baseURL）。
 * ZCode 启动/迁移时会整文件重写 v2/config.json，故必须先完全退出再写。
 */
const ZCODE_PROVIDER_KEY = 'ccb';

function zcodeProviderEntry(cfg) {
	return {
		name: 'CCB',
		kind: 'openai-compatible',
		source: 'custom',
		enabled: true,
		options: {
			apiKey: cfg.apiKey,
			baseURL: cfg.apiBase.replace(/\/+$/, ''),
			apiKeyRequired: true,
		},
		models: Object.fromEntries(cfg.models.map((m) => [m, {}])),
	};
}

function readJsonObject(file, log) {
	if (!fs.existsSync(file)) return {};
	try {
		const v = JSON.parse(readText(file));
		return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
	} catch {
		if (log) log(`警告：${file} 解析失败，将重建配置对象（原文件已备份）`);
		return {};
	}
}

async function writeZCode(cfg, log, client, detected) {
	const root = path.join(HOME, (client && client.homeDir) || '.zcode');
	const v2 = path.join(root, 'v2', 'config.json');
	if (!fs.existsSync(v2)) {
		return { ok: false, error: '未找到 ~/.zcode/v2/config.json，请先启动一次 ZCode 再重试' };
	}
	backupOnce(v2, log);
	const data = readJsonObject(v2, log);
	const providers =
		data.provider && typeof data.provider === 'object' && !Array.isArray(data.provider) ? data.provider : {};
	providers[ZCODE_PROVIDER_KEY] = zcodeProviderEntry(cfg);
	data.provider = providers;
	writeText(v2, JSON.stringify(data, null, 2));
	log(`已写入 ${v2}（自定义供应商 ${ZCODE_PROVIDER_KEY}，${cfg.models.length} 个模型）`);

	/* 当前模型：~/.zcode/cli/config.json */
	const cliDir = path.join(root, 'cli');
	fs.mkdirSync(cliDir, { recursive: true });
	const cliFile = path.join(cliDir, 'config.json');
	backupOnce(cliFile, log);
	const cliCfg = readJsonObject(cliFile, log);
	const base = cfg.apiBase.replace(/\/+$/, '');
	const model = cfg.defaultModel || cfg.models[0];
	cliCfg.model = `${ZCODE_PROVIDER_KEY}/${model}`;
	cliCfg.provider = {
		...(cliCfg.provider && typeof cliCfg.provider === 'object' && !Array.isArray(cliCfg.provider)
			? cliCfg.provider
			: {}),
		[ZCODE_PROVIDER_KEY]: { options: { baseURL: base, apiKey: cfg.apiKey } },
	};
	writeText(cliFile, JSON.stringify(cliCfg, null, 2));
	log(`已将 ZCode 当前模型设为 ${cliCfg.model}`);

	/* 上面两处是 CLI/注册表口径；GUI 的当前模型另存 renderer 的 localStorage
	 * （zcode-last-agent-config:<agent>:<scope>，值 custom:<供应商>:<模型>），不驱动界面的话
	 * 界面仍用用户旧供应商、聊天不走 CCB——实测只写文件时界面停留在「中转1/glm-5.3」。
	 * 取证与实现见 zcodeui.js。 */
	const exe = findLaunchExe(client, detected);
	if (!exe) {
		log('未找到程序位置，无法自动设置界面当前模型。请点「详情」手动选择路径后重新配置。');
		log('完成。模型已注册；打开客户端后请在模型选择器里选 CCB 的模型。');
		return { ok: true };
	}

	const r = await selectZCodeModel({ exePath: exe, providerId: ZCODE_PROVIDER_KEY, modelId: model, label: client.name, log });
	if (r.entries && r.entries.length) saveGuiChoice([root], 'ccb-zcode-gui.json', r.entries, log);

	/* selectDefaultModel 会以调试端口拉起客户端，注入完立刻关掉（同 WorkBuddy 的处理） */
	await sleep(800);
	await stopClient(client);

	if (!r.ok) {
		log(r.error);
		log('完成。模型已注册，但界面当前模型未能自动设置。');
		return { ok: true, warning: r.error };
	}
	log('完成。已写入全部模型并把界面当前模型设为 CCB 的。');
	return { ok: true };
}

async function rollbackZCode(log, client, detected) {
	const root = path.join(HOME, (client && client.homeDir) || '.zcode');
	let changed = 0;
	const v2 = path.join(root, 'v2', 'config.json');
	if (fs.existsSync(v2)) {
		if (restoreBackup(v2, log)) {
			changed++;
		} else {
			const data = readJsonObject(v2);
			if (data.provider && data.provider[ZCODE_PROVIDER_KEY]) {
				delete data.provider[ZCODE_PROVIDER_KEY];
				writeText(v2, JSON.stringify(data, null, 2));
				log(`已从 ${v2} 移除 CCB 供应商`);
				changed++;
			}
		}
	}
	const cliFile = path.join(root, 'cli', 'config.json');
	if (fs.existsSync(cliFile)) {
		if (restoreBackup(cliFile, log)) {
			changed++;
		} else {
			const cliCfg = readJsonObject(cliFile);
			let touched = false;
			if (typeof cliCfg.model === 'string' && cliCfg.model.startsWith(ZCODE_PROVIDER_KEY + '/')) {
				delete cliCfg.model;
				touched = true;
			}
			if (cliCfg.provider && cliCfg.provider[ZCODE_PROVIDER_KEY]) {
				delete cliCfg.provider[ZCODE_PROVIDER_KEY];
				touched = true;
			}
			if (cliCfg.provider && typeof cliCfg.provider === 'object' && !Object.keys(cliCfg.provider).length) {
				delete cliCfg.provider;
			}
			if (touched) {
				if (Object.keys(cliCfg).length === 0) fs.rmSync(cliFile);
				else writeText(cliFile, JSON.stringify(cliCfg, null, 2));
				log('已清理 ZCode 的当前模型与供应商');
				changed++;
			}
		}
	}

	/* 界面当前模型存在客户端自己的 localStorage 里，不还原的话回滚后界面还指着
	 * 已被移除的 CCB 供应商。快照在写入时留下（见 saveGuiChoice），照它还原。 */
	const { entries, files } = loadGuiChoice([root], GUI_SNAPSHOT_FILES.zcode, log);
	if (entries.length) {
		const exe = findLaunchExe(client, detected);
		if (!exe) {
			log('未找到程序位置，界面当前模型未还原。请点「详情」手动选择路径后重新回滚。');
		} else {
			const r = await restoreZCodeModel({ exePath: exe, entries, label: client.name, log });
			await sleep(800);
			await stopClient(client);
			if (r.ok) {
				changed++;
				for (const f of files) {
					try { fs.rmSync(f); } catch {}
				}
			} else {
				/* 快照留着，用户修好问题后再点一次回滚还能还原 */
				log(r.error);
			}
		}
	}

	log(changed ? '回滚完成。请重启 ZCode。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- 回滚 ---------- */
/** 回滚单个配置目录的 models.json / settings.json（WorkBuddy 与 CodeBuddy 共用） */
function modelsJsonIsCcbOnly(file) {
	try {
		const data = JSON.parse(readText(file));
		const models = Array.isArray(data) ? data : data && Array.isArray(data.models) ? data.models : [];
		return models.length > 0 && models.every((m) => m && m.vendor === 'CCB');
	} catch {
		/* 解析失败按「含其他内容」处理，不删除 */
		return false;
	}
}

function rollbackModelsJsonDir(dir, log) {
	let changed = 0;
	const file = path.join(dir, 'models.json');
	const bak = file + '.bak';
	const hadBak = fs.existsSync(bak);
	if (hadBak) {
		fs.copyFileSync(bak, file);
		log(`已恢复 ${file}`);
		changed++;
	}
	if (fs.existsSync(file) && modelsJsonIsCcbOnly(file)) {
		/* 备份里也只有 CCB 内容 → 该文件本就是我们新建的，直接删除并清掉备份 */
		fs.rmSync(file);
		if (hadBak) fs.rmSync(bak);
		log(`已删除 ${file}（CCB 新建的配置文件）`);
		changed++;
	} else if (fs.existsSync(file) && !hadBak) {
		log(`跳过 ${file}：包含非 CCB 模型且没有备份，未做修改`);
	}

	/* settings.json（默认模型所在）：优先还原备份；
	 * 无备份且内容只剩 model 一个字段，说明是我们新建的（backupOnce 只对已存在文件备份），删除 */
	const settingsFile = path.join(dir, 'settings.json');
	if (restoreBackup(settingsFile, log)) {
		changed++;
	} else if (fs.existsSync(settingsFile)) {
		try {
			const d = JSON.parse(readText(settingsFile));
			if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && 'model' in d) {
				fs.rmSync(settingsFile);
				log(`已删除 ${settingsFile}（CCB 新建的配置文件）`);
				changed++;
			}
		} catch {
			/* 解析失败则不动它 */
		}
	}
	return changed;
}

async function rollbackWorkBuddy(log, client, detected) {
	let changed = 0;
	const dirs = (client && client.configDirs) || [];
	for (const dir of dirs) {
		changed += rollbackModelsJsonDir(dir, log);
	}

	/* 界面默认模型存在客户端自己的 localStorage 里，不还原的话回滚后界面还指着一个
	 * 已经不存在的 CCB 模型。快照在写入时留下（见 saveGuiChoice），照它还原。 */
	const snapshotName = GUI_SNAPSHOT_FILES.workbuddy;
	const entries = [];
	const snapshots = [];
	for (const dir of dirs) {
		const file = path.join(dir, snapshotName);
		if (!fs.existsSync(file)) continue;
		snapshots.push(file);
		try {
			const d = JSON.parse(readText(file));
			if (d && Array.isArray(d.entries)) entries.push(...d.entries);
		} catch {
			log(`警告：${snapshotName} 解析失败，界面默认模型未还原`);
		}
	}
	if (entries.length) {
		const exe = findLaunchExe(client, detected);
		if (!exe) {
			log('未找到程序位置，界面默认模型未还原。请点「详情」手动选择路径后重新回滚。');
		} else {
			const r = await restoreWorkBuddyModel({ exePath: exe, entries, label: client.name, log });
			await sleep(800);
			await stopClient(client);
			if (r.ok) {
				changed++;
				for (const f of snapshots) {
					try { fs.rmSync(f); } catch {}
				}
			} else {
				/* 快照留着，用户修好问题（比如手动选路径）后再点一次回滚还能还原 */
				log(r.error);
			}
		}
	}

	log(changed ? '回滚完成。请重启 WorkBuddy。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

function rollbackCodeBuddy(log, client) {
	let changed = 0;
	for (const dir of (client && client.configDirs) || []) {
		changed += rollbackModelsJsonDir(dir, log);
	}
	for (const dir of (client && client.appDirs) || []) {
		const appData = path.join(APPDATA, dir);
		/* 各工作区库：从首次写入前的备份还原（连同 WAL/SHM） */
		for (const file of codebuddyWorkspaceDbs(appData)) {
			if (restoreSqlite(file, log)) changed++;
		}
		/* 旧版曾把选中模型错写进全局库，一并尝试还原（通常无备份，no-op） */
		if (restoreBackup(vscdb.stateDbPath(appData), log)) changed++;
	}
	log(changed ? '回滚完成。请重启 CodeBuddy。' : '没有找到需要回滚的内容。');
	return { ok: true };
}

/* ---------- 旧版遗留：Kiro 环境变量清理 ----------
 * 1.0.0 版曾用 setx 把 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
 * 写进 HKCU\Environment，但 Kiro 从不读它们（取证见 clients.js「已下架」），属无效配置；
 * 而 ANTHROPIC_BASE_URL 是全局变量，会连带影响本机其它 Anthropic 兼容工具，
 * 所以 Kiro 下架后仍保留这个显式清理入口（改由「高级设置」提供）。
 */
const LEGACY_KIRO_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'];

function cleanupLegacyKiroEnv(log) {
	let removed = 0;
	for (const name of LEGACY_KIRO_ENV) {
		if (regQueryUserEnv(name) === null) continue;
		const r = spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], {
			encoding: 'utf8', timeout: 10000, windowsHide: true,
		});
		if (r.status === 0) {
			log(`已删除环境变量 ${name}`);
			removed++;
		} else {
			log(`失败：删除环境变量 ${name} 出错`);
		}
	}
	log(removed ? '清理完成。请注销重登或重启后生效。' : '当前没有旧版写入的环境变量。');
	return { ok: true };
}

/* ---------- 分发 ----------
 * needsClosed：该客户端配置存在 SQLite 数据库中，写入前必须完全退出。
 *   运行中的客户端会在退出时用内存状态回写，覆盖我们的修改；并发写还有损坏风险。
 *   需关闭的进程名取自 clients.js 的 exeNames（同一份清单，避免两处维护）。
 *   WorkBuddy 同样必须关闭：它是托盘应用，主进程持有 models.json 的内存副本，
 *   运行中写入会在其后续落盘时被覆盖（实测会把自己的空数组写回去，CCB 模型全丢）。
 */
const WRITERS = {
	workbuddy: { apply: writeWorkBuddy, rollback: rollbackWorkBuddy, needsClosed: true },
	codebuddy: { apply: writeCodeBuddy, rollback: rollbackCodeBuddy, needsClosed: true },
	traeui: { apply: writeTraeUi, rollback: rollbackTraeUi },
	cursor: { apply: writeCursor, rollback: rollbackCursor, needsClosed: true },
	qoder: { apply: writeQoder, rollback: rollbackQoder, needsClosed: true },
	qoderappcn: { apply: writeQoderAppCn, rollback: rollbackQoderAppCn, needsClosed: true },
	qoderwork: { apply: writeQoderWork, rollback: rollbackQoderWork, needsClosed: true },
	zcode: { apply: writeZCode, rollback: rollbackZCode, needsClosed: true },
};

/** 返回需要先关闭的进程名列表（空数组表示无需关闭） */
function guardProcesses(entry, client) {
	if (!entry.needsClosed) return [];
	return client.exeNames || [];
}

/**
 * 写入前把目标客户端关干净。
 *
 * 托盘类应用（WorkBuddy）关掉窗口只是收进托盘，进程仍在跑并持有配置，必须强制结束整棵
 * 进程树。一键配置的语义是「配置并启动」，客户端本来就要重启，所以这里直接自动关闭，
 * 不再让用户手动退出后「再点一次」。
 * @returns {string|null} 关闭失败时的错误信息
 */
async function closeBeforeWrite(client, running, log) {
	log(`检测到 ${running.join('、')} 正在运行，正在自动关闭以便安全写入…`);
	const { stopped } = await stopClient(client);
	if (!stopped) {
		const msg = `请先完全退出 ${client.name}（检测到 ${running.join('、')} 正在运行），再点一次一键配置`;
		log(msg);
		return msg;
	}
	log(`已关闭 ${client.name}，继续写入配置。`);
	return null;
}

async function applyConfig(clientId, cfg, detected) {
	const client = getClient(clientId);
	if (!client) return { ok: false, error: '未知客户端' };
	const entry = client.writer ? WRITERS[client.writer] : null;
	if (!entry) return { ok: false, error: '该客户端暂不支持自动写入' };
	if (!cfg.apiKey) return { ok: false, error: '缺少 API Key' };
	if (!cfg.models || !cfg.models.length) return { ok: false, error: '请至少选择一个模型' };

	const logLines = [];
	const log = (msg) => logLines.push(msg);

	/* 运行中先自动关闭，再写入 */
	const guard = guardProcesses(entry, client);
	if (guard.length) {
		const running = runningAmong(guard);
		if (running.length) {
			const err = await closeBeforeWrite(client, running, log);
			if (err) return { ok: false, error: err, log: logLines };
		}
	}

	try {
		const result = await entry.apply(cfg, log, client, detected);
		return { ...result, log: logLines };
	} catch (e) {
		logLines.push(`错误：${e.message}`);
		return { ok: false, error: e.message, log: logLines };
	}
}

async function rollbackConfig(clientId, detected) {
	const client = getClient(clientId);
	const entry = client && client.writer ? WRITERS[client.writer] : null;
	if (!entry) return { ok: false, error: '该客户端暂不支持回滚' };
	const logLines = [];
	const log = (msg) => logLines.push(msg);
	const guard = guardProcesses(entry, client);
	if (guard.length) {
		const running = runningAmong(guard);
		if (running.length) {
			const err = await closeBeforeWrite(client, running, log);
			if (err) return { ok: false, error: err, log: logLines };
		}
	}
	try {
		const result = await entry.rollback(log, client, detected);
		return { ...result, log: logLines };
	} catch (e) {
		logLines.push(`错误：${e.message}`);
		return { ok: false, error: e.message, log: logLines };
	}
}

module.exports = {
	applyConfig,
	rollbackConfig,
	cleanupLegacyKiroEnv,
	qoderWorkRow,
	qoderEncrypt,
	qoderDecrypt,
	writeCursorForDir,
	rollbackCursorForDir,
	writeCursorProxySettings,
   rollbackCursorProxySettings,
   isCursorProxyActive,
	writeQoderCnProxySettings,
	rollbackQoderCnProxySettings,
	qoderCnUserSettingsPath,
	isQoderProxyActive,
	writeQoderCnVscdbModels,
	rollbackQoderCnVscdbModels,
	reapplyQoderCn,
	hasQoderCnModels,
	parseJsonc,
	CURSOR_PROXY_DEFAULT_PORT,
	saveGuiChoice,
	accountUidsUnder,
};
