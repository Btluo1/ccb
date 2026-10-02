import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import qb from '../electron/lib/qoderbridge';

/* 合成最小 runtime 片段：还原 openCall 锚点段、JA（get_model_policy 回调）段、
 * reconcile 默认模型段、传输工厂段与目录同步回写段（真实文件为单行混淆 ESM，
 * 前后缀字节与 qoder-worker-runtime.obf.mjs 1.0.45 一致） */
const SAMPLE = [
	'export async function openCall(A){',
	'try{let i=ZPI(A);gLi()&&m4i({sessionId:A.sessionId,requestId:A.requestId,bodyKind:"req",body:i});let I=e.ChatCompletionStream(i,t,{deadline:1});return{call:I,client:e,requestId:A.requestId,serverRequestId:null};}catch(B){throw B;}}',
	'var hA=1e3,MA=!1,JA=u&&iA?async(i,I,B,e,Q,E)=>{if(!MA)return;let{requestId:t,promise:g}=iA.createRequest(Q),o=PF(A).map(Qte);q(hO(t,{subtype:"get_model_policy",purpose:i,sessionId:I,turnIndex:B,agentId:e,models:o}));try{let G=Mhg(await Promise.race([g]));if(null!==G)return G;throw new Error("policy failed")}catch(B){throw B}}:void 0;',
	'class C{reconcileModelWithCatalog(A){let i=dt(),I=Qi(),B=i.getAvailableModels().length>0,e=A?.catalogWasAwaited??!0;if(this.model){}else try{let A=i.getDefaultModel().key;this.model=A,this.RN=A}catch{let A=opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene});A&&(D.debug(`[config] Using cached default model: "${A}"`),this.model=A,this.RN=A)}}}',
	'function OTe(){let{protocol:A,rewriteProtocol:i}=ZJI(),I=KJI(A);if(XmA&&AVn===I&&eVn===A&&iVn===i)return XmA;switch(AVn=I,eVn=A,iVn=i,I){case"http":XmA=new bTe(i);break;case"grpc":XmA=new RTe(i);break;default:XmA=new GTe}return XmA}',
	'class X{async syncCatalog(){this.getDefaultModel=()=>({key:"auto"});Xme({key:this.getDefaultModel().key,uid:t,scene:i}).catch(()=>{})}}',
	'',
].join('\n');

/* 测试用 QoderWork CN 客户端定义（与 clients.js 的字段保持一致） */
const CLIENT = { id: 'qoderwork-cn', appDirs: ['QoderWork CN'], exeNames: ['QoderWork CN.exe'] };

let tmpRoot;
beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-qwbridge-'));
});
afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('qoderbridge 锚点提取（extractAnchor）', () => {
	it('从真实锚点段提取变量名与注入位置', () => {
		const a = qb.extractAnchor(SAMPLE);
		expect(a.ok).toBe(true);
		expect(a.varName).toBe('A');
		expect(a.insertPos).toBe(SAMPLE.indexOf('try{') + 4);
	});

	it('支持其它混淆变量名', () => {
		const src = 'async function f(Zz){try{let i=ZPI(Zz);gLi()&&m4i({sessionId:Zz.sessionId,requestId:Zz.requestId,bodyKind:"req",body:i});}catch(e){}}';
		const a = qb.extractAnchor(src);
		expect(a.ok).toBe(true);
		expect(a.varName).toBe('Zz');
	});

	it('缺锚点时失败且不写盘（fail-fast）', () => {
		expect(qb.extractAnchor('const x=1;').ok).toBe(false);
	});

	it('锚点不唯一时失败', () => {
		expect(qb.extractAnchor(SAMPLE + SAMPLE).ok).toBe(false);
	});

	it('锚点距 try{ 过远时失败', () => {
		const pad = 'y'.repeat(500);
		const src = 'try{' + pad + 'm4i({sessionId:A.sessionId,requestId:A.requestId,bodyKind:"req"});';
		expect(qb.extractAnchor(src).ok).toBe(false);
	});
});

