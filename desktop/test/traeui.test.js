import net from 'node:net';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/* 与 writers.js 用同一份模块实例，避免出现两份 SEL / 两份逻辑 */
const require = createRequire(import.meta.url);
const { displayNameOf, findFreePort, buildFillScript, Cdp, SEL, waitFor, waitForWorkbench, waitForRect, LOGIN_VISIBLE, ENSURE_APPEND_MODE, RPC_FIND_SERVICE, RPC_LIST, buildRpcPayload, isRpcAddSuccess, rpcWaitModelList, addModelsViaRpc } = require('../electron/lib/traeui');

describe('Trae UI 自动化：纯逻辑', () => {
	it('展示名统一加 CCB 前缀（Trae 列表里混着同名预置模型）', () => {
		expect(displayNameOf('glm-5.3')).toBe('CCB glm-5.3');
		expect(displayNameOf('claude-opus-5')).toBe('CCB claude-opus-5');
	});

	it('findFreePort 返回可用的空闲端口', async () => {
		const port = await findFreePort();
		expect(port).toBeGreaterThan(0);
		await new Promise((resolve, reject) => {
			const srv = net.createServer();
			srv.on('error', reject);
			srv.listen(port, '127.0.0.1', () => srv.close(resolve));
		});
	});

	it('选择器都指向实测过的类名，避免改错地方（新旧两代 UI 同时覆盖）', () => {
		/* 旧版（TraeWork CN 1.107.1）与新版（TraeCode CN 2026-09）各有前缀，逗号多选择器并存 */
		expect(SEL.modelTrigger).toBe('.core-model-select-trigger, .icd-model-select-trigger, [class*="model-select-trigger"]');
		expect(SEL.modelMenu).toBe('.core-model-select-portal, .icube-model-select-portal, [class*="model-select-portal"]');
		expect(SEL.menuFooterAdd).toBe('.core-model-select-footer-action, .icube-model-select-portal-footer, [class*="model-select"][class*="footer"]');
		expect(SEL.dialog).toBe('.icd-modal-overlay.add-model-dialog');
		expect(SEL.dialogSubmit).toBe('.add-model-connect-button');
		/* 新版提交先跑连通性测试，失败后弹窗里才出现「直接保存」（跳过测试入库） */
		expect(SEL.dialogSave).toBe('.add-model-save-button');
	});
});

describe('Trae UI 自动化：填表脚本', () => {
	it('生成合法 JS，且把值安全注入（含引号/反斜杠也不破脚本）', () => {
		const apiKey = 'sk-ccb-a"b\\c\'d';
		const script = buildFillScript('https://code.btluo.com/v1', 'glm-5.3', 'CCB glm-5.3', apiKey);
		expect(() => new Function('return ' + script)).not.toThrow();
		/* 值必须原样出现在脚本里（JSON 转义），不能是裸拼接 */
		expect(script).toContain(JSON.stringify(apiKey));
		expect(script).toContain(JSON.stringify('https://code.btluo.com/v1'));
	});

	it('脚本按 placeholder 定位四个输入框，并派发 React 认得的 input/change 事件', () => {
		const script = buildFillScript('https://x/v1', 'm', 'CCB m', 'k');
		for (const ph of [SEL.phBase, SEL.phModelId, SEL.phDisplay, SEL.phApiKey]) {
			expect(script).toContain(JSON.stringify(ph));
		}
		expect(script).toContain("new Event('input'");
		expect(script).toContain("new Event('change'");
	});
});

describe('Trae UI 自动化：「完整 URL」开关归一化', () => {
	it('只在开关已勾选时点击拨回，且是合法 JS（失败后客户端会把表单缓存成完整 URL 模式）', () => {
		expect(() => new Function('return ' + ENSURE_APPEND_MODE)).not.toThrow();
		expect(ENSURE_APPEND_MODE).toContain('.add-model-switch-input');
		expect(ENSURE_APPEND_MODE).toContain('sw.checked');
		expect(ENSURE_APPEND_MODE).toContain('sw.click()');
		/* 归一化必须限定在弹窗内，避免误点页面其他开关 */
		expect(ENSURE_APPEND_MODE).toContain(JSON.stringify(SEL.dialog));
	});
});

