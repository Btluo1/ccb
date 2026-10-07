import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/* 用 Node 原生 require 载入被测模块：保证测试与 writers.js 内部引用的是同一个
 * clients 模块实例，这样 patchClient 改动 CLIENTS 才能被 applyConfig 看到。 */
const require = createRequire(import.meta.url);
const writers = require('../electron/lib/writers');
const { CLIENTS } = require('../electron/lib/clients');

/* 清单里的原始配置目录：patchClient 会在用例内改写 CLIENTS，
 * 需要断言「产品真实目录」的用例必须读这份模块加载时留下的快照。 */
const ORIGINAL_CONFIG_DIRS = Object.fromEntries(CLIENTS.map((c) => [c.id, c.configDirs]));

const { applyConfig, rollbackConfig, qoderWorkRow, qoderEncrypt, qoderDecrypt, saveGuiChoice, accountUidsUnder } = writers;

const CFG = {
	apiKey: 'sk-test-roundtrip-key',
	apiBase: 'https://code.btluo.com/v1',
	anthropicBase: 'https://code.btluo.com',
	models: ['model-a', 'model-b', 'model-c'],
	defaultModel: 'model-a',
};

/* 写入器测试一律在临时目录里做：把客户端的 homeDir / appDirs / configDirs 指到临时目录，
 * 绝不触碰用户真实的客户端配置。临时目录在 afterEach 中删除。 */
const TMP = path.join(os.homedir(), '.ccb-test-tmp');
const TMP_APP = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.ccb-test-tmp');

function patchClient(id, patch) {
	const c = CLIENTS.find((x) => x.id === id);
	const before = { ...c };
	/* 默认把进程名换成不可能存在的值：测试不应依赖本机进程状态，
	 * 否则本机恰好开着该客户端时，「运行中拒绝写入」的守卫会正确地拦住测试 */
	Object.assign(c, { exeNames: ['ccb-test-no-such-client.exe'] }, patch);
	return () => Object.assign(c, before);
}

function cleanTmp() {
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(TMP_APP, { recursive: true, force: true });
}

/* 安全护栏：这些是用户真实客户端的配置文件，测试期间必须保持不变。
 * 一旦客户端补丁失效导致写入落到真实路径，afterEach 会立刻失败并暴露问题。 */
const REAL_FILES = [
	path.join(os.homedir(), '.zcode', 'v2', 'config.json'),
	path.join(os.homedir(), '.zcode', 'cli', 'config.json'),
	path.join(os.homedir(), '.qoderworkcn', '.models', 'default'),
	path.join(os.homedir(), '.qoder-cn', 'settings.json'),
	path.join(os.homedir(), '.codebuddy', 'settings.json'),
	path.join(os.homedir(), '.codebuddy', 'models.json'),
	path.join(os.homedir(), '.workbuddy', 'models.json'),
	path.join(os.homedir(), '.workbuddy', 'settings.json'),
	path.join(os.homedir(), '.workbuddy', 'ccb-workbuddy-gui.json'),
	path.join(os.homedir(), '.workbuddy-ai', 'models.json'),
	path.join(os.homedir(), '.workbuddy-ai', 'settings.json'),
	path.join(os.homedir(), '.workbuddy-ai', 'ccb-workbuddy-gui.json'),
	path.join(os.homedir(), '.codex', 'config.toml'),
	path.join(os.homedir(), '.ccb', 'codex-apply.json'),
];

function realSnapshot() {
	return REAL_FILES.map((f) => {
		try {
			const s = fs.statSync(f);
			return `${f}:${s.size}:${s.mtimeMs}`;
		} catch {
			return `${f}:absent`;
		}
	}).join('|');
}

describe('WorkBuddy 配置写入/回滚往返', () => {
	const modelsFile = path.join(TMP, 'wb', 'models.json');
	const settingsFile = path.join(TMP, 'wb', 'settings.json');
	let restore;
	let guard;

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		restore = patchClient('wb-cn', { configDirs: [path.join(TMP, 'wb')] });
	});
	afterEach(() => {
		restore();
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('apply（全新安装场景）：models.json 必须是顶层数组', async () => {
		const r = await applyConfig('wb-cn', CFG);
		expect(r.ok).toBe(true);

		const data = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
		/* WorkBuddy 客户端自己用顶层数组重写 models.json；写成 {models,…} 对象会被它替换成 []，
		 * CCB 模型全丢（实测）。这里锁死格式，避免回归。 */
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(3);
		expect(data.every((m) => m.vendor === 'CCB' && m.apiKey === CFG.apiKey)).toBe(true);
		/* 撞名客户端内置目录的模型（如 glm-5.3）会被归并成「不可关思考」，用户一关深度思考
		 * 就 REFUSAL「Current model does not support disabling thinking」。条目必须显式声明。 */
		expect(data.every((m) => m.reasoning?.canDisableThinking === true)).toBe(true);

		/* 默认模型已写入 settings.json */
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model).toBe(CFG.defaultModel);
	});

	it('glm 系条目覆盖 thinkingFormat=deepseek，其余模型不覆盖', async () => {
		const r = await applyConfig('wb-cn', { ...CFG, models: ['glm-5.3', 'kimi-k3', 'model-a'] });
		expect(r.ok).toBe(true);

		const data = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
		/* 撞名 glm 目录会继承 thinkingFormat:"zai"：开思考的请求体会附加
		 * thinking.clear_thinking 字段，GLM 上游报 400「未知请求字段」。条目自带
		 * compat 覆盖成 deepseek 后开思考只发 thinking:{type:"enabled"}（实测 200，
		 * reasoning_effort 档位可共存）；关思考沿用目录 off=null 的「不发字段」路径
		 * （glm-5.3 上游强制开思考，发 {type:"disabled"} 会 400）。 */
		expect(data.find((m) => m.id === 'glm-5.3').compat).toEqual({ thinkingFormat: 'deepseek' });
		/* 非撞名 / 撞名其他厂商目录的模型保持目录原生思考格式，避免破坏其上游
		 * 接受的字段（如 qwen 系的 enable_thinking）。 */
		expect(data.find((m) => m.id === 'kimi-k3').compat).toBeUndefined();
		expect(data.find((m) => m.id === 'model-a').compat).toBeUndefined();
	});

	it('rollback（无备份 → 删除新建文件）', async () => {
		await applyConfig('wb-cn', CFG);
		expect((await rollbackConfig('wb-cn')).ok).toBe(true);
		expect(fs.existsSync(modelsFile)).toBe(false);
		expect(fs.existsSync(settingsFile)).toBe(false);
	});

	it('二次 apply + rollback 往返', async () => {
		await applyConfig('wb-cn', CFG);
		await applyConfig('wb-cn', CFG);
		expect(JSON.parse(fs.readFileSync(modelsFile, 'utf8'))).toHaveLength(3);
		await rollbackConfig('wb-cn');
		expect(fs.existsSync(modelsFile)).toBe(false);
	});

	it('保留用户已有的 models.json / settings.json', async () => {
		const dir = path.join(TMP, 'wb');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			modelsFile,
			JSON.stringify([{ id: 'user-own', vendor: 'User', apiKey: 'sk-user' }])
		);
		fs.writeFileSync(settingsFile, JSON.stringify({ model: 'user-own', env: { K: 'v' } }));

		await applyConfig('wb-cn', CFG);
		const data = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
		expect(data.map((m) => m.id)).toEqual(['user-own', 'model-a', 'model-b', 'model-c']);
		const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		expect(settings.model).toBe(CFG.defaultModel);
		expect(settings.env).toEqual({ K: 'v' });

		await rollbackConfig('wb-cn');
		expect(JSON.parse(fs.readFileSync(modelsFile, 'utf8')).map((m) => m.id)).toEqual(['user-own']);
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model).toBe('user-own');
	});

	it('未知客户端 / 缺参校验', async () => {
		expect((await applyConfig('nonexist', CFG)).ok).toBe(false);
		expect((await applyConfig('wb-cn', { ...CFG, apiKey: '' })).ok).toBe(false);
		expect((await applyConfig('wb-cn', { ...CFG, models: [] })).ok).toBe(false);
	});

	it('找不到程序位置时不启动客户端，只提示手动选路径', async () => {
		const r = await applyConfig('wb-cn', CFG);
		expect(r.ok).toBe(true);
		expect(r.log.join('\n')).toContain('未找到程序位置');
		/* 界面默认模型没设上，但这不是配置失败（模型列表已经写好了） */
		expect(r.warning).toBeUndefined();
	});

	it('回滚：界面默认模型快照在无法还原时保留，供用户重试', async () => {
		const dir = path.join(TMP, 'wb');
		fs.mkdirSync(dir, { recursive: true });
		const snapshot = path.join(dir, 'ccb-workbuddy-gui.json');
		fs.writeFileSync(snapshot, JSON.stringify({ entries: [{ key: 'cb-newtask:model:uid1', value: null }] }));

		const r = await rollbackConfig('wb-cn');
		expect(r.ok).toBe(true);
		expect(r.log.join('\n')).toContain('未找到程序位置');
		expect(fs.existsSync(snapshot)).toBe(true);
	});
});

