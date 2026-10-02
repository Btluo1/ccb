/* Cursor MITM 本地代理（模仿 cursor-agent 的 proxy_ca 模块）
 *
 * 原理（逆向自 cursor-agent 4.0.15，详见 docs/cursor-agent-research.md）：
 * Cursor 的后端流量全部走 HTTPS 到 *.cursor.sh（Connect RPC，application/proto）。
 * 通过在 settings.json 写入 http.proxy=http://127.0.0.1:9182 + http.proxySupport=override
 * + cursor.general.disableHttp2=true，把流量导入本代理；本代理用自签根 CA（安装进
 * 当前用户根证书库）对 *.cursor.sh 做 TLS 终结，按 Connect 协议处理请求：
 *   - 我们能实现的端点（ChatService/SSE、AiService/AvailableModels 等）→ 转发 CCB 中转
 *   - 其余端点 → 原样转发真实后端（保持登录、更新等链路不断），响应体一律不改写
 *   - 非白名单域名 → 纯 TCP 隧道，不解密
 *
 * 合规说明：仅代理用户本机 Cursor 到自己选择的中转服务。不做机器码篡改、账号池，
 * 也不改写订阅/额度类响应（那属于向客户端谎报账号状态，cursor-agent 本身也没做）。
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_PORT = 9182;

/* 只有这些域名做 TLS 终结（Cursor 后端 API）；其余一律隧道透传 */
const MITM_HOST_RE = /(^|\.)cursor\.sh$/i;

/* ---------- 状态 ---------- */
const state = {
	server: null,
	port: DEFAULT_PORT,
	dataDir: null,
	ca: null /* { keyPem, certPem, certDer, thumbprint, keyObj, certObj } */,
	certCache: new Map() /* host -> { key, cert } */,
	log: () => {},
	upstream: null /* { baseUrl, apiKey, models, defaultModel } */,
	handlers: new Map() /* connect 全路径 -> async handler(ctx) */,
	stats: { intercepted: 0, tunneled: 0, passthrough: 0 },
};

function log(msg) {
	try {
		state.log(msg);
	} catch {}
}

/* ---------- 根 CA 管理（node-forge 纯 JS，免管理员，写当前用户证书库） ---------- */
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
		{ name: 'commonName', value: 'CCB Local Proxy CA' },
		{ name: 'organizationName', value: 'CCB' },
	];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
		{ name: 'subjectKeyIdentifier' },
	]);
	cert.sign(keys.privateKey, forge.md.sha256.create());
	return {
		keyPem: forge.pki.privateKeyToPem(keys.privateKey),
		certPem: forge.pki.certificateToPem(cert),
		keyObj: keys.privateKey,
		certObj: cert,
	};
}

/** 确保证书存在（从磁盘加载或重新生成） */
function ensureCa(logFn) {
	if (logFn) state.log = logFn;
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
	state.ca = generateCa();
	fs.writeFileSync(p.key, state.ca.keyPem, { mode: 0o600 });
	fs.writeFileSync(p.cert, state.ca.certPem);
	log(`根证书已保存到 ${p.dir}`);
	return state.ca;
}

function caThumbprint() {
	ensureCa();
	const forge = require('node-forge');
	const der = forge.asn1.toDer(forge.pki.certificateToAsn1(state.ca.certObj)).getBytes();
	return crypto.createHash('sha1').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase();
}

/** 是否已安装进当前用户根证书库
 * 注意两点 certutil 行为：查不到目标哈希时 exit code 仍是 0（还会顺带列出库里
 * 其它证书），所以必须比对哈希字符串本身；且中文系统输出的是小写哈希，
 * 比对需忽略大小写（否则装了也永远显示未安装）。 */
function isCaInstalled() {
	if (os.platform() !== 'win32') return false;
	const tp = caThumbprint();
	const r = spawnSync('certutil', ['-user', '-store', 'Root', tp], { encoding: 'utf8' });
	return r.status === 0 && (r.stdout || '').toLowerCase().includes(tp.toLowerCase());
}

