import net from 'node:net';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/* 与 writers.js 用同一份模块实例，避免出现两份 SEL / 两份逻辑 */
const require = createRequire(import.meta.url);
const { displayNameOf, findFreePort, buildFillScript, Cdp, SEL, waitFor, waitForWorkbench, waitForRect, LOGIN_VISIBLE, ENSURE_APPEND_MODE } = require('../electron/lib/traeui');

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
		expect(SEL.modelTrigger).toBe('.core-model-select-trigger, .icd-model-select-trigger');
		expect(SEL.modelMenu).toBe('.core-model-select-portal, .icube-model-select-portal');
		expect(SEL.menuFooterAdd).toBe('.core-model-select-footer-action, .icube-model-select-portal-footer');
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
	it('四个 Trae 客户端都指向 traeui 写入器', () => {
		const { CLIENTS } = require('../electron/lib/clients');
		const traes = CLIENTS.filter((c) => /^trae/.test(c.id));
		expect(traes).toHaveLength(4);
		for (const c of traes) {
			expect(c.writer).toBe('traeui');
		}
	});

	it('拿不到程序路径时给出明确提示，而不是抛异常（曾经漏导出 findLaunchExe）', async () => {
		const { applyConfig } = require('../electron/lib/writers');
		const r = await applyConfig('traework-cn', { apiKey: 'sk-ccb-x', apiBase: 'https://x/v1', models: ['m'] }, {});
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
		const res = await waitForWorkbench(cdp, 0, 'TraeCode', () => {}, { pollMs: 1, loginGraceMs: 400, deadlineMs: 5000 });
		expect(res.error).toBeUndefined();
		expect(res.cdp).toBe(cdp);
	});

	it('waitForWorkbench：登录按钮持续存在超过宽限期 → 判未登录并给出可读错误', async () => {
		const { cdp } = scriptedCdp((expr) => (expr.includes('登录') ? '1' : null));
		const res = await waitForWorkbench(cdp, 0, 'TraeCode', () => {}, { pollMs: 2, loginGraceMs: 60, deadlineMs: 5000 });
		expect(res.error).toMatch(/TraeCode 未登录/);
	});

	it('waitForWorkbench：选择器与登录按钮都不出现 → 超时错误（不是未登录）', async () => {
		const { cdp } = scriptedCdp(() => null);
		const res = await waitForWorkbench(cdp, 0, 'TraeCode', () => {}, { pollMs: 2, deadlineMs: 80 });
		expect(res.error).toMatch(/主界面/);
		expect(res.error).not.toMatch(/未登录/);
	});

	it('waitForWorkbench：调试 socket 已断开时不做求值（避免每次空烧 20 秒超时），无新目标则等到截止', async () => {
		const { cdp, calls } = scriptedCdp(() => '1', { url: 'ws://test/splash', readyState: 3 });
		/* 端口 1 上没有调试端点：listPages 立刻连接失败，不会挂住 */
		const res = await waitForWorkbench(cdp, 1, 'TraeCode', () => {}, { pollMs: 2, deadlineMs: 80 });
		expect(res.error).toMatch(/主界面/);
		expect(calls.length).toBe(0);
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