describe('qoderbridge 策略门禁锚点提取（extractPolicyGuard）', () => {
	it('从 JA 段提取变量名与 guard 位置', () => {
		const a = qb.extractPolicyGuard(SAMPLE);
		expect(a.ok).toBe(true);
		expect(a.varName).toBe('MA');
		expect(SAMPLE.slice(a.start, a.start + a.len)).toBe('if(!MA)return;');
	});

	it('无 get_model_policy 字面量时标记 absent（无门禁=正常跳过）', () => {
		const a = qb.extractPolicyGuard('export const x=1;\n');
		expect(a.ok).toBe(false);
		expect(a.absent).toBe(true);
	});

	it('字面量不唯一时失败（版本不兼容）', () => {
		expect(qb.extractPolicyGuard(SAMPLE + SAMPLE).ok).toBe(false);
	});

	it('有字面量但缺 guard 形状时失败（版本不兼容）', () => {
		const a = qb.extractPolicyGuard('async f()=>{q(hO(t,{subtype:"get_model_policy"}));}');
		expect(a.ok).toBe(false);
		expect(a.absent).toBeUndefined();
		expect(a.reason).toContain('guard');
	});

	it('guard 距字面量过远时失败', () => {
		const src = 'async x=>{if(!Foo)return;' + 'a'.repeat(600) + 'q(hO(t,{subtype:"get_model_policy"}));}';
		expect(qb.extractPolicyGuard(src).ok).toBe(false);
	});
});

describe('qoderbridge reconcile 锚点提取（extractReconcilePatch）', () => {
	it('从 reconcile 段提取全部混淆变量名', () => {
		const p = qb.extractReconcilePatch(SAMPLE);
		expect(p.ok).toBe(true);
		expect(p.modelVar).toBe('A');
		expect(p.catalogVar).toBe('i');
		expect(p.cacheFn).toBe('opA');
		expect(p.uidExpr).toBe('I.getUserInfo()?.uid??""');
		expect(p.sceneExpr).toBe('tC().scene');
		expect(SAMPLE.slice(p.start, p.start + p.len))
			.toBe('try{let A=i.getDefaultModel().key;this.model=A,this.RN=A}catch{let A=opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene})');
	});

	it('支持其它混淆变量名', () => {
		const src = 'try{let Q=cat.getDefaultModel().key;this.model=Q,this.zz=Q}catch{let Q=rd({uid:au.getUserInfo()?.uid??"",scene:sc().scene});Q&&(this.model=Q)}';
		const p = qb.extractReconcilePatch(src);
		expect(p.ok).toBe(true);
		expect(p.modelVar).toBe('Q');
		expect(p.catalogVar).toBe('cat');
		expect(p.cacheFn).toBe('rd');
		expect(p.uidExpr).toBe('au.getUserInfo()?.uid??""');
		expect(p.sceneExpr).toBe('sc().scene');
	});

	it('缺锚点 / 锚点不唯一时失败', () => {
		expect(qb.extractReconcilePatch('const x=1;').ok).toBe(false);
		expect(qb.extractReconcilePatch(SAMPLE + SAMPLE).ok).toBe(false);
	});

	it('applyReconcilePatch：try 体改为「缓存默认 || 目录默认」，标记还原字节级', () => {
		const p = qb.extractReconcilePatch(SAMPLE);
		const out = qb.applyReconcilePatch(SAMPLE, p);
		expect(out).toContain(
			'let A=/*__CCB_QW_RGUARD_B:[i]__*/opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene})||i.getDefaultModel().key/*__CCB_QW_RGUARD_E__*/;'
		);
		/* catch 体原样保留（表达式提取复用、不破坏原逻辑） */
		expect(out).toContain('catch{let A=opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene});');
		/* 剥离后字节级还原 */
		expect(qb.stripReconcileGuard(out)).toBe(SAMPLE);
	});
});

describe('qoderbridge 传输工厂锚点提取（extractFactoryPatch）', () => {
	it('从工厂分派尾提取变量名', () => {
		const p = qb.extractFactoryPatch(SAMPLE);
		expect(p.ok).toBe(true);
		expect(p.cacheVar).toBe('XmA');
		expect(p.grpcCls).toBe('RTe');
		expect(p.rewriteVar).toBe('i');
		expect(SAMPLE.slice(p.start, p.start + p.len))
			.toBe('case"grpc":XmA=new RTe(i);break;default:XmA=new GTe}return XmA}');
	});

	it('缺锚点 / 锚点不唯一时失败', () => {
		expect(qb.extractFactoryPatch('const x=1;').ok).toBe(false);
		expect(qb.extractFactoryPatch(SAMPLE + SAMPLE).ok).toBe(false);
	});

	it('applyFactoryWrapper：包装插在 default 与 return 之间，标记剥离字节级还原', () => {
		const p = qb.extractFactoryPatch(SAMPLE);
		const out = qb.applyFactoryWrapper(SAMPLE, p);
		expect(out).toContain('default:XmA=new GTe}/*__CCB_QW_TGUARD_B__*/{let __ccbOT=XmA;');
		expect(out).toContain('return new RTe(i).open(q);');
		expect(out).toContain('return __ccbOT.open(q)}}}/*__CCB_QW_TGUARD_E__*/return XmA}');
		expect(qb.stripFactoryWrapper(out)).toBe(SAMPLE);
	});
});

