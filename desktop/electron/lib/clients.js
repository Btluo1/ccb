const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PROGRAMS = path.join(LOCALAPPDATA, 'Programs');

const EXE_SEARCH_ROOTS = [
	PROGRAMS,
	LOCALAPPDATA,
	process.env.ProgramFiles || 'C:\\Program Files',
	process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
];

const APP_PATH_ROOTS = [
	'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
	'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
	'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
];

/**
 * 支持的客户端清单（14 项，全部为**桌面客户端**）
 *
 * 产品定位：一键配置面向桌面客户端，不含 CLI 工具（Codex CLI 已下架，
 * 也不写 traecli 的 YAML——那些是各自 CLI 的独占配置）。
 * 清单里的每一项都必须能做到一键写入，做不到的不进清单（见下方「已下架」）。
 *
 * 字段说明：
 *   appDirs    —— %APPDATA% 下的用户数据目录名（VS Code 分支 / Electron 应用的 userData）
 *   exeNames   —— 可执行文件名，用于进程守卫、注册表 App Paths 探测与启动
 *   homeDir    —— 用户主目录下的产品数据目录（~/.trae、~/.qoder 等），部分产品把配置放这里
 *   cli        —— 命令行程序名（where 探测）
 *   configDirs —— 需要逐目录检查 models.json 的配置目录（WorkBuddy / CodeBuddy 系）
 *   writer     —— writers.js 中的写入器名
 *   trayApp    —— 常驻托盘的应用（关窗口不退进程）。关闭时必须直接 /F /T 结束整棵树，
 *                 不能走「先 taskkill 不带 /F」的优雅关闭（见 launcher.js 的说明）
 *
 * 关键实测结论（勿凭产品名臆测）：
 *   - 「TraeCode CN」就是字节中国版 Trae IDE（安装目录仍是 Programs\Trae CN）
 *   - 「TraeWork CN」就是 TRAE SOLO CN（userData 目录仍是 TRAE SOLO CN），其模型列表
 *     场景与 Trae IDE 完全不同（9 个 solo 场景 vs 7 个 IDE 场景）；四端模型列表均由
 *     服务端同步覆盖，本地文件写入无效，因此走 CDP 驱动官方「添加模型」界面（traeui.js）
 *   - 「Qoder IDE」是 VS Code 分支（~/.qoder、%APPDATA%\Qoder）；Qoder 独立桌面 App
 *     是另一个产品（userData 为 com.qoder.app.stable）
 *   - 「Qoder CN」桌面版与「Qoder CN IDE」共用同一个 qodercli 配置目录 ~/.qoder-cn
 *     （CN 版产品配置 cliConfigDirectoryName=".qoder-cn"），因此两者的自定义模型走同一份
 *     settings.json / .models 缓存；桌面版的模型列表来自内置 qodercli 的模型目录
 *
 * 已下架（无法一键写入，不列入支持清单）：
 *   - Kiro：逐 bundle 取证确认没有任何 BYOK 通道——扩展未注册语言模型提供方，
 *     不读 ANTHROPIC_BASE_URL 等环境变量，请求走私有协议 runtime.{region}.kiro.dev，
 *     普通 OpenAI/Anthropic 兼容中转无法对接。
 *   - Kimi 桌面客户端：daimon 内核对「第三方网关 BYOK」有 DNS 内网 IP 硬开关
 *     （公网不可能通过，自定义模型永不进选择器），且 KimiWorkModelService 会用服务端
 *     下发配置覆盖本地写入；MITM 代理方案（kimiproxy，2026-09-30）实测也拦不到流量，
 *     两条路都走不通，整体下架。
 *   - Qoder 独立桌面 App（国际版，com.qoder.app.stable）：它的 BYOK（界面叫「个人模型」）
 *     只允许从内置 Qoder Runtime 目录里挑 Provider，且 Provider 必须「只有一个 api_key
 *     字段」；其 byok_model_profiles 表没有 endpoint_url / configuration_kind 字段
 *     （CN 版才有），无处存放自建地址，凭据还是 safeStorage(DPAPI) 密文。
 *   （CN 版同产品 com.qodercn.app.stable 有 settings.json 的 modelConfigs 通道，仍在清单内）
 */