describe('Trae UI 自动化：写入器接线', () => {
	it('Trae 系客户端都指向 traeui 写入器（CN 两客户端已合并为 TRAE CN 单条目）', () => {
		const { CLIENTS } = require('../electron/lib/clients');
		const traes = CLIENTS.filter((c) => /^trae/.test(c.id));
		expect(traes.map((c) => c.id)).toEqual(['trae-intl', 'trae-cn', 'traework-intl']);
		for (const c of traes) {
			expect(c.writer).toBe('traeui');
		}
		/* 合并后的 TRAE CN：沿用 TraeCode CN 的安装目录 / exe / 数据目录 */
		const cn = traes.find((c) => c.id === 'trae-cn');
		expect(cn.name).toBe('TRAE CN');
		expect(cn.appDirs).toEqual(['Trae CN']);
		expect(cn.exeNames).toEqual(['Trae CN.exe', 'TRAE CN.exe']);
		expect(cn.homeDir).toBe('.trae-cn');
	});

	it('拿不到程序路径时给出明确提示，而不是抛异常（曾经漏导出 findLaunchExe）', async () => {
		const { applyConfig } = require('../electron/lib/writers');
		const r = await applyConfig('trae-cn', { apiKey: 'sk-ccb-x', apiBase: 'https://x/v1', models: ['m'] }, {});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/未找到程序位置/);
	});
});