describe('qoderbridge 目录回写保护（extractXlPatch）', () => {
	it('从 Xl 回写段提取 uid/scene 变量名', () => {
		const p = qb.extractXlPatch(SAMPLE);
		expect(p.ok).toBe(true);
		expect(p.uidVar).toBe('t');
		expect(p.sceneVar).toBe('i');
		expect(SAMPLE.slice(p.start, p.start + p.len))
			.toBe('Xme({key:this.getDefaultModel().key,uid:t,scene:i}).catch(()=>{})');
	});

	it('支持其它混淆变量名', () => {
		const src = 'Xme({key:this.getDefaultModel().key,uid:Ux,scene:Sc}).catch(()=>{})';
		const p = qb.extractXlPatch(src);
		expect(p.ok).toBe(true);
		expect(p.uidVar).toBe('Ux');
		expect(p.sceneVar).toBe('Sc');
	});

	it('缺锚点 / 锚点不唯一时失败', () => {
		expect(qb.extractXlPatch('const x=1;').ok).toBe(false);
		expect(qb.extractXlPatch(SAMPLE + SAMPLE).ok).toBe(false);
	});

	it('applyXlPatch：缓存读取函数名动态传入（不写死 opA），标记剥离字节级还原', () => {
		const p = qb.extractXlPatch(SAMPLE);
		p.cacheFn = 'opA'; /* patchQoderWorkRuntime 从 reconcile 段提取后传入 */
		const out = qb.applyXlPatch(SAMPLE, p);
		expect(out).toContain(
			'/*__CCB_QW_XGUARD_B:[t,i]__*/'
			+ 'Xme({key:(function(c){return typeof c==="string"&&c.indexOf("ccb/")===0?c:this.getDefaultModel().key})'
			+ '.call(this,opA({uid:t,scene:i})),uid:t,scene:i})'
			+ '/*__CCB_QW_XGUARD_E__*/'
		);
		/* 原始回写不再存在（整段被替换） */
		expect(out.indexOf('Xme({key:this.getDefaultModel().key,uid:t,scene:i})')).toBe(-1);
		/* 剥离后字节级还原 */
		expect(qb.stripXlGuard(out)).toBe(SAMPLE);
	});

	it('applyXlPatch：混淆名变化时缓存读取函数随 reconcile 提取值', () => {
		const src = 'try{let A=c.getDefaultModel().key;this.model=A,this.RN=A}catch{let A=rd({uid:U.getUserInfo()?.uid??"",scene:S().scene});A&&(this.model=A)}}Xme({key:this.getDefaultModel().key,uid:U2,scene:S2}).catch(()=>{})';
		const rp = qb.extractReconcilePatch(src);
		expect(rp.cacheFn).toBe('rd');
		const xp = qb.extractXlPatch(src);
		xp.cacheFn = rp.cacheFn;
		const out = qb.applyXlPatch(src, xp);
		expect(out).toContain('.call(this,rd({uid:U2,scene:S2}))');
		expect(out).not.toContain('.call(this,opA(');
		expect(qb.stripXlGuard(out)).toBe(src);
	});
});