/** 安装到当前用户根证书库（certutil -user，免管理员；Windows 会弹一次安全警告，需用户确认） */
function installCa(logFn) {
	if (logFn) state.log = logFn;
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

function uninstallCa(logFn) {
	if (logFn) state.log = logFn;
	if (os.platform() !== 'win32') return { ok: false, error: '目前仅支持 Windows' };
	if (!state.ca && !fs.existsSync(caPaths().cert)) return { ok: true };
	const tp = caThumbprint();
	const r = spawnSync('certutil', ['-user', '-delstore', 'Root', tp], { encoding: 'utf8' });
	if (r.status === 0) log('已从当前用户证书库移除 CCB 根证书');
	return { ok: r.status === 0 };
}

/* ---------- 按域名动态签发站点证书 ---------- */
function siteCert(host) {
	const key = host.toLowerCase();
	if (state.certCache.has(key)) return state.certCache.get(key);
	const forge = require('node-forge');
	ensureCa();
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = crypto.randomBytes(16).toString('hex');
	cert.validity.notBefore = new Date(Date.now() - 86400000);
	cert.validity.notAfter = new Date();
	cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 2);
	cert.setSubject([{ name: 'commonName', value: key }]);
	cert.setIssuer(state.ca.certObj.subject.attributes);
	cert.setExtensions([
		{ name: 'basicConstraints', cA: false, critical: true },
		{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
		{ name: 'extKeyUsage', serverAuth: true },
		{ name: 'subjectAltName', altNames: [{ type: 2, value: key }] },
	]);
	cert.sign(state.ca.keyObj, forge.md.sha256.create());
	const entry = {
		key: forge.pki.privateKeyToPem(keys.privateKey),
		cert: forge.pki.certificateToPem(cert),
	};
	state.certCache.set(key, entry);
	return entry;
}

/* ---------- Connect 协议帧编解码 ----------
 * 流式（application/connect+proto）：每帧 = 1 字节标志 + 4 字节大端长度 + 载荷。
 * 标志 bit0=压缩(gzip)，bit1=EndStreamResponse（载荷为 JSON：{} 或 {"error":{...}}）。
 * 高位为保留位——写成 0x80 会让 Cursor 认不出流结束，把正常完成当异常整流重试。 */
function encodeFrame(payload, { endStream = false, compress = false } = {}) {
	let flags = endStream ? 0x02 : 0;
	let body = payload;
	if (compress && !endStream) {
		body = zlib.gzipSync(payload);
		flags |= 1;
	}
	const head = Buffer.alloc(5);
	head[0] = flags;
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

/** 流式解析器：喂 chunk，吐 { endStream, data(已解压) } */
function frameParser(onFrame) {
	let buf = Buffer.alloc(0);
	return (chunk) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		for (;;) {
			if (buf.length < 5) return;
			const flags = buf[0];
			const len = buf.readUInt32BE(1);
			if (buf.length < 5 + len) return;
			let data = buf.subarray(5, 5 + len);
			buf = buf.subarray(5 + len);
			if (flags & 1) {
				try {
					data = zlib.gunzipSync(data);
				} catch {}
			}
			onFrame({ endStream: !!(flags & 0x02), data });
			if (flags & 0x02) buf = Buffer.alloc(0);
		}
	};
}

function connectError(res, code, message) {
	/* Connect 流式错误：EndStream 帧里带 error 对象 */
	const frame = encodeFrame(Buffer.from(JSON.stringify({ error: { code, message } })), {
		endStream: true,
	});
	res.writeHead(200, {
		'Content-Type': 'application/connect+proto',
		'Connect-Protocol-Version': '1',
	});
	res.end(frame);
}

/* ---------- 转发到真实后端（未接管的端点走这里，保持登录/更新链路） ----------
 * 一律原样透传，不缓存、不改写响应体：登录、账号、订阅、更新等链路拿到的
 * 必须是 Cursor 服务端的原始应答。 */
function passthrough(host, port, req, res, bodyChunks) {
	const options = {
		host,
		port: port || 443,
		method: req.method,
		path: req.url,
		headers: { ...req.headers, host },
	};
	delete options.headers['proxy-authorization'];
	const up = https.request(options, (upRes) => {
		res.writeHead(upRes.statusCode || 502, upRes.headers);
		upRes.pipe(res);
	});
	up.on('error', (e) => {
		state.stats.passthrough++;
		log(`转发真实后端失败 ${host}${req.url}：${e.message}`);
		if (!res.headersSent) res.writeHead(502);
		res.end();
	});
	for (const c of bodyChunks) up.write(c);
	up.end();
	state.stats.passthrough++;
}

/* ---------- 请求路由 ---------- */
const router = {
	/** 返回 true 表示已接管 */
	async handle(host, req, res, bodyChunks) {
		const u = new URL(req.url, `https://${host}`);
		const handler = state.handlers.get(u.pathname);
		if (handler) {
			state.stats.intercepted++;
			log(`▶ 接管 ${host}${u.pathname}`);
			const ctx = {
				host,
				path: u.pathname,
				req,
				res,
				frames: [],
				upstream: state.upstream,
				log,
				encodeFrame,
				connectError,
			};
			/* 流式请求体按帧解析收集 */
			const frames = [];
			const parse = frameParser((f) => frames.push(f));
			for (const c of bodyChunks) parse(c);
			ctx.frames = frames;
			ctx.rawBody = Buffer.concat(bodyChunks);
			/* unary 请求可能带 HTTP 级 gzip（Content-Encoding），先解压再交给端点解码 */
			const ce = String(req.headers['content-encoding'] || '').toLowerCase();
			if (ce.includes('gzip') && ctx.rawBody.length > 2 && ctx.rawBody[0] === 0x1f && ctx.rawBody[1] === 0x8b) {
				try {
					ctx.rawBody = zlib.gunzipSync(ctx.rawBody);
				} catch (e) {
					log(`gzip 解压失败 ${u.pathname}：${e.message}`);
				}
			}
			try {
				await handler(ctx);
			} catch (e) {
				log(`端点处理异常 ${u.pathname}：${e.message}`);
				if (!res.headersSent) connectError(res, 'internal', String(e.message || e));
				else res.end();
			}
			return true;
		}
		return false;
	},
};

/* ---------- MITM 主流程 ---------- */
function handlePlainRequest(host, port) {
	return (req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const taken = await router.handle(host, req, res, chunks);
			if (!taken) {
				log(`↪ 转发 ${host}${req.url}`);
				passthrough(host, port, req, res, chunks);
			}
		});
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
	/* 复用一个临时 http.Server 解析 HTTP/1.1（settings 里已禁用 HTTP/2） */
	const srv = new http.Server();
	srv.on('request', handlePlainRequest(host, port));
	srv.on('error', () => {});
	srv.emit('connection', secure);
}

