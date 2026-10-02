import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/* 与 writers.js 用同一份模块实例 */
const require = createRequire(import.meta.url);
const {
	buildChoiceScript,
	buildReadScript,
	buildRawSetScript,
	buildRemoveScript,
	modelIdCandidates,
	collectChoiceKeys,
	SELECTOR,
	CHOICE_KEY_PREFIX,
	CUSTOM_LOCAL_PREFIX,
	LIST_KEYS_SCRIPT,
} = require('../electron/lib/workbuddyui');

/* 用假 localStorage 真跑一遍生成的脚本：比「字符串里包含某段文本」更能锁住行为 */
function runScript(script, store = new Map()) {
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		key: (i) => [...store.keys()][i] ?? null,
		get length() { return store.size; },
	};
	const value = new Function('localStorage', 'return ' + script)(localStorage);
	return { value, store };
}

describe('WorkBuddy UI 自动化：存储脚本', () => {
	it('选择器与键前缀指向实测过的值', () => {
		expect(SELECTOR).toBe('.cr-model-selector__trigger');
		expect(CHOICE_KEY_PREFIX).toBe('cb-newtask:model:');
		expect(CUSTOM_LOCAL_PREFIX).toBe('custom-local:');
	});

	it('buildChoiceScript 写入客户端认得的 JSON 结构', () => {
		const { value, store } = runScript(buildChoiceScript('cb-newtask:model:uid1', 'custom-local:glm-5.3'));
		expect(store.get('cb-newtask:model:uid1')).toBe('{"id":"custom-local:glm-5.3","isThinking":false}');
		expect(value).toBe(store.get('cb-newtask:model:uid1'));
	});

	it('buildReadScript 读回原值，键不存在时返回 null', () => {
		expect(runScript(buildReadScript('k')).value).toBe(null);
		expect(runScript(buildReadScript('k'), new Map([['k', 'v']])).value).toBe('v');
	});

	it('buildRawSetScript 原样写回快照（回滚用）', () => {
		const raw = '{"id":"user-own","isThinking":true}';
		expect(runScript(buildRawSetScript('k', raw)).store.get('k')).toBe(raw);
	});

	it('buildRemoveScript 删除键（回到客户端内置档位）', () => {
		expect(runScript(buildRemoveScript('k'), new Map([['k', 'v']])).store.has('k')).toBe(false);
	});

	it('模型名/键名里的引号与反斜杠不会拼坏脚本', () => {
		const key = 'cb-newtask:model:a"b\\c\'d';
		const model = 'custom-local:x"y\\z';
		for (const script of [
			buildChoiceScript(key, model),
			buildReadScript(key),
			buildRawSetScript(key, '{"a":"b\\\\c"}'),
			buildRemoveScript(key),
		]) {
			expect(() => new Function('localStorage', 'return ' + script)).not.toThrow();
		}
		const { store } = runScript(buildChoiceScript(key, model));
		expect(store.has(key)).toBe(true);
		expect(JSON.parse(store.get(key)).id).toBe(model);
	});

	it('LIST_KEYS_SCRIPT 只枚举默认模型键，其它键不掺进来', () => {
		const store = new Map([
			['cb-newtask:model:uid-a', '{"id":"x"}'],
			['theme', 'dark'],
			['cb-newtask:model:uid-b', '{"id":"y"}'],
			['cb-effort:by-model', '{}'],
		]);
		expect(JSON.parse(runScript(LIST_KEYS_SCRIPT, store).value)).toEqual([
			'cb-newtask:model:uid-a',
			'cb-newtask:model:uid-b',
		]);
	});

	it('LIST_KEYS_SCRIPT 没有任何键时返回空数组', () => {
		expect(JSON.parse(runScript(LIST_KEYS_SCRIPT).value)).toEqual([]);
	});
});

describe('WorkBuddy UI 自动化：多账号键收集', () => {
	it('当前账号 + localStorage 里出现过的账号 + 数据目录发现的账号，去重合并', () => {
		expect(collectChoiceKeys('uid-a', ['cb-newtask:model:uid-b', 'other'], ['uid-c', 'uid-a'])).toEqual([
			'cb-newtask:model:uid-a',
			'cb-newtask:model:uid-b',
			'cb-newtask:model:uid-c',
		]);
	});

	it('带前缀开头的名字不会拼出双重前缀；非字符串项被忽略', () => {
		expect(collectChoiceKeys('uid-a', null, ['cb-newtask:model:uid-a', '', null, 42])).toEqual([
			'cb-newtask:model:uid-a',
		]);
	});
});

describe('WorkBuddy UI 自动化：模型 id 候选', () => {
	it('先试带 custom-local: 前缀的，再试裸 id', () => {
		expect(modelIdCandidates('glm-5.3')).toEqual(['custom-local:glm-5.3', 'glm-5.3']);
	});

	it('已经是带前缀的 id 不会被拼成两遍', () => {
		expect(modelIdCandidates('custom-local:glm-5.3')).toEqual(['custom-local:glm-5.3', 'glm-5.3']);
	});
});