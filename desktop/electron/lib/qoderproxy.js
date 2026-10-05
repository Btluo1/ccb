/**
 * CCB Qoder CN IDE 本地 MITM 代理
 *
 * 用途：Qoder CN 1.32 的自定义模型（BYOK）要求 provider 存在于服务端 BYOK 配置
 * （gateway.qoder.com.cn/api/v2/byok/config）中，否则模型被禁用（provider_unavailable）。
 * 本代理拦截该接口的响应，向 providers 里注入一个指向 CCB 中转的自定义 provider，
 * 使本地自定义模型（provider="ccb"）通过校验并被 Go 语言客户端路由到 CCB 中转。
 *
 * 机制：
 *  - 仅对 gateway.qoder.com.cn 做 MITM（复用 cursor-proxy 的根 CA，已装入用户根证书库）
 *  - 其余 CONNECT 一律 TCP 隧道透传
 *  - 命中 /api/v2/byok/config：转发真实服务器 → dump 原始响应（供排障）→ 自适应注入 provider
 *  - 命中其它路径：原样透传
 *
 * 使用：HTTPS_PROXY=http://127.0.0.1:9183 启动 Qoder（或 settings.json http.proxy）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_PORT = 9183;
const MITM_HOST = 'gateway.qoder.com.cn';
/* 需要 MITM 的域名：byok 等接口按「最优端点」可能走 openapi/qts 等备用域；
 * 推理请求（BYOK 自定义模型）由 Go 客户端按服务端下发的端点表路由，可能落在
 * 任意 qoder 域（gateway、api2/api3、qts、openapi），因此用域名匹配而不是固定集合。 */
const MITM_HOSTS = new Set([
	'gateway.qoder.com.cn',
	'openapi.qoder.com.cn',
	'qts.qoder.com.cn',
	'api2.qoder.sh',
	'api3.qoder.sh',
	/* v3：BYOK 模型挂在预定义 deepseek provider 下，Go 客户端按内置端点表路由到
	 * api.deepseek.com（client-side BYOK 时）。MITM 后按 sk-ccb 密钥识别重定向到中转站。 */
	'api.deepseek.com',
]);
const MITM_HOST_RE = /(^|\.)qoder\.(com\.cn|sh)$/i;
function shouldMitm(host) {
	const h = String(host || '').toLowerCase();
	return MITM_HOSTS.has(h) || MITM_HOST_RE.test(h);
}
/* 真实端点带网关前缀：GET /algo/api/v2/byok/config（早期只匹配裸 /api/v2/byok/config
 * 导致注入从不触发）。容忍任意前导路径段。 */
const BYOK_PATH_RE = /^(?:\/[\w-]+)*\/api\/v2\/byok\/config(?:\?|$)/;
const RELAY_BASE_URL = 'https://code.btluo.com/v1';
/* 中转站域名（重定向目标，从 relayBaseUrl 解析） */

const state = {
	server: null,
	port: DEFAULT_PORT,
	dataDir: path.join(os.homedir(), '.ccb'),
	relayBaseUrl: RELAY_BASE_URL,
	log: (m) => console.log('[CCB Qoder代理]', m),
	ca: null,
	certCache: new Map(),
	models: [],        // 从 qoder-models.json 读取的模型名列表
	dumpDone: false,
	stats: { intercepted: 0, tunneled: 0, injected: 0, relayed: 0 },
};

function log(msg) {
	try { state.log(msg); } catch {}
}

/* ---------- 根 CA（与 cursor-proxy 同目录同一张证书，装一次两边通用） ---------- */
function caPaths() {
	return {
		dir: path.join(state.dataDir, 'cursor-proxy'),
		key: path.join(state.dataDir, 'cursor-proxy', 'ca-key.pem'),
		cert: path.join(state.dataDir, 'cursor-proxy', 'ca-cert.pem'),
	};
}

function generateCa() {
	const forge = require('node-forge');
	log('正在生成 CCB 本地代理根证书（RSA 2048，可能需要几秒）…');
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = crypto.randomBytes(16).toString('hex');
	cert.validity.notBefore = new Date(Date.now() - 86400000);
	cert.validity.notAfter = new Date();
	cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);
	const attrs = [
		{ name: 'organizationName', value: 'CCB' },
		{ name: 'commonName', value: 'CCB Local Proxy CA' },
	];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([
		{ name: 'basicConstraints', cA: true },
		{ name: 'keyUsage', keyCertSign: true, cRLSign: true },
	]);
	cert.sign(keys.privateKey, forge.md.sha256.create());
	const p = caPaths();
	fs.mkdirSync(p.dir, { recursive: true });
	fs.writeFileSync(p.key, forge.pki.privateKeyToPem(keys.privateKey));
	fs.writeFileSync(p.cert, forge.pki.certificateToPem(cert));
	log('根证书已生成（尚未安装到系统证书库）');
	return { keyObj: keys.privateKey, certObj: cert };
}

