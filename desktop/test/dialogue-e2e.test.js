import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

/* 对话链路端到端测试（「一键配置」的最终验收）：
 *
 * 一键配置写入的不是「文件长这样」而是「客户端拿着这份文件能完成一次对话」。
 * /v1/* 由中转站 codeb（另一项目）负责，本仓库无法起真实链路，因此这里起一个
 * OpenAI 兼容的本地 mock 中转站，按下述闭环逐写入器验收：
 *
 *   applyConfig（写入临时目录）
 *     → 按「客户端自己读配置的方式」读回服务端点 + API Key + 默认模型
 *     → GET  /v1/models          （客户端启动拉模型列表）
 *     → POST /v1/chat/completions（真实发起一次对话；Codex 桌面版按新版 core 走 Responses API → /v1/responses）
 *     → 断言鉴权、模型、回复全部正确
 *
 * 覆盖全部 8 个文件型写入器（traeui 系除外：它必须 CDP 驱动真实客户端 UI，
 * 且要求已登录 Trae 账号，无法离线自动化——其可离线部分由 traeui.test.js 覆盖）。
 * qoder 写入器（Qoder IDE 国际版/中国版）此前没有任何端到端覆盖，在此一并补齐。
 */

const require = createRequire(import.meta.url);
const { applyConfig } = require('../electron/lib/writers');
const { CLIENTS } = require('../electron/lib/clients');
const vscdb = require('../electron/lib/vscdb');

/* 临时目录与 roundtrip.test.js 隔离：vitest 并行跑多个测试文件时，
 * 共用目录会被彼此的 cleanTmp 误删（曾导致 ENOENT 假失败） */
const TMP = path.join(os.homedir(), '.ccb-test-tmp-e2e');
const TMP_APP = path.join(
	process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
	'.ccb-test-tmp-e2e'
);

const CURSOR_BLOB_KEY =
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

/* ---------- 本地 mock 中转站（OpenAI 兼容） ---------- */

const REPLY = '你好，这是 CCB 对话链路测试回复。';
let server;
let port;
let relayRequests = [];

function startRelay() {
	return new Promise((resolve) => {
		server = http.createServer((req, res) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				relayRequests.push({
					method: req.method,
					path: req.url,
					auth: req.headers.authorization || '',
					body: body ? JSON.parse(body) : null,
				});
				const send = (status, payload) => {
					res.writeHead(status, { 'content-type': 'application/json' });
					res.end(JSON.stringify(payload));
				};
				if (req.method === 'GET' && req.url === '/v1/models') {
					send(200, { data: [{ id: 'glm-5.3' }, { id: 'kimi-k2' }] });
				} else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
					send(200, {
						id: 'chatcmpl-ccb-e2e',
						object: 'chat.completion',
						choices: [
							{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' },
						],
						usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
					});
				} else if (req.method === 'POST' && req.url === '/v1/responses') {
					/* Codex 桌面版按新版 core 走 Responses API（wire_api = "responses"）：最小可用形状 */
					send(200, {
						id: 'resp-ccb-e2e',
						object: 'response',
						status: 'completed',
						output: [
							{
								id: 'msg-ccb-e2e',
								type: 'message',
								role: 'assistant',
								status: 'completed',
								content: [{ type: 'output_text', text: REPLY, annotations: [] }],
							},
						],
						usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 },
					});
				} else {
					send(404, { error: { message: 'Not Found' } });
				}
			});
		});
		server.listen(0, '127.0.0.1', () => {
			port = server.address().port;
			resolve();
		});
	});
}

beforeAll(startRelay);
afterAll(() => new Promise((r) => server.close(r)));

/* ---------- 测试基础设施（与 roundtrip.test.js 同模式） ---------- */

function cleanTmp() {
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(TMP_APP, { recursive: true, force: true });
}

function patchClient(id, patch) {
	const c = CLIENTS.find((x) => x.id === id);
	const before = { ...c };
	Object.assign(c, { exeNames: ['ccb-test-no-such-client.exe'] }, patch);
	return () => Object.assign(c, before);
}