/**
 * 品牌图标映射：客户端 id → 图标文件名（renderer/icons/<name>.png，64×64 透明 PNG）
 *
 * 图标来源为本机各客户端自带的品牌资源（应用图标/随包 logo），提取脚本见
 * scripts/extract-icons.ps1；同一产品的国际版/中国版共用一张（它们本来就是同一品牌）：
 *   - Trae 与 TraeCode CN 的 exe 图标完全一致 → 共用 trae
 *   - WorkBuddy CN 与 WorkBuddy AI 的 icon.png 完全一致 → 共用 workbuddy
 *   - Qoder IDE 国际版本机未安装 → 与 Qoder CN IDE 共用 qoder（同一品牌标记）
 *   - TraeWork / QoderWork 国际版本机未安装 → 与各自 CN 版共用
 *   - Qoder CN 桌面版用 qoder-app（Qoder 独立 App 的图标，与 IDE 版区分开）
 */
const BRAND_ICONS = {
	'trae-intl': 'trae',
	'trae-cn': 'trae',
	'traework-intl': 'traework',
	'traework-cn': 'traework',
	'qoder-intl': 'qoder',
	'qoder-cn': 'qoder',
	'qoder-app-cn': 'qoder-app',
	'qoderwork-intl': 'qoderwork',
	'qoderwork-cn': 'qoderwork',
	'codebuddy-cn': 'codebuddy',
	'wb-intl': 'workbuddy',
	'wb-cn': 'workbuddy',
	zcode: 'zcode',
	cursor: 'cursor',
};

/**
 * Trae 系（Trae / TraeCode / TraeWork，四端共用同一套模型模块 @byted-icube/ai-modules-chat）
 * 的写入方式与其它客户端不同：**不能写本地文件，只能驱动客户端自己的「添加模型」界面**。
 * 逐条取证：
 *   1. 该模块内 `K = "AI.agent.model.model_list_map"`，`storeModelListMap()` 把模型列表
 *      序列化写进 state.vscdb；`getModelListMapFromCache()` 只把它当**缓存**读。
 *   2. 列表的真实来源是服务端 RPC：`ModelService._refreshModelListByFunction()` →
 *      `model-list-service`，启动/刷新时整表重取并调 `setOriginModelListMapAndCache()`
 *      覆盖本地（`this._modelStorageService.storeModelListMap(o)`）。
 *   3. 实测（TraeWork CN）：写入 19 模型 × 9 场景 = 171 条 CCB 条目，当场查库确认在；
 *      启动客户端后该键 171 条 → 0，value 长度回到写入前的 170651 字符，**字节级还原**。
 *      此时密钥有效（本地中转 /v1/models 200、chat 成功并正确扣费），故与密钥无关。
 *   4. 自定义模型有官方通道，配置存 Trae 账号：模块内含「添加模型」UI 文案
 *      （add_model_tooltip_text「配置 API key 添加更多可用模型」/ custom_models
 *      「用户自定义添加的模型列表，使用用户的 API Key 资源」）与 RPC 方法
 *      AddCustomModel / UpdateCustomModel / TestModelConnect。
 * 结论：本地文件写入必被覆盖，因此改用 CDP 驱动官方界面（traeui.js），配置落到账号上，
 * 重启不丢。要求客户端已登录 Trae 账号。
 */
const TRAE_WRITER = 'traeui';