describe('qoderbridge 补丁 / 回滚（合成 runtime 文件）', () => {
	const log = () => {};

	it('patch：注入 guard 与 bridge、生成原始备份、幂等重入', () => {
		const file = path.join(tmpRoot, 'runtime.obf.mjs');
		fs.writeFileSync(file, SAMPLE);
		expect(qb.patchQoderWorkRuntime(file, log)).toBe(true);

		const out = fs.readFileSync(file, 'utf8');
		/* guard 紧跟锚点 try{ 之后 */
		const bi = out.indexOf('bodyKind:"req"');
		const ti = out.lastIndexOf('try{', bi);
		expect(out.indexOf(qb.GUARD_BEGIN)).toBe(ti + 4);
		/* guard 内容：变量名动态 + sk-ccb- 前缀判定 + 短路调用 */
		const guard = out.slice(out.indexOf(qb.GUARD_BEGIN), out.indexOf(qb.GUARD_END));
		expect(guard).toContain('if(A&&A.customModel&&A.customModel.parameters');
		expect(guard).toContain('api_key.indexOf("sk-ccb-")===0');
		expect(guard).toContain('return await __ccbOpenAiBridge(A);');
		/* bridge 块追加在末尾，语法整体通过 node --check（patch 内部已校验） */
		expect(out.indexOf(qb.MARK_BEGIN)).toBeGreaterThan(0);
		expect(out.endsWith(qb.MARK_END)).toBe(true);
		/* policy 门禁跳过：JA 的 if(!MA)return; 被替换为恒真跳过，原始 guard 不再存在 */
		expect(out).toContain(qb.PGUARD_MARK + '[MA]__*/if(!0)return;' + qb.PGUARD_END);
		expect(out.indexOf('if(!MA)return;')).toBe(-1);
		/* reconcile：try 体改为 opA 缓存优先，catch 体原样保留 */
		expect(out).toContain(
			'let A=' + qb.RGUARD_MARK + '[i]__*/opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene})||i.getDefaultModel().key' + qb.RGUARD_END + ';'
		);
		expect(out).toContain('catch{let A=opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene});');
		/* 传输路由：工厂返回值包装，sk-ccb- 请求改走 gRPC 传输 */
		expect(out).toContain('default:XmA=new GTe}' + qb.TGUARD_MARK + '{let __ccbOT=XmA;');
		expect(out).toContain('api_key.indexOf("sk-ccb-")===0)return new RTe(i).open(q);');
		expect(out).toContain('return __ccbOT.open(q)}}}' + qb.TGUARD_END + 'return XmA}');
		/* 目录回写保护：缓存现值为 ccb/ 前缀时保留，目录默认不再无条件覆盖 */
		expect(out).toContain(qb.XGUARD_MARK + '[t,i]__*/');
		expect(out).toContain('c.indexOf("ccb/")===0?c:this.getDefaultModel().key');
		expect(out).toContain('.call(this,opA({uid:t,scene:i}))');
		expect(out.indexOf('Xme({key:this.getDefaultModel().key,uid:t,scene:i})')).toBe(-1);
		/* 备份恒为原始内容 */
		expect(fs.readFileSync(file + '.ccb.bak', 'utf8')).toBe(SAMPLE);

		/* 幂等：第二次 patch 内容不变 */
		expect(qb.patchQoderWorkRuntime(file, log)).toBe(true);
		expect(fs.readFileSync(file, 'utf8')).toBe(out);
	});

	it('patch：无 get_model_policy 门禁的版本照常打桥（policy 跳过）', () => {
		const noPolicy = [
			'export async function openCall(A){',
			'try{let i=ZPI(A);gLi()&&m4i({sessionId:A.sessionId,requestId:A.requestId,bodyKind:"req",body:i});let I=e.ChatCompletionStream(i,t,{deadline:1});return{call:I,client:e,requestId:A.requestId,serverRequestId:null};}catch(B){throw B;}}',
			SAMPLE.split('\n')[3],
			SAMPLE.split('\n')[4],
			SAMPLE.split('\n')[5],
			'',
		].join('\n');
		const file = path.join(tmpRoot, 'runtime.obf.mjs');
		fs.writeFileSync(file, noPolicy);
		expect(qb.patchQoderWorkRuntime(file, log)).toBe(true);
		const out = fs.readFileSync(file, 'utf8');
		expect(out.indexOf(qb.GUARD_BEGIN)).toBeGreaterThan(0);
		expect(out).not.toContain(qb.PGUARD_MARK);
		expect(out.indexOf('if(!MA)return;')).toBe(-1); /* 原本就没有 */
		expect(out).toContain(qb.RGUARD_MARK);
		expect(out).toContain(qb.TGUARD_MARK);
		expect(out).toContain(qb.XGUARD_MARK);
	});

	it('不兼容的 runtime：报错且文件不动、不留备份', () => {
		const file = path.join(tmpRoot, 'runtime.obf.mjs');
		fs.writeFileSync(file, 'export const x=1;\n');
		expect(() => qb.patchQoderWorkRuntime(file, log)).toThrow(/不兼容/);
		expect(fs.readFileSync(file, 'utf8')).toBe('export const x=1;\n');
		expect(fs.existsSync(file + '.ccb.bak')).toBe(false);
	});

	it('缺 reconcile / 缺传输工厂时 fail-fast 且文件不动；缺目录回写时记录提示并继续', () => {
		/* 缺 reconcile 段（有工厂与回写） */
		const noRecon = [SAMPLE.split('\n')[0], SAMPLE.split('\n')[1], SAMPLE.split('\n')[2], SAMPLE.split('\n')[4], SAMPLE.split('\n')[5], ''].join('\n');
		let file = path.join(tmpRoot, 'a.obf.mjs');
		fs.writeFileSync(file, noRecon);
		expect(() => qb.patchQoderWorkRuntime(file, log)).toThrow(/reconcile/);
		expect(fs.readFileSync(file, 'utf8')).toBe(noRecon);
		expect(fs.existsSync(file + '.ccb.bak')).toBe(false);
		/* 缺工厂段（有 reconcile 与回写） */
		const noFactory = [SAMPLE.split('\n')[0], SAMPLE.split('\n')[1], SAMPLE.split('\n')[2], SAMPLE.split('\n')[3], SAMPLE.split('\n')[5], ''].join('\n');
		file = path.join(tmpRoot, 'b.obf.mjs');
		fs.writeFileSync(file, noFactory);
		expect(() => qb.patchQoderWorkRuntime(file, log)).toThrow(/传输工厂/);
		expect(fs.readFileSync(file, 'utf8')).toBe(noFactory);
		expect(fs.existsSync(file + '.ccb.bak')).toBe(false);
		/* 缺目录回写段（有 reconcile 与工厂）：Xl 回写保护为可选（部分 SDK 无此段），
		 * 缺失时记录提示并继续打其余补丁，文件仍被修改 */
		const noXl = [SAMPLE.split('\n')[0], SAMPLE.split('\n')[1], SAMPLE.split('\n')[2], SAMPLE.split('\n')[3], SAMPLE.split('\n')[4], ''].join('\n');
		file = path.join(tmpRoot, 'c.obf.mjs');
		fs.writeFileSync(file, noXl);
		const xlLog = [];
		expect(qb.patchQoderWorkRuntime(file, (m) => xlLog.push(m))).toBe(true);
		expect(fs.readFileSync(file, 'utf8')).not.toBe(noXl);
		expect(fs.existsSync(file + '.ccb.bak')).toBe(true);
		expect(xlLog.some((m) => /回写/.test(m))).toBe(true);
	});

	it('rollback：优先还原备份；无备份时按标记精确剥离到字节级原样', () => {
		const file = path.join(tmpRoot, 'runtime.obf.mjs');
		fs.writeFileSync(file, SAMPLE);
		qb.patchQoderWorkRuntime(file, log);

		/* 有备份：还原原始内容，备份保留 */
		expect(qb.rollbackQoderWorkRuntime(file, log)).toBe(true);
		expect(fs.readFileSync(file, 'utf8')).toBe(SAMPLE);
		expect(fs.existsSync(file + '.ccb.bak')).toBe(true);

		/* 无备份：剥离路径也能字节级还原 */
		fs.rmSync(file + '.ccb.bak');
		qb.patchQoderWorkRuntime(file, log);
		expect(qb.rollbackQoderWorkRuntime(file, log)).toBe(true);
		expect(fs.readFileSync(file, 'utf8')).toBe(SAMPLE);
	});
});

describe('qoderbridge 真实 runtime 副本冒烟（未安装则跳过）', () => {
	it('真实文件：锚点提取 → patch → 幂等 → rollback 字节级往返', () => {
		const file = qb.findQoderWorkRuntime(CLIENT, () => {});
		if (!file) return; /* 本机未装 QoderWork 时跳过 */

		/* 实机 runtime 可能已打过补丁（含 CCB 标记）：优先取原始备份，
		 * 保证冒烟从干净态出发、rollback 期望为真正的原始字节 */
		const srcFile = fs.existsSync(file + '.ccb.bak') ? file + '.ccb.bak' : file;
		const src = fs.readFileSync(srcFile, 'utf8');
		const a = qb.extractAnchor(src);
		expect(a.ok).toBe(true);
		expect(a.varName).toBe('A');
		const pa = qb.extractPolicyGuard(src);
		expect(pa.ok).toBe(true);
		expect(pa.varName).toBe('MA');
		const rp = qb.extractReconcilePatch(src);
		expect(rp.ok).toBe(true);
		expect(rp.modelVar).toBe('A');
		expect(rp.catalogVar).toBe('i');
		expect(rp.cacheFn).toBe('opA');
		expect(rp.uidExpr).toBe('I.getUserInfo()?.uid??""');
		expect(rp.sceneExpr).toBe('tC().scene');
		const tp = qb.extractFactoryPatch(src);
		expect(tp.ok).toBe(true);
		expect(tp.cacheVar).toBe('XmA');
		expect(tp.grpcCls).toBe('RTe');
		expect(tp.rewriteVar).toBe('i');
		const xp = qb.extractXlPatch(src);
		expect(xp.ok).toBe(true);
		expect(typeof xp.uidVar).toBe('string');
		expect(typeof xp.sceneVar).toBe('string');

		const tmp = path.join(tmpRoot, 'runtime.obf.mjs');
		fs.writeFileSync(tmp, src);
		expect(qb.patchQoderWorkRuntime(tmp, () => {})).toBe(true);
		const patched = fs.readFileSync(tmp, 'utf8');

		/* guard 位置正确且紧跟锚点 try{ */
		const bi = patched.indexOf('bodyKind:"req"');
		const ti = patched.lastIndexOf('try{', bi);
		expect(patched.indexOf(qb.GUARD_BEGIN)).toBe(ti + 4);
		/* policy 门禁跳过已注入 */
		expect(patched).toContain(qb.PGUARD_MARK + '[MA]__*/if(!0)return;' + qb.PGUARD_END);
		expect(patched.indexOf('if(!MA)return;')).toBe(-1);
		/* reconcile 缓存优先已注入 */
		expect(patched).toContain(
			'let A=' + qb.RGUARD_MARK + '[i]__*/opA({uid:I.getUserInfo()?.uid??"",scene:tC().scene})||i.getDefaultModel().key' + qb.RGUARD_END + ';'
		);
		/* 传输路由包装已注入 */
		expect(patched).toContain('default:XmA=new GTe}' + qb.TGUARD_MARK + '{let __ccbOT=XmA;');
		expect(patched).toContain('api_key.indexOf("sk-ccb-")===0)return new RTe(i).open(q);');
		expect(patched).toContain('return __ccbOT.open(q)}}}' + qb.TGUARD_END + 'return XmA}');
		/* 目录回写保护已注入（变量名动态提取，只断言标记与判定逻辑） */
		expect(patched).toContain(qb.XGUARD_MARK + '[' + xp.uidVar + ',' + xp.sceneVar + ']__*/');
		expect(patched).toContain('c.indexOf("ccb/")===0?c:this.getDefaultModel().key');
		expect(patched).toContain('.call(this,opA({uid:' + xp.uidVar + ',scene:' + xp.sceneVar + '}))');

		/* 幂等 + 回滚字节级还原 */
		expect(qb.patchQoderWorkRuntime(tmp, () => {})).toBe(true);
		expect(fs.readFileSync(tmp, 'utf8')).toBe(patched);
		expect(qb.rollbackQoderWorkRuntime(tmp, () => {})).toBe(true);
		expect(fs.readFileSync(tmp, 'utf8')).toBe(src);
	}, 120000);
});

