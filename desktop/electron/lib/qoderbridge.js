'use strict';

/**
 * QoderWork worker 运行时桥接补丁（CCB BYOK 直连桥）
 * =====================================================
 *
 * 背景（2026-10-01 逆向 qoder-worker-runtime.obf.mjs 1.0.45）：
 *   QoderWork 的聊天不走 IDE 的 Go cosy 网关，而是由内置 @qoder-ai/qoder-agent-sdk
 *   通过 worker_threads 拉起 Node worker，用原生 gRPC（grpc-js，HTTP/2）调
 *   gateway.qoder.com.cn 的 model.chat.ChatService/ChatCompletionStream。
 *   ChatCompletionRequest 自带 custom_model 字段（url + parameters.api_key 都在），
 *   但自定义模型被两道门禁拦住（gRPC 请求本身已被理解，能被合法短路）：
 *   ① worker 每轮聊天前经 control_request（worker→主进程本地通道）调 get_model_policy：
 *      主进程侧 SDK（dist/index.js case"get_model_policy"）把请求交给 app 的
 *      resolveModel 回调，后者按账号权益对自定义模型抛 FORBIDDEN
 *      （100406 "Custom model disabled"），worker 会话引擎把错误包成 assistant
 *      消息（"Qoder API error: FORBIDDEN - {...}"）→ error_during_execution，
 *      gRPC 根本没发出（日志零 GrpcTransport call.start 即此特征）；
 *   ② 若过了策略关，gRPC 到网关仍按权益拒绝。
 *
 * 方案（就地补丁 worker runtime，.ccb.bak 备份 + 可回滚）：
 *   1. 在 GrpcTransport.openCall 的 try{ 之后注入 guard：请求的
 *      customModel.parameters.api_key 以 sk-ccb- 开头时，短路返回 __ccbOpenAiBridge(A)，
 *      破掉门禁②；
 *   2. 把 JA（worker 的 get_model_policy 回调）开头的 if(!MA)return; 替换为恒真跳过：
 *      worker 从不向主进程询问模型策略，破掉门禁①。主进程侧纯被动（只在被问时响应），
 *      不问即不拦；且主进程「无 provider」时返回空响应、worker 的 Mhg 解析得
 *      undefined → 直接放行——本补丁正是把 worker 拉回这一原生等价态（MA=false 语义，
 *      SDK 本就支持）。副作用：平台模型同样跳过策略咨询——无害，平台模型凭据在网关侧，
 *      策略只做权益拒绝与模型覆盖；
 *   3. 默认模型 reconcile（2026-10-01 实测发现）：app 对 BYOK 自定义模型故意不传
 *      --model（buildMainSessionRuntimeExtraArgs 的 hasByokCustomModel 分支），worker 的
 *      reconcileModelWithCatalog 在 config.model 为空时「目录默认（平台 auto）优先、
 *      .models/default（opA 读取，带 uid/scene/24h 新鲜度校验）仅 catch 兜底」→ BYOK
 *      默认模型永远解析不生效、请求按平台 auto 发网关。补丁把 try 体改为
 *      「opA 缓存值 || 目录默认」，catch 体里的 opA 调用表达式原样提取复用（混淆名
 *      随版本变化，不写死）。解析成功后 worker 会把结果经 Xme 回写 .models/default
 *      （uid/scene/updatedAt 同步刷新）→ 配置自我维持；
 *   4. 传输路由（2026-10-01 实测发现）：模型传输由 OTe 工厂按远端配置分派
 *      （http→bTe / grpc→RTe / 默认 GTe legacy），本机账号 protocol=legacy——BYOK
 *      请求与平台模型走同一传输（HTTP agent_chat_generation 直发网关被权益拒绝），
 *      openCall 里的 CCB guard 永远不触发。补丁把工厂返回值包一层 open()：请求的
 *      customModel.parameters.api_key 以 sk-ccb- 开头时改走 gRPC 传输（其 openCall
 *      有 guard① → 短路直连中转，全程不发 gRPC 网络请求），其余请求原样走原传输；
 *   5. 目录同步回写保护（2026-10-01 实测发现）：模型目录同步（Xl）后会无条件把
 *      .models/default 回写为目录默认（Xme({key:getDefaultModel().key})）——应用启动
 *      加载目录缓存的同一毫秒即把 ccb/codeb-auto 踆回 "auto"，补丁③读到的永远是
 *      平台默认（stock 行为：BYOK 模型根本无法成为默认）。补丁改为：缓存现值为
 *      ccb/ 前缀（CCB 模型 key）时保留，其余场景维持原回写；
 *   6. 在文件末尾（ESM 顶层作用域，函数声明提升）追加桥函数：把内部请求映射成
 *      OpenAI 兼容 body，直接 fetch customModel.url（CCB 中转，OpenAI 协议），
 *      把中转 SSE chunk 伪装成 gRPC 流事件（openCall 的消费方 oJI 只依赖
 *      on('data'/'end'/'error') + cancel()，rJI 只依赖 once('metadata'/'error')
 *      + removeListener + cancel()，手写缓冲事件 emitter 完全兼容）；
 *   6. 官方模型/登录/标题生成零影响：guard 只命中 sk-ccb- 密钥的 BYOK 请求，
 *      传输包装对无 customModel 的请求（平台模型/工具请求）完全透传。
 *
 * 兼容性安全网：
 *   - 锚点（bodyKind:"req" 全文件唯一）与请求变量名提取失败时 fail-fast，不写盘；
 *   - 写盘后 node --check 语法校验，失败立即用内存中的原内容还原；
 *   - worker 主进程启动即设 NODE_TLS_REJECT_UNAUTHORIZED="0"，无需处理证书问题
 *     （我们也不做 MITM，直连 https）。
 *
 * 回滚：优先还原 .ccb.bak（恒为首次写入前的原始状态）；无备份时按标记精确剥离
 * guard 与桥函数块。注意：若 QoderWork 升级后回滚，旧备份可能不再匹配新版本
 * runtime，此时应以「重新写入配置」代替回滚（日志有提示）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { findExeEverywhere, APPDATA } = require('./clients');

const BRIDGE_FN = '__ccbOpenAiBridge';
const MARK_BEGIN = '/*__CCB_QW_BRIDGE_BEGIN__*/';
const MARK_END = '/*__CCB_QW_BRIDGE_END__*/';
const GUARD_BEGIN = '/*__CCB_QW_GUARD_B__*/';
const GUARD_END = '/*__CCB_QW_GUARD_E__*/';
const CCB_KEY_PREFIX = 'sk-ccb-';
const BACKUP_SUFFIX = '.ccb.bak';
const ANCHOR = 'bodyKind:"req"';