function ensureCa() {
	if (state.ca) return state.ca;
	const forge = require('node-forge');
	const p = caPaths();
	fs.mkdirSync(p.dir, { recursive: true });
	if (fs.existsSync(p.key) && fs.existsSync(p.cert)) {
		try {
			const keyPem = fs.readFileSync(p.key, 'utf8');
			const certPem = fs.readFileSync(p.cert, 'utf8');
			state.ca = {
				keyPem,
				certPem,
				keyObj: forge.pki.privateKeyFromPem(keyPem),
				certObj: forge.pki.certificateFromPem(certPem),
			};
			return state.ca;
		} catch (e) {
			log(`根证书读取失败（${e.message}），重新生成`);
		}
	}
	const { keyObj, certObj } = generateCa();
	state.ca = {
		keyPem: fs.readFileSync(p.key, 'utf8'),
		certPem: fs.readFileSync(p.cert, 'utf8'),
		keyObj,
		certObj,
	};
	return state.ca;
}

function caThumbprint() {
	ensureCa();
	const forge = require('node-forge');
	const der = forge.asn1.toDer(forge.pki.certificateToAsn1(state.ca.certObj)).getBytes();
	return crypto.createHash('sha1').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase();
}

/** 是否已安装进当前用户根证书库（certutil 查不到 exit 也是 0 且中文系统输出小写哈希，需忽略大小写比对） */
function isCaInstalled() {
	if (os.platform() !== 'win32') return false;
	const tp = caThumbprint();
	const r = spawnSync('certutil', ['-user', '-store', 'Root', tp], { encoding: 'utf8' });
	return r.status === 0 && (r.stdout || '').toLowerCase().includes(tp.toLowerCase());
}

/** 安装到当前用户根证书库（certutil -user，免管理员；Windows 会弹一次安全警告，需用户确认） */
function installCa() {
	if (os.platform() !== 'win32') return { ok: false, error: '目前仅支持 Windows' };
	ensureCa();
	if (isCaInstalled()) {
		log('根证书已在当前用户证书库中');
		return { ok: true, already: true };
	}
	const p = caPaths();
	const r = spawnSync('certutil', ['-user', '-addstore', 'Root', p.cert], { encoding: 'utf8' });
	if (r.status !== 0) {
		const msg = `${r.stdout || ''}${r.stderr || ''}`.trim();
		log(`根证书安装失败：${msg}`);
		return { ok: false, error: msg || 'certutil 失败' };
	}
	log('根证书已安装到当前用户证书库（如弹出安全警告请点「是」）');
	return { ok: true };
}

function uninstallCa() {
	if (os.platform() !== 'win32') return { ok: false, error: '目前仅支持 Windows' };
	if (!state.ca && !fs.existsSync(caPaths().cert)) return { ok: true };
	const tp = caThumbprint();
	const r = spawnSync('certutil', ['-user', '-delstore', 'Root', tp], { encoding: 'utf8' });
	if (r.status === 0) log('已从当前用户证书库移除 CCB 根证书');
	return { ok: r.status === 0 };
}

function siteCert(host) {
	const key = host.toLowerCase();
	if (state.certCache.has(key)) return state.certCache.get(key);
	const forge = require('node-forge');
	ensureCa();
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = require('crypto').randomBytes(16).toString('hex');
	cert.validity.notBefore = new Date(Date.now() - 86400000);
	cert.validity.notAfter = new Date();
	cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 2);
	cert.setSubject([{ name: 'commonName', value: host }]);
	cert.setIssuer(state.ca.certObj.subject.attributes);
	cert.setExtensions([
		{ name: 'basicConstraints', cA: false },
		{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
		{ name: 'extKeyUsage', serverAuth: true },
		{ name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
	]);
	cert.sign(state.ca.keyObj, forge.md.sha256.create());
	const out = {
		key: forge.pki.privateKeyToPem(keys.privateKey),
		cert: forge.pki.certificateToPem(cert),
	};
	state.certCache.set(key, out);
	return out;
}

/* ---------- 模型清单 ---------- */
function loadModels() {
	try {
		const p = path.join(state.dataDir, 'qoder-models.json');
		state.models = JSON.parse(fs.readFileSync(p, 'utf8'));
		log(`已加载 CCB 模型清单（${state.models.length} 个）`);
	} catch (e) {
		state.models = [];
		log(`模型清单读取失败：${e.message}`);
	}
}

/** 主进程在启动代理时下发最新模型清单：内存生效 + 落盘供独立运行使用 */
function setModels(models) {
	if (!Array.isArray(models)) return;
	const list = models.map((m) => String(m || '')).filter(Boolean);
	if (!list.length) return;
	state.models = list;
	try {
		fs.mkdirSync(state.dataDir, { recursive: true });
		fs.writeFileSync(path.join(state.dataDir, 'qoder-models.json'), JSON.stringify(list));
	} catch {}
}

/** 设置 CCB 中转站基址（注入到 ccb provider 的 base_url）；空值忽略。
 *  同时落盘 qoder-relay.json：detached runner 是独立进程，setRelayBaseUrl 只改
 *  本进程内存时它永远收不到（2026-10-01 实测：apply 传了本地 8788，runner 仍把
 *  sk-ccb 请求重定向到默认生产地址）。文件是唯一可靠的跨进程通道，与
 *  qoder-models.json 的模型清单同一模式。 */
function setRelayBaseUrl(url) {
	if (typeof url !== 'string' || !url) return;
	state.relayBaseUrl = url;
	try {
		fs.mkdirSync(state.dataDir, { recursive: true });
		const p = path.join(state.dataDir, 'qoder-relay.json');
		const want = JSON.stringify(url);
		/* 同值跳过写入：runner 的文件 watch 会因 setRelayBaseUrl 自身落盘而再次
		 * 触发，若不加保护会形成「写→watch→读→写」无限循环 */
		try { if (fs.readFileSync(p, 'utf8') === want) return; } catch {}
		fs.writeFileSync(p, want);
	} catch {}
}

/** 启动时读落盘的 relay 地址（runner / CCB 重启后恢复） */
function loadRelayBaseUrl() {
	try {
		const v = JSON.parse(fs.readFileSync(path.join(state.dataDir, 'qoder-relay.json'), 'utf8'));
		if (typeof v === 'string' && v) {
			state.relayBaseUrl = v;
			log(`已加载 relay 地址：${v}`);
		}
	} catch { /* 无文件：保持默认 */ }
}

/* ---------- BYOK 响应自适应注入 ---------- */
function cloneLocalizedText(v, zh, en) {
	if (v && typeof v === 'object') return { ...v, cn_zh: zh, en_us: en };
	if (typeof v === 'string') return zh;
	return { cn_zh: zh, en_us: en };
}

function buildProvider(templateProvider) {
	/* 以服务器返回的 provider 为模板克隆，保证字段形状一致。
	 * 实测真实 BYOK 配置（/algo/api/v2/byok/config）里 provider 形状为：
	 *   { key, enabled, source:'predefined', fields:[{key:'api_key',...}],
	 *     types:[{ key:'pg', models:[...], display_name }], display_name, api_key_url }
	 * 模型嵌在 types[].models 下，provider 顶层没有 models，且没有任何 provider 带 base_url
	 * （端点由 Go 客户端按 provider key 硬编码解析）。 */
	const tpl = templateProvider && typeof templateProvider === 'object' ? templateProvider : {};
	const prov = JSON.parse(JSON.stringify(tpl));
	/* v4：provider key 用 'custom'（Qoder 官方「自定义服务商」语义）。实证依据：
	 * 1) QoderWork worker 的模型解析 Zxn(provider, url) 只对空/'custom' 透传条目 url，
	 *    其它 provider 一律丢弃 url（Qoder CN worker 侧 2026-10-01 实测）；
	 * 2) v3 挂 deepseek 的模型实测被网关按 DeepSeek 官方端点鉴权——sk-ccb 对
	 *    DeepSeek 无效 → 网关返回「自定义模型认证失败」（请求体 CosyClient 加密，
	 *    MITM 无法改写）。'custom' 是让端点透传到我们中转的唯一通路。 */
	prov.key = 'custom';
	if ('id' in prov && typeof prov.id !== 'object') prov.id = 'custom';
	if ('name' in prov) prov.name = 'custom';
	if ('display_name' in prov) prov.display_name = cloneLocalizedText(tpl.display_name, 'CCB 中转', 'CCB Relay');
	if ('displayName' in prov) prov.displayName = 'CCB 中转';
	/* source='custom'：预定义 provider 都是 'predefined'，客户端对 custom 源大概率会读
	 * base_url 而不是查硬编码端点表——这是我们注入 base_url 能被尊重的前提假设。 */
	if ('source' in prov) prov.source = 'custom';
	else prov.source = 'custom';
	if ('enabled' in prov) prov.enabled = true;
	if ('enable' in prov) prov.enable = true;
	/* 端点字段：模板里有哪个就改哪个；都没有则补 base_url（custom 源的推理端点） */
	const relay = state.relayBaseUrl || RELAY_BASE_URL;
	const urlFields = ['base_url', 'baseUrl', 'api_base_url', 'apiBaseUrl', 'endpoint', 'url', 'host', 'baseURL'];
	let touched = false;
	for (const f of urlFields) {
		if (f in prov && typeof prov[f] === 'string') { prov[f] = relay; touched = true; }
	}
	if (!touched) prov.base_url = relay;
	/* 顶层 models 是早期实现的错误产物，真实 schema 没有，删掉避免干扰 */
	delete prov.models;

	/* 模型模板：优先取模板 provider 的 types[0].models[0]（真实模型条目，含
	 * available_context_tokens / available_reasoning_effort 等客户端会读的字段） */
	const tplType = (Array.isArray(tpl.types) && tpl.types[0]) || null;
	const modelTpl = (tplType && Array.isArray(tplType.models) && tplType.models[0]) || {};
	const buildModels = () => state.models.map((name) => {
		const m = JSON.parse(JSON.stringify(modelTpl));
		m.key = name;
		if ('id' in m) m.id = name;
		if ('name' in m) m.name = name;
		if ('model' in m) m.model = name;
		if ('display_name' in m) m.display_name = cloneLocalizedText(modelTpl.display_name, `CCB ${name}`, `CCB ${name}`);
		if ('displayName' in m) m.displayName = `CCB ${name}`;
		if ('enabled' in m) m.enabled = true;
		if ('enable' in m) m.enable = true;
		return m;
	});

	/* types：单条目，key 固定 'pg'（与 vscdb 里 CCB 条目的 byokTypeKey='pg' 对齐），
	 * 形状克隆模板的 types[0]，但 models 换成我们的 CCB 模型清单。 */
	if (tplType) {
		const t = JSON.parse(JSON.stringify(tplType));
		t.key = 'pg';
		t.models = buildModels();
		prov.types = [t];
	} else {
		prov.types = [{ key: 'pg', display_name: cloneLocalizedText(null, '按量付费', 'Pay-as-you-go'), models: buildModels() }];
	}
	return prov;
}

/* v4：注入一个自定义 provider（key='custom'，source='custom'，带 base_url 指向 CCB 中转），
 * CCB 模型挂它的 types[0].models 下。v3 挂 deepseek 已实证失败：网关按 DeepSeek 官方
 * 端点鉴权 sk-ccb →「自定义模型认证失败」（请求体 CosyClient 加密，MITM 改不了）。
 * 'custom' 是 Qoder 官方的「自定义服务商」通道（QoderWork worker 同语义：只对
 * 空/'custom' 透传条目 url），端点由 base_url / 条目 url 决定 → 指向我们的中转。 */
function injectByokConfig(bodyText) {
	let json;
	try { json = JSON.parse(bodyText); } catch { return { ok: false, reason: '响应非 JSON' }; }
	if (!json || !Array.isArray(json.providers)) return { ok: false, reason: '缺少 providers 数组' };
	/* 顶层 enabled 必须显式为 true：请求经 Go 语言客户端中转（CALL_METHOD_ON_LANGUAGE_CLIENT），
	 * Go 的 encoding/json 把缺失的 bool 字段解析为 false → 渲染层 _applyByokRemoteEnabledFromResponse
	 * 读到 enabled=false → byokRemoteEnabled=false → 自定义模型 account_disabled 被过滤。
	 * 真实响应本就没有顶层 enabled 字段，无条件补 true（2026-10-01 实测修复）。 */
	json.enabled = true;
	if (!state.models.length) return { ok: false, reason: '模型清单为空' };
	/* 清理 v3 残留：曾把 CCB 模型注入 deepseek provider 的 types[].models（display_name
	 * 带 'CCB ' 前缀识别），全部摘除，避免 UI 里同一模型出现「按量付费|DeepSeek」形态。 */
	for (const p of json.providers) {
		if (!p || !Array.isArray(p.types) || p.key === 'custom') continue;
		for (const t of p.types) {
			if (!Array.isArray(t.models)) continue;
			t.models = t.models.filter((m) => {
				const dn = m && (m.displayName || (m.display_name && (m.display_name.cn_zh || m.display_name.en_us)));
				return !(typeof dn === 'string' && dn.startsWith('CCB '));
			});
		}
	}
	/* 注入/替换我们的 custom provider（模板取任意预定义 provider，保证字段形状一致） */
	const tpl = json.providers.find((p) => p && Array.isArray(p.types) && p.types.length);
	const ours = buildProvider(tpl);
	const existing = json.providers.find((p) => p && p.key === 'custom');
	if (existing) json.providers = json.providers.filter((p) => p !== existing);
	json.providers.push(ours);
	return { ok: true, body: JSON.stringify(json), added: state.models.length };
}

/* ---------- 上游请求（identity 编码，便于改写） ---------- */
function fetchUpstream(req, bodyChunks, cb) {
	const host = (req.headers.host || MITM_HOST).split(':')[0];
	const options = {
		host,
		port: 443,
		method: req.method,
		path: req.url,
		headers: { ...req.headers, host, 'accept-encoding': 'identity' },
	};
	delete options.headers['proxy-authorization'];
	delete options.headers['content-length'];
	if (bodyChunks && bodyChunks.length) {
		const len = bodyChunks.reduce((n, c) => n + c.length, 0);
		options.headers['content-length'] = len;
	}
	const up = https.request(options, (upRes) => {
		const chunks = [];
		upRes.on('data', (c) => chunks.push(c));
		upRes.on('end', () => cb(null, upRes, Buffer.concat(chunks)));
	});
	up.on('error', (e) => cb(e));
	up.setTimeout(30000, () => up.destroy(new Error('上游超时')));
	for (const c of bodyChunks || []) up.write(c);
	up.end();
}

/** 流式原样转发到真实上游（不缓冲响应；SSE 等长连接接口必须走这条，否则挂死） */
function forwardUpstream(req, res, bodyChunks) {
	const host = String(req.headers.host || MITM_HOST).split(':')[0];
	const headers = { ...req.headers, host };
	delete headers['proxy-authorization'];
	delete headers['content-length'];
	const body = Buffer.concat(bodyChunks || []);
	if (body.length) headers['content-length'] = body.length;
	const up = https.request(
		{ host, port: 443, method: req.method, path: req.url, headers, servername: host },
		(upRes) => {
			res.writeHead(upRes.statusCode || 502, upRes.headers);
			/* 临时诊断（用完删除）：dump agent_chat_generation 响应抓网关错误详情 */
			if (/agent_chat_generation/.test(req.url || '')) {
				let buf = '';
				const keep = (c) => { buf += c.toString('utf8'); };
				upRes.on('data', keep);
				upRes.on('end', () => {
					try {
						fs.appendFileSync(path.join(state.dataDir, 'qoder-agentchat-dump.txt'),
							`\n===== ${new Date().toISOString()} ${req.method} ${req.url}\nstatus=${upRes.statusCode}\n${buf.slice(0, 6000)}\n`);
					} catch {}
				});
			}
			upRes.pipe(res);
		},
	);
	up.on('error', (e) => {
		log(`上游转发失败：${e.message}`);
		try { res.destroy(); } catch {}
	});
	up.setTimeout(300000, () => up.destroy(new Error('上游转发超时（5 分钟）')));
	if (body.length) up.write(body);
	up.end();
}

/* ---------- 中转重定向（v2：让 BYOK 推理请求直达 CCB 中转站） ----------
 * 机制：Qoder CN IDE 1.32 的 Go 客户端把 BYOK 推理请求发给 Qoder 网关（provider 端点
 * 由服务端下发，base_url 被丢弃）。但请求会携带用户配置的 apiKey（我们的 sk-ccb-*）。
 * 因此凡是带 CCB 平台密钥的请求都是我们的——直接改写到 CCB 中转站（OpenAI 兼容），
 * 不再经过 Qoder 网关。SSE 流式响应原样透传。 */

function relayHostFromUrl(u) {
	try { return new URL(u).host; } catch { return 'code.btluo.com'; }
}

/** 请求里是否携带我们的平台密钥（Bearer 头或常见 key 头） */
function findOurKey(headers) {
	const h = headers || {};
	const authz = String(h.authorization || '');
	const m = /^(?:Bearer|token)\s+(sk-ccb-[A-Za-z0-9_-]+)$/i.exec(authz);
	if (m) return m[1];
	for (const k of ['x-api-key', 'api-key', 'x-goog-api-key']) {
		const v = String(h[k] || '');
		if (/^sk-ccb-/.test(v)) return v;
	}
	return null;
}

/** 把路径改写成中转站的 OpenAI 兼容端点后缀（不含 /v1 前缀，由 relayBaseUrl 带上） */
function relayPathSuffix(origPath, method) {
	const p = String(origPath || '');
	if (/\/chat\/completions\/?$/.test(p)) return '/chat/completions';
	if (/\/models\/?$/.test(p)) return '/models';
	if (/\/embeddings\/?$/.test(p)) return '/embeddings';
	/* POST 默认按聊天补全处理（BYOK 模型的主用途）；GET 且未知路径给模型列表 */
	return method === 'GET' ? '/models' : '/chat/completions';
}

/** 流式转发到中转站（SSE 直通，不缓冲） */
function redirectRelay(req, res, bodyChunks) {
	const relay = state.relayBaseUrl || RELAY_BASE_URL;
	let target;
	try { target = new URL(relay); } catch {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end('CCB proxy: invalid relay url');
		return;
	}
	const key = findOurKey(req.headers);
	const origHost = req.headers.host || '';
	/* 目标路径 = relayBaseUrl 的路径前缀（形如 /v1）+ 端点后缀；
	 * relayBaseUrl 若不带路径前缀（如 https://code.btluo.com），则补 /v1 */
	const basePath = target.pathname.replace(/\/+$/, '');
	const prefix = basePath || '/v1';
	const fullPath = prefix + relayPathSuffix(req.url, req.method);
	const headers = { ...req.headers };
	headers.host = target.host;
	headers['accept-encoding'] = 'identity';
	delete headers['proxy-authorization'];
	delete headers['content-length'];
	/* 清掉 Qoder 网关的签名/路由头，避免中转站（Cloudflare/WAF）误判 */
	for (const k of Object.keys(headers)) {
		if (/^(cosy-|x-qoder|x-tongyi|sign|signature)/i.test(k)) delete headers[k];
	}
	const body = Buffer.concat(bodyChunks || []);
	if (body.length) headers['content-length'] = body.length;

	log(`中转重定向：${req.method} https://${origHost}${req.url} → https://${target.host}${fullPath}`);
	state.stats.relayed++;
	const up = https.request(
		{ host: target.hostname, port: target.port || 443, method: req.method, path: fullPath, headers, servername: target.hostname },
		(upRes) => {
			const outHeaders = { ...upRes.headers };
			delete outHeaders['content-encoding'];
			delete outHeaders['content-length'];
			delete outHeaders['transfer-encoding'];
			res.writeHead(upRes.statusCode || 502, outHeaders);
			upRes.pipe(res);
		},
	);
	up.on('error', (e) => {
		log(`中转请求失败：${e.message}`);
		try {
			res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(`CCB proxy relay error: ${e.message}`);
		} catch {}
	});
	up.setTimeout(300000, () => up.destroy(new Error('中转请求超时（5 分钟）')));
	if (body.length) up.write(body);
	up.end();
}


/* ---------- MITM 请求处理 ---------- */
function handleRequest(req, res, bodyChunks) {
	log(`MITM 请求：${req.method} https://${req.headers.host || MITM_HOST}${req.url}`);
	/* 1) 带 CCB 平台密钥的请求 → 直接重定向到中转站（v2 核心通道） */
	if (findOurKey(req.headers)) {
		redirectRelay(req, res, bodyChunks);
		return;
	}
	/* 2) 观察通道：请求体疑似携带我们的密钥/模型名的 POST 也 dump 下来，
	 *    用于确认 Go 客户端的实际请求格式（密钥可能不在 Authorization 头）。 */
	const reqHost = String(req.headers.host || '').toLowerCase();
	if (req.method === 'POST' && bodyChunks && bodyChunks.length) {
		const head = Buffer.concat(bodyChunks.slice(0, 8)).toString('latin1');
		if (head.includes('sk-ccb-')) {
			log('发现请求体携带 CCB 密钥但未走 Bearer 头，已 dump（待适配）');
			try {
				fs.writeFileSync(path.join(state.dataDir, `qoder-keyed-req-${Date.now()}.txt`),
					`POST https://${req.headers.host}${req.url}\nheaders: ${JSON.stringify(req.headers, null, 2)}\n\n` +
					Buffer.concat(bodyChunks).toString('utf8').slice(0, 200000));
			} catch {}
		}
		/* 模型名侦测：请求体精确出现 "model":"<我们的模型名>" 时记录（判定推理走向） */
		const hit = state.models.find((n) => head.includes(`"model":"${n}"`) || head.includes(`"model": "${n}"`));
		if (hit) log(`★ 请求体出现我们的模型名 ${hit}（${req.method} https://${reqHost}${req.url}）`);
	}
	/* 3) api.deepseek.com 到达但未携带 CCB 密钥：说明 key 没随请求发出（或用户配了真实
	 *    deepseek key），原样透传到真实 DeepSeek 并记录，便于区分「路由成功但缺 key」。 */
	if (reqHost === 'api.deepseek.com') {
		log(`到达 api.deepseek.com 但未携带 CCB 密钥（${req.method} ${req.url}），透传真实 DeepSeek`);
	}
	/* 3.5) user/status 注入：渲染层按 allow_byok + isQuotaExceeded 推导 BYOK 全局 enabled。
	 *      Free 账号 allow_byok=2 / isQuotaExceeded=true → enabled=false → 本地 agent 不走
	 *      客户端 BYOK 直连 provider，回退网关 cosy 信封 → 网关不认我们的模型 → 10408。
	 *      强制改成「已启用」让 agent 走 client-side BYOK → 命中 api.deepseek.com MITM → 中转。 */
	if (/\/api\/v3\/user\/status(?:\?|$)/.test(req.url || '') || /\/algo\/api\/v2\/user\/plan(?:\?|$)/.test(req.url || '')) {
		fetchUpstream(req, bodyChunks, (err, upRes, body) => {
			if (err) { res.destroy(); return; }
			let out = body;
			/* 排障：落盘最新的 user/status|plan 原始响应，确认 allow_byok 字段位置 */
			try {
				fs.writeFileSync(path.join(state.dataDir, 'qoder-user-resp-dump.txt'),
					`${req.method} ${req.url}\nHTTP ${upRes.statusCode}\n\n${body.toString('utf8').slice(0, 8000)}`);
			} catch {}
			try {
				const j = JSON.parse(body.toString('utf8'));
				let changed = false;
				if (j && j.featureSwitches && j.featureSwitches.allow_byok !== undefined && j.featureSwitches.allow_byok !== 1) {
					j.featureSwitches.allow_byok = 1; changed = true;
				}
				if (j && 'isQuotaExceeded' in j && j.isQuotaExceeded === true) { j.isQuotaExceeded = false; changed = true; }
				if (changed) {
					out = Buffer.from(JSON.stringify(j), 'utf8');
					log(`已注入 user/status：allow_byok=1, isQuotaExceeded=false（解锁 BYOK 全局开关）`);
				}
			} catch {}
			const headers = { ...upRes.headers };
			delete headers['content-encoding'];
			delete headers['content-length'];
			delete headers['transfer-encoding'];
			headers['content-length'] = out.length;
			res.writeHead(upRes.statusCode || 502, headers);
			res.end(out);
		});
		return;
	}
	if (BYOK_PATH_RE.test(req.url || '')) {
		state.stats.intercepted++;
		log(`命中 BYOK 配置接口：${req.method} ${req.url}`);
		fetchUpstream(req, bodyChunks, (err, upRes, body) => {
			if (err) {
				log(`BYOK 上游请求失败：${err.message}`);
				res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('CCB proxy upstream error');
				return;
			}
			const text = body.toString('utf8');
			/* dump 原始响应（首次）供排障 */
			if (!state.dumpDone) {
				state.dumpDone = true;
				try {
					fs.writeFileSync(path.join(state.dataDir, 'qoder-byok-dump.json'),
						`HTTP ${upRes.statusCode}\nheaders: ${JSON.stringify(upRes.headers, null, 2)}\n\n${text}`);
					log(`已 dump 原始 BYOK 配置到 ${path.join(state.dataDir, 'qoder-byok-dump.json')}`);
				} catch {}
			}
			if (upRes.statusCode !== 200) {
				log(`BYOK 上游返回 HTTP ${upRes.statusCode}，原样透传`);
				const headers = { ...upRes.headers };
				delete headers['content-encoding'];
				headers['content-length'] = body.length;
				res.writeHead(upRes.statusCode, headers);
				res.end(body);
				return;
			}
			const injected = injectByokConfig(text);
			if (!injected.ok) {
				log(`BYOK 注入失败（${injected.reason}），原样透传`);
				const headers = { ...upRes.headers };
				delete headers['content-encoding'];
				headers['content-length'] = body.length;
				res.writeHead(200, headers);
				res.end(body);
				return;
			}
		if (injected.already) log('BYOK 配置已包含我们的模型，无需注入');
		else {
			state.stats.injected++;
			log(`已注入 CCB 自定义 provider（custom，${injected.added || state.models.length} 个模型 → ${state.relayBaseUrl || RELAY_BASE_URL}）`);
		}
			const out = Buffer.from(injected.body, 'utf8');
			const headers = { ...upRes.headers };
			delete headers['content-encoding'];
			headers['content-type'] = 'application/json';
			headers['content-length'] = out.length;
			res.writeHead(200, headers);
			res.end(out);
		});
		return;
	}
	/* 排障：dump login/identity 响应（定位 IDE 侧 allowByok 的真实来源） */
	if (/\/api\/v3\/user\/login/.test(req.url || '') || /\/api\/v2\/service\/migration\/identity/.test(req.url || '')) {
		fetchUpstream(req, bodyChunks, (err, upRes, body) => {
			if (err) { res.destroy(); return; }
			try {
				fs.writeFileSync(path.join(state.dataDir, 'qoder-login-dump.txt'),
					`${req.method} ${req.url}\nHTTP ${upRes.statusCode}\n\n${body.toString('utf8').slice(0, 8000)}`);
			} catch {}
			const headers = { ...upRes.headers };
			delete headers['content-encoding'];
			delete headers['content-length'];
			delete headers['transfer-encoding'];
			headers['content-length'] = body.length;
			res.writeHead(upRes.statusCode || 502, headers);
			res.end(body);
		});
		return;
	}
	/* 其它路径：流式原样透传（fetchUpstream 会收完整响应，对 SSE（agent_chat_generation
	 * 等流式接口）永不结束 → 挂死 → 客户端整流重试；曾因此每条消息重试 4 次报
	 * 「连接失败」。必须用 pipe 直通（与 redirectRelay 同理）。 */
	forwardUpstream(req, res, bodyChunks);
}

function handlePlainRequest() {
	return (req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => handleRequest(req, res, chunks));
		req.on('error', () => res.destroy());
	};
}

