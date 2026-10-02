import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import writers from '../electron/lib/writers';
import vscdb from '../electron/lib/vscdb';

const { writeCursorForDir, rollbackCursorForDir } = writers;

const CURSOR_BLOB =
	'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const CFG = {
	apiKey: 'sk-ccb-test-key-0001',
	apiBase: 'https://code.btluo.com/v1',
	models: ['model-a', 'model-b'],
};

/* 合成一个最小 state.vscdb（ItemTable 表结构取自真实 IDE） */
function makeDb(appDataDir, items) {
	const file = vscdb.stateDbPath(appDataDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
	const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
	for (const [k, v] of Object.entries(items)) ins.run(k, typeof v === 'string' ? v : JSON.stringify(v));
	db.close();
	return file;
}

let tmpRoot;
beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-test-'));
});
afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Cursor 自定义服务写入', () => {
	function seed() {
		return makeDb(tmpRoot, {
			[CURSOR_BLOB]: { openAIBaseUrl: null, useOpenAIKey: false, otherSetting: 42 },
			'cursorAuth/cachedEmail': 'user@example.com',
		});
	}

	it('写入 baseUrl（带 /v1）、useOpenAIKey 开关与 API Key，并保留其他设置', () => {
		const file = seed();
		expect(writeCursorForDir(tmpRoot, CFG, () => {})).toBe(true);

		const blob = vscdb.readJson(file, CURSOR_BLOB);
		expect(blob.openAIBaseUrl).toBe('https://code.btluo.com/v1');
		expect(blob.useOpenAIKey).toBe(true);
		expect(blob.otherSetting).toBe(42);
		expect(vscdb.readItem(file, 'cursorAuth/openAIKey')).toBe(CFG.apiKey);
		expect(vscdb.readItem(file, 'cursorAuth/cachedEmail')).toBe('user@example.com');
	});

	it('登记自定义模型并把各场景默认模型指向 CCB', () => {
		const file = makeDb(tmpRoot, {
			[CURSOR_BLOB]: {
				openAIBaseUrl: null,
				useOpenAIKey: false,
				aiSettings: {
					userAddedModels: ['user-own-model'],
					modelConfig: {
						composer: { modelName: 'default', maxMode: true, selectedModels: [{ modelId: 'default', parameters: [] }] },
						'cmd-k': { modelName: 'default', maxMode: false, selectedModels: [{ modelId: 'default', parameters: [] }] },
					},
				},
			},
		});
		writeCursorForDir(tmpRoot, CFG, () => {});
		const blob = vscdb.readJson(file, CURSOR_BLOB);
		/* 用户自建模型保留，我们的追加在后 */
		expect(blob.aiSettings.userAddedModels).toEqual(['user-own-model', 'model-a', 'model-b']);
		expect(blob.aiSettings.modelOverrideEnabled).toEqual(['model-a', 'model-b']);
		/* 各场景默认模型指向 CCB 默认模型，并关掉 maxMode（自定义模型不支持） */
		expect(blob.aiSettings.modelConfig.composer).toMatchObject({ modelName: 'model-a', maxMode: false });
		expect(blob.aiSettings.modelConfig.composer.selectedModels).toEqual([{ modelId: 'model-a', parameters: [] }]);
		expect(blob.aiSettings.modelConfig['cmd-k'].modelName).toBe('model-a');
	});

	it('不写 availableDefaultModels2（服务端目录）', () => {
		const file = makeDb(tmpRoot, {
			[CURSOR_BLOB]: { aiSettings: {}, availableDefaultModels2: [{ name: 'server-hash' }] },
		});
		writeCursorForDir(tmpRoot, CFG, () => {});
		const blob = vscdb.readJson(file, CURSOR_BLOB);
		expect(blob.availableDefaultModels2).toEqual([{ name: 'server-hash' }]);
	});

	it('回滚从备份完全还原', () => {
		const file = seed();
		const before = vscdb.readItem(file, CURSOR_BLOB);
		writeCursorForDir(tmpRoot, CFG, () => {});
		rollbackCursorForDir(tmpRoot, () => {});
		expect(vscdb.readItem(file, CURSOR_BLOB)).toBe(before);
		expect(vscdb.readItem(file, 'cursorAuth/openAIKey')).toBe(null);
	});

	it('无备份回滚时关闭开关但不动用户自建的 Key', () => {
		const file = makeDb(tmpRoot, {
			[CURSOR_BLOB]: { openAIBaseUrl: 'https://code.btluo.com/v1', useOpenAIKey: true },
			'cursorAuth/openAIKey': 'sk-user-own-key',
		});
		rollbackCursorForDir(tmpRoot, () => {});
		const blob = vscdb.readJson(file, CURSOR_BLOB);
		expect(blob.useOpenAIKey).toBe(false);
		expect(blob.openAIBaseUrl).toBe(null);
		expect(vscdb.readItem(file, 'cursorAuth/openAIKey')).toBe('sk-user-own-key');
	});
});