describe('WorkBuddy 界面默认模型快照（多账号）', () => {
	const dir = path.join(TMP, 'wb-gui');
	const snapshot = path.join(dir, 'ccb-workbuddy-gui.json');
	const noop = () => {};
	const read = () => JSON.parse(fs.readFileSync(snapshot, 'utf8')).entries;
	let guard;

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		fs.mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('首次保存写入全部键；再次保存只补新键，已记过的原始值不被覆盖', () => {
		/* 第一次：只碰了 uid-a，原本用户选的是 platform-x */
		saveGuiChoice([dir], 'ccb-workbuddy-gui.json', [{ key: 'cb-newtask:model:uid-a', value: '{"id":"platform-x"}' }], noop);
		expect(read()).toEqual([{ key: 'cb-newtask:model:uid-a', value: '{"id":"platform-x"}' }]);

		/* 第二次：换了账号（uid-b，键原本不存在），不能把 uid-a 的原始值换成 CCB 模型 */
		saveGuiChoice([dir], 'ccb-workbuddy-gui.json', [
			{ key: 'cb-newtask:model:uid-a', value: '{"id":"custom-local:glm-5.3","isThinking":false}' },
			{ key: 'cb-newtask:model:uid-b', value: null },
		], noop);
		expect(read()).toEqual([
			{ key: 'cb-newtask:model:uid-a', value: '{"id":"platform-x"}' },
			{ key: 'cb-newtask:model:uid-b', value: null },
		]);
	});

	it('没有新键要补时不重写文件', () => {
		saveGuiChoice([dir], 'ccb-workbuddy-gui.json', [{ key: 'cb-newtask:model:uid-a', value: null }], noop);
		const before = fs.statSync(snapshot).mtimeMs;
		const logs = [];
		saveGuiChoice([dir], 'ccb-workbuddy-gui.json', [{ key: 'cb-newtask:model:uid-a', value: '{"id":"whatever"}' }], (m) => logs.push(m));
		expect(fs.statSync(snapshot).mtimeMs).toBe(before);
		expect(logs).toEqual([]);
	});

	it('快照文件损坏时按无快照重建', () => {
		fs.writeFileSync(snapshot, 'not-json{');
		saveGuiChoice([dir], 'ccb-workbuddy-gui.json', [{ key: 'cb-newtask:model:uid-a', value: null }], noop);
		expect(read()).toEqual([{ key: 'cb-newtask:model:uid-a', value: null }]);
	});
});

describe('WorkBuddy 账号数据目录枚举', () => {
	const dir = path.join(TMP, 'wb-accounts');
	let guard;

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		fs.mkdirSync(path.join(dir, 'dce9720f-8520-4eb0-b9d4-16b2f8e66f2d'), { recursive: true });
		fs.mkdirSync(path.join(dir, '53C2982B-42EF-425A-8A3B-EA967EF61EF4'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'not-a-uuid'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'models.json'), '[]');
	});
	afterEach(() => {
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('只把 UUID 命名的目录当账号（大小写都认），文件与普通目录不掺进来', () => {
		expect(accountUidsUnder(dir).sort()).toEqual([
			'53C2982B-42EF-425A-8A3B-EA967EF61EF4',
			'dce9720f-8520-4eb0-b9d4-16b2f8e66f2d',
		].sort());
	});

	it('目录不存在时返回空数组而不是抛错', () => {
		expect(accountUidsUnder(path.join(TMP, 'no-such-dir'))).toEqual([]);
	});
});