/* ---------- 桥函数（vm 隔离，mock fetch/SSE） ---------- */

function sseResponse(chunks) {
	const text = chunks.map((o) => 'data: ' + JSON.stringify(o) + '\n\n').join('') + 'data: [DONE]\n\n';
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'text/event-stream' },
		body: new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(text));
				c.close();
			},
		}),
	};
}

function makeCtx(fetchImpl) {
	const ctx = { fetch: fetchImpl, AbortController, TextDecoder, console };
	vm.createContext(ctx);
	vm.runInContext(qb.bridgeSource(), ctx);
	return ctx;
}

function baseReq(over) {
	return Object.assign({
		requestId: 'req-1',
		customModel: {
			model: 'glm-5.3',
			url: 'https://code.btluo.com/v1/chat/completions',
			parameters: { api_key: 'sk-ccb-abc123' },
		},
		messages: [{ role: 'user', content: '你好' }],
	}, over);
}

/* 按 worker 消费方（rJI/oJI）的事件注册顺序消费 fake call */
async function consume(call) {
	const meta = await new Promise((res, rej) => {
		call.once('metadata', res);
		call.once('error', rej);
	});
	const chunks = [];
	await new Promise((res, rej) => {
		call.on('data', (c) => chunks.push(c));
		call.on('end', res);
		call.on('error', rej);
	});
	return { meta, chunks };
}

