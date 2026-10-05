import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseScriptDispatch, buildScriptArgs } = require('../electron/lib/script-dispatch');

describe('打包版脚本派发（script-dispatch）', () => {
	it('普通启动（无标记）不派发', () => {
		expect(parseScriptDispatch(['C:\\CCB.exe'])).toBe(null);
		expect(parseScriptDispatch(['electron.exe', 'F:\\ccb\\desktop'])).toBe(null);
		expect(parseScriptDispatch([])).toBe(null);
	});

	it('打包形态：标记在 argv[1]，argv 规整为 [execPath, 脚本名, ...原参数]', () => {
		const r = parseScriptDispatch([
			'C:\\Program Files\\CCB\\CCB.exe',
			'--ccb-script=qoder-secret-helper.js',
			'encrypt',
			'sk-ccb-unit',
		]);
		expect(r.error).toBeUndefined();
		expect(r.name).toBe('qoder-secret-helper.js');
		/* 被派发模块按 argv[2]/argv[3] 位置解析参数，与 dev 直跑脚本的布局完全一致 */
		expect(r.argv).toEqual([
			'C:\\Program Files\\CCB\\CCB.exe',
			'qoder-secret-helper.js',
			'encrypt',
			'sk-ccb-unit',
		]);
	});

	it('dev 形态：electron . 后跟标记，同样派发且参数位置正确', () => {
		const r = parseScriptDispatch([
			'electron.exe',
			'F:\\ccb\\desktop',
			'--ccb-script=qoder-proxy-runner.js',
			'9183',
		]);
		expect(r.error).toBeUndefined();
		expect(r.name).toBe('qoder-proxy-runner.js');
		expect(r.argv).toEqual(['electron.exe', 'qoder-proxy-runner.js', '9183']);
	});

	it('白名单外的脚本拒绝派发', () => {
		const r = parseScriptDispatch(['CCB.exe', '--ccb-script=evil.js', 'x']);
		expect(r.error).toBeTypeOf('string');
		expect(r.name).toBe('evil.js');
	});

	it('带路径分隔符的脚本名不构成标记（防路径穿越）', () => {
		expect(parseScriptDispatch(['CCB.exe', '--ccb-script=../evil.js', 'x'])).toBe(null);
		expect(parseScriptDispatch(['CCB.exe', '--ccb-script=a/b.js', 'x'])).toBe(null);
		expect(parseScriptDispatch(['CCB.exe', '--ccb-script=..\\evil.js', 'x'])).toBe(null);
	});

	it('argv[0] 位置的标记不算（只认参数区）', () => {
		expect(parseScriptDispatch(['--ccb-script=qoder-secret-helper.js'])).toBe(null);
	});

	it('buildScriptArgs：打包用标记，dev 用脚本路径', () => {
		const script = 'F:\\ccb\\desktop\\electron\\lib\\qoder-secret-helper.js';
		expect(buildScriptArgs(true, script, 'encrypt', 'sk-x')).toEqual([
			'--ccb-script=qoder-secret-helper.js',
			'encrypt',
			'sk-x',
		]);
		expect(buildScriptArgs(false, script, 'encrypt', 'sk-x')).toEqual([script, 'encrypt', 'sk-x']);
		expect(buildScriptArgs(true, script)).toEqual(['--ccb-script=qoder-secret-helper.js']);
	});
});