const CLIENTS = [
	{
		id: 'trae-intl', name: 'Trae', variant: '国际版', vendor: '字节跳动', site: 'trae.ai',
		glyph: 'T', accent: '#7c3aed', mode: 'auto', writer: TRAE_WRITER, provider: 'openai',
		appDirs: ['Trae'],
		exeNames: ['Trae.exe'],
		homeDir: '.trae',
	},
	{
		id: 'trae-cn', name: 'TraeCode', variant: '中国版', vendor: '字节跳动', site: 'trae.cn',
		glyph: 'T', accent: '#2563eb', mode: 'auto', writer: TRAE_WRITER, provider: 'openai',
		appDirs: ['Trae CN'],
		exeNames: ['Trae CN.exe', 'TRAE CN.exe'],
		homeDir: '.trae-cn',
	},
	{
		id: 'traework-intl', name: 'TraeWork', variant: '国际版', vendor: '字节跳动', site: 'trae.ai',
		glyph: 'TW', accent: '#9333ea', mode: 'auto', writer: TRAE_WRITER, provider: 'openai',
		/* 国际版本机未装过，目录名是按 CN 版（TRAE SOLO CN）去掉 CN 后缀推断的，
		 * 故列多个候选；即使全猜错，下面的 findExeEverywhere 兜底仍能按 exe 名从
		 * 注册表 App Paths / 开始菜单快捷方式 / 卸载表反查到真实安装路径。 */
		appDirs: ['TRAE SOLO', 'TRAE SOLO GLOBAL', 'TraeWork', 'TRAE Work'],
		exeNames: ['TRAE SOLO.exe', 'TRAE SOLO GLOBAL.exe', 'TraeWork.exe', 'TRAE Work.exe'],
	},
	{
		id: 'traework-cn', name: 'TraeWork', variant: '中国版', vendor: '字节跳动', site: 'trae.cn',
		glyph: 'TW', accent: '#4f46e5', mode: 'auto', writer: TRAE_WRITER, provider: 'openai',
		appDirs: ['TRAE SOLO CN'],
		exeNames: ['TRAE SOLO CN.exe'],
	},
	{
		id: 'qoder-intl', name: 'Qoder IDE', variant: '国际版', vendor: '阿里巴巴', site: 'qoder.com',
		glyph: 'Q', accent: '#ea580c', mode: 'auto', writer: 'qoder', provider: 'openai',
		appDirs: ['Qoder'],
		exeNames: ['Qoder.exe'],
		cli: 'qoder',
		homeDir: '.qoder',
	},
	{
		/* Qoder CN IDE 1.30+ 一键配置 v2（Plan B，2026-09-29）：
		 * 模型挂官方预定义 provider 'deepseek' 过 UI 校验，apiKey 用 CCB 平台密钥；
		 * 本地 MITM 代理（qoderproxy，127.0.0.1:9183）把携带 sk-ccb 密钥的推理请求
		 * 直接重定向到 CCB 中转站（Go 客户端按 provider 路由到 Qoder 网关，base_url 被丢弃，
		 * 故以密钥为识别特征）。IDE 必须经 CCB「启动 / 重启」按钮启动（注入 HTTPS_PROXY）。
		 * 启动前 reapplyQoderCn 重写 vscdb，对冲 IDE 退出时清空 customModels 的问题。 */
		id: 'qoder-cn', name: 'Qoder CN IDE', variant: '中国版', vendor: '阿里巴巴', site: 'qoder.com.cn',
		glyph: 'Q', accent: '#dc2626', mode: 'auto', writer: 'qoder', provider: 'openai',
		appDirs: ['QoderCN'],
		exeNames: ['Qoder CN IDE.exe'],
		homeDir: '.qoder-cn',
	},
	{
		id: 'qoder-app-cn', name: 'Qoder CN', variant: '桌面版', vendor: '阿里巴巴', site: 'qoder.com.cn',
		glyph: 'Q', accent: '#ef4444', mode: 'auto', writer: 'qoderappcn', provider: 'openai',
		appDirs: ['com.qodercn.app.stable'],
		exeNames: ['Qoder CN.exe'],
		homeDir: '.qoder-cn',
	},
	{
		/* QoderWork（对话式客户端，非 IDE）聊天走内置 @qoder-ai/qoder-agent-sdk 的
		 * Node worker（原生 gRPC → gateway.qoder.com），两道门禁拦自定义模型：
		 * get_model_policy 权益拒绝（worker→主进程 control_request）+ 网关权益拒绝。
		 * CCB 一键配置就地补丁 worker runtime：sk-ccb- 请求短路 gRPC 直连中转 +
		 * 跳过策略门禁（writers.js writeQoderWork → qoderbridge.js，2026-10-01 打通）。
		 * 国际版目录名系按 CN 版规律推断（appDirs=['QoderWork']），与 CN 版
		 * （'QoderWork CN'）不同名，不共用配置。 */
		id: 'qoderwork-intl', name: 'QoderWork', variant: '国际版', vendor: '阿里巴巴', site: 'qoder.com',
		glyph: 'QW', accent: '#c2410c', mode: 'auto', writer: 'qoderwork', provider: 'openai',
		appDirs: ['QoderWork'],
		exeNames: ['QoderWork.exe'],
		homeDir: '.qoderwork',
	},
	{
		/* 同上：聊天链路经 qoderbridge 补丁打通；安装实测路径 F:\360Downloads\QoderWork CN */
		id: 'qoderwork-cn', name: 'QoderWork', variant: '中国版', vendor: '阿里巴巴', site: 'qoder.com.cn',
		glyph: 'QW', accent: '#b91c1c', mode: 'auto', writer: 'qoderwork', provider: 'openai',
		appDirs: ['QoderWork CN'],
		exeNames: ['QoderWork CN.exe'],
		homeDir: '.qoderworkcn',
	},
	{
		id: 'codebuddy-cn', name: 'CodeBuddy', variant: '中国版', vendor: '腾讯', site: 'copilot.tencent.com',
		glyph: 'CB', accent: '#0ea5e9', mode: 'auto', writer: 'codebuddy', provider: 'codebuddy',
		appDirs: ['CodeBuddy CN'],
		exeNames: ['CodeBuddy CN.exe'],
		homeDir: '.codebuddycn',
		configDirs: [path.join(HOME, '.codebuddy')],
	},
	{
		id: 'wb-intl', name: 'WorkBuddy AI', variant: '国际版', vendor: '腾讯', site: 'workbuddy.ai',
		glyph: 'W', accent: '#0284c7', mode: 'auto', writer: 'workbuddy', provider: 'codebuddy',
		trayApp: true,
		appDirs: ['WorkBuddy AI'],
		exeNames: ['WorkBuddyAI.exe', 'WorkBuddy AI.exe'],
		homeDir: '.workbuddy-ai',
		configDirs: [path.join(HOME, '.workbuddy-ai')],
	},
	{
		id: 'wb-cn', name: 'WorkBuddy', variant: '中国版', vendor: '腾讯', site: 'workbuddy.cn',
		glyph: 'W', accent: '#059669', mode: 'auto', writer: 'workbuddy', provider: 'codebuddy',
		trayApp: true,
		appDirs: ['WorkBuddy'],
		exeNames: ['WorkBuddy.exe'],
		homeDir: '.workbuddy',
		configDirs: [path.join(HOME, '.workbuddy')],
	},
	{
		id: 'zcode', name: 'ZCode', variant: '', vendor: '智谱', site: 'z.ai',
		glyph: 'Z', accent: '#0891b2', mode: 'auto', writer: 'zcode', provider: 'openai',
		appDirs: ['ZCode'],
		exeNames: ['ZCode.exe'],
		homeDir: '.zcode',
	},
	{
		id: 'cursor', name: 'Cursor', variant: '', vendor: 'Anysphere', site: 'cursor.com',
		glyph: 'C', accent: '#475569', mode: 'auto', writer: 'cursor', provider: 'cursor',
		appDirs: ['Cursor', 'cursor'],
		exeNames: ['Cursor.exe'],
	},
];

function exists(p) {
	try { return fs.existsSync(p); } catch { return false; }
}

function isDir(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function whereCmd(exe) {
	try {
		const r = spawnSync('where', [exe], { encoding: 'utf8', timeout: 8000, windowsHide: true });
		if (r.status === 0 && r.stdout) {
			const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
			if (first) return first.trim();
		}
	} catch {}
	return null;
}

function regQueryUserEnv(name) {
	try {
		const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
			encoding: 'utf8', timeout: 8000, windowsHide: true,
		});
		if (r.status === 0 && r.stdout) {
			const m = r.stdout.match(/REG_[A-Z_]+\s+(.*)/);
			if (m) return m[1].trim();
		}
	} catch {}
	return null;
}

/* 注册表 App Paths：覆盖任意盘符的自定义安装位置 */
function regQueryExe(exeName) {
	for (const root of APP_PATH_ROOTS) {
		try {
			const r = spawnSync('reg', ['query', root + '\\' + exeName, '/ve'], {
				encoding: 'utf8', timeout: 8000, windowsHide: true,
			});
			if (r.status === 0 && r.stdout) {
				const m = r.stdout.match(/REG_SZ\s+(.+)/);
				const v = m && m[1].trim();
				if (v && exists(v)) return v;
			}
		} catch {}
	}
	return null;
}

/* 卸载信息：InstallLocation 很多产品会写，DisplayIcon 更是几乎都写（指向 exe 或其所在目录的图标）。
 * 实测本机：Kimi/ZCode/CodeBuddy/WorkBuddy/Qoder/QoderWork/Cursor/Trae 全都装在
 * F:\ 下的自定义目录（F:\rhhj\WorkBuddy、F:\360Downloads\QoderWork CN…），
 * 只按 C:\Program Files 猜路径一个都找不到 —— 这也是「配置写好了但客户端起不来」的根因。 */
let uninstallCache = null;
function uninstallEntries() {
	if (uninstallCache) return uninstallCache;
	const roots = [
		'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
		'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
		'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
	];
	const out = [];
	for (const root of roots) {
		try {
			const r = spawnSync('reg', ['query', root, '/s'], {
				encoding: 'utf8', timeout: 20000, windowsHide: true,
			});
			if (r.status !== 0 || !r.stdout) continue;
			let displayName = null;
			let cur = null;
			for (const line of r.stdout.split(/\r?\n/)) {
				const key = /^HKEY_[^\r\n]*\\([^\\]+)\s*$/.exec(line.trim());
				if (key) {
					if (cur) out.push(cur);
					displayName = key[1];
					cur = { displayName, installLocation: null, displayIcon: null };
					continue;
				}
				const m = /^\s*(DisplayIcon|InstallLocation)\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
				if (m && cur) {
					if (m[1].toLowerCase() === 'displayicon') cur.displayIcon = m[2];
					else cur.installLocation = m[2];
				}
			}
			if (cur) out.push(cur);
		} catch {}
	}
	uninstallCache = out;
	return out;
}

/** 开始菜单快捷方式指向的真实 exe：桌面客户端基本都会建，且路径一定对。
 *  直接扫 .lnk 二进制里的路径串（ANSI + UTF-16LE 两种编码），实测 121 个快捷方式只要 5ms。 */
let shortcutCache = null;
function startMenuTargets() {
	if (shortcutCache) return shortcutCache;
	const roots = [
		path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
		path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
	];
	const lnks = [];
	const walk = (dir, depth) => {
		if (depth > 4) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else if (e.name.toLowerCase().endsWith('.lnk')) lnks.push(p);
		}
	};
	for (const r of roots) walk(r, 0);

	const out = [];
	for (const lnk of lnks) {
		let text;
		try {
			text = fs.readFileSync(lnk);
		} catch {
			continue;
		}
		for (const enc of ['latin1', 'utf16le']) {
			for (const m of text.toString(enc).matchAll(/[A-Za-z]:\\[^\u0000-\u001f<>|?*"]{2,200}?\.exe/gi)) {
				out.push({ shortcut: path.basename(lnk, '.lnk'), target: m[0] });
			}
		}
	}
	shortcutCache = out;
	return out;
}

/** 在目录里按 exeNames 找可执行文件（含浅层子目录，如 Qoder CN 的 .qoder-versions\0.3.3\） */
function findExeDeep(dir, exeNames, depth = 3) {
	const direct = findExeInDir(dir, exeNames);
	if (direct) return direct;
	if (depth <= 0) return null;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const hit = findExeDeep(path.join(dir, e.name), exeNames, depth - 1);
		if (hit) return hit;
	}
	return null;
}

/** 依次从 App Paths → 开始菜单快捷方式 → 卸载表 DisplayIcon → 卸载表安装目录里找 exe */
function findExeEverywhere(exeNames) {
	for (const name of exeNames || []) {
		const p = regQueryExe(name);
		if (p) return p;
	}
	const wanted = (exeNames || []).map((n) => n.toLowerCase());
	for (const t of startMenuTargets()) {
		if (wanted.includes(path.basename(t.target).toLowerCase()) && exists(t.target)) return t.target;
	}
	for (const e of uninstallEntries()) {
		const icon = (e.displayIcon || '').replace(/,\s*-?\d+\s*$/, '').replace(/^"|"$/g, '');
		if (icon && wanted.includes(path.basename(icon).toLowerCase()) && exists(icon)) return icon;
	}
	for (const e of uninstallEntries()) {
		for (const raw of [e.displayIcon, e.installLocation]) {
			const p = (raw || '').replace(/,\s*-?\d+\s*$/, '').replace(/^"|"$/g, '');
			if (!p || !exists(p)) continue;
			/* DisplayIcon 常见两种：直接指向 exe（WorkBuddy），或指向 uninstallerIcon.ico
			 * 这类图标文件（ZCode / Qoder / Qoder CN）——后者要取其所在目录再找 exe */
			const dir = isDir(p) ? p : path.dirname(p);
			const hit = findExeDeep(dir, exeNames);
			if (hit) return hit;
		}
	}
	return null;
}