describe('qoderbridge 桥函数（vm 隔离）', () => {
	it('OpenAI body 映射 + SSE 透传 + rJI/oJI 事件语义', async () => {
		const seen = [];
		const ctx = makeCtx(async (url, opts) => {
			seen.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) });
			return sseResponse([
				{ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '回复' } }] },
				{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
			]);
		});
		const req = baseReq({
			messages: [
				{ role: 'user', content: '你好' },
				{ role: 'assistant', contents: '前回复', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
				{ role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: '结果' }, { type: 'other' }] },
				{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'http://x/y.png' } }] },
			],
			tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
			parameters: { max_tokens: 1024, temperature: 0.5, tool_choice: null },
			reasoningEffort: 'none',
		});
		const r = await ctx.__ccbOpenAiBridge(req);
		expect(r.requestId).toBe('req-1');
		expect(r.serverRequestId).toBe(null);

		/* fetch 请求映射 */
		expect(seen.length).toBe(1);
		expect(seen[0].url).toBe('https://code.btluo.com/v1/chat/completions');
		expect(seen[0].auth).toBe('Bearer sk-ccb-abc123');
		const b = seen[0].body;
		expect(b.model).toBe('glm-5.3');
		expect(b.stream).toBe(true);
		expect(b.stream_options).toEqual({ include_usage: true });
		expect(b.max_tokens).toBe(1024);
		expect(b.temperature).toBe(0.5);
		expect(b.tool_choice).toBeUndefined(); /* null 不传，防 +null=0 */
		expect(b.thinking).toEqual({ type: 'disabled' }); /* reasoningEffort=none */
		expect(b.tools).toEqual([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]);
		expect(b.messages).toEqual([
			{ role: 'user', content: '你好' },
			{ role: 'assistant', content: '前回复', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
			{ role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: '结果' }] },
			{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'http://x/y.png' } }] },
		]);

		/* 事件流：metadata 立即可得（sJI 兼容），SSE chunk 原样入 data 队列 */
		const { meta, chunks } = await consume(r.call);
		expect(meta.get('x-request-id')).toEqual([]);
		expect(chunks).toEqual([
			{ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '回复' } }] },
			{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
		]);
	});

	it('reasoningEffort 非 none 时不传 thinking；采样参数缺省不落键', async () => {
		const seen = [];
		const ctx = makeCtx(async (u, o) => { seen.push(JSON.parse(o.body)); return sseResponse([]); });
		await ctx.__ccbOpenAiBridge(baseReq({ reasoningEffort: 'high' }));
		const b = seen[0];
		expect(b.thinking).toBeUndefined();
		expect('max_tokens' in b).toBe(false);
		expect('temperature' in b).toBe(false);
	});

	it('非流式 JSON 响应兜底：转 delta+finish 两块再 end', async () => {
		const ctx = makeCtx(async () => ({
			ok: true, status: 200,
			headers: { get: () => 'application/json' },
			text: async () => JSON.stringify({
				id: 'j1', model: 'glm-5.3',
				choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			}),
		}));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		const { chunks } = await consume(r.call);
		expect(chunks.length).toBe(2);
		expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '答案' });
		expect(chunks[0].choices[0].finish_reason).toBe(null);
		expect(chunks[1].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
		expect(chunks[1].usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
	});

	it('HTTP 错误：status 与响应体进入 error 事件', async () => {
		const ctx = makeCtx(async () => ({
			ok: false, status: 401,
			headers: { get: () => 'application/json' },
			text: async () => '{"error":"Invalid key"}',
		}));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		const err = await new Promise((res, rej) => {
			r.call.on('end', () => rej(new Error('should not end')));
			r.call.on('error', res);
		});
		expect(err.message).toContain('CCB HTTP 401');
		expect(err.message).toContain('Invalid key');
	});

	it('abort：call.cancel() 转发到 fetch signal（AbortError 传播）', async () => {
		let fetchSignal;
		const ctx = makeCtx((u, o) => new Promise((res, rej) => {
			fetchSignal = o.signal;
			fetchSignal.addEventListener('abort', () => {
				const e = new Error('aborted');
				e.name = 'AbortError';
				rej(e);
			});
		}));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		expect(fetchSignal.aborted).toBe(false);
		r.call.cancel();
		expect(fetchSignal.aborted).toBe(true);
		const err = await new Promise((res) => r.call.on('error', res));
		expect(err.name).toBe('AbortError');
	});

	it('外部 signal 已 abort 时立即传播', async () => {
		let fetchSignal;
		const ctx = makeCtx((u, o) => new Promise((res, rej) => {
			fetchSignal = o.signal;
			fetchSignal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		}));
		const ac = new AbortController();
		ac.abort();
		const r = await ctx.__ccbOpenAiBridge(baseReq({ signal: ac.signal }));
		expect(fetchSignal.aborted).toBe(true);
	});

	it('url 缺失：error 事件而非崩溃；url 为 base 时补全 /chat/completions', async () => {
		const seen = [];
		const ctx = makeCtx(async (u) => { seen.push(u); return sseResponse([]); });
		/* 缺 url */
		const r1 = await ctx.__ccbOpenAiBridge(baseReq({ customModel: { model: 'glm-5.3', url: '', parameters: { api_key: 'sk-ccb-x' } } }));
		const err = await new Promise((res) => r1.call.on('error', res));
		expect(err.message).toContain('missing custom model url');
		/* base url 补全 */
		const r2 = await ctx.__ccbOpenAiBridge(baseReq({ customModel: { model: 'glm-5.3', url: 'https://code.btluo.com/v1', parameters: { api_key: 'sk-ccb-x' } } }));
		await consume(r2.call);
		expect(seen[0]).toBe('https://code.btluo.com/v1/chat/completions');
	});
});