function mitmSocket(clientSocket, host, port) {
	const { key, cert } = siteCert(host);
	const ctx = tls.createSecureContext({ key, cert });
	const secure = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: ctx });
	secure.on('error', (e) => {
		log(`TLS 终结失败 ${host}：${e.message}`);
		clientSocket.destroy();
	});
	const srv = new http.Server();
	srv.on('request', handlePlainRequest());
	srv.on('error', () => {});
	srv.emit('connection', secure);
}

function tunnel(clientSocket, host, port) {
	state.stats.tunneled++;
	log(`隧道透传：${host}:${port || 443}`);
	const upstream = net.connect(port || 443, host, () => {
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.on('error', () => clientSocket.destroy());
	clientSocket.on('error', () => upstream.destroy());
}

function onProxyConnection(socket) {
	const peer = `${socket.remoteAddress}:${socket.remotePort}`;
	log(`socket 已连接：${peer}`);
	let gotBytes = 0;
	socket.on('data', () => {});
	socket.once('data', (head) => {
		gotBytes = head.length;
		socket.pause();
		const line = head.toString('latin1', 0, head.indexOf('\r\n'));
		log(`收到连接首行：${line}`);
		log(`首包 hex（前 64B）：${head.slice(0, 64).toString('hex')}`);
		const m = /^CONNECT\s+([^\s:]+)(?::(\d+))?\s+HTTP/i.exec(line);
		if (m) {
			const host = m[1];
			const port = Number(m[2]) || 443;
			if (shouldMitm(host)) {
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				mitmSocket(socket, host, port);
			} else {
				tunnel(socket, host, port);
			}
			return;
		}
		log(`非 CONNECT 首包，直接断开（协议不识别）`);
		socket.destroy();
	});
	socket.on('close', () => log(`socket 关闭：${peer}（收到 ${gotBytes} 字节）`));
	socket.on('error', () => socket.destroy());
}

function start(opts = {}) {
	if (state.server) {
		/* 已在运行也允许刷新模型清单与中转地址（一键配置后热更新；
		 * relay 走 setRelayBaseUrl 落盘，detached runner 靠文件 watch 同步） */
		if (opts.models) setModels(opts.models);
		if (opts.relayBaseUrl) setRelayBaseUrl(String(opts.relayBaseUrl));
		return Promise.resolve({ ok: true, already: true, port: state.port });
	}
	if (opts.log) state.log = opts.log;
	if (opts.dataDir) state.dataDir = opts.dataDir;
	if (opts.relayBaseUrl) state.relayBaseUrl = String(opts.relayBaseUrl);
	state.port = opts.port || DEFAULT_PORT;
	ensureCa();
	if (opts.models) setModels(opts.models);
	else loadModels();
	/* 落盘的 relay 地址优先于内置默认（runner 重启后恢复上次配置的中转地址） */
	loadRelayBaseUrl();
	state.server = net.createServer(onProxyConnection);
	return new Promise((resolve) => {
		state.server.on('error', (e) => {
			log(`代理监听失败（端口 ${state.port}）：${e.message}`);
			state.server = null;
			resolve({ ok: false, error: e.message });
		});
		state.server.listen(state.port, '127.0.0.1', () => {
			log(`CCB Qoder 代理已启动：http://127.0.0.1:${state.port}（MITM: ${MITM_HOST} → ${state.relayBaseUrl}）`);
			resolve({ ok: true, port: state.port });
		});
	});
}

function stop() {
	if (!state.server) return { ok: true };
	try { state.server.close(); } catch {}
	state.server = null;
	return { ok: true };
}

function status() {
	let caInstalled = false;
	try {
		caInstalled = isCaInstalled();
	} catch {}
	return { running: !!state.server, port: state.port, caInstalled, models: state.models.length, stats: { ...state.stats } };
}

function init(opts = {}) {
	if (opts.dataDir) state.dataDir = opts.dataDir;
	if (opts.log) state.log = opts.log;
	if (opts.relayBaseUrl) state.relayBaseUrl = String(opts.relayBaseUrl);
}

module.exports = {
	init,
	start,
	stop,
	status,
	installCa,
	uninstallCa,
	isCaInstalled,
	injectByokConfig,
	buildProvider,
	setModels,
	setRelayBaseUrl,
	DEFAULT_PORT,
	RELAY_BASE_URL,
};