function tunnel(clientSocket, host, port) {
	state.stats.tunneled++;
	const upstream = net.connect(port || 443, host, () => {
		clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.on('error', () => clientSocket.destroy());
	clientSocket.on('error', () => upstream.destroy());
}

function onProxyConnection(socket) {
	socket.once('data', (head) => {
		socket.pause();
		const line = head.toString('latin1', 0, head.indexOf('\r\n'));
		const m = /^CONNECT\s+([^\s:]+)(?::(\d+))?\s+HTTP/i.exec(line);
		if (m) {
			const host = m[1];
			const port = Number(m[2]) || 443;
			if (MITM_HOST_RE.test(host)) {
				/* 先回 200 再做 TLS 终结 */
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				mitmSocket(socket, host, port);
			} else {
				/* 隧道：把已读到的 CONNECT 头消费掉，直连目标 */
				tunnel(socket, host, port);
			}
			return;
		}
		/* 非 CONNECT 的明文代理请求（http:// 绝对 URI） */
		const m2 = /^[A-Z]+\s+http:\/\/([^\/\s]+)(\/\S*)?\s+HTTP/i.exec(line);
		if (m2) {
			const hostPort = m2[1].split(':');
			const srv = new http.Server();
			srv.on('request', handlePlainRequest(hostPort[0], Number(hostPort[1]) || 80));
			srv.on('error', () => {});
			socket.unshift(head);
			srv.emit('connection', socket);
			return;
		}
		socket.destroy();
	});
	socket.on('error', () => socket.destroy());
}

/* ---------- 生命周期 ---------- */
function start(opts = {}) {
	/* 已在运行也允许刷新上游（换账号/换密钥后重新写入配置需热更新，
	 * 否则代理继续用旧密钥打旧地址，直到手动停止才生效） */
	if (opts.upstream) state.upstream = opts.upstream;
	if (state.server) return { ok: true, already: true, port: state.port };
	if (opts.log) state.log = opts.log;
	state.dataDir = opts.dataDir || state.dataDir || path.join(os.homedir(), '.ccb');
	state.port = opts.port || state.port || DEFAULT_PORT;
	ensureCa();

	/* 注册协议端点（懒加载，避免循环依赖） */
	require('./cursorproxy-endpoints').register(state.handlers, {
		encodeFrame,
		connectError,
		frameParser,
		log,
	});

	state.server = net.createServer(onProxyConnection);
	state.server.on('error', (e) => {
		log(`代理监听失败（端口 ${state.port}）：${e.message}`);
		state.server = null;
	});
	return new Promise((resolve) => {
		state.server.listen(state.port, '127.0.0.1', () => {
			log(`CCB Cursor 代理已启动：http://127.0.0.1:${state.port}`);
			resolve({ ok: true, port: state.port });
		});
		state.server.on('error', () => resolve({ ok: false, error: `端口 ${state.port} 被占用` }));
	});
}

function stop() {
	if (!state.server) return { ok: true };
	try {
		state.server.close();
	} catch {}
	state.server = null;
	log('CCB Cursor 代理已停止');
	return { ok: true };
}

function status() {
	let caInstalled = false;
	try {
		caInstalled = state.dataDir ? isCaInstalled() : false;
	} catch {}
	return {
		running: !!state.server,
		port: state.port,
		caInstalled,
		stats: { ...state.stats },
	};
}

function init(opts = {}) {
	if (opts.dataDir) state.dataDir = opts.dataDir;
	if (opts.log) state.log = opts.log;
	if (opts.upstream) state.upstream = opts.upstream;
}

module.exports = {
	init,
	start,
	stop,
	status,
	ensureCa,
	installCa,
	uninstallCa,
	isCaInstalled,
	/* 暴露给端点模块与测试 */
	encodeFrame,
	frameParser,
	connectError,
	DEFAULT_PORT,
};