describe('WorkBuddy AI（国际版）配置写入/回滚往返', () => {
	const modelsFile = path.join(TMP, 'wbai', 'models.json');
	const settingsFile = path.join(TMP, 'wbai', 'settings.json');
	let restore;
	let guard;

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		restore = patchClient('wb-intl', { configDirs: [path.join(TMP, 'wbai')] });
	});
	afterEach(() => {
		restore();
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('国际版与国内版写入目录互不串台', () => {
		expect(ORIGINAL_CONFIG_DIRS['wb-intl']).toEqual([path.join(os.homedir(), '.workbuddy-ai')]);
		expect(ORIGINAL_CONFIG_DIRS['wb-cn']).toEqual([path.join(os.homedir(), '.workbuddy')]);
		expect(ORIGINAL_CONFIG_DIRS['wb-intl']).not.toEqual(ORIGINAL_CONFIG_DIRS['wb-cn']);
	});

	it('apply：models.json 为顶层数组，settings.json 写入默认模型', async () => {
		expect((await applyConfig('wb-intl', CFG)).ok).toBe(true);

		const data = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
		expect(Array.isArray(data)).toBe(true);
		expect(data.map((m) => m.id)).toEqual(CFG.models);
		expect(data.every((m) => m.vendor === 'CCB' && m.apiKey === CFG.apiKey)).toBe(true);
		expect(data[0].url).toBe('https://code.btluo.com/v1/chat/completions');
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model).toBe(CFG.defaultModel);
	});

	it('保留用户已有配置，回滚可还原', async () => {
		const dir = path.join(TMP, 'wbai');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(modelsFile, JSON.stringify([{ id: 'user-own', vendor: 'User', apiKey: 'sk-user' }]));
		fs.writeFileSync(settingsFile, JSON.stringify({ model: 'user-own', claw: { channels: {} } }));

		await applyConfig('wb-intl', CFG);
		expect(JSON.parse(fs.readFileSync(modelsFile, 'utf8')).map((m) => m.id)).toEqual(['user-own', ...CFG.models]);
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).claw).toEqual({ channels: {} });

		await rollbackConfig('wb-intl');
		expect(JSON.parse(fs.readFileSync(modelsFile, 'utf8')).map((m) => m.id)).toEqual(['user-own']);
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).model).toBe('user-own');
	});

	it('rollback（无备份 → 删除新建文件）', async () => {
		await applyConfig('wb-intl', CFG);
		expect((await rollbackConfig('wb-intl')).ok).toBe(true);
		expect(fs.existsSync(modelsFile)).toBe(false);
		expect(fs.existsSync(settingsFile)).toBe(false);
	});
});

describe('Qoder 加密缓存格式', () => {
	const IKM = 'test-machine-id-0123456789abcdef';

	it('往返一致', async () => {
		const plain = JSON.stringify([{ key: 'ccb/model-a', provider: 'custom' }], null, 2);
		const enc = await qoderEncrypt(plain, IKM);
		expect(await qoderDecrypt(enc, IKM)).toBe(plain);
	});

	it('密文带 QMC 版本头（base64 解码后前 4 字节）', async () => {
		const enc = await qoderEncrypt('[]', IKM);
		const raw = Buffer.from(enc, 'base64');
		expect(raw.subarray(0, 3).toString('ascii')).toBe('QMC');
		expect(raw[3]).toBe(1);
	});

	it('密钥不匹配或格式不符时返回 null', async () => {
		const enc = await qoderEncrypt('[]', IKM);
		expect(await qoderDecrypt(enc, 'other-machine-id')).toBe(null);
		expect(await qoderDecrypt('not-a-valid-ciphertext', IKM)).toBe(null);
		expect(await qoderDecrypt('', IKM)).toBe(null);
	});
});

describe('QoderWork BYOK 行（纯函数）', () => {
	it('字段与 api_key 编码符合客户端 decodeParameter 约定', () => {
		const row = qoderWorkRow({ apiKey: 'sk-ccb-x', apiBase: 'https://code.btluo.com/v1' }, 'glm-5.3', 1700000000);
		expect(row.key).toBe('ccb/glm-5.3');
		expect(row.url).toBe('https://code.btluo.com/v1/chat/completions');
		expect(row.style).toBe('openai');
		expect(row.format).toBe('openai');
		expect(row.model).toBe('glm-5.3');
		/* provider 留空，客户端 normalizeProvider 会回落到 style */
		expect(row.provider).toBe(null);
		expect(row.max_input_tokens).toBeGreaterThan(0);
		expect(row.created_at).toBe(1700000000);

		const params = JSON.parse(row.encrypted_parameters);
		expect(params.api_key.encoding).toBe('plainBase64');
		expect(Buffer.from(params.api_key.value, 'base64').toString('utf8')).toBe('sk-ccb-x');
	});
});