describe('Trae UI 自动化：等待与未登录检测', () => {
	/** 脚手架：让 cdp.evaluate(expr) 依次按预设返回；页面导航失败用「抛错」模拟。
	 * waitForWorkbench 会按序求值 RECT_TRIGGER（找模型选择器）与 LOGIN_VISIBLE（找登录按钮），
	 * 预设函数用「是否含“登录”」区分这两类探测。 */
	function scriptedCdp(responses, ws) {
		const calls = [];
		const cdp = {
			ws: ws || { url: 'ws://test/target-1', readyState: 1 },
			evaluate: async (expr) => {
				calls.push(expr);
				const hit = responses(expr, calls.length);
				if (hit instanceof Error) throw hit;
				return hit;
			},
		};
		return { cdp, calls };
	}

	it('waitFor：求值抛错（页面正在导航）不算失败，继续轮询直到为真', async () => {
		let n = 0;
		const { cdp } = scriptedCdp(() => {
			n++;
			if (n < 3) return new Error(' Cannot find context');
			return true;
		});
		await expect(waitFor(cdp, 'TRIGGER', 2000, '主界面')).resolves.toBe(true);
	});

	it('waitFor：超时抛出可读错误', async () => {
		const { cdp } = scriptedCdp(() => null);
		await expect(waitFor(cdp, 'TRIGGER', 300, '主界面')).rejects.toThrow(/等待「主界面」超时/);
	});

	it('waitForWorkbench：登录按钮冷启动瞬时出现后消失、选择器随后就位 → 不误判未登录（本 bug 曾让已登录用户必现失败）', async () => {
		const seq = [];
		const { cdp } = scriptedCdp((expr) => {
			/* 顺序：触发器(无) → 登录按钮(有，冷启动顶栏先渲染登录态) → 触发器(无) → 登录按钮(无，会话已恢复) → 触发器(有) */
			if (expr.includes('登录')) {
				seq.push('login');
				return seq.filter((s) => s === 'login').length === 1 ? '1' : '';
			}
			seq.push('trigger');
			return seq.filter((s) => s === 'trigger').length >= 3 ? '{"x":1,"y":2}' : null;
		});
		const res = await waitForWorkbench(cdp, 0, 'TRAE CN', () => {}, { pollMs: 1, loginGraceMs: 400, deadlineMs: 5000 });
		expect(res.error).toBeUndefined();
		expect(res.cdp).toBe(cdp);
	});

	it('waitForWorkbench：登录按钮持续存在超过宽限期 → 判未登录并给出可读错误', async () => {
		const { cdp } = scriptedCdp((expr) => (expr.includes('登录') ? '1' : null));
		const res = await waitForWorkbench(cdp, 0, 'TRAE CN', () => {}, { pollMs: 2, loginGraceMs: 60, deadlineMs: 5000 });
		expect(res.error).toMatch(/TRAE CN 未登录/);
	});

	it('waitForWorkbench：选择器与登录按钮都不出现 → 超时错误（不是未登录）', async () => {
		const { cdp } = scriptedCdp(() => null);
		const res = await waitForWorkbench(cdp, 0, 'TRAE CN', () => {}, { pollMs: 2, deadlineMs: 80 });
		expect(res.error).toMatch(/主界面/);
		expect(res.error).not.toMatch(/未登录/);
	});

	it('waitForWorkbench：调试 socket 已断开时不做求值（避免每次空烧 20 秒超时），无新目标则等到截止', async () => {
		const { cdp, calls } = scriptedCdp(() => '1', { url: 'ws://test/splash', readyState: 3 });
		/* 端口 1 上没有调试端点：listPages 立刻连接失败，不会挂住 */
		const res = await waitForWorkbench(cdp, 1, 'TRAE CN', () => {}, { pollMs: 2, deadlineMs: 80 });
		expect(res.error).toMatch(/主界面/);
		expect(calls.length).toBe(0);
	});

	it('waitForWorkbench：从未发现任何调试窗口 → 报错区分「客户端可能未成功启动」（2026-10-22 用户超时无法远程定位根因后补的诊断分支）', async () => {
		const { cdp } = scriptedCdp(() => null);
		const res = await waitForWorkbench(cdp, 0, 'TRAE CN', () => {}, { pollMs: 2, deadlineMs: 60 });
		expect(res.error).toMatch(/没有发现任何客户端调试窗口/);
	});

	it('waitForWorkbench：发现过窗口但选择器不出 → 错误文案带窗口名，便于远程排障', async () => {
		const origList = Cdp.listPages;
		const origOpen = Cdp.open;
		Cdp.listPages = async () => [{ type: 'page', url: 'file:///x/solo/solo-lite.html', title: '', webSocketDebuggerUrl: 'ws://test/solo' }];
		Cdp.open = async () => ({ ws: { url: 'ws://test/solo', readyState: 1 }, evaluate: async () => null });
		try {
			const { cdp } = scriptedCdp(() => null, { url: 'ws://test/dead', readyState: 3 });
			const res = await waitForWorkbench(cdp, 0, 'TRAE CN', () => {}, { pollMs: 2, deadlineMs: 60 });
			expect(res.error).toMatch(/主界面等待超时/);
			expect(res.error).toContain('solo-lite.html');
			expect(res.error).toMatch(/AI 对话主界面/);
		} finally {
			Cdp.listPages = origList;
			Cdp.open = origOpen;
		}
	});

	it('waitForRect：坐标表达式先返回 null 后返回 JSON，要等它出现（连通性测试期间提交按钮禁用）', async () => {
		let n = 0;
		const { cdp } = scriptedCdp(() => {
			n++;
			if (n < 3) return null;
			return '{"x":1,"y":2}';
		});
		await expect(waitForRect(cdp, 'RECT', 2000, '提交按钮')).resolves.toBe('{"x":1,"y":2}');
	});

	it('waitForRect：求值抛错不算失败，超时抛出可读错误', async () => {
		let n = 0;
		const { cdp } = scriptedCdp(() => {
			n++;
			if (n < 3) return new Error('navigating');
			return null;
		});
		await expect(waitForRect(cdp, 'RECT', 300, '提交按钮')).rejects.toThrow(/提交按钮不可用/);
	});

	it('未登录脚本只认可见按钮的精确「登录」文案，且是合法 JS', () => {
		expect(() => new Function('return ' + LOGIN_VISIBLE)).not.toThrow();
		expect(LOGIN_VISIBLE).toContain("'登录'");
		expect(LOGIN_VISIBLE).toContain('offsetWidth');
		expect(LOGIN_VISIBLE).toContain('[role=button]');
	});
});

/* 用一个假 WebSocket 验证 CDP 客户端的收发与超时，不需要真的起 Trae */
class FakeWs {
	constructor() {
		this.sent = [];
		this.listeners = {};
	}
	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}
	send(text) {
		this.sent.push(JSON.parse(text));
	}
	close() {}
	emit(msg) {
		for (const fn of this.listeners.message || []) fn({ data: JSON.stringify(msg) });
	}
}

describe('Trae UI 自动化：RPC 直调（方案 A，2026-10-10 实测）', () => {
	it('两个页面脚本都是合法 JS（求值前先静态校验，改坏立刻暴露）', () => {
		expect(() => new Function('return ' + RPC_FIND_SERVICE)).not.toThrow();
		expect(() => new Function('return ' + RPC_LIST)).not.toThrow();
		/* 取服务脚本必须包含三个实测踩坑的兜底：懒初始化三连、真身模块、双 token 尝试 */
		expect(RPC_FIND_SERVICE).toContain('prepareModule');
		expect(RPC_FIND_SERVICE).toContain('injectServiceCollection');
		expect(RPC_FIND_SERVICE).toContain('bootstrap');
		expect(RPC_FIND_SERVICE).toContain('_loadedModule');
		expect(RPC_FIND_SERVICE).toContain("Symbol.for('aiAgent.IAiNativeModelService')");
		expect(RPC_FIND_SERVICE).toContain('window.__CCB_MODEL_SVC = svc');
	});

	it('buildRpcPayload 与客户端 UI 提交的字段逐一对齐（bundle 逆向）', () => {
		const p = buildRpcPayload({ apiBase: 'https://code.btluo.com/v1//', apiKey: 'sk-x' }, 'glm-5.3');
		expect(p.provider).toBe('custom_openai_compatible');
		expect(p.model_name).toBe('glm-5.3');
		expect(p.ak).toBe('sk-x');
		expect(p.is_custom).toBe(true);
		expect(p.auth_type).toBe(0);
		/* 裸 base 自动拼 /chat/completions（等价 UI「拼接」模式），尾部斜杠要归一 */
		expect(p.base_url).toBe('https://code.btluo.com/v1/chat/completions');
		expect(p.display_name).toBe('CCB glm-5.3');
		expect(p.config_detail).toEqual({ multimodal: true, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 });
	});

	it('isRpcAddSuccess：message==="success" 才算成功；服务层吞错的异常串不算（曾因此误判 29 个全失败）', () => {
		expect(isRpcAddSuccess({ code: 0, message: 'success' })).toBe(true);
		expect(isRpcAddSuccess({ code: 0, message: '' })).toBe(true);
		expect(isRpcAddSuccess({ code: 0 })).toBe(true);
		/* 吞错形态：{code:0, message:<异常字符串>} */
		expect(isRpcAddSuccess({ code: 0, message: 'TypeError: network error' })).toBe(false);
		expect(isRpcAddSuccess({ code: 4028, message: 'failure' })).toBe(false);
		expect(isRpcAddSuccess({ err: '页面脚本异常' })).toBe(false);
		expect(isRpcAddSuccess(null)).toBe(false);
	});

	/** 脚手架：按表达式内容分流预设应答的假 CDP（只实现 RPC 路径用到的方法） */
	function rpcCdp(respond) {
		return {
			evaluate: async (expr) => respond(expr, 'short'),
			evaluateLong: async (expr) => respond(expr, 'long'),
		};
	}

	it('rpcWaitModelList：空列表（凭证未就绪被吞错）先重试，非空后放行', async () => {
		let n = 0;
		const cdp = rpcCdp((expr) => {
			if (expr.includes('getModelList')) {
				n++;
				return n < 3
					? JSON.stringify({ ok: true, total: 0, custom: [] })
					: JSON.stringify({ ok: true, total: 2, custom: ['custom_openai_compatible//glm-5.3|CCB glm-5.3'] });
			}
			/* reset 轮询 */
			return '';
		});
		const r = await rpcWaitModelList(cdp, () => {}, 10000);
		expect(r.total).toBe(2);
	}, 20000);

	it('rpcWaitModelList：一直空列表 → 超时抛可读错误（触发上层降级 UI 路径）', async () => {
		const cdp = rpcCdp(() => JSON.stringify({ ok: true, total: 0, custom: [] }));
		await expect(rpcWaitModelList(cdp, () => {}, 50)).rejects.toThrow(/超时未就绪/);
	});

	it('addModelsViaRpc：按 name 与展示名双重去重；吞错 message 判失败不误报成功', async () => {
		const added = [];
		const cdp = rpcCdp((expr) => {
			if (expr.includes('IICubeAiChatModuleManager')) return JSON.stringify({ ok: true, out: {} });
			if (expr.includes('getModelList')) {
				return JSON.stringify({
					ok: true, total: 2,
					custom: [
						'custom_openai_compatible//glm-5.3|CCB glm-5.3',
						'custom_openai_compatible//x|CCB kimi-k3',
					],
				});
			}
			/* addCustomModel：glm-5.2 正常 success；deepseek-v4-pro 模拟服务层吞错 */
			if (expr.includes('"model_name":"glm-5.2"')) {
				added.push('glm-5.2');
				return JSON.stringify({ code: 0, message: 'success', id: '123' });
			}
			if (expr.includes('"model_name":"deepseek-v4-pro"')) {
				added.push('deepseek-v4-pro');
				return JSON.stringify({ code: 0, message: 'TypeError: network error' });
			}
			throw new Error('unexpected expr: ' + expr.slice(0, 80));
		});
		const r = await addModelsViaRpc(cdp, {
			apiBase: 'https://x/v1', apiKey: 'sk-x',
			models: ['glm-5.3', 'kimi-k3', 'glm-5.2', 'deepseek-v4-pro'],
		}, () => {});
		/* glm-5.3（name 去重）与 kimi-k3（展示名去重）跳过；4-2=2 待添加 */
		expect(r.skipped).toBe(2);
		expect(r.added).toBe(1);
		expect(r.failed).toEqual([expect.stringContaining('deepseek-v4-pro')]);
		expect(added).toEqual(['glm-5.2', 'deepseek-v4-pro']);
	});

	it('addModelsViaRpc：找不到服务（新版本 DI 改名）→ 抛错给上层降级 UI', async () => {
		const cdp = rpcCdp(() => JSON.stringify({ ok: false, err: 'no-module-manager' }));
		await expect(addModelsViaRpc(cdp, { apiBase: 'https://x/v1', apiKey: 'k', models: ['m'] }, () => {}))
			.rejects.toThrow(/no-module-manager/);
	});
});

