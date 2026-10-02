/* qoderproxy.injectByokConfig 单元测试（纯函数，无网络）
 *
 * 核心回归（2026-10-01 实机定位）：BYOK config 请求经 Go 语言客户端中转
 * （CALL_METHOD_ON_LANGUAGE_CLIENT），Go 的 encoding/json 把缺失的 bool 字段
 * 解析为 false。真实 /algo/api/v2/byok/config 响应顶层没有 enabled 字段 →
 * Go 补 false → 渲染层 byokRemoteEnabled=false → 自定义模型 account_disabled
 * 被下拉过滤（customItems=0）。注入必须显式写 enabled=true，且幂等分支
 * （already）返回的 body 也要带上。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const require = createRequire(import.meta.url);
const proxy = require('../electron/lib/qoderproxy.js');

/* 真实响应形状（2026-10-01 dump 取证）：顶层只有 providers、无 enabled；
 * deepseek provider enabled=true、types=[{key:'pg', models:[...]}] */
const realShape = {
	providers: [
		{ key: 'bailian', enabled: true, source: 'predefined', types: [{ key: 'tp', models: [{ key: 'qwen3.8-flash-tp' }] }] },
		{ key: 'deepseek', enabled: true, source: 'predefined', types: [{ key: 'pg', models: [{ key: 'deepseek-chat', display_name: { cn_zh: 'DeepSeek Chat', en_us: 'DeepSeek Chat' } }] }] },
	],
};

beforeAll(() => {
	/* dataDir 指到临时目录：setModels 会落盘 qoder-models.json，不能污染真实 ~/.ccb */
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoderproxy-inject-test-'));
	proxy.init({ dataDir: dir });
	proxy.setModels(['codeb-auto', 'glm-5.3']);
});

describe('injectByokConfig', () => {
	it('真实响应（顶层无 enabled）注入后显式 enabled=true', () => {
		const r = proxy.injectByokConfig(JSON.stringify(realShape));
		expect(r.ok).toBe(true);
		const j = JSON.parse(r.body);
		expect(j.enabled).toBe(true);
	});

	it('CCB 模型注入到独立的 custom provider，deepseek 原生模型保留', () => {
		const r = proxy.injectByokConfig(JSON.stringify(realShape));
		expect(r.ok).toBe(true);
		const j = JSON.parse(r.body);
		/* deepseek 原生模型保留，CCB 模型不混入 */
		const ds = j.providers.find((p) => p.key === 'deepseek');
		const dsKeys = ds.types[0].models.map((m) => m.key);
		expect(dsKeys).toContain('deepseek-chat');
		expect(dsKeys).not.toContain('codeb-auto');
		expect(dsKeys).not.toContain('glm-5.3');
		/* CCB 模型注入到独立的 custom provider */
		const custom = j.providers.find((p) => p.key === 'custom');
		expect(custom).toBeTruthy();
		const customKeys = custom.types[0].models.map((m) => m.key);
		expect(customKeys).toContain('codeb-auto');
		expect(customKeys).toContain('glm-5.3');
	});

	it('重复注入（幂等）返回的 body 同样带 enabled=true，且 custom provider 唯一', () => {
		const first = proxy.injectByokConfig(JSON.stringify(realShape));
		const again = proxy.injectByokConfig(first.body);
		expect(again.ok).toBe(true);
		expect(JSON.parse(again.body).enabled).toBe(true);
		/* 重复注入只保留一个 custom provider（先删旧的再追加） */
		const customCount = JSON.parse(again.body).providers.filter((p) => p.key === 'custom').length;
		expect(customCount).toBe(1);
	});

	it('显式 enabled=false 的响应也被打开', () => {
		const r = proxy.injectByokConfig(JSON.stringify({ enabled: false, ...realShape }));
		expect(r.ok).toBe(true);
		expect(JSON.parse(r.body).enabled).toBe(true);
	});

	it('非 JSON 与缺 providers 数组返回 ok=false', () => {
		expect(proxy.injectByokConfig('not-json').ok).toBe(false);
		expect(proxy.injectByokConfig('{}').ok).toBe(false);
	});

	it('模型清单为空时拒绝注入（ok=false）', () => {
		/* init 不清空内存 models，需全新模块实例模拟「从未加载清单」状态 */
		const modPath = require.resolve('../electron/lib/qoderproxy.js');
		const cached = require.cache[modPath];
		delete require.cache[modPath];
		try {
			const fresh = require(modPath);
			const r = fresh.injectByokConfig(JSON.stringify(realShape));
			expect(r.ok).toBe(false);
			expect(r.reason).toContain('模型清单为空');
		} finally {
			require.cache[modPath] = cached;
		}
	});
});
