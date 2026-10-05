import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

/* 用 Node 原生 require 载入被测模块（与 roundtrip.test.js 同理：共享模块实例） */
const require = createRequire(import.meta.url);
const writers = require('../electron/lib/writers');
const vscdb = require('../electron/lib/vscdb');

const { writeQoderCnVscdbModels, reapplyQoderCn } = writers;

const MODELS_KEY = 'aicoding.customModels';
const SECRET_PREFIX = 'secret://aicoding.customModel.apiKey.';
const AGENT_KEY = 'aicoding.aicoding-agent';

const BASE_CFG = {
	apiKey: 'sk-ccb-qcn-unit',
	apiBase: 'https://code.btluo.com/v1',
	models: ['codeb-auto', 'glm-5.3'],
	defaultModel: 'codeb-auto',
	qoderSecretBlob: Buffer.from('v10-unit-blob').toString('base64'),
	qoderProvider: 'custom',
};

/* 真实护栏：reapply 默认读写真机 ~/.ccb/qoder-apply.json，测试必须只动临时文件
 * （.tmp-apikey 事故教训）。真机 state.vscdb 由 IDE 自身随时回写（运行中不稳定），
 * 不纳入快照，靠 stateDbPath 显式指定隔离。 */
const REAL_APPLY_FILE = path.join(os.homedir(), '.ccb', 'qoder-apply.json');

function realApplySnapshot() {
	try {
		const s = fs.statSync(REAL_APPLY_FILE);
		return `${s.size}:${s.mtimeMs}`;
	} catch {
		return 'absent';
	}
}

let tmpRoot;
let dbFile;
let applyFile;
let client;
let guard;

function makeDb(items) {
	fs.mkdirSync(path.dirname(dbFile), { recursive: true });
	const db = new DatabaseSync(dbFile);
	db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
	const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
	for (const [k, v] of Object.entries(items)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
	db.close();
}

const readEntries = () => {
	const list = vscdb.readJson(dbFile, MODELS_KEY) || [];
	return list.filter((m) => String(m.displayName || '').startsWith('CCB '));
};
const readApply = () => JSON.parse(fs.readFileSync(applyFile, 'utf8'));
const writeApply = (data) => fs.writeFileSync(applyFile, JSON.stringify(data));
const selectedChat = () => {
	const agent = vscdb.readJson(dbFile, AGENT_KEY) || {};
	return (agent['globalstate-selected-models'] || {}).chat || null;
};

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-qcn-'));
	dbFile = path.join(tmpRoot, 'state.vscdb');
	applyFile = path.join(tmpRoot, 'qoder-apply.json');
	/* stateDbPath / qoderApplyFile 双双指向临时目录，绝不触碰真机配置 */
	client = { id: 'qoder-cn', name: 'Qoder CN IDE', appDirs: ['qcn-unit'], stateDbPath: dbFile, qoderApplyFile: applyFile };
	guard = realApplySnapshot();
});
afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	expect(realApplySnapshot()).toBe(guard);
});