/** 按产品显示名（忽略大小写与空格差异）查安装目录 */
function regQueryInstallLocation(names) {
	const wanted = names.map((n) => n.toLowerCase().replace(/\s+/g, ''));
	for (const e of uninstallEntries()) {
		const dn = e.displayName.toLowerCase().replace(/\s+/g, '');
		if (wanted.some((w) => dn === w || dn.startsWith(w))) {
			const dir = e.installLocation.replace(/^"|"$/g, '').replace(/\\+$/, '');
			if (dir && exists(dir)) return dir;
		}
	}
	return null;
}

/** 在安装目录里找可执行文件 */
function findExeInDir(dir, exeNames) {
	for (const name of exeNames || []) {
		const p = path.join(dir, name);
		if (exists(p)) return p;
	}
	return null;
}

function detectAppDirs(names, exeNames) {
	const found = [];
	for (const dir of names) {
		const userData = path.join(APPDATA, dir);
		let exe = null;
		for (const root of EXE_SEARCH_ROOTS) {
			const candidates = [
				path.join(root, dir, `${dir}.exe`),
				path.join(root, dir, `${dir.replace(/\s+/g, '')}.exe`),
			];
			exe = candidates.find(exists) || null;
			if (exe) break;
		}
		if (!exe) {
			/* 安装目录名常与 userData 名不同（如 WorkBuddy 装在 F:\rhhj\WorkBuddy） */
			const loc = regQueryInstallLocation([dir]);
			if (loc) exe = findExeInDir(loc, exeNames);
		}
		if (exists(userData) || exe) {
			found.push({ dir, userData, exe });
		}
	}
	return found;
}

/**
 * 从用户指定的自定义路径解析出可执行文件：
 *   - 路径本身是 .exe → 直接返回
 *   - 路径是目录 → 在其中（含浅层子目录）按 exeNames 查找
 *   - 都不是 → null（调用方据此判定 mismatch）
 * 与 launcher.findLaunchExe 的解析逻辑一致，这里独立一份供检测层展示/校验用，
 * 避免检测层反向依赖 launcher（launcher 依赖 clients，会成环）。
 */
function resolveCustomExe(c, custom) {
	if (!custom || !exists(custom)) return null;
	if (/\.exe$/i.test(custom)) return custom;
	if (isDir(custom)) return findExeDeep(custom, c.exeNames || [], 3);
	return null;
}

/**
 * 校验用户所选路径是否像该客户端：
 *   strong  —— 程序名命中 exeNames，或在所选目录里找到了对应 exe（最可靠）
 *   medium  —— 所选是目录且里面有 .exe，但程序名对不上（可能是改名/便携版，建议人工核对）
 *   none    —— 既不是 exe、目录里也没有任何 .exe，或 exe 名完全不符且无旁证
 * 返回 { matched, reason, exe }。reason 直接喂给界面提示。
 *
 * 设计原则：宁可「medium 提示核对」也不要误判 strong——自定义路径场景本就是
 * 用户机器千差万别（改名 build、便携包、绿色版），强拦会误伤；但 none 要拦下，
 * 因为那几乎一定是选错了（比如把 Trae 指到了 Qoder 的目录）。
 */
function validateCustomPath(c, custom) {
	if (!custom || !exists(custom)) return { matched: 'none', reason: '路径不存在', exe: null };
	const exeNames = (c.exeNames || []).map((n) => n.toLowerCase());
	const isExe = /\.exe$/i.test(custom);

	if (isExe) {
		const base = path.basename(custom).toLowerCase();
		if (exeNames.includes(base)) return { matched: 'strong', reason: `程序名匹配 ${path.basename(custom)}`, exe: custom };
		return { matched: 'none', reason: `所选是 ${path.basename(custom)}，与 ${c.name} 的已知程序名（${(c.exeNames || []).join(' / ') || '无'}）不符`, exe: custom };
	}

	if (isDir(custom)) {
		const exe = findExeDeep(custom, c.exeNames || [], 3);
		if (exe) return { matched: 'strong', reason: `在所选目录中找到 ${path.basename(exe)}`, exe };
		/* 目录里有任意 .exe 但对不上名：可能是改名/便携版，提示核对而非拦截 */
		let anyExe = null;
		try {
			for (const e of fs.readdirSync(custom, { withFileTypes: true })) {
				if (e.isFile() && /\.exe$/i.test(e.name)) { anyExe = e.name; break; }
			}
		} catch {}
		if (anyExe) return { matched: 'medium', reason: `目录中有 ${anyExe}，但未确认是否为 ${c.name}，建议核对后再使用`, exe: null };
		return { matched: 'none', reason: `所选目录中未找到 ${c.name} 的程序（${(c.exeNames || []).join(' / ') || '无'}）`, exe: null };
	}

	return { matched: 'none', reason: '请选择 .exe 程序文件或其安装目录', exe: null };
}