/* 策略门禁（get_model_policy）补丁：
 * 锚点是 worker 里唯一的 get_model_policy 字面量（JA 回调体内 createRequest 处），
 * 目标是它所在箭头函数开头的 if(!VAR)return;。标记里带原始变量名，剥离时还原。 */
const POLICY_ANCHOR = 'subtype:"get_model_policy"';
const PGUARD_MARK = '/*__CCB_QW_PGUARD_B:';
const PGUARD_END = '/*__CCB_QW_PGUARD_E__*/';
const PGUARD_RE = /\/\*__CCB_QW_PGUARD_B:\[(\w+)\]__\*\/[\s\S]*?\/\*__CCB_QW_PGUARD_E__\*\//g;

/* 默认模型 reconcile 补丁：锚点是 reconcileModelWithCatalog else 分支的完整形状——
 * try{let X=Y.getDefaultModel().key;this.model=X,this.Z=X}catch{let X=opA({uid:I.getUserInfo()...
 * scene:tC().scene});X&&(...)}。catch 体里的 opA 缓存读取表达式原样提取、注入 try 体
 * 提为优先（opA 值 || 目录默认）。标记里带目录变量名，剥离时还原 getDefaultModel()。 */
const RGUARD_MARK = '/*__CCB_QW_RGUARD_B:';
const RGUARD_END = '/*__CCB_QW_RGUARD_E__*/';
const RGUARD_RE = /\/\*__CCB_QW_RGUARD_B:\[(\w+)\]__\*\/[\s\S]*?\/\*__CCB_QW_RGUARD_E__\*\//g;
/* uid/scene 表达式按「完整表达式」捕获（不再写死 getUserInfo/getModelCacheIdentity 等
 * 混淆函数名）：QoderWork 1.0.45 用 I.getUserInfo()?.uid??""，Qoder CN 0.4.3 用
 * t.getModelCacheIdentity()，scene 同理（tC().scene / sg().scene）。uid 用 [^,]+ 匹配到
 * 逗号（表达式内无逗号）；scene 用 (.+?) 非贪婪匹配到第一个 })（scene 形如 fn().scene，
 * 内含 () 但不含 })，第一个 }) 即缓存函数调用的闭合）。 */
const RECONCILE_RE = /try\{let (\w+)=(\w+)\.getDefaultModel\(\)\.key;this\.model=\1,this\.\w+=\1\}catch\{let \1=(\w+)\(\{uid:([^,]+),scene:(.+?)\}\)/g;

/* 传输路由补丁：锚点是 OTe 工厂的 grpc/default 分派尾（case"grpc":XmA=new RTe(i);break;
 * default:XmA=new GTe}return XmA}）。包装 factory 返回值——open() 拦截 sk-ccb- 请求
 * 改走 gRPC 传输，其余透传原传输。包装块整体为注入代码，标记间剥离即还原。 */
const TGUARD_MARK = '/*__CCB_QW_TGUARD_B__*/';
const TGUARD_END = '/*__CCB_QW_TGUARD_E__*/';
const TGUARD_RE = /\/\*__CCB_QW_TGUARD_B__\*\/[\s\S]*?\/\*__CCB_QW_TGUARD_E__\*\//g;
/* 变量名用 [\w$]+：Qoder CN 0.4.3 的混淆名含 $（如 r$A），\w 不含 $ 会漏匹配；
 * QoderWork 1.0.45 全为 \w 名，[\w$]+ 同样兼容。 */
const FACTORY_RE = /case"grpc":([\w$]+)=new ([\w$]+)\(([\w$]+)\);break;default:\1=new ([\w$]+)\}return \1\}/g;

/* 目录同步回写保护补丁：模型目录同步（Xl）后会无条件把 .models/default 回写为
 * 目录默认（Xme({key:this.getDefaultModel().key,uid:X,scene:Y}).catch(()=>{})）——
 * 2026-10-01 实测：应用启动的 headless worker 加载目录缓存的同一毫秒即把 apply 写入的
 * ccb/codeb-auto 覆盖回 "auto"，导致 reconcile 的 opA 优先补丁永远读到 "auto"
 * （这也解释了 stock QoderWork 的 BYOK 模型为何无法成为默认模型）。
 * 补丁：回写前先读 opA 缓存，现值为 ccb/ 前缀（CCB 模型 key，Qoder 平台模型 key
 * 无此前缀）时保留缓存值，其余场景保持原行为（回写目录默认）。
 * 锚点形状按混淆变量名提取；标记内嵌 uid/scene 变量名供剥离还原。 */
const XGUARD_MARK = '/*__CCB_QW_XGUARD_B:';
const XGUARD_END = '/*__CCB_QW_XGUARD_E__*/';
const XGUARD_RE = /\/\*__CCB_QW_XGUARD_B:(\[[\w$,]+\]|cn)__\*\/[\s\S]*?\/\*__CCB_QW_XGUARD_E__\*\//g;
const XLSYNC_RE = /Xme\(\{key:this\.getDefaultModel\(\)\.key,uid:(\w+),scene:(\w+)\}\)\.catch\(\(\)=>\{\}\)/g;
/* CN worker（qoder-cn-agent-sdk）的默认模型回写是独立函数 l$A（writeDefaultModelCache），
 * 不是 QoderWork 的 Xme call-site。用 "[defaultModelCache] Failed to write cache:" 作锚点
 * 定位函数，注入「缓存现值为 ccb/ 前缀则跳过回写」的守卫。函数体内已引用 w5e（fs）与
 * vqr（.models/default 路径），守卫可直接复用。 */
const XL_CN_ANCHOR = '[defaultModelCache] Failed to write cache:';
const XL_CN_FN_RE = /async function ([\w$]+)\(A\)\{let e=\{key:A\.key,uid:A\.uid,scene:A\.scene,updatedAt:Date\.now\(\)\}/;
const CCB_MODEL_PREFIX = 'ccb/';

/* exe → worker runtime 的相对路径（app.asar.unpacked 内，可直接写） */
const RUNTIME_RELPATH = path.join(
	'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai',
	'qoder-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs'
);

/* SDK 日志里 worker runtime 路径的输出格式（路径可能含空格，不能按空白截断） */
const LOG_LINE_RE = /Using asar-unpacked worker runtime: (.+)/g;

/* ---------- 桥函数源码（注入 worker ESM 顶层作用域） ----------
 * 约束：不 import（fetch/AbortController/TextDecoder 均为 Node 全局）；
 * 全部 var/function（最大兼容混淆环境）；注释只用块注释（注入是行拼接）。
 * 事件语义与 worker 消费方对齐，双契约并存（2026-10-02 Qoder CN 实机取证）：
 *   QoderWork（qoder-agent-sdk）：openCall 返回对象的 call 字段是 EventEmitter——
 *   rJI: once('metadata')→立即 resolve；oJI: on('data') 多次 / on('end') 正常结束 /
 *   on('error') 抛错、cancel()→AbortController.abort；SSE chunk 直接入队。
 *   Qoder CN（qoder-cn-agent-sdk）：payloadsFromCall 对返回对象解构 {chunks, requestId}
 *   后 for await 迭代 chunks（OpenAI chunk 原样，经 BOc/XF 归一化在 SDK 侧完成），
 *   并访问 execution.reportStreamHealth / finishRouteLifecycle（取消前置路径还会调
 *   chunks.return()）——缺 chunks 时 for await undefined 立即 TypeError，
 *   表现为聊天 turn「系统发生异常」且 fetch 被流取消链 abort。
 *   故 __emit 单点向 EventEmitter 队列与 hub 队列（异步迭代）双通道分发。
 */
function bridgeSource() {
	return [
		MARK_BEGIN,
		'function __ccbMkCall(){',
		'var q={metadata:[],data:[],end:[],error:[]};var l={metadata:[],data:[],end:[],error:[]};var c={};',
		'var hb={items:[],waiters:[]};',
		'function wk(){var w=hb.waiters.splice(0);for(var i=0;i<w.length;i++){try{w[i]();}catch(e){}}}',
		'c.__hub=hb;',
		'function dr(k){while(l[k].length>0&&q[k].length>0){var v=q[k].shift();var a=l[k].slice();for(var j=0;j<a.length;j++){try{a[j](v);}catch(e){}}}}',
		'c.on=function(k,f){if(!l[k])return;l[k].push(f);dr(k);};',
		'c.once=function(k,f){var w=function(v){c.removeListener(k,w);f(v);};w.__fn=f;l[k].push(w);dr(k);};',
		'c.removeListener=function(k,f){var a=l[k];if(!a)return;for(var i=0;i<a.length;i++){if(a[i]===f||a[i].__fn===f){a.splice(i,1);return;}}};',
		'c.cancel=function(){};',
		'c.__emit=function(k,v){if(!q[k])return;q[k].push(v);if(k==="data"){hb.items.push({v:v});wk();}else if(k==="error"){hb.items.push({e:v});wk();}else if(k==="end"){hb.items.push({d:1});wk();}dr(k);};',
		'return c;}',
		'function __ccbTake(hb){if(hb.items.length>0)return Promise.resolve(hb.items.shift());return new Promise(function(res){hb.waiters.push(function(){res(hb.items.shift());});});}',
		'async function* __ccbChunks(c){for(;;){var m=await __ccbTake(c.__hub);if(m.d)return;if(m.e)throw m.e;yield m.v;}}',
		'function __ccbTcs(t){var o=[];for(var i=0;i<t.length;i++){var x=t[i]||{};var f=x.function||{};o.push({id:x.id||x.call_id||"",type:"function",function:{name:f.name||"",arguments:typeof f.arguments==="string"?f.arguments:(f.arguments==null?"":JSON.stringify(f.arguments))}});}return o;}',
		'function __ccbParts(p){var o=[];for(var i=0;i<p.length;i++){var x=p[i]||{};if(x.type==="text"&&typeof x.text==="string")o.push({type:"text",text:x.text});else if(x.type==="image_url"&&x.image_url&&x.image_url.url)o.push({type:"image_url",image_url:{url:x.image_url.url}});else if(x.type==="input_audio")o.push(x);}return o;}',
		'function __ccbMsgs(ms){var o=[];for(var i=0;i<ms.length;i++){var m=ms[i]||{};var r={role:m.role};var c=(m.content!==undefined&&m.content!==null)?m.content:m.contents;if(typeof c==="string")r.content=c;else if(Array.isArray(c))r.content=__ccbParts(c);if(m.tool_call_id)r.tool_call_id=m.tool_call_id;if(m.tool_calls&&m.tool_calls.length>0)r.tool_calls=__ccbTcs(m.tool_calls);o.push(r);}return o;}',
		'function __ccbBody(A){var cm=A.customModel||{};var b={};b.model=cm.model;b.messages=__ccbMsgs(A.messages||[]);if(A.tools&&A.tools.length>0)b.tools=A.tools;b.stream=true;b.stream_options={include_usage:true};var p=A.parameters||{};var mt=(p.max_tokens!=null)?p.max_tokens:A.max_tokens;if(mt!=null)b.max_tokens=mt;if(p.temperature!=null)b.temperature=p.temperature;if(p.top_p!=null)b.top_p=p.top_p;if(p.presence_penalty!=null)b.presence_penalty=p.presence_penalty;if(p.frequency_penalty!=null)b.frequency_penalty=p.frequency_penalty;if(p.parallel_tool_calls!=null)b.parallel_tool_calls=p.parallel_tool_calls;if(p.response_format)b.response_format=p.response_format;if(p.tool_choice!=null)b.tool_choice=p.tool_choice;var st=Array.isArray(p.stop)?p.stop:A.stop;if(Array.isArray(st)&&st.length>0)b.stop=st;if(A.reasoningEffort==="none")b.thinking={type:"disabled"};return b;}',
		'function __ccbSse(res,c){var rd=res.body.getReader();var dec=new TextDecoder();var buf="";var done=false;',
		'function fin(){if(done)return;done=true;try{rd.cancel();}catch(e){}c.__emit("end");}',
		'function line(s){if(s.length>0&&s.charCodeAt(s.length-1)===13)s=s.slice(0,s.length-1);if(s.indexOf("data:")!==0)return;var p=s.slice(5).trim();if(!p)return;if(p==="[DONE]"){fin();return;}try{c.__emit("data",JSON.parse(p));}catch(e){}}',
		'function pump(){rd.read().then(function(m){if(done)return;if(m.done){var r=buf;buf="";if(r)line(r);fin();return;}buf+=dec.decode(m.value,{stream:true});var ls=buf.split("\\n");buf=ls.pop();for(var i=0;i<ls.length;i++)line(ls[i]);pump();},function(e){if(done)return;done=true;c.__emit("error",e);});}',
		'pump();}',
		'function __ccbRun(u,k,A,c,sig){fetch(u,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+k},body:JSON.stringify(__ccbBody(A)),signal:sig}).then(function(res){if(!res.ok){res.text().then(function(t){c.__emit("error",new Error("CCB HTTP "+res.status+(t?": "+t.slice(0,600):"")));},function(){c.__emit("error",new Error("CCB HTTP "+res.status));});return;}var ct=(res.headers.get("content-type")||"")+"";if(ct.indexOf("event-stream")<0){res.text().then(function(t){try{var j=JSON.parse(t);var id=j.id||A.requestId||"";var ts=Math.floor(Date.now()/1e3);var md=j.model||"";var ch=(j.choices&&j.choices[0])||null;var mg=ch?(ch.message||null):null;if(mg){var d={role:"assistant"};if(mg.content!=null)d.content=mg.content;if(mg.tool_calls)d.tool_calls=__ccbTcs(mg.tool_calls);c.__emit("data",{id:id,object:"chat.completion.chunk",created:ts,model:md,choices:[{index:0,delta:d,finish_reason:null}]});c.__emit("data",{id:id,object:"chat.completion.chunk",created:ts,model:md,choices:[{index:0,delta:{},finish_reason:(ch&&ch.finish_reason)||"stop"}],usage:j.usage});}c.__emit("end");}catch(e){c.__emit("error",e);}},function(e){c.__emit("error",e);});return;}__ccbSse(res,c);},function(e){c.__emit("error",e);});}',
		'function ' + BRIDGE_FN + '(A){var cm=(A&&A.customModel)||{};var u=cm.url||"";var k=(cm.parameters&&cm.parameters.api_key)||"";var c=__ccbMkCall();var ac=new AbortController();if(A&&A.signal){if(A.signal.aborted)ac.abort();else A.signal.addEventListener("abort",function(){try{ac.abort();}catch(e){}});}c.cancel=function(){try{ac.abort();}catch(e){}};c.__emit("metadata",{get:function(){return[];}});var ret={call:c,requestId:(A&&A.requestId)||"",serverRequestId:null,chunks:__ccbChunks(c),execution:{reportStreamHealth:function(){}},finishRouteLifecycle:function(){try{ac.abort();}catch(e){}}};if(!u){c.__emit("error",new Error("CCB bridge: missing custom model url"));return Promise.resolve(ret);}if(u.indexOf("/chat/completions")<0)u=u.replace(/\\/+$/,"")+"/chat/completions";__ccbRun(u,k,A,c,ac.signal);return Promise.resolve(ret);}',
		MARK_END,
	].join('\n');
}

/* ---------- 补丁算法（纯函数，便于单测） ---------- */

/** 提取补丁锚点：返回 {ok:true, varName, insertPos} 或 {ok:false, reason}
 *  锚点 = openCall try 块里的 m4i({...bodyKind:"req"...})，全文件唯一；
 *  请求变量名从锚点段（sessionId:<v>.sessionId,requestId:<v>.requestId）提取，
 *  混淆名随版本变化，不能写死。 */
function extractAnchor(src) {
	const bi = src.indexOf(ANCHOR);
	if (bi < 0) return { ok: false, reason: '未找到锚点 bodyKind:"req"' };
	if (src.indexOf(ANCHOR, bi + 1) >= 0) return { ok: false, reason: '锚点 bodyKind:"req" 不唯一' };
	const ti = src.lastIndexOf('try{', bi);
	if (ti < 0 || bi - ti > 400) {
		return { ok: false, reason: '锚点距 try{ ' + (ti < 0 ? '未找到' : bi - ti + ' 字符') + '，超出预期' };
	}
	const seg = src.slice(ti, bi);
	const m = seg.match(/sessionId:(\w+)\.sessionId,requestId:\1\.requestId/);
	if (!m) return { ok: false, reason: '无法从锚点段提取请求变量名' };
	return { ok: true, varName: m[1], insertPos: ti + 4 };
}

/** guard 源码：命中 sk-ccb- 密钥的 BYOK 请求时短路到桥函数 */
function guardSource(varName) {
	const v = varName;
	return GUARD_BEGIN
		+ 'if(' + v + '&&' + v + '.customModel&&' + v + '.customModel.parameters'
		+ '&&typeof ' + v + '.customModel.parameters.api_key=="string"'
		+ '&&' + v + '.customModel.parameters.api_key.indexOf("' + CCB_KEY_PREFIX + '")===0)'
		+ 'return await ' + BRIDGE_FN + '(' + v + ');'
		+ GUARD_END;
}

/** 按 guard 标记精确剥离（无标记返回原串） */
function stripGuard(src) {
	const b = src.indexOf(GUARD_BEGIN);
	if (b < 0) return src;
	const e = src.indexOf(GUARD_END, b);
	if (e < 0) return src.slice(0, b);
	return src.slice(0, b) + src.slice(e + GUARD_END.length);
}

/** 按 bridge 标记剥离（无标记返回原串） */
function stripBridge(src) {
	const b = src.indexOf(MARK_BEGIN);
	if (b < 0) return src;
	const e = src.indexOf(MARK_END, b);
	if (e < 0) return src.slice(0, b);
	return src.slice(0, b) + src.slice(e + MARK_END.length);
}

/** 追加或整体替换 bridge 标记块（无条件替换为当前源码，实现幂等更新） */
function upsertBridge(src) {
	const bs = bridgeSource();
	const b = src.indexOf(MARK_BEGIN);
	if (b < 0) return src + '\n' + bs;
	const e = src.indexOf(MARK_END, b);
	if (e < 0) return src.slice(0, b) + bs; /* 有头无尾的残块：从头整体重写 */
	return src.slice(0, b) + bs + src.slice(e + MARK_END.length);
}

/* ---------- 策略门禁跳过（get_model_policy） ---------- */

/** 提取 JA（worker 的 get_model_policy 回调）guard 的位置与原始变量名。
 *  形状：async(...)=>{if(!VAR)return;let{...}=...createRequest(...);...{subtype:"get_model_policy"...
 *  结构锚点 = 全文件唯一的 get_model_policy 字面量；guard 是它前面最近的
 *  「=>{if(!VAR)return;」。找不到字面量时返回 absent:true（该版本无此门禁，
 *  属正常，调用方跳过而非失败）；其余形状异常按版本不兼容 fail-fast。 */
function extractPolicyGuard(src) {
	const li = src.indexOf(POLICY_ANCHOR);
	if (li < 0) return { ok: false, absent: true, reason: '无 get_model_policy（该版本无模型策略门禁）' };
	if (src.indexOf(POLICY_ANCHOR, li + 1) >= 0) return { ok: false, reason: 'get_model_policy 锚点不唯一' };
	const winStart = Math.max(0, li - 3000);
	const win = src.slice(winStart, li);
	const re = /=>\{if\(!(\w+)\)return;/g;
	let m; let last = null;
	while ((m = re.exec(win))) last = m;
	if (!last) return { ok: false, reason: '未找到 policy guard 形状（=>{if(!VAR)return;）' };
	const start = winStart + last.index + 3; /* 跳过 "=>{" */
	const len = `if(!${last[1]})return;`.length;
	if (li - (start + len) > 500) {
		return { ok: false, reason: `policy guard 距锚点过远（${li - start} 字符）` };
	}
	return { ok: true, varName: last[1], start, len };
}

/** policy guard 替换源码：恒真跳过（JA 直接 return undefined = 无策略，放行）。
 *  BEGIN 标记内嵌原始变量名，供无备份剥离时还原 if(!VAR)return;。 */
function policyGuardSource(varName) {
	return `${PGUARD_MARK}[${varName}]__*/if(!0)return;${PGUARD_END}`;
}

/** 按 policy 标记剥离并还原原始 guard（无标记返回原串） */
function stripPolicyGuard(src) {
	return src.replace(PGUARD_RE, (_m, v) => `if(!${v})return;`);
}

/* ---------- 默认模型 reconcile（.models/default 提为优先） ---------- */

/** 提取 reconcile else 分支的形状与混淆变量名（全文件唯一，不唯一=不兼容） */
function extractReconcilePatch(src) {
	const matches = [...src.matchAll(RECONCILE_RE)];
	if (!matches.length) {
		return { ok: false, reason: '未找到默认模型 reconcile 分支（try{…getDefaultModel().key…}catch{…cached default…}）' };
	}
	if (matches.length > 1) return { ok: false, reason: 'reconcile 分支锚点不唯一' };
	const m = matches[0];
	return {
		ok: true,
		start: m.index,
		len: m[0].length,
		modelVar: m[1], catalogVar: m[2], cacheFn: m[3],
		uidExpr: m[4], sceneExpr: m[5],
	};
}

/** 注入 try 体的「缓存默认 || 目录默认」span：标记里带目录变量名，剥离时还原。
 *  uid/scene 用从 catch 体捕获的完整表达式（QoderWork / Qoder CN 函数名不同），
 *  保证重建的缓存调用与原 catch 体逐字节一致。 */
function reconcileSpanSource(p) {
	const cacheExpr = `${p.cacheFn}({uid:${p.uidExpr},scene:${p.sceneExpr}})`;
	return `${RGUARD_MARK}[${p.catalogVar}]__*/${cacheExpr}||${p.catalogVar}.getDefaultModel().key${RGUARD_END}`;
}

/** 按 reconcile 标记剥离并还原目录默认（无标记返回原串） */
function stripReconcileGuard(src) {
	return src.replace(RGUARD_RE, (_m, v) => `${v}.getDefaultModel().key`);
}

/** 应用 reconcile 补丁（纯函数）：try 体改为 opA 缓存优先 */
function applyReconcilePatch(src, p) {
	const span = src.slice(p.start, p.start + p.len);
	const origTry = `let ${p.modelVar}=${p.catalogVar}.getDefaultModel().key;`;
	if (span.indexOf(origTry) !== span.lastIndexOf(origTry)) return null;
	const patched = span.replace(origTry, `let ${p.modelVar}=${reconcileSpanSource(p)};`);
	return src.slice(0, p.start) + patched + src.slice(p.start + p.len);
}

/* ---------- 传输路由（sk-ccb- 请求改走 gRPC 传输） ---------- */

/** 提取 OTe 工厂分派尾的形状与混淆变量名（cacheVar/grpcCls/rewriteVar，全文件唯一） */
function extractFactoryPatch(src) {
	const matches = [...src.matchAll(FACTORY_RE)];
	if (!matches.length) {
		return { ok: false, reason: '未找到模型传输工厂分派（case"grpc":…default:…}return…}）' };
	}
	if (matches.length > 1) return { ok: false, reason: '传输工厂锚点不唯一' };
	const m = matches[0];
	return { ok: true, start: m.index, len: m[0].length, cacheVar: m[1], grpcCls: m[2], rewriteVar: m[3] };
}

/** 传输包装源码：拦截 sk-ccb- 请求改走 gRPC 传输（其 openCall 有 guard 短路直连中转），
 *  其余请求原样透传原传输。块整体为注入代码，标记间剥离即还原。 */
function factoryWrapperSource(p) {
	return TGUARD_MARK
		+ `{let __ccbOT=${p.cacheVar};${p.cacheVar}={open:function(q){`
		+ 'if(q&&q.customModel&&q.customModel.parameters'
		+ '&&typeof q.customModel.parameters.api_key=="string"'
		+ `&&q.customModel.parameters.api_key.indexOf("${CCB_KEY_PREFIX}")===0)`
		+ `return new ${p.grpcCls}(${p.rewriteVar}).open(q);`
		+ 'return __ccbOT.open(q)}}}'
		+ TGUARD_END;
}

/** 按传输包装标记整体剥离（无标记返回原串） */
function stripFactoryWrapper(src) {
	return src.replace(TGUARD_RE, '');
}

/** 应用传输包装（纯函数）：插在 default 分派 } 与 return 之间 */
function applyFactoryWrapper(src, p) {
	const span = src.slice(p.start, p.start + p.len);
	const tail = `return ${p.cacheVar}}`;
	if (!span.endsWith(tail)) return null;
	const head = span.slice(0, span.length - tail.length); /* …default:XmA=new GTe} */
	return src.slice(0, p.start) + head + factoryWrapperSource(p) + tail + src.slice(p.start + p.len);
}

/* ---------- 目录同步回写保护（Xl 的 Xme 无条件回写） ---------- */

/** 提取目录同步回写的形状与混淆变量名（全文件唯一，不唯一=不兼容）。
 *  QoderWork：Xme({key:this.getDefaultModel().key,uid:X,scene:Y}).catch(()=>{}) call-site
 *  Qoder CN：async function FN(A){let e={key:A.key,...}} 函数（writeDefaultModelCache） */
function extractXlPatch(src) {
	/* 1) QoderWork 的 Xme call-site */
	const matches = [...src.matchAll(XLSYNC_RE)];
	if (matches.length === 1) {
		const m = matches[0];
		return { ok: true, type: 'qw', start: m.index, len: m[0].length, uidVar: m[1], sceneVar: m[2] };
	}
	if (matches.length > 1) return { ok: false, reason: '目录同步回写锚点不唯一（Xme）' };
	/* 2) Qoder CN 的 writeDefaultModelCache 函数 */
	if (src.indexOf(XL_CN_ANCHOR) < 0) {
		return { ok: false, reason: '未找到目录同步回写（Xme / writeDefaultModelCache）' };
	}
	const fnMatch = XL_CN_FN_RE.exec(src);
	if (!fnMatch) return { ok: false, reason: '找到 defaultModelCache 锚点但函数签名不匹配' };
	if (XL_CN_FN_RE.exec(src.slice(fnMatch.index + 1))) {
		return { ok: false, reason: 'writeDefaultModelCache 函数不唯一' };
	}
	const fnName = fnMatch[1];
	const fnStart = fnMatch.index;
	const fnLen = fnMatch[0].length;
	return { ok: true, type: 'cn', fnName, start: fnStart, len: fnLen };
}

/** 原始回写（剥离时还原用） */
function xlOriginalCall(p) {
	if (p.type === 'cn') {
		return `async function ${p.fnName}(A){let e={key:A.key,uid:A.uid,scene:A.scene,updatedAt:Date.now()}`;
	}
	return `Xme({key:this.getDefaultModel().key,uid:${p.uidVar},scene:${p.sceneVar}}).catch(()=>{})`;
}

/** 保护版回写源码 */
function xlSpanSource(p) {
	if (p.type === 'cn') {
		/* 注入到函数体开头：读 .models/default，现值为 ccb/ 前缀则 return 跳过回写。
		 * w5e 是 fs、vqr() 返回 .models/default 路径——函数体内已引用两者，可直接复用。 */
		const guard = 'try{let _c=JSON.parse(w5e.readFileSync(vqr(),"utf-8"));if(_c&&typeof _c.key==="string"&&_c.key.indexOf("' + CCB_MODEL_PREFIX + '")===0)return}catch{}';
		return XGUARD_MARK + 'cn__*/' + guard + XGUARD_END;
	}
	const cacheFn = p.cacheFn || 'opA';
	return XGUARD_MARK + `[${p.uidVar},${p.sceneVar}]__*/`
		+ `Xme({key:(function(c){return typeof c==="string"&&c.indexOf("${CCB_MODEL_PREFIX}")===0?c:this.getDefaultModel().key})`
		+ `.call(this,${cacheFn}({uid:${p.uidVar},scene:${p.sceneVar}})),uid:${p.uidVar},scene:${p.sceneVar}})`
		+ XGUARD_END;
}

/** 按标记剥离并还原原始回写（无标记返回原串） */
function stripXlGuard(src) {
	return src.replace(XGUARD_RE, (m, tag) => {
		if (tag === 'cn') {
			/* CN 守卫注入在函数体开头，剥离即移除整段标记（守卫不替换任何原代码） */
			return '';
		}
		/* QoderWork：tag 形如 "uidVar,sceneVar" */
		const parts = tag.slice(1, -1).split(',');
		return `Xme({key:this.getDefaultModel().key,uid:${parts[0]},scene:${parts[1]}}).catch(()=>{})`;
	});
}

/** 应用回写保护（纯函数） */
function applyXlPatch(src, p) {
	const span = src.slice(p.start, p.start + p.len);
	if (span !== xlOriginalCall(p)) return null;
	if (p.type === 'cn') {
		/* 在 async function FN(A){ 之后、let e=... 之前注入守卫。
		 * span = "async function FN(A){let e={key:A.key,...Date.now()}"，
		 * 函数体开口 { 位于 span 内 "async function FN(A){" 末尾。 */
		const head = `async function ${p.fnName}(A){`;
		if (!span.startsWith(head)) return null;
		const insertPos = p.start + head.length;
		return src.slice(0, insertPos) + xlSpanSource(p) + src.slice(insertPos);
	}
	return src.slice(0, p.start) + xlSpanSource(p) + src.slice(p.start + p.len);
}

/* ---------- fast-update 完整性清单 hash 同步 ---------- */

/** Qoder CN 用 fast-update manifest 校验 app.asar.unpacked 内文件的 SHA256，
 *  不符则启动时还原为清单原值（导致 worker 补丁被冲掉）。补丁写盘后必须同步
 *  清单中该 worker 的 hash。manifest 不存在（如 QoderWork）时静默跳过。 */
function syncFastUpdateManifest(workerFile, log) {
	try {
		/* worker: <appRoot>/resources/app.asar.unpacked/.../qoder-worker-runtime.obf.mjs
		 * manifest: <appRoot>/resources/fast-update/qoder-fast-update-manifest.json */
		const resourcesIdx = workerFile.lastIndexOf(path.join('resources', 'app.asar.unpacked'));
		if (resourcesIdx < 0) return false;
		const appRoot = workerFile.slice(0, resourcesIdx);
		const manifest = path.join(appRoot, 'resources', 'fast-update', 'qoder-fast-update-manifest.json');
		if (!fs.existsSync(manifest)) return false;
		/* worker 在清单中的相对路径（正斜杠） */
		const relWorker = path.relative(appRoot, workerFile).split(path.sep).join('/');
		const raw = fs.readFileSync(manifest, 'utf8');
		const newHash = crypto.createHash('sha256').update(fs.readFileSync(workerFile)).digest('hex');
		const newSize = fs.statSync(workerFile).size;
		/* 匹配该 worker 的清单条目：{"path":"<rel>","size":N,"sha256":"<h>"} */
		const re = new RegExp(
			'("path":"' + relWorker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			+ '","size":)\\d+(,"sha256":")[a-f0-9]{64}("})'
		);
		if (!re.test(raw)) {
			log('提示：fast-update 清单中未找到 worker 条目，跳过 hash 同步。');
			return false;
		}
		const updated = raw.replace(re, `$1${newSize}$2${newHash}$3`);
		if (updated === raw) return false;
		fs.writeFileSync(manifest, updated, 'utf8');
		log(`已同步 fast-update 清单 hash（${path.basename(manifest)}）。`);
		return true;
	} catch (e) {
		log(`提示：同步 fast-update 清单失败（${e.message}），不影响补丁本身。`);
		return false;
	}
}

/* ---------- 定位 worker runtime ---------- */

function runtimeFromExe(exe) {
	const p = path.join(path.dirname(exe), RUNTIME_RELPATH);
	return fs.existsSync(p) ? p : null;
}

/** 日志兜底：解析 SDK 日志里的「Using asar-unpacked worker runtime: <path>」，
 *  取最新日志文件中的最后一次记录（覆盖自定义安装路径的场景）。 */
function runtimeFromLogs(client) {
	const dir = ((client && client.appDirs) || [])[0];
	if (!dir) return null;
	const logRoot = path.join(APPDATA, dir, 'logs');
	if (!fs.existsSync(logRoot)) return null;
	let best = null;
	let bestMtime = 0;
	const walk = (d) => {
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			const p = path.join(d, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (ent.name === 'qoder-agent-sdk.log') {
				let mtimeMs;
				try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
				if (mtimeMs <= bestMtime) continue;
				let text;
				try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
				const hits = [...text.matchAll(LOG_LINE_RE)];
				if (!hits.length) continue;
				const file = hits[hits.length - 1][1].trim();
				if (file && fs.existsSync(file)) {
					best = file;
					bestMtime = mtimeMs;
				}
			}
		}
	};
	walk(logRoot);
	return best;
}

/** 定位 QoderWork 的 worker runtime mjs（exe 同级 resources → 日志兜底），找不到返回 null */
function findQoderWorkRuntime(client, log) {
	const exe = findExeEverywhere(((client && client.exeNames) || []));
	if (exe) {
		const hit = runtimeFromExe(exe);
		if (hit) {
			log(`定位 worker runtime：${hit}`);
			return hit;
		}
	}
	const hit = runtimeFromLogs(client);
	if (hit) {
		log(`从日志定位 worker runtime：${hit}`);
		return hit;
	}
	log('未定位到 QoderWork worker runtime（exe 探测与日志解析均无结果）。');
	return null;
}

/* ---------- 补丁 / 回滚 ---------- */

/** 补丁指定 runtime 文件。返回 true=已写入或已是最新；失败 throw（文件保持原样）。 */
function patchQoderWorkRuntime(file, log) {
	if (!fs.existsSync(file)) throw new Error(`runtime 文件不存在：${file}`);
	const src = fs.readFileSync(file, 'utf8');
	const hadAny = src.indexOf(MARK_BEGIN) >= 0 || src.indexOf(GUARD_BEGIN) >= 0
		|| src.indexOf(PGUARD_MARK) >= 0 || src.indexOf(RGUARD_MARK) >= 0
		|| src.indexOf(TGUARD_MARK) >= 0 || src.indexOf(XGUARD_MARK) >= 0;
	let out = src;
	/* 幂等更新：先剥离旧 span，保证各锚点形状可重新提取 */
	if (src.indexOf(PGUARD_MARK) >= 0) out = stripPolicyGuard(out);
	if (src.indexOf(RGUARD_MARK) >= 0) out = stripReconcileGuard(out);
	if (src.indexOf(TGUARD_MARK) >= 0) out = stripFactoryWrapper(out);
	if (src.indexOf(XGUARD_MARK) >= 0) out = stripXlGuard(out);
	if (src.indexOf(GUARD_BEGIN) < 0) {
		const a = extractAnchor(out);
		if (!a.ok) {
			throw new Error(`QoderWork runtime 与当前 CCB 版本不兼容（${a.reason}），已中止且未修改文件`);
		}
		out = out.slice(0, a.insertPos) + guardSource(a.varName) + out.slice(a.insertPos);
	}
	/* 策略门禁跳过：有门禁就打（锚点缺失=无门禁，正常跳过）；形状异常=不兼容，fail-fast */
	const pa = extractPolicyGuard(out);
	if (!pa.ok) {
		if (!pa.absent) {
			throw new Error(`QoderWork runtime 与当前 CCB 版本不兼容（${pa.reason}），已中止且未修改文件`);
		}
		log('该 runtime 无 get_model_policy 门禁，无需策略跳过补丁。');
	} else {
		out = out.slice(0, pa.start) + policyGuardSource(pa.varName) + out.slice(pa.start + pa.len);
	}
	/* 默认模型 reconcile：BYOK 不传 --model，没有此补丁默认模型永远解析回平台目录默认 */
	const rp = extractReconcilePatch(out);
	if (!rp.ok) {
		throw new Error(`QoderWork runtime 与当前 CCB 版本不兼容（${rp.reason}），已中止且未修改文件`);
	}
	const ro = applyReconcilePatch(out, rp);
	if (ro === null) {
		throw new Error('QoderWork runtime 与当前 CCB 版本不兼容（reconcile try 体形状异常），已中止且未修改文件');
	}
	out = ro;
	/* 传输路由：legacy/http 传输下 BYOK 请求直发网关，guard 永不触发，必须改道 gRPC */
	const tp = extractFactoryPatch(out);
	if (!tp.ok) {
		throw new Error(`QoderWork runtime 与当前 CCB 版本不兼容（${tp.reason}），已中止且未修改文件`);
	}
	const to = applyFactoryWrapper(out, tp);
	if (to === null) {
		throw new Error('QoderWork runtime 与当前 CCB 版本不兼容（传输工厂尾部形状异常），已中止且未修改文件');
	}
	out = to;
	/* 目录同步回写保护：不修则启动/刷新即把默认模型踩回平台默认，前面所有补丁白做。
	 * QoderWork 是 Xme({key:this.getDefaultModel...}) call-site；Qoder CN 是独立的
	 * writeDefaultModelCache 函数（l$A）。extractXlPatch 自动识别两者，缺失才跳过。 */
	const xp = extractXlPatch(out);
	if (!xp.ok) {
		log(`提示：该 runtime 无目录同步回写段（${xp.reason}），跳过回写保护补丁。`);
	} else {
		if (xp.type === 'qw') xp.cacheFn = rp.cacheFn; /* QoderWork：缓存读取函数与 reconcile 同源 */
		const xo = applyXlPatch(out, xp);
		if (xo === null) {
			throw new Error('QoderWork runtime 与当前 CCB 版本不兼容（目录同步回写形状异常），已中止且未修改文件');
		}
		out = xo;
	}
	out = upsertBridge(out);
	if (out === src) {
		log('QoderWork runtime 补丁已存在且为最新，无需重写。');
		return true;
	}
	/* 备份（恒为首次写入前的原始状态），再写盘 */
	const bak = file + BACKUP_SUFFIX;
	if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
	fs.writeFileSync(file, out, 'utf8');
	/* 语法安全网：校验失败时用内存里的原始内容还原（不依赖备份，防版本错配） */
	const chk = spawnSync('node', ['--check', file], { encoding: 'utf8' });
	if (chk.error) {
		log('提示：未找到 node 命令，跳过写后语法校验。');
	} else if (chk.status !== 0) {
		fs.writeFileSync(file, src, 'utf8');
		throw new Error(`补丁后语法校验失败，已还原原文件：${String(chk.stderr || chk.stdout).slice(0, 300)}`);
	}
	/* Qoder CN 的 fast-update 清单会校验 worker hash，不符则启动时还原——同步之 */
	syncFastUpdateManifest(file, log);
	log(hadAny
		? 'QoderWork runtime 补丁已更新（BYOK 直连桥 + 策略门禁跳过 + 默认模型 reconcile + 传输路由 + 回写保护）。'
		: `QoderWork runtime 补丁已写入（备份 ${path.basename(bak)}）：CCB 模型请求直连中转并跳过服务端自定义模型门禁，官方模型不受影响。`);
	return true;
}

/** 回滚指定 runtime 文件。优先还原 .ccb.bak；无备份则按标记剥离。返回是否有修改。 */
function rollbackQoderWorkRuntime(file, log) {
	if (!fs.existsSync(file)) return false;
	const bak = file + BACKUP_SUFFIX;
	if (fs.existsSync(bak)) {
		fs.copyFileSync(bak, file);
		syncFastUpdateManifest(file, log);
		log(`已从备份还原 ${path.basename(file)}`
			+ `（若 QoderWork 本身升级过，旧备份可能不再匹配，请改用「重新写入配置」）。`);
		return true;
	}
	const src = fs.readFileSync(file, 'utf8');
	let out = stripGuard(src);
	out = stripPolicyGuard(out);
	out = stripReconcileGuard(out);
	out = stripFactoryWrapper(out);
	out = stripXlGuard(out);
	out = stripBridge(out);
	if (out === src) return false;
	fs.writeFileSync(file, out, 'utf8');
	/* 剥离是注入的逆操作，仅在 node 可用时顺手校验；失败则用内存原内容还原 */
	const chk = spawnSync('node', ['--check', file], { encoding: 'utf8' });
	if (!chk.error && chk.status !== 0) {
		fs.writeFileSync(file, src, 'utf8');
		log('提示：剥离后的内容语法校验异常，已还原保持原样。');
		return false;
	}
	syncFastUpdateManifest(file, log);
	log('已从 QoderWork runtime 剥离 CCB 桥（无备份可用时的精确清理）。');
	return true;
}

/* ---------- writers.js 集成入口 ---------- */

/** 写入配置后调用：定位 runtime 并打补丁。失败 throw（调用方决定整体语义）。 */
function ensureQoderWorkBridge(client, log) {
	/* 显式跳过开关：格式类测试（roundtrip / dialogue-e2e）在合成环境验证
	 * customs/agents.db/默认模型的写入格式，桥接另有专测（qoderbridge.test.js
	 * 含真实 runtime 副本的字节级往返），且必须避免测试触碰真实 runtime 文件。 */
	if (process.env.CCB_QW_BRIDGE === 'off') {
		log('CCB_QW_BRIDGE=off：跳过 QoderWork runtime 桥接。');
		return false;
	}
	const file = findQoderWorkRuntime(client, log);
	if (!file) {
		throw new Error('未定位到 QoderWork worker runtime，桥接补丁未生效（请先安装并启动一次 QoderWork 再重新写入配置）');
	}
	return patchQoderWorkRuntime(file, log);
}

/** 回滚时调用：定位 runtime 并还原。失败只记日志，不让回滚整体失败。 */
function removeQoderWorkBridge(client, log) {
	const file = findQoderWorkRuntime(client, log);
	if (!file) return false;
	try {
		return rollbackQoderWorkRuntime(file, log);
	} catch (e) {
		log(`QoderWork runtime 桥回滚失败：${e.message}`);
		return false;
	}
}

module.exports = {
	CCB_KEY_PREFIX, CCB_MODEL_PREFIX, MARK_BEGIN, MARK_END, GUARD_BEGIN, GUARD_END, BACKUP_SUFFIX,
	POLICY_ANCHOR, PGUARD_MARK, PGUARD_END,
	RGUARD_MARK, RGUARD_END, TGUARD_MARK, TGUARD_END, XGUARD_MARK, XGUARD_END,
	bridgeSource, extractAnchor, guardSource, stripGuard, stripBridge,
	extractPolicyGuard, policyGuardSource, stripPolicyGuard,
	extractReconcilePatch, reconcileSpanSource, stripReconcileGuard, applyReconcilePatch,
	extractFactoryPatch, factoryWrapperSource, stripFactoryWrapper, applyFactoryWrapper,
	extractXlPatch, xlSpanSource, stripXlGuard, applyXlPatch,
	findQoderWorkRuntime, patchQoderWorkRuntime, rollbackQoderWorkRuntime,
	ensureQoderWorkBridge, removeQoderWorkBridge,
};