describe('Qoder CN IDE vscdb 写入与启动前重写（reapply 一致性护栏）', () => {
	it('写入条目、加密 secret、默认模型与参数持久化', () => {
		makeDb({ 'someUserKey': { a: 1 } });
		const r = writeQoderCnVscdbModels(client, { ...BASE_CFG }, () => {});
		expect(r.ok).toBe(true);
		expect(r.added).toBe(2);

		const ours = readEntries();
		expect(ours).toHaveLength(2);
		expect(ours.every((m) => m.baseUrl === BASE_CFG.apiBase)).toBe(true);
		expect(ours.every((m) => m.provider === 'custom' && m.byokTypeKey === 'pg')).toBe(true);
		expect(ours.every((m) => m.visible === true && m.hasApiKey === true)).toBe(true);

		const secrets = vscdb.listKeys(dbFile, SECRET_PREFIX + '%');
		expect(secrets).toHaveLength(2);

		const want = ours.find((m) => m.model === BASE_CFG.defaultModel);
		expect(selectedChat()).toBe('custom:' + want.id);

		const saved = readApply();
		expect(saved.apiKey).toBe(BASE_CFG.apiKey);
		expect(saved.apiBase).toBe(BASE_CFG.apiBase);
		expect(saved.models).toEqual(BASE_CFG.models);
		expect(saved.defaultModel).toBe(BASE_CFG.defaultModel);
		expect(saved.qoderSecretBlob).toBe(BASE_CFG.qoderSecretBlob);
		expect(saved.qoderProvider).toBe('custom');

		/* 用户已有条目不被误伤 */
		expect(vscdb.readJson(dbFile, 'someUserKey')).toEqual({ a: 1 });
	});

	it('条目与参数一致时 reapply 跳过（id 不变，选中模型不失效）', () => {
		makeDb({});
		writeQoderCnVscdbModels(client, { ...BASE_CFG }, () => {});
		const idsBefore = readEntries().map((m) => m.id).join(',');
		const selBefore = selectedChat();

		expect(reapplyQoderCn(client, () => {})).toBe(true);
		expect(readEntries().map((m) => m.id).join(',')).toBe(idsBefore);
		expect(selectedChat()).toBe(selBefore);
	});

	it('参数 baseUrl 更新后条目仍指旧地址时必须重写（本 bug 的核心回归）', () => {
		makeDb({});
		writeQoderCnVscdbModels(client, { ...BASE_CFG }, () => {});
		const idsBefore = new Set(readEntries().map((m) => m.id));

		/* 模拟一次成功 apply 更新了持久化参数（如测试隧道 → 生产中转），
		 * 但 vscdb 条目因 IDE 回写/崩溃恢复等原因仍挂着旧地址 */
		const saved = readApply();
		writeApply({ ...saved, apiBase: 'https://relay-new.example/v1' });

		expect(reapplyQoderCn(client, () => {})).toBe(true);
		const ours = readEntries();
		expect(ours).toHaveLength(2);
		expect(ours.every((m) => m.baseUrl === 'https://relay-new.example/v1')).toBe(true);
		expect(ours.some((m) => idsBefore.has(m.id))).toBe(false);

		/* 重写后默认模型指向新条目，secret 与新 id 对齐，旧 secret 被清扫 */
		const want = ours.find((m) => m.model === BASE_CFG.defaultModel);
		expect(selectedChat()).toBe('custom:' + want.id);
		const secrets = vscdb.listKeys(dbFile, SECRET_PREFIX + '%');
		expect(secrets).toHaveLength(2);
		const ids = new Set(ours.map((m) => m.id));
		expect(secrets.every((k) => ids.has(k.slice(SECRET_PREFIX.length)))).toBe(true);
	});

	it('provider 漂移（历史 deepseek 方案条目）同样触发重写', () => {
		makeDb({});
		writeQoderCnVscdbModels(client, { ...BASE_CFG, qoderProvider: 'deepseek' }, () => {});
		/* 持久化参数已是 custom 方案，vscdb 里还是 deepseek 旧条目 */
		const saved = readApply();
		expect(saved.qoderProvider).toBe('deepseek');
		writeApply({ ...saved, qoderProvider: 'custom' });

		expect(reapplyQoderCn(client, () => {})).toBe(true);
		const ours = readEntries();
		expect(ours.every((m) => m.provider === 'custom')).toBe(true);
		expect(ours).toHaveLength(2);
	});

	it('条目在但 secret 被 IDE 清掉一半时触发重写（恢复可解密的完整状态）', () => {
		makeDb({});
		writeQoderCnVscdbModels(client, { ...BASE_CFG }, () => {});
		const [first] = readEntries();
		vscdb.deleteItem(dbFile, SECRET_PREFIX + first.id);
		expect(vscdb.listKeys(dbFile, SECRET_PREFIX + '%')).toHaveLength(1);

		expect(reapplyQoderCn(client, () => {})).toBe(true);
		const ours = readEntries();
		const secrets = vscdb.listKeys(dbFile, SECRET_PREFIX + '%');
		expect(secrets).toHaveLength(2);
		const ids = new Set(ours.map((m) => m.id));
		expect(secrets.every((k) => ids.has(k.slice(SECRET_PREFIX.length)))).toBe(true);
	});

	it('条目被 IDE 清空时 reapply 重写恢复', () => {
		makeDb({});
		writeQoderCnVscdbModels(client, { ...BASE_CFG }, () => {});
		vscdb.writeItem(dbFile, MODELS_KEY, '[]');

		expect(reapplyQoderCn(client, () => {})).toBe(true);
		expect(readEntries()).toHaveLength(2);
	});

	it('从未配置过（无参数文件）返回 false 静默跳过', () => {
		expect(reapplyQoderCn(client, () => {})).toBe(false);
	});
});