describe('进程守卫解析（纯函数）', () => {
	const { parseTasklistNames } = require('../electron/lib/proc');

	it('能解析带空格的进程名（曾检测不到 → 运行中仍写入 → 被客户端回写覆盖）', () => {
		const csv =
			'"TRAE SOLO CN.exe","12724","Console","1","181,388 K"\r\n' +
			'"TRAE SOLO CN.exe","1924","Console","1","23,476 K"\r\n';
		expect(parseTasklistNames(csv)).toEqual(['TRAE SOLO CN.exe']);
	});

	it('解析普通进程名并去重', () => {
		const csv = '"Cursor.exe","111","Console","1","10 K"\r\n"Cursor.exe","222","Console","1","20 K"\r\n';
		expect(parseTasklistNames(csv)).toEqual(['Cursor.exe']);
	});

	it('未命中时的本地化提示行不产生结果', () => {
		expect(parseTasklistNames('信息: 没有运行的任务匹配指定标准。\r\n')).toEqual([]);
		expect(parseTasklistNames('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([]);
		expect(parseTasklistNames('')).toEqual([]);
	});
});

/* 端到端写入/回滚：把客户端的 homeDir / appDirs / configDirs 临时改到测试目录，
 * 全程不触碰用户真实的客户端配置（临时目录在 afterEach 中删除）。 */
describe('新增写入器端到端写入/回滚（临时目录）', () => {
	const CFG2 = {
		apiKey: 'sk-ccb-e2e-key',
		apiBase: 'https://code.btluo.com/v1',
		anthropicBase: 'https://code.btluo.com',
		models: ['glm-5.3', 'kimi-k2'],
		defaultModel: 'glm-5.3',
	};

	let guard;

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
	});
	afterEach(() => {
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('ZCode：写入自定义供应商与当前模型，保留用户供应商，回滚可还原', async () => {
		const restore = patchClient('zcode', { homeDir: '.ccb-test-tmp/zcode' });
		try {
			const v2 = path.join(TMP, 'zcode', 'v2', 'config.json');
			fs.mkdirSync(path.dirname(v2), { recursive: true });
			fs.writeFileSync(
				v2,
				JSON.stringify({ provider: { 'user-own': { name: 'X', kind: 'openai', source: 'custom' } } }, null, 2)
			);

			expect((await applyConfig('zcode', CFG2)).ok).toBe(true);
			const data = JSON.parse(fs.readFileSync(v2, 'utf8'));
			expect(data.provider['user-own']).toBeTruthy();
			expect(data.provider.ccb.kind).toBe('openai-compatible');
			expect(data.provider.ccb.source).toBe('custom');
			expect(data.provider.ccb.options.baseURL).toBe('https://code.btluo.com/v1');
			expect(data.provider.ccb.options.apiKey).toBe(CFG2.apiKey);
			expect(Object.keys(data.provider.ccb.models)).toEqual(['glm-5.3', 'kimi-k2']);

			const cli = JSON.parse(fs.readFileSync(path.join(TMP, 'zcode', 'cli', 'config.json'), 'utf8'));
			expect(cli.model).toBe('ccb/glm-5.3');
			expect(cli.provider.ccb.options.baseURL).toBe('https://code.btluo.com/v1');

			expect((await rollbackConfig('zcode')).ok).toBe(true);
			const after = JSON.parse(fs.readFileSync(v2, 'utf8'));
			expect(after.provider.ccb).toBeUndefined();
			expect(after.provider['user-own']).toBeTruthy();
			expect(fs.existsSync(path.join(TMP, 'zcode', 'cli', 'config.json'))).toBe(false);
		} finally {
			restore();
		}
	});

	it('QoderWork：写加密 customs + agents.db + 默认模型', async () => {
		/* exeNames 置空防止 exe 探测命中真实注册表；桥接另有专测且必须与真实 runtime 隔离 */
		const restore = patchClient('qoderwork-cn', {
			homeDir: '.ccb-test-tmp/qw',
			appDirs: ['.ccb-test-tmp/qwapp'],
			exeNames: [],
		});
		const savedBridge = process.env.CCB_QW_BRIDGE;
		process.env.CCB_QW_BRIDGE = 'off';
		try {
			const root = path.join(TMP, 'qw');
			fs.mkdirSync(path.join(root, '.auth'), { recursive: true });
			fs.writeFileSync(path.join(root, '.auth', 'machine_id'), 'test-machine-id-abcdef');
			fs.mkdirSync(path.join(root, '.models', 'uid-1'), { recursive: true });
			fs.writeFileSync(
				path.join(root, '.models', 'default'),
				JSON.stringify({ key: 'qmodel_38max', uid: 'uid-1', scene: 'assistant', updatedAt: 1 })
			);

			const dbFile = path.join(TMP_APP, 'qwapp', 'data', 'agents.db');
			fs.mkdirSync(path.dirname(dbFile), { recursive: true });
			const seed = new DatabaseSync(dbFile);
			seed.exec(`CREATE TABLE byok_custom_models (
				key text PRIMARY KEY NOT NULL, legacy_key text, source text DEFAULT 'byok' NOT NULL,
				display_name text NOT NULL, provider text, type text, url text, style text,
				model text NOT NULL, format text, is_vl integer, is_reasoning integer,
				max_input_tokens integer, max_output_tokens integer,
				encrypted_parameters text DEFAULT '{}', extra_params text DEFAULT '',
				migrated_from text, created_at integer, updated_at integer)`);
			seed.close();

			expect((await applyConfig('qoderwork-cn', CFG2)).ok).toBe(true);

			const db = new DatabaseSync(dbFile, { readOnly: true });
			const rows = db.prepare('SELECT * FROM byok_custom_models ORDER BY key').all();
			db.close();
			expect(rows.map((r) => r.key)).toEqual(['ccb/glm-5.3', 'ccb/kimi-k2']);
			expect(rows[0].url).toBe('https://code.btluo.com/v1/chat/completions');
			expect(rows[0].style).toBe('openai');
			const params = JSON.parse(rows[0].encrypted_parameters);
			expect(Buffer.from(params.api_key.value, 'base64').toString('utf8')).toBe(CFG2.apiKey);

			/* 加密 customs 可被同一 machine_id 解出；QoderWork 的 provider 必须是 'custom'
			 * （worker 的 Zxn 只对空/custom 透传 url，'ccb' 会丢 url → 桥缺中转地址） */
			const customs = fs.readFileSync(path.join(root, '.models', 'uid-1', 'customs'), 'utf8');
			const plain = await qoderDecrypt(customs, 'test-machine-id-abcdef');
			expect(plain).toBeTruthy();
			const customsArr = JSON.parse(plain);
			expect(customsArr.map((m) => m.key)).toEqual(['ccb/glm-5.3', 'ccb/kimi-k2']);
			expect(customsArr.every((m) => m.provider === 'custom' && typeof m.url === 'string' && m.url.startsWith('https://'))).toBe(true);

			/* 默认模型指向 CCB，scene 保留 */
			const def = JSON.parse(fs.readFileSync(path.join(root, '.models', 'default'), 'utf8'));
			expect(def.key).toBe('ccb/glm-5.3');
			expect(def.scene).toBe('assistant');
			expect(def.uid).toBe('uid-1');

			expect((await rollbackConfig('qoderwork-cn')).ok).toBe(true);
			const db2 = new DatabaseSync(dbFile, { readOnly: true });
			expect(db2.prepare('SELECT COUNT(*) c FROM byok_custom_models').get().c).toBe(0);
			db2.close();
		} finally {
			if (savedBridge === undefined) delete process.env.CCB_QW_BRIDGE;
			else process.env.CCB_QW_BRIDGE = savedBridge;
			restore();
		}
	});

	it('CodeBuddy CN：写 models.json 并重指向各工作区的选中模型（带 custom-local: 前缀）', async () => {
		const restore = patchClient('codebuddy-cn', {
			homeDir: '.ccb-test-tmp/cbhome',
			configDirs: [path.join(TMP, 'codebuddy')],
			appDirs: ['.ccb-test-tmp/cbapp'],
		});
		try {
			const cbApp = path.join(TMP_APP, 'cbapp');
			/* 选中模型是 workspace 键：存在各工作区自己的 state.vscdb，不在全局库 */
			const wsDb = path.join(cbApp, 'User', 'workspaceStorage', 'ws-1', 'state.vscdb');
			const globalDb = path.join(cbApp, 'User', 'globalStorage', 'state.vscdb');
			for (const f of [wsDb, globalDb]) {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				const seed = new DatabaseSync(f);
				seed.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
				seed.close();
			}
			const seed = new DatabaseSync(wsDb);
			seed.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
				'Tencent-Cloud.coding-copilot',
				JSON.stringify({
					chatSelectedModelMapV2: JSON.stringify({ craft: 'doubao-1.6' }),
					'CodeBuddy-Endpoint-Cache': 'https://copilot.tencent.com',
				})
			);
			seed.close();

			expect((await applyConfig('codebuddy-cn', CFG2)).ok).toBe(true);

			const models = JSON.parse(fs.readFileSync(path.join(TMP, 'codebuddy', 'models.json'), 'utf8'));
			expect(models.models.map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k2']);
			expect(models.models[0].vendor).toBe('CCB');
			/* 同 WorkBuddy：撞名内置目录的模型必须显式声明可关思考，否则关思考即 REFUSAL */
			expect(models.models.every((m) => m.reasoning?.canDisableThinking === true)).toBe(true);

			const read = new DatabaseSync(wsDb, { readOnly: true });
			const raw = read.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').value;
			read.close();
			const data = JSON.parse(String(raw));
			/* 已有的 craft 重指向 + 补种 ask，值带 custom-local: 前缀，其余字段原样保留 */
			expect(JSON.parse(data.chatSelectedModelMapV2)).toEqual({
				craft: 'custom-local:glm-5.3',
				ask: 'custom-local:glm-5.3',
			});
			expect(data['CodeBuddy-Endpoint-Cache']).toBe('https://copilot.tencent.com');

			/* 全局库不再被触碰（旧版写错位置，写全局无任何效果） */
			const g = new DatabaseSync(globalDb, { readOnly: true });
			expect(g.prepare('SELECT COUNT(*) c FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').c).toBe(0);
			g.close();

			expect((await rollbackConfig('codebuddy-cn')).ok).toBe(true);
			expect(fs.existsSync(path.join(TMP, 'codebuddy', 'models.json'))).toBe(false);
			/* 工作区库从备份还原：craft 回到用户原值，ask 补种项消失 */
			const back = new DatabaseSync(wsDb, { readOnly: true });
			const raw2 = back.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').value;
			back.close();
			const data2 = JSON.parse(String(raw2));
			expect(JSON.parse(data2.chatSelectedModelMapV2)).toEqual({ craft: 'doubao-1.6' });
		} finally {
			restore();
		}
	});

	it('CodeBuddy CN：从未选过模型时补种 craft/ask 默认模型', async () => {
		const restore = patchClient('codebuddy-cn', {
			homeDir: '.ccb-test-tmp/cbhome2',
			configDirs: [path.join(TMP, 'codebuddy2')],
			appDirs: ['.ccb-test-tmp/cbapp2'],
		});
		try {
			const cbApp = path.join(TMP_APP, 'cbapp2');
			/* ws-1：键存在但没有 chatSelectedModelMapV2（用户从未在模型切换器里选过）；
			 * ws-2：整个键都不存在（该工作区从未打开过聊天面板）——两种都要补种 */
			const ws1 = path.join(cbApp, 'User', 'workspaceStorage', 'ws-1', 'state.vscdb');
			const ws2 = path.join(cbApp, 'User', 'workspaceStorage', 'ws-2', 'state.vscdb');
			for (const f of [ws1, ws2]) {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				const seed = new DatabaseSync(f);
				seed.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
				seed.close();
			}
			const seed = new DatabaseSync(ws1);
			seed.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
				'Tencent-Cloud.coding-copilot',
				JSON.stringify({ 'CodeBuddy-Endpoint-Cache': 'https://copilot.tencent.com' })
			);
			seed.close();

			const r = await applyConfig('codebuddy-cn', CFG2);
			expect(r.ok).toBe(true);

			/* models.json 照常写入 */
			const models = JSON.parse(fs.readFileSync(path.join(TMP, 'codebuddy2', 'models.json'), 'utf8'));
			expect(models.models.map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k2']);

			for (const [f, hasKey] of [[ws1, true], [ws2, false]]) {
				const read = new DatabaseSync(f, { readOnly: true });
				const raw = read.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').value;
				read.close();
				const data = JSON.parse(String(raw));
				expect(JSON.parse(data.chatSelectedModelMapV2)).toEqual({
					craft: 'custom-local:glm-5.3',
					ask: 'custom-local:glm-5.3',
				});
				if (hasKey) expect(data['CodeBuddy-Endpoint-Cache']).toBe('https://copilot.tencent.com');
			}

			expect((await rollbackConfig('codebuddy-cn')).ok).toBe(true);
			expect(fs.existsSync(path.join(TMP, 'codebuddy2', 'models.json'))).toBe(false);
			/* 回滚后：ws-1 恢复原样（无选择字段），ws-2 的键整个被还原为不存在 */
			const r1 = new DatabaseSync(ws1, { readOnly: true });
			const raw1 = r1.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').value;
			r1.close();
			expect(JSON.parse(String(raw1)).chatSelectedModelMapV2).toBeUndefined();
			const r2 = new DatabaseSync(ws2, { readOnly: true });
			expect(r2.prepare('SELECT COUNT(*) c FROM ItemTable WHERE key = ?').get('Tencent-Cloud.coding-copilot').c).toBe(0);
			r2.close();
		} finally {
			restore();
		}
	});
});

/* Codex 桌面版：写入 ~/.codex/config.toml（行级合并 + 内联 bearer 密钥）。
 * 全程在临时目录里做，并用 realSnapshot 护栏确认没碰到真实的 ~/.codex。 */
describe('Codex 桌面版写入（config.toml）', () => {
	const CFG3 = {
		apiKey: 'sk-ccb-codex-key',
		apiBase: 'https://code.btluo.com/v1',
		models: ['glm-5.3', 'kimi-k2'],
		defaultModel: 'glm-5.3',
	};
	const ROOT = path.join(TMP, 'codex');
	const FILE = path.join(ROOT, 'config.toml');
	const APPLY = path.join(TMP, 'codex-apply.json');
	/* 用户现场快照：旧中转（激活）+ 另一条遗留 provider——正是新版 Codex 会拒绝加载的形态
	 * （任一处 wire_api="chat" 都致命：2026-10-08 实测应用弹「Codex configuration could not
	 * be loaded」、CLI 0.161.0 直接 exit 1）。写入器必须把两处都迁移成 responses。 */
	const SEED = [
		'model_provider = "codeb"',
		'model = "claude-sonnet-4-20250514"',
		'',
		'[model_providers.codeb]',
		'name = "Codeb Relay"',
		'base_url = "https://code.btluo.com/v1"',
		'wire_api = "chat"',
		'env_key = "OPENAI_API_KEY"',
		'',
		'[model_providers.legacy]',
		'name = "Legacy"',
		'base_url = "https://legacy.example.com/v1"',
		"wire_api = 'chat'  # 单引号 + 行尾注释",
		'',
		'[tui]',
		'notifications = true',
		'',
	].join('\n');

	let guard;
	const restoreClient = () =>
		patchClient('codex', { homeDir: '.ccb-test-tmp/codex', codexApplyFile: APPLY });

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
	});
	afterEach(() => {
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	const writeSeed = () => {
		fs.mkdirSync(ROOT, { recursive: true });
		fs.writeFileSync(FILE, SEED);
	};

	it('写入：顶层指向 ccb、密钥内联；遗留 provider 的 wire_api = chat 全部迁移为 responses，其它内容原样保留', async () => {
		const restore = restoreClient();
		try {
			writeSeed();
			const r = await applyConfig('codex', CFG3);
			expect(r.ok).toBe(true);
			expect((r.log || []).join('\n')).toContain('迁移为 "responses"');

			const text = fs.readFileSync(FILE, 'utf8');
			expect(text).toContain('model_provider = "ccb"');
			expect(text).toContain('model = "glm-5.3"');
			expect(text).toContain('[model_providers.ccb]');
			expect(text).toContain('base_url = "https://code.btluo.com/v1"');
			/* 我们写的块（responses）+ 两处遗留 chat 的迁移：全文件不再残留 chat */
			expect((text.match(/^\s*wire_api\s*=\s*"responses"/gm) || []).length).toBe(3);
			expect(text).not.toMatch(/wire_api\s*=\s*['"]chat['"]/i);
			expect(text).toContain('experimental_bearer_token = "sk-ccb-codex-key"');
			/* 顶层键只出现一次：旧的 model_provider/model 是替换掉的，不是追加 */
			expect(text.match(/^model_provider\s*=/gm).length).toBe(1);
			expect(text.match(/^model\s*=/gm).length).toBe(1);
			/* 除 wire_api 迁移外，用户原有内容一字不动（含段结构、键与行尾注释） */
			expect(text).toContain('[model_providers.codeb]');
			expect(text).toContain('name = "Codeb Relay"');
			expect(text).toContain('env_key = "OPENAI_API_KEY"');
			expect(text).toContain('[model_providers.legacy]');
			expect(text).toContain('wire_api = "responses"  # 单引号 + 行尾注释');
			expect(text).toContain('[tui]');
			expect(text).toContain('notifications = true');

			expect(JSON.parse(fs.readFileSync(APPLY, 'utf8')).model).toBe('glm-5.3');
		} finally {
			restore();
		}
	});

	it('幂等：二次写入不重复 provider 段，.bak 恒为首次写入前的原始文件', async () => {
		const restore = restoreClient();
		try {
			writeSeed();
			await applyConfig('codex', CFG3);
			const first = fs.readFileSync(FILE, 'utf8');
			await applyConfig('codex', CFG3);
			const second = fs.readFileSync(FILE, 'utf8');

			expect(second).toBe(first);
			expect(second.match(/\[model_providers\.ccb\]/g).length).toBe(1);
			expect(fs.readFileSync(FILE + '.bak', 'utf8')).toBe(SEED);
		} finally {
			restore();
		}
	});

	it('回滚：优先还原备份，与原文件逐字节一致', async () => {
		const restore = restoreClient();
		try {
			writeSeed();
			await applyConfig('codex', CFG3);
			const r = await rollbackConfig('codex');
			expect(r.ok).toBe(true);
			expect(fs.readFileSync(FILE, 'utf8')).toBe(SEED);
			expect(fs.existsSync(APPLY)).toBe(false);
		} finally {
			restore();
		}
	});

	it('无备份时的兜底回滚：精准摘掉 CCB 供应商与默认模型，用户内容保留', async () => {
		const restore = restoreClient();
		try {
			writeSeed();
			await applyConfig('codex', CFG3);
			fs.rmSync(FILE + '.bak');
			await rollbackConfig('codex');

			const text = fs.readFileSync(FILE, 'utf8');
			expect(text).not.toContain('[model_providers.ccb]');
			expect(text).not.toContain('model_provider = "ccb"');
			expect(text).not.toContain('sk-ccb-codex-key');
			expect(text).not.toContain('glm-5.3');
			expect(text).toContain('[model_providers.codeb]');
			expect(text).toContain('[tui]');
		} finally {
			restore();
		}
	});

	it('原本没有 config.toml 时：写入新建、回滚删除（不留空文件）', async () => {
		const restore = restoreClient();
		try {
			fs.mkdirSync(ROOT, { recursive: true });
			expect((await applyConfig('codex', CFG3)).ok).toBe(true);
			expect(fs.existsSync(FILE)).toBe(true);
			await rollbackConfig('codex');
			expect(fs.existsSync(FILE)).toBe(false);
		} finally {
			restore();
		}
	});

	it('未安装（应用根不存在）时报错而不是凭空造配置', async () => {
		const restore = restoreClient();
		try {
			const r = await applyConfig('codex', CFG3);
			expect(r.ok).toBe(false);
			expect(r.error).toContain('请先安装并启动');
			expect(r.error).toContain(ROOT);
			expect(fs.existsSync(FILE)).toBe(false);
		} finally {
			restore();
		}
	});
});

/* Qoder CN 桌面版：走 qodercli 的配置目录 ~/.qoder-cn（settings.json 的
 * modelConfigs.customModels + .models/<uid>/customs），不写 main.sqlite。
 * 全程在临时目录里做，并用 realSnapshot 护栏确认没碰到真实的 ~/.qoder-cn。 */
describe('Qoder CN 桌面版写入（settings.json + 加密 customs）', () => {
	const QC = {
		apiKey: 'sk-ccb-qcn-key',
		apiBase: 'https://code.btluo.com/v1',
		anthropicBase: 'https://code.btluo.com',
		models: ['glm-5.3', 'kimi-k2'],
		defaultModel: 'glm-5.3',
	};
	const MACHINE_ID = 'test-machine-id-qcn-0123456789';
	const UID = 'uid-cn-0001';

	let restore;
	let guard;
	const root = path.join(TMP, 'qappcn');
	const settingsFile = path.join(root, 'settings.json');
	const defaultFile = path.join(root, '.models', 'default');
	const customsFile = path.join(root, '.models', UID, 'customs');

	/* 模拟真实情况：用户已有一个自建自定义模型 + 其它设置字段 */
	const seedSettings = () => ({
		aicodingPluginSettingsMigrationVersion: 1,
		enabledPlugins: { 'better-harness@qoder-bundler': true },
		modelConfigs: {
			aliases: { fast: 'ccb/glm-5.3' },
			customModels: [{ key: 'user/own', displayName: 'own', provider: 'user', model: 'own', apiKey: 'sk-user' }],
		},
	});
	/* qodercli 自己维护的默认模型缓存：我们不应该动它 */
	const seedDefault = () => ({ key: 'qmodel_38max', uid: UID, scene: 'app', updatedAt: 1 });

	const readCustoms = async () => JSON.parse(await qoderDecrypt(fs.readFileSync(customsFile, 'utf8'), MACHINE_ID));

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		restore = patchClient('qoder-app-cn', { homeDir: '.ccb-test-tmp/qappcn' });
		fs.mkdirSync(path.join(root, '.auth'), { recursive: true });
		fs.writeFileSync(path.join(root, '.auth', 'machine_id'), MACHINE_ID);
		fs.mkdirSync(path.join(root, '.models'), { recursive: true });
		fs.writeFileSync(defaultFile, JSON.stringify(seedDefault()));
		fs.writeFileSync(settingsFile, JSON.stringify(seedSettings(), null, 4));
	});
	afterEach(() => {
		restore();
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('写入 settings.json 的自定义模型与加密 customs，保留用户原有数据', async () => {
		const r = await applyConfig('qoder-app-cn', QC);
		expect(r.ok).toBe(true);
		/* bridge + reconcile 补丁后，CCB 模型可设为默认，日志如实说明 */
		expect(r.log.join('\n')).toContain('默认模型即为 CCB');

		const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		/* 其它设置字段原样保留 */
		expect(settings.aicodingPluginSettingsMigrationVersion).toBe(1);
		expect(settings.enabledPlugins).toEqual({ 'better-harness@qoder-bundler': true });
		expect(settings.modelConfigs.aliases).toEqual({ fast: 'ccb/glm-5.3' });
		/* 用户自建模型保留，CCB 条目追加在后 */
		expect(settings.modelConfigs.customModels.map((m) => m.key)).toEqual(['user/own', 'ccb/glm-5.3', 'ccb/kimi-k2']);
		expect(settings.modelConfigs.customModels[1]).toEqual({
			key: 'ccb/glm-5.3',
			displayName: 'glm-5.3',
			provider: 'custom',
			model: 'glm-5.3',
			apiKey: QC.apiKey,
			baseURL: 'https://code.btluo.com/v1',
			format: 'openai',
			isVl: false,
			isReasoning: false,
			maxInputTokens: 128000,
		});

		/* 加密 customs 与写入的 machine_id 一致，可被 qodercli 解出 */
		const customs = await readCustoms();
		expect(customs.map((m) => m.key)).toEqual(['ccb/glm-5.3', 'ccb/kimi-k2']);
		expect(customs[0]).toMatchObject({
			display_name: 'glm-5.3',
			provider: 'custom',
			model: 'glm-5.3',
			url: 'https://code.btluo.com/v1',
			format: 'openai',
			max_input_tokens: 128000,
			parameters: { api_key: QC.apiKey },
		});

		/* .models/default 已被设为 CCB 默认模型（reconcile 补丁启动时优先读此值）；
		 * 原 uid/scene 保留，key 被覆盖为 CCB 模型 */
		const def = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
		expect(def.key).toBe('ccb/glm-5.3');
		expect(def.uid).toBe(UID);
		expect(def.scene).toBe('app');
	});

	it('幂等：重复写入不产生重复条目', async () => {
		await applyConfig('qoder-app-cn', QC);
		await applyConfig('qoder-app-cn', QC);

		const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		expect(settings.modelConfigs.customModels.map((m) => m.key)).toEqual(['user/own', 'ccb/glm-5.3', 'ccb/kimi-k2']);
		expect((await readCustoms()).map((m) => m.key)).toEqual(['ccb/glm-5.3', 'ccb/kimi-k2']);
	});

	it('回滚（有备份）完全还原 settings.json，默认模型缓存不受影响', async () => {
		await applyConfig('qoder-app-cn', QC);
		expect((await rollbackConfig('qoder-app-cn')).ok).toBe(true);

		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(seedSettings());
		expect(JSON.parse(fs.readFileSync(defaultFile, 'utf8'))).toEqual(seedDefault());
		/* customs 原本不存在（无备份）→ 只移除 CCB 条目 */
		expect(await readCustoms()).toEqual([]);
	});

	it('无备份回滚时只移除 CCB 写入的内容', async () => {
		await applyConfig('qoder-app-cn', QC);
		fs.rmSync(settingsFile + '.bak');

		await rollbackConfig('qoder-app-cn');

		const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		expect(settings.modelConfigs.customModels.map((m) => m.key)).toEqual(['user/own']);
		expect(settings.enabledPlugins).toEqual({ 'better-harness@qoder-bundler': true });
		expect(JSON.parse(fs.readFileSync(defaultFile, 'utf8'))).toEqual(seedDefault());
		expect(await readCustoms()).toEqual([]);
	});

	it('未安装过（无 settings.json）时给出明确错误而不是假成功', async () => {
		fs.rmSync(settingsFile);
		const r = await applyConfig('qoder-app-cn', QC);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Qoder CN');
		expect(r.error).toContain('settings.json');
	});

	it('缺参校验', async () => {
		expect((await applyConfig('qoder-app-cn', { ...QC, apiKey: '' })).ok).toBe(false);
		expect((await applyConfig('qoder-app-cn', { ...QC, models: [] })).ok).toBe(false);
	});
});

/* Qoder CN IDE 的本地 MITM 代理设置：writeQoderCnProxySettings 写 %APPDATA%/QoderCN/User/settings.json
 * 里的 app.configAdvancedProxyMode='manual' + app.configAdvancedProxyURL='http://127.0.0.1:<port>'，
 * isQoderProxyActive 用来在 CCB 重启后判断是否要自动拉起代理（resumeQoderProxy 的门槛）。
 * 测试临时把 APPDATA 指到 TMP_APP，用假 client {appDirs:['qcn']} 完全在沙箱内跑。 */
describe('Qoder CN IDE 代理设置（writeQoderCnProxySettings/isQoderProxyActive）', () => {
	const { writeQoderCnProxySettings, rollbackQoderCnProxySettings, isQoderProxyActive, qoderCnUserSettingsPath } = writers;
	const fakeClient = { id: 'qoder-cn', name: 'Qoder CN IDE (test)', appDirs: ['qcn'] };
	let settingsFile;
	let savedAppData;
	const logs = [];
	const log = (m) => logs.push(String(m));

	beforeEach(() => {
		cleanTmp();
		savedAppData = process.env.APPDATA;
		process.env.APPDATA = TMP_APP;
		fs.mkdirSync(TMP_APP, { recursive: true });
		settingsFile = qoderCnUserSettingsPath(fakeClient);
		logs.length = 0;
	});
	afterEach(() => {
		if (savedAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = savedAppData;
		cleanTmp();
	});

	it('写入 manual + 127.0.0.1:<port>，isQoderProxyActive 识别为真', () => {
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }, null, '\t') + '\n');

		expect(isQoderProxyActive(fakeClient)).toBe(false);
		expect(writeQoderCnProxySettings(fakeClient, 9183, log)).toBe(true);

		const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		expect(written.theme).toBe('dark'); /* 用户其它设置保留 */
		expect(written.app.configAdvancedProxyMode).toBe('manual');
		expect(written.app.configAdvancedProxyURL).toBe('http://127.0.0.1:9183');
		expect(isQoderProxyActive(fakeClient)).toBe(true);
	});

	it('端口未传时兜底 9183', () => {
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		writeQoderCnProxySettings(fakeClient, undefined, log);
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).app.configAdvancedProxyURL).toBe('http://127.0.0.1:9183');
	});

	it('settings.json 不存在时 isQoderProxyActive 返回 false（不会误拉起代理）', () => {
		expect(isQoderProxyActive(fakeClient)).toBe(false);
	});

	it('非 manual 模式或外链 URL 都不算挂着我们的代理', () => {
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify({ app: { configAdvancedProxyMode: 'system', configAdvancedProxyURL: 'http://127.0.0.1:9183' } }));
		expect(isQoderProxyActive(fakeClient)).toBe(false);

		fs.writeFileSync(settingsFile, JSON.stringify({ app: { configAdvancedProxyMode: 'manual', configAdvancedProxyURL: 'http://proxy.corp:8080' } }));
		expect(isQoderProxyActive(fakeClient)).toBe(false);
	});

	it('回滚：有备份时完整还原；无备份时只摘掉代理字段', () => {
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		const seed = { theme: 'dark', app: { someOther: 1 } };
		fs.writeFileSync(settingsFile, JSON.stringify(seed, null, '\t') + '\n');

		writeQoderCnProxySettings(fakeClient, 9183, log);
		expect(isQoderProxyActive(fakeClient)).toBe(true);

		/* 有 .bak → 完整还原 */
		expect(rollbackQoderCnProxySettings(fakeClient, log)).toBe(1);
		expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(seed);
		expect(isQoderProxyActive(fakeClient)).toBe(false);

		/* 无 .bak → 只删代理字段，保留其它 */
		writeQoderCnProxySettings(fakeClient, 9183, log);
		fs.rmSync(settingsFile + '.bak');
		expect(rollbackQoderCnProxySettings(fakeClient, log)).toBe(1);
		const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		expect(after.theme).toBe('dark');
		expect(after.app.someOther).toBe(1);
		expect(after.app.configAdvancedProxyMode).toBeUndefined();
		expect(after.app.configAdvancedProxyURL).toBeUndefined();
		expect(isQoderProxyActive(fakeClient)).toBe(false);
	});
});

/* Plan D 回归：Qoder CN IDE 1.30+ 的 writeQoder 路径不再写本地 MITM 代理设置，
 * 而是主动清理旧版本遗留的 app.configAdvancedProxyMode/URL，并在日志里说明
 * 「1.30+ 暂不支持 CCB 中转自定义模型」。~/.qoder-cn 的写入保留（对内置 qodercli 有效）。
 * 沙箱：homeDir 指到 TMP/qcn，APPDATA 指到 TMP_APP，appDirs=['qcn-ide']，
 * realSnapshot 护栏确认真实 ~/.qoder-cn 不被触碰。 */
describe('Qoder CN IDE 写入（writeQoder）：v2.1 始终写入代理设置（官方代理通道 → 本地 MITM）', () => {
	const QC = {
		apiKey: 'sk-ccb-qcn-ide',
		apiBase: 'https://code.btluo.com/v1',
		anthropicBase: 'https://code.btluo.com',
		models: ['glm-5.3', 'kimi-k2'],
		defaultModel: 'glm-5.3',
	};
	const MACHINE_ID = 'test-machine-qcn-ide-0123456789';
	const UID = 'uid-qcn-ide-0001';

	let restore;
	let guard;
	let savedAppData;
	const root = path.join(TMP, 'qcn');
	const ideSettings = () => path.join(TMP_APP, 'qcn-ide', 'User', 'settings.json');

	const seedStaleProxy = () => {
		fs.mkdirSync(path.dirname(ideSettings()), { recursive: true });
		fs.writeFileSync(
			ideSettings(),
			JSON.stringify(
				{ theme: 'dark', app: { configAdvancedProxyMode: 'manual', configAdvancedProxyURL: 'http://127.0.0.1:9183' } },
				null,
				'\t'
			) + '\n'
		);
	};

	beforeEach(() => {
		cleanTmp();
		guard = realSnapshot();
		savedAppData = process.env.APPDATA;
		process.env.APPDATA = TMP_APP;
		restore = patchClient('qoder-cn', { homeDir: '.ccb-test-tmp/qcn', appDirs: ['qcn-ide'] });
		/* ~/.qoder-cn（临时 root）：machine_id + .models/default，让加密 customs 能落盘 */
		fs.mkdirSync(path.join(root, '.auth'), { recursive: true });
		fs.writeFileSync(path.join(root, '.auth', 'machine_id'), MACHINE_ID);
		fs.mkdirSync(path.join(root, '.models'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.models', 'default'),
			JSON.stringify({ key: 'qmodel_38max', uid: UID, scene: 'app', updatedAt: 1 })
		);
	});
	afterEach(() => {
		restore();
		if (savedAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = savedAppData;
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	it('写入 IDE 代理设置（manual → 本地 MITM 代理），保留其它设置', async () => {
		seedStaleProxy();
		const r = await applyConfig('qoder-cn', QC);
		expect(r.ok).toBe(true);

		const text = (r.log || []).join('\n');
		expect(text).toContain('已写入 Qoder 代理设置');

		/* IDE settings.json：代理字段指向本地 MITM 代理，其它设置保留 */
		const s = JSON.parse(fs.readFileSync(ideSettings(), 'utf8'));
		expect(s.theme).toBe('dark');
		expect(s.app.configAdvancedProxyMode).toBe('manual');
		expect(s.app.configAdvancedProxyURL).toBe('http://127.0.0.1:9183');

		/* ~/.qoder-cn 仍写入 CCB 模型（对内置 qodercli 命令行有效） */
		const cnSettings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
		const keys = cnSettings.modelConfigs.customModels.map((m) => m.key);
		expect(keys).toEqual(['ccb/glm-5.3', 'ccb/kimi-k2']);
	});

	it('废弃的 qoderMitm 参数仅用于指定代理端口，代理设置始终写入', async () => {
		seedStaleProxy();
		const r = await applyConfig('qoder-cn', { ...QC, qoderMitm: { enabled: true, port: 9183 } });
		expect(r.ok).toBe(true);
		const s = JSON.parse(fs.readFileSync(ideSettings(), 'utf8'));
		expect(s.app.configAdvancedProxyMode).toBe('manual');
		expect(s.app.configAdvancedProxyURL).toBe('http://127.0.0.1:9183');
	});

	it('没有旧代理设置时也会写入代理字段，正常完成写入', async () => {
		fs.mkdirSync(path.dirname(ideSettings()), { recursive: true });
		fs.writeFileSync(ideSettings(), JSON.stringify({ theme: 'light' }, null, '\t') + '\n');
		const r = await applyConfig('qoder-cn', QC);
		expect(r.ok).toBe(true);
		const s = JSON.parse(fs.readFileSync(ideSettings(), 'utf8'));
		expect(s.theme).toBe('light');
		expect(s.app).toEqual({
			configAdvancedProxyMode: 'manual',
			configAdvancedProxyURL: 'http://127.0.0.1:9183',
		});
	});
});
