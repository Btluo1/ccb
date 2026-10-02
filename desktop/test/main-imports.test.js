import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/* 用 Node 原生 require 载入被测模块（与 roundtrip.test.js 同理） */
const require = createRequire(import.meta.url);

const mainPath = fileURLToPath(new URL('../electron/main.js', import.meta.url));

/* main.js 无法脱离 Electron 运行时加载（顶部 require('electron')），但两类问题
 * 可以在纯 Node 里静态验证，各自都出过真实事故：
 *   1. main.js 使用了未导入的名字 → IPC 处理器一调用就抛 ReferenceError
 *      （事故：调用了未导入的 cleanupLegacyKiroEnv）
 *   2. 解构导入的名字在目标模块里不存在 → main.js 启动即抛 SyntaxError
 */

function extractDestructuredRequires(source) {
	const out = [];
	const re = /const\s*\{([^}]+)\}\s*=\s*require\('\.\/lib\/([^']+)'\)/g;
	for (const m of source.matchAll(re)) {
		const names = m[1]
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		out.push({ module: m[2], names });
	}
	return out;
}

/** 收集源码里「已声明」的名字（变量 / 函数 / 解构 / 函数参数，宽口径防误报） */
function collectDeclared(source) {
	const names = new Set();
	for (const m of source.matchAll(/\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})/g)) {
		const decl = m[1];
		if (decl.startsWith('{')) {
			for (const part of decl.slice(1, -1).split(',')) {
				names.add(part.trim().split(':')[0].trim());
			}
		} else {
			names.add(decl);
		}
	}
	for (const m of source.matchAll(/\bfunction\s+([\w$]+)/g)) names.add(m[1]);
	/* 函数参数（含箭头函数）：即便被当函数调用也不算未定义。
	 * 注意嵌套括号：new Promise((resolve) => …) 会捕获到 "(resolve"，需剥掉前导括号。 */
	for (const m of source.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
		for (const part of m[1].split(',')) {
			names.add(part.trim().split('=')[0].trim().replace(/^[^\w$]+/, ''));
		}
	}
	return names;
}

const KEYWORDS = new Set([
	'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof',
	'delete', 'void', 'do', 'else', 'in', 'of', 'await', 'async', 'constructor', 'super',
]);
const GLOBALS = new Set([
	'require', 'fetch', 'console', 'JSON', 'Math', 'Date', 'Promise', 'Object', 'Array',
	'String', 'Number', 'Boolean', 'Error', 'TypeError', 'RangeError', 'RegExp', 'Map',
	'Set', 'Symbol', 'Buffer', 'URL', 'URLSearchParams', 'AbortSignal', 'parseInt',
	'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'setInterval', 'clearTimeout',
	'decodeURIComponent', 'encodeURIComponent',
]);

describe('main.js 导入完整性（防 ReferenceError 回归）', () => {
	const source = fs.readFileSync(mainPath, 'utf8');

	it('解构导入的每个名字都存在于目标模块的导出', () => {
		const imports = extractDestructuredRequires(source);
		expect(imports.length).toBeGreaterThan(0);
		for (const { module: mod, names } of imports) {
			const exports = require(`../electron/lib/${mod}`);
			for (const name of names) {
				expect(exports, `lib/${mod} 应导出 ${name}`).toHaveProperty(name);
			}
		}
	});

	it('所有裸调用名均已声明或导入（曾经调用未导入的函数，IPC 一触发即 ReferenceError）', () => {
		const declared = collectDeclared(source);
		for (const { names } of extractDestructuredRequires(source)) {
			for (const n of names) declared.add(n);
		}
		const undefined_ = new Set();
		for (const m of source.matchAll(/(?<![.\w$'"`])([a-zA-Z_$][\w$]*)\s*\(/g)) {
			const name = m[1];
			if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
			undefined_.add(name);
		}
		expect([...undefined_], 'main.js 中存在未声明/未导入即调用的名字').toEqual([]);
	});
});