function detectOne(c, customPaths) {
	const result = {
		id: c.id, name: c.name, variant: c.variant, vendor: c.vendor, site: c.site,
		glyph: c.glyph, accent: c.accent, mode: c.mode, writer: c.writer || null,
		icon: BRAND_ICONS[c.id] || null,
		provider: c.provider || null,
		installed: false, evidence: [], details: {},
	};

	/* 用户手动指定的路径优先 */
	const custom = customPaths && customPaths[c.id];
	if (custom) {
		if (exists(custom)) {
			result.installed = true;
			result.evidence.push(`用户指定：${custom}`);
			result.details.customPath = custom;
			/* 校验路径是否像本客户端，并把解析到的 exe 回填，让卡片/启动器都能直接用 */
			const v = validateCustomPath(c, custom);
			result.details.pathMatched = v.matched;
			result.details.pathReason = v.reason;
			if (v.exe) {
				result.details.customResolvedExe = v.exe;
				if (!result.details.exePath) result.details.exePath = v.exe;
			}
		} else {
			result.details.staleCustomPath = custom;
			result.details.pathMatched = 'stale';
		}
	}

	if (c.cli) {
		const cliPath = whereCmd(c.cli);
		if (cliPath) {
			result.installed = true;
			result.evidence.push(`CLI：${cliPath}`);
			result.details.cliPath = cliPath;
		}
	}

	if (c.exeNames) {
		for (const exeName of c.exeNames) {
			const p = regQueryExe(exeName);
			if (p) {
				result.installed = true;
				result.evidence.push(`注册表：${p}`);
				result.details.exePath = p;
				break;
			}
		}
	}

	if (c.appDirs) {
		const apps = detectAppDirs(c.appDirs, c.exeNames);
		if (apps.length) {
			result.installed = true;
			for (const a of apps) {
				result.evidence.push(a.exe ? `程序：${a.exe}` : `数据目录：${a.userData}`);
			}
			result.details.apps = apps;
			result.details.userData = apps[0].userData;
		}
	}

	if (c.homeDir) {
		const dir = path.join(HOME, c.homeDir);
		result.details.homeDir = dir;
		if (exists(dir)) {
			result.installed = true;
			result.evidence.push(`数据目录：${dir}`);
		}
	}

	/* 兜底：按可执行文件名去开始菜单快捷方式与卸载表里找真实安装位置。
	 * 这一步专门解决「装在自定义目录（F:\rhhj\WorkBuddy 之类）」导致配置写得进、客户端却起不来的问题。 */
	if (c.exeNames && !result.details.exePath && !(result.details.apps || []).some((a) => a.exe)) {
		const p = findExeEverywhere(c.exeNames);
		if (p) {
			result.installed = true;
			result.details.exePath = p;
			result.evidence.push(`程序：${p}`);
		}
	}

	if (c.configDirs) {
		const existing = c.configDirs.filter(exists);
		result.details.configDirs = c.configDirs.map((d) => ({
			dir: d, exists: exists(d),
			modelsJson: path.join(d, 'models.json'),
			hasModelsJson: exists(path.join(d, 'models.json')),
		}));
		if (existing.length) {
			result.installed = true;
			result.evidence.push(`配置目录：${existing[0]}`);
		}
	}

	if (c.configDir) {
		result.details.configDir = c.configDir;
		result.details.hasConfigToml = exists(path.join(c.configDir, 'config.toml'));
		if (exists(c.configDir)) {
			result.installed = true;
			result.evidence.push(`配置目录：${c.configDir}`);
		}
	}

	return result;
}

function detectClients(customPaths) {
	return CLIENTS.map((c) => detectOne(c, customPaths));
}

function getClient(id) {
	return CLIENTS.find((c) => c.id === id) || null;
}

module.exports = {
	CLIENTS, detectClients, getClient, APPDATA, HOME,
	whereCmd, regQueryUserEnv, regQueryExe, regQueryInstallLocation, findExeEverywhere,
	uninstallEntries, startMenuTargets, findExeDeep, validateCustomPath, resolveCustomExe,
};