/* 安全护栏：用户真实客户端配置在测试期间必须保持不变 */
const REAL_FILES = [
	path.join(os.homedir(), '.zcode', 'v2', 'config.json'),
	path.join(os.homedir(), '.zcode', 'cli', 'config.json'),
	path.join(os.homedir(), '.qoder', 'settings.json'),
	path.join(os.homedir(), '.qoder-cn', 'settings.json'),
	path.join(os.homedir(), '.qoderworkcn', '.models', 'default'),
	path.join(os.homedir(), '.codebuddy', 'models.json'),
	path.join(os.homedir(), '.codebuddy', 'settings.json'),
	path.join(os.homedir(), '.workbuddy', 'models.json'),
	path.join(os.homedir(), '.workbuddy-ai', 'models.json'),
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

function cfg() {
	return {
		apiKey: 'sk-ccb-dialogue-e2e-key',
		apiBase: `http://127.0.0.1:${port}/v1`,
		anthropicBase: `http://127.0.0.1:${port}`,
		models: ['glm-5.3', 'kimi-k2'],
		defaultModel: 'glm-5.3',
	};
}

/* 按客户端读取配置的方式读回凭据：endpoint（完整对话端点）+ apiKey + 默认模型 */
const READERS = {
	/* WorkBuddy：models.json 顶层数组，url 已是完整 /chat/completions 端点 */
	'wb-cn': () => {
		const arr = JSON.parse(fs.readFileSync(path.join(TMP, 'wb', 'models.json'), 'utf8'));
		return { endpoint: arr[0].url, apiKey: arr[0].apiKey, model: JSON.parse(
			fs.readFileSync(path.join(TMP, 'wb', 'settings.json'), 'utf8')
		).model };
	},
	/* CodeBuddy：models.json 对象形态 */
	'codebuddy-cn': () => {
		const data = JSON.parse(fs.readFileSync(path.join(TMP, 'codebuddy', 'models.json'), 'utf8'));
		const arr = Array.isArray(data) ? data : data.models;
		return { endpoint: arr[0].url, apiKey: arr[0].apiKey, model: JSON.parse(
			fs.readFileSync(path.join(TMP, 'codebuddy', 'settings.json'), 'utf8')
		).model };
	},
	/* ZCode：v2/config.json 的 provider.ccb */
	zcode: () => {
		const p = JSON.parse(fs.readFileSync(path.join(TMP, 'zcode', 'v2', 'config.json'), 'utf8'))
			.provider.ccb.options;
		const cli = JSON.parse(fs.readFileSync(path.join(TMP, 'zcode', 'cli', 'config.json'), 'utf8'));
		return { endpoint: p.baseURL + '/chat/completions', apiKey: p.apiKey, model: cli.model.replace(/^ccb\//, '') };
	},
	/* Qoder IDE：settings.json 的 modelConfigs.customModels（此前无端到端覆盖） */
	'qoder-intl': () => {
		const m = JSON.parse(fs.readFileSync(path.join(TMP, 'qoder', 'settings.json'), 'utf8'))
			.modelConfigs.customModels.find((x) => x.key === 'ccb/glm-5.3');
		return { endpoint: m.baseURL + '/chat/completions', apiKey: m.apiKey, model: 'glm-5.3' };
	},
	/* Qoder CN 桌面版：与 Qoder IDE 共用写入函数，但入口独立，单独验证 */
	'qoder-app-cn': () => {
		const m = JSON.parse(fs.readFileSync(path.join(TMP, 'qappcn', 'settings.json'), 'utf8'))
			.modelConfigs.customModels.find((x) => x.key === 'ccb/glm-5.3');
		return { endpoint: m.baseURL + '/chat/completions', apiKey: m.apiKey, model: 'glm-5.3' };
	},
	/* QoderWork：agents.db 的 byok 行，url 已是完整端点，api_key 为 plainBase64 */
	'qoderwork-cn': () => {
		const db = new DatabaseSync(path.join(TMP_APP, 'qwapp', 'data', 'agents.db'), { readOnly: true });
		const row = db.prepare("SELECT url, encrypted_parameters FROM byok_custom_models WHERE key = 'ccb/glm-5.3'").get();
		db.close();
		return {
			endpoint: row.url,
			apiKey: Buffer.from(JSON.parse(row.encrypted_parameters).api_key.value, 'base64').toString('utf8'),
			model: 'glm-5.3',
		};
	},
	/* Cursor：state.vscdb 的 blob（openAIBaseUrl 须带 /v1）+ 明文 Key 位 */
	cursor: () => {
		const file = vscdb.stateDbPath(path.join(TMP_APP, 'cursorapp'));
		const blob = vscdb.readJson(file, CURSOR_BLOB_KEY);
		return {
			endpoint: blob.openAIBaseUrl + '/chat/completions',
			apiKey: vscdb.readItem(file, 'cursorAuth/openAIKey'),
			model: 'glm-5.3',
		};
	},
	/* Codex 桌面版：~/.codex/config.toml（顶层 model_provider/model + [model_providers.ccb]）。
	 * 按新版 codex core 的读法取值：wire_api = "responses" → base_url + /responses、
	 * experimental_bearer_token 作 Authorization（chat 已被移除，写 chat 的配置加载即失败）。 */
	codex: () => {
		const text = fs.readFileSync(path.join(TMP, 'codex', 'config.toml'), 'utf8');
		const pick = (key) => {
			const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text);
			return m && m[1];
		};
		expect(text).toMatch(/^\s*model_provider\s*=\s*"ccb"\s*$/m);
		expect(text).toMatch(/^\s*wire_api\s*=\s*"responses"\s*$/m);
		return {
			endpoint: pick('base_url') + '/responses',
			apiKey: pick('experimental_bearer_token'),
			model: pick('model'),
		};
	},
};

/* 各客户端的对话协议：默认走 OpenAI chat/completions；Codex 桌面版例外——新版 core 只支持
 * Responses API（config.toml 里 wire_api = "responses"），请求体与回复形状都不同。 */
const DIALOGUE = {
	codex: {
		path: '/v1/responses',
		/* 最小可用请求体（真实 core 会附 instructions/tools/stream 等完整字段） */
		body: (model) => ({
			model,
			input: [{ type: 'message', role: 'user', content: '你好，请回复确认。' }],
			stream: false,
		}),
		reply: (payload) => payload.output[0].content[0].text,
		userText: (body) => body.input[0].content,
	},
};
const DEFAULT_DIALOGUE = {
	path: '/v1/chat/completions',
	body: (model) => ({
		model,
		messages: [{ role: 'user', content: '你好，请回复确认。' }],
		stream: false,
	}),
	reply: (payload) => payload.choices[0].message.content,
	userText: (body) => body.messages[0].content,
};

/* 各客户端写入前的环境铺垫（模拟「已安装并启动过一次」的现场） */
function seedClient(id) {
	if (id === 'zcode') {
		fs.mkdirSync(path.join(TMP, 'zcode', 'v2'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'zcode', 'v2', 'config.json'), JSON.stringify({
			provider: { 'user-own': { name: 'X', kind: 'openai', source: 'custom' } },
		}));
	}
	if (id === 'qoder-intl') {
		/* writeQoder 要求根目录已存在；补 machine_id 与 .models 让加密 customs 全链路执行 */
		fs.mkdirSync(path.join(TMP, 'qoder', '.auth'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qoder', '.auth', 'machine_id'), 'dialogue-e2e-machine-id');
		fs.mkdirSync(path.join(TMP, 'qoder', '.models', 'uid-e2e'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qoder', '.models', 'default'),
			JSON.stringify({ key: 'qmodel_x', uid: 'uid-e2e', scene: 'app' }));
	}
	if (id === 'qoder-app-cn') {
		fs.mkdirSync(path.join(TMP, 'qappcn', '.auth'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qappcn', '.auth', 'machine_id'), 'dialogue-e2e-machine-id-cn');
		fs.mkdirSync(path.join(TMP, 'qappcn', '.models', 'uid-cn'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qappcn', 'settings.json'), JSON.stringify({ theme: 'dark' }));
	}
	if (id === 'qoderwork-cn') {
		fs.mkdirSync(path.join(TMP, 'qw', '.auth'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qw', '.auth', 'machine_id'), 'dialogue-e2e-machine-id-qw');
		fs.mkdirSync(path.join(TMP, 'qw', '.models', 'uid-qw'), { recursive: true });
		fs.writeFileSync(path.join(TMP, 'qw', '.models', 'default'),
			JSON.stringify({ key: 'qmodel_y', uid: 'uid-qw', scene: 'assistant' }));
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
	}
	if (id === 'cursor') {
		const file = vscdb.stateDbPath(path.join(TMP_APP, 'cursorapp'));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const seed = new DatabaseSync(file);
		seed.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
		seed.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
			CURSOR_BLOB_KEY,
			JSON.stringify({ openAIBaseUrl: null, useOpenAIKey: false, otherSetting: 42 })
		);
		seed.close();
	}
	if (id === 'codex') {
		/* writeCodex 要求应用根已存在；顺带放一份用户既有配置，验证行级合并不动它 */
		fs.mkdirSync(path.join(TMP, 'codex'), { recursive: true });
		fs.writeFileSync(
			path.join(TMP, 'codex', 'config.toml'),
			'[model_providers.other]\nname = "Other"\nbase_url = "https://example.com/v1"\n'
		);
	}
}

/* patchClient 的目录改写（各客户端 → 临时目录） */
const PATCHES = {
	'wb-cn': { configDirs: [path.join(TMP, 'wb')] },
	'codebuddy-cn': { configDirs: [path.join(TMP, 'codebuddy')], appDirs: ['.ccb-test-tmp-e2e/cbapp'] },
	zcode: { homeDir: '.ccb-test-tmp-e2e/zcode' },
	'qoder-intl': { homeDir: '.ccb-test-tmp-e2e/qoder' },
	'qoder-app-cn': { homeDir: '.ccb-test-tmp-e2e/qappcn' },
	'qoderwork-cn': { homeDir: '.ccb-test-tmp-e2e/qw', appDirs: ['.ccb-test-tmp-e2e/qwapp'], exeNames: [] },
	cursor: { appDirs: ['.ccb-test-tmp-e2e/cursorapp'] },
	codex: { homeDir: '.ccb-test-tmp-e2e/codex', codexApplyFile: path.join(TMP, 'codex-apply.json') },
};

/* ---------- 逐客户端的对话闭环 ---------- */

describe('一键配置 → 对话 完整链路（本地 mock 中转站）', () => {
	let guard;

	beforeEach(() => {
		cleanTmp();
		relayRequests = [];
		guard = realSnapshot();
	});
	afterEach(() => {
		expect(realSnapshot()).toBe(guard);
		cleanTmp();
	});

	/* 每个写入器独立走完整闭环 */
		for (const id of Object.keys(READERS)) {
			it(`${id}：写入配置后，按客户端方式读回凭据可完成一次真实对话`, async () => {
				const restore = patchClient(id, PATCHES[id]);
				/* QoderWork 桥接与真实 runtime 强相关，格式闭环里显式跳过（另有 qoderbridge 专测） */
				const savedBridge = id === 'qoderwork-cn' ? process.env.CCB_QW_BRIDGE : undefined;
				if (id === 'qoderwork-cn') process.env.CCB_QW_BRIDGE = 'off';
				try {
				seedClient(id);
				const c = cfg();
				const d = DIALOGUE[id] || DEFAULT_DIALOGUE;

				/* 1. 一键配置写入 */
				const r = await applyConfig(id, c);
				expect(r.ok, (r.error || '') + '\n' + (r.log || []).join('\n')).toBe(true);

				/* 2. 按客户端读取配置的方式读回 */
				const { endpoint, apiKey, model } = READERS[id]();
				expect(endpoint).toBe(`http://127.0.0.1:${port}${d.path}`);
				expect(apiKey).toBe(c.apiKey);
				expect(model).toBe(c.defaultModel);

				/* 3. 客户端启动时拉模型列表 */
				relayRequests = [];
				const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
					headers: { authorization: `Bearer ${apiKey}` },
				});
				expect(modelsRes.status).toBe(200);
				expect((await modelsRes.json()).data.map((m) => m.id)).toEqual(c.models);
				expect(relayRequests[0].auth).toBe(`Bearer ${c.apiKey}`);

				/* 4. 发起一次真实对话 */
				relayRequests = [];
				const chatRes = await fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
					body: JSON.stringify(d.body(model)),
				});
				expect(chatRes.status).toBe(200);
				const chat = await chatRes.json();
				expect(d.reply(chat)).toBe(REPLY);

				/* 5. 中转站侧收到正确的鉴权、模型与消息 */
				expect(relayRequests).toHaveLength(1);
				expect(relayRequests[0].path).toBe(d.path);
				expect(relayRequests[0].auth).toBe(`Bearer ${c.apiKey}`);
				expect(relayRequests[0].body.model).toBe(c.defaultModel);
				expect(d.userText(relayRequests[0].body)).toBe('你好，请回复确认。');
			} finally {
				if (id === 'qoderwork-cn') {
					if (savedBridge === undefined) delete process.env.CCB_QW_BRIDGE;
					else process.env.CCB_QW_BRIDGE = savedBridge;
				}
				restore();
			}
		});
	}

	it('写入器接线：除 traeui（CDP 驱动真实客户端）外，全部写入器都有对话闭环用例', () => {
		/* 写入器 → 对话闭环用例所用的代表客户端 */
		const representatives = {
			workbuddy: 'wb-cn',
		codebuddy: 'codebuddy-cn',
		zcode: 'zcode',
			qoder: 'qoder-intl',
			qoderappcn: 'qoder-app-cn',
			qoderwork: 'qoderwork-cn',
			cursor: 'cursor',
			codex: 'codex',
		};
		const writersInUse = new Set(CLIENTS.map((c) => c.writer));
		/* 清单里出现的每个写入器都必须有代表用例（防止新增写入器时漏掉对话验收） */
		for (const w of writersInUse) {
			if (w === 'traeui') continue;
			expect(representatives, `写入器 ${w} 缺少对话闭环用例`).toHaveProperty(w);
			expect(READERS[representatives[w]], `写入器 ${w} 的代表客户端 ${representatives[w]} 没有 READERS 条目`).toBeTruthy();
		}
		/* 反向：代表用例对应的写入器真实存在于清单 */
		for (const [w, id] of Object.entries(representatives)) {
			expect(CLIENTS.some((c) => c.id === id && c.writer === w), `客户端 ${id} 的写入器应为 ${w}`).toBe(true);
		}
	});
});