/* ---------- 桥函数双契约（Qoder CN qoder-cn-agent-sdk：chunks 异步迭代） ---------- */

async function collectChunks(iterable) {
	const out = [];
	for await (const c of iterable) out.push(c);
	return out;
}

describe('qoderbridge 桥函数 chunks 契约（Qoder CN SDK）', () => {
	it('chunks 异步迭代透传 OpenAI chunk，[DONE] 正常收束；辅助字段齐备', async () => {
		const ctx = makeCtx(async () => sseResponse([
			{ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '回复' } }] },
			{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
		]));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		/* payloadsFromCall 解构 {chunks, requestId}，BOc/XF 在 SDK 侧归一化 */
		expect(typeof r.chunks[Symbol.asyncIterator]).toBe('function');
		expect(r.requestId).toBe('req-1');
		expect(r.serverRequestId).toBe(null);
		expect(typeof r.execution.reportStreamHealth).toBe('function');
		expect(typeof r.finishRouteLifecycle).toBe('function');
		expect(() => r.execution.reportStreamHealth({ phase: 'stream_end', elapsedMs: 1 })).not.toThrow();
		expect(() => r.finishRouteLifecycle()).not.toThrow();
		const chunks = await collectChunks(r.chunks);
		expect(chunks).toEqual([
			{ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '回复' } }] },
			{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
		]);
	});

	it('HTTP 错误：chunks 迭代器 reject（CCB HTTP 状态码+响应体）', async () => {
		const ctx = makeCtx(async () => ({
			ok: false, status: 401,
			headers: { get: () => 'application/json' },
			text: async () => '{"error":"Invalid key"}',
		}));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		await expect(collectChunks(r.chunks)).rejects.toThrow(/CCB HTTP 401.*Invalid key/);
	});

	it('url 缺失：chunks 迭代器 reject 而非 TypeError', async () => {
		const ctx = makeCtx(async () => sseResponse([]));
		const r = await ctx.__ccbOpenAiBridge(baseReq({ customModel: { model: 'glm-5.3', url: '', parameters: { api_key: 'sk-ccb-x' } } }));
		await expect(collectChunks(r.chunks)).rejects.toThrow(/missing custom model url/);
	});

	it('非流式 JSON 兜底：chunks 产出合成 delta+finish 两块', async () => {
		const ctx = makeCtx(async () => ({
			ok: true, status: 200,
			headers: { get: () => 'application/json' },
			text: async () => JSON.stringify({
				id: 'j1', model: 'glm-5.3',
				choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			}),
		}));
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		const chunks = await collectChunks(r.chunks);
		expect(chunks.length).toBe(2);
		expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '答案' });
		expect(chunks[1].choices[0].finish_reason).toBe('stop');
	});

	it('取消前置路径：chunks.return() 后迭代立即 done（onCancelBeforeIteration 语义）', async () => {
		const ctx = makeCtx(() => new Promise(() => {})); /* 挂起的 fetch */
		const r = await ctx.__ccbOpenAiBridge(baseReq({}));
		const it = r.chunks[Symbol.asyncIterator]();
		const ret = await it.return(void 0); /* onCancelBeforeIteration: await A.chunks.return(void 0) */
		expect(ret.done).toBe(true);
		/* finishRouteLifecycle 可随后调用（abort fetch 清理） */
		expect(() => r.finishRouteLifecycle()).not.toThrow();
	});

	it('双通道并存：EventEmitter 消费与 chunks 消费互不影响（QoderWork 回归护栏）', async () => {
		const ctx = makeCtx(async () => sseResponse([
			{ id: 'c1', choices: [{ index: 0, delta: { content: 'A' } }] },
			{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
		]));
		/* 仅走 EventEmitter（QoderWork 路径）：chunks 无人迭代不报错 */
		const r1 = await ctx.__ccbOpenAiBridge(baseReq({}));
		const { chunks: viaEvents } = await consume(r1.call);
		expect(viaEvents.length).toBe(2);
		/* 仅走 chunks（Qoder CN 路径）：事件队列无人订阅不影响迭代 */
		const r2 = await ctx.__ccbOpenAiBridge(baseReq({}));
		const viaIter = await collectChunks(r2.chunks);
		expect(viaIter.length).toBe(2);
		expect(viaIter[0].choices[0].delta.content).toBe('A');
	});
});