describe('Trae UI 自动化：CDP 客户端', () => {
	it('send 发出请求并把应答交给调用方', async () => {
		const ws = new FakeWs();
		const cdp = new Cdp(ws);
		const p = cdp.send('Runtime.evaluate', { expression: '1+1' });
		const req = ws.sent[0];
		expect(req.method).toBe('Runtime.evaluate');
		ws.emit({ id: req.id, result: { result: { value: 2 } } });
		expect(await p).toEqual({ id: req.id, result: { result: { value: 2 } } });
	});

	it('evaluate 返回值；页面异常时抛出可读错误', async () => {
		const ws = new FakeWs();
		const cdp = new Cdp(ws);
		const ok = cdp.evaluate('1+1');
		ws.emit({ id: ws.sent[0].id, result: { result: { value: 42 } } });
		expect(await ok).toBe(42);

		const bad = cdp.evaluate('boom');
		ws.emit({
			id: ws.sent[1].id,
			result: { exceptionDetails: { exception: { description: 'ReferenceError: boom is not defined' } } },
		});
		await expect(bad).rejects.toThrow(/ReferenceError/);
	});

	it('超时后 reject，不会永久挂住', async () => {
		const ws = new FakeWs();
		const cdp = new Cdp(ws);
		await expect(cdp.send('Page.enable', {}, 50)).rejects.toThrow(/超时/);
	});
});
