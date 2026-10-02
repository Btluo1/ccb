const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { detectClients, getClient, validateCustomPath } = require('./lib/clients');
const { applyConfig, rollbackConfig, cleanupLegacyKiroEnv, isCursorProxyActive } = require('./lib/writers');
const cursorproxy = require('./lib/cursorproxy');
const qoderproxy = require('./lib/qoderproxy');
const { launchClient } = require('./lib/launcher');
const api = require('./lib/api');
const auth = require('./lib/auth');
const store = require('./lib/store');
const updater = require('./lib/updater');

let mainWindow = null;

function createWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 900,
		minWidth: 1100,
		minHeight: 720,
		autoHideMenuBar: true,
		backgroundColor: '#ffffff',
		title: 'CCB · AI 编程助手一键配置',
		icon: path.join(__dirname, '..', 'build', 'icon.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
	return win;
}

app.whenReady().then(() => {
	const c = store.load();
	api.setToken(c.token);

	/* Cursor MITM 代理：CA/站点证书缓存在 userData/cursor-proxy */
	cursorproxy.init({
		dataDir: app.getPath('userData'),
		log: (m) => console.log('[cursorproxy]', m),
	});

	/* Qoder CN IDE MITM 代理（1.30+ 自定义模型的前提）：
	 * CA 复用 ~/.ccb/cursor-proxy（若桌面端已生成过 cursor CA 则拷过去共用，一张证书两边通用） */
	try {
		const os = require('os');
		const sharedCaDir = path.join(os.homedir(), '.ccb', 'cursor-proxy');
		const cursorCaDir = path.join(app.getPath('userData'), 'cursor-proxy');
		if (
			!fs.existsSync(path.join(sharedCaDir, 'ca-key.pem')) &&
			fs.existsSync(path.join(cursorCaDir, 'ca-key.pem'))
		) {
			fs.mkdirSync(sharedCaDir, { recursive: true });
			fs.copyFileSync(path.join(cursorCaDir, 'ca-key.pem'), path.join(sharedCaDir, 'ca-key.pem'));
			fs.copyFileSync(path.join(cursorCaDir, 'ca-cert.pem'), path.join(sharedCaDir, 'ca-cert.pem'));
		}
	} catch {}
	qoderproxy.init({
		log: (m) => console.log('[qoderproxy]', m),
	});

	/* Qoder CN IDE v2：只要处于代理模式就恢复本地代理。两个条件取并集：
	 * ① settings.json 里有我们的代理设置（持久状态，即使 vscdb 模型被 IDE
	 *    退出时清空也成立——不恢复的话 Go 客户端会全部请求失败，生产事故根源）；
	 * ② vscdb 里仍有我们的模型（settings.json 尚未写入的中间态）。 */
	try {
		const { hasQoderCnModels, isQoderProxyActive } = require('./lib/writers');
		const qc = { id: 'qoder-cn', appDirs: ['QoderCN'] };
		if (hasQoderCnModels(qc) || isQoderProxyActive(qc)) {
			ensureQoderProxy().then((r) => {
				if (r && r.ok) console.log('[qoderproxy] 检测到 Qoder CN 代理模式，已恢复本地代理（' + r.mode + '）');
			});
		}
	} catch (e) {
		console.log('[qoderproxy] 自动恢复失败：', e.message || e);
	}

	/* Cursor MITM 模式：app 重启后自动恢复本地代理——Cursor 的 settings.json 仍指向
	 * 127.0.0.1:9182，不恢复的话 Cursor 的 AI 请求会一直连不上。密钥不入 store，
	 * 用登录 token 现拉；未登录 / 已回滚 / 已切回 BYOK 时静默跳过。 */
	resumeCursorProxy().catch((e) => console.log('[cursorproxy] 自动恢复失败：', e.message || e));

	mainWindow = createWindow();
	mainWindow.webContents.on('console-message', (_e, level, message) => {
		if (level >= 2) console.log('[renderer]', message);
	});

	/* 自动更新：状态变化推给渲染层，由横幅展示 */
	updater.init({
		version: app.getVersion(),
		isPackaged: app.isPackaged,
		isPortable: !!process.env.PORTABLE_EXECUTABLE_FILE,
		onState: (s) => {
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', s);
		},
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:info', () => ({
	version: app.getVersion(),
	platform: process.platform,
}));

/* ---------- 检查更新 / 自动更新 ---------- */
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:state', () => updater.getState());

/* ---------- 账号 ---------- */
/* 登录/注册成功后若 Cursor 仍指向本机代理（MITM 模式），自动恢复/刷新代理：
 * 覆盖「启动时未登录、之后才登录」的场景，换账号重登也会热更新密钥 */
async function afterAuthSuccess() {
	try {
		await resumeCursorProxy();
	} catch (e) {
		console.log('[cursorproxy] 登录后恢复代理失败：', e.message || e);
	}
}

ipcMain.handle('auth:login', async (_e, username, password) => {
	if (typeof username !== 'string' || typeof password !== 'string') {
		return { ok: false, error: '参数无效' };
	}
	const r = await auth.loginWithPassword(username.trim(), password);
	if (r && r.ok) afterAuthSuccess();
	return r;
});

ipcMain.handle('auth:register', async (_e, username, password) => {
	if (typeof username !== 'string' || typeof password !== 'string') {
		return { ok: false, error: '参数无效' };
	}
	const r = await auth.registerWithPassword(username.trim(), password);
	if (r && r.ok) afterAuthSuccess();
	return r;
});

ipcMain.handle('auth:logout', () => auth.logout());

ipcMain.handle('auth:status', () => {
	const s = store.load();
	return { loggedIn: !!s.token, user: s.user || null };
});

/* ---------- 后端 API ---------- */
ipcMain.handle('api:profile', () => api.getProfile());
ipcMain.handle('api:models', () => api.getModels());
ipcMain.handle('api:currentKey', (_e, provider) => {
	if (typeof provider !== 'string' || !provider) return { error: '参数无效' };
	return api.getCurrentKey(provider);
});
ipcMain.handle('api:redeem', (_e, code) => {
	if (typeof code !== 'string' || !code.trim()) return { error: '请输入兑换码' };
	return api.redeem(code.trim());
});

/* ---------- Qoder CN IDE v10 密钥加密（qoder-secret-helper 子进程） ----------
 * QoderCN 的 safeStorage 密钥从其 userData 的 Local State 派生，主进程无法直接复用，
 * 用自身 exe 起一个无窗口子进程（app.setPath('userData', QoderCN) 后加密）。
 * 开发模式（electron .）与打包后（CCB.exe <script>）都兼容。 */
function encryptQoderSecret(plaintext) {
	return new Promise((resolve) => {
		if (!plaintext) return resolve(null);
		const script = path.join(__dirname, 'lib', 'qoder-secret-helper.js');
		if (!fs.existsSync(script)) {
			console.log('[qoder-secret] helper 不存在：', script);
			return resolve(null);
		}
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE; /* 必须是完整 Electron，safeStorage 才可用 */
		let out = '';
		let settled = false;
		const done = (v) => {
			if (!settled) { settled = true; resolve(v); }
		};
		try {
			const child = spawn(process.execPath, [script, 'encrypt', plaintext], {
				env,
				stdio: ['ignore', 'pipe', 'ignore'],
				windowsHide: true,
			});
			const timer = setTimeout(() => {
				try { child.kill(); } catch {}
				done(null);
			}, 20000);
			child.stdout.on('data', (c) => { out += c.toString('utf8'); });
			child.on('error', () => { clearTimeout(timer); done(null); });
			child.on('close', () => {
				clearTimeout(timer);
				try {
					const r = JSON.parse(out.trim().split('\n').pop() || '{}');
					done(r.ok && r.b64 ? r.b64 : null);
				} catch {
					done(null);
				}
			});
		} catch (e) {
			console.log('[qoder-secret] spawn 失败：', e.message || e);
			done(null);
		}
	});
}

/* ---------- Qoder CN 本地代理生命周期（常驻 runner + 进程内兜底） ----------
 * 代理必须比 CCB 主应用活得久：Qoder IDE 的 User/settings.json
 * （app.configAdvancedProxyMode）持久指向 127.0.0.1:9183，CCB 一关代理就死的
 * 话，IDE 的 Go 客户端所有请求失败（「连接失败，请检查您的网络连接或 VPN」，
 * 1.0.4 生产事故的根源）。因此优先拉起 detached 无窗口 runner
 * （lib/qoder-proxy-runner.js，CCB 关闭后继续运行），并写 HKCU Run 自启动
 * 覆盖「重启后先开 IDE 后开 CCB」场景；runner 拉不起（便携版等）才退回进程内。 */
const QODER_PROXY_PORT = 9183;
const QODER_PROXY_RUN_KEY = 'CCBQoderProxy';

function qoderProxyPidFile() {
	const os = require('os');
	return path.join(os.homedir(), '.ccb', 'qoder-proxy.pid');
}

function isPortListening(port, host = '127.0.0.1') {
	return new Promise((resolve) => {
		const net = require('net');
		const s = net.connect({ port, host, timeout: 600 });
		s.on('connect', () => { s.destroy(); resolve(true); });
		s.on('error', () => resolve(false));
		s.on('timeout', () => { s.destroy(); resolve(false); });
	});
}

function qoderProxyAutostartCmd() {
	/* 便携版 process.execPath 在临时解包目录（退出即删），不能作为自启动目标 */
	if (process.env.PORTABLE_EXECUTABLE_FILE) return null;
	const script = path.join(__dirname, 'lib', 'qoder-proxy-runner.js');
	if (!fs.existsSync(script)) return null;
	return `"${process.execPath}" "${script}" ${QODER_PROXY_PORT}`;
}

function setQoderProxyAutostart(enable) {
	const cmd = qoderProxyAutostartCmd();
	if (!cmd) return; /* 便携版：无自启动，依赖 CCB 打开时恢复 */
	const { spawnSync } = require('child_process');
	try {
		if (enable) {
			spawnSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
				'/v', QODER_PROXY_RUN_KEY, '/t', 'REG_SZ', '/d', cmd, '/f'],
				{ windowsHide: true });
		} else {
			spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
				'/v', QODER_PROXY_RUN_KEY, '/f'],
				{ windowsHide: true });
		}
	} catch {}
}

async function ensureQoderProxy(opts = {}) {
	const port = Number(opts.port) || QODER_PROXY_PORT;
	/* 1) 进程内已在跑：热更新模型清单 + relay 地址（relay 落盘后返回） */
	const st = qoderproxy.status();
	if (st.running) {
		await qoderproxy.start({ ...opts, port });
		return { ok: true, mode: 'inprocess' };
	}
	/* 2) 端口已有人监听（常驻 runner 还活着 / 开机自启动已拉起）：
	 *    relay 地址走 setRelayBaseUrl 落盘（runner 的文件 watch 热更新），
	 *    模型清单同理。否则 apply 传的 apiBase 永远到不了 runner（实测踩坑：
	 *    旧版只 setModels，sk-ccb 请求一直被 runner 重定向到默认生产地址）。 */
	if (await isPortListening(port)) {
		if (Array.isArray(opts.models) && opts.models.length) {
			try { qoderproxy.setModels(opts.models); } catch {}
		}
		if (opts.relayBaseUrl) {
			try { qoderproxy.setRelayBaseUrl(String(opts.relayBaseUrl)); } catch {}
		}
		return { ok: true, mode: 'detached-alive' };
	}
	/* 3) 拉起 detached runner（安装版）：spawn 前把 relay 地址落盘，
	 *    runner 启动时读文件恢复（比 argv 可靠：watch 通道同一份文件） */
	const script = path.join(__dirname, 'lib', 'qoder-proxy-runner.js');
	if (fs.existsSync(script) && !process.env.PORTABLE_EXECUTABLE_FILE) {
		if (opts.relayBaseUrl) {
			try { qoderproxy.setRelayBaseUrl(String(opts.relayBaseUrl)); } catch {}
		}
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		try {
			const child = spawn(process.execPath, [script, String(port)], {
				detached: true, stdio: 'ignore', windowsHide: true, env,
			});
			child.unref();
			for (let i = 0; i < 25; i++) {
				await new Promise((r) => setTimeout(r, 200));
				if (await isPortListening(port)) {
					setQoderProxyAutostart(true);
					return { ok: true, mode: 'detached' };
				}
			}
			console.log('[qoderproxy] detached runner 未在 5s 内就绪，回退进程内模式');
		} catch (e) {
			console.log('[qoderproxy] runner 拉起失败，回退进程内：', e.message || e);
		}
	}
	/* 4) 兜底：进程内代理（CCB 关闭后失效，需保持 CCB 运行） */
	const r = await qoderproxy.start({ ...opts, port });
	return r.ok ? { ok: true, mode: 'inprocess' } : r;
}

function stopQoderProxy() {
	qoderproxy.stop();
	/* 常驻 runner：kill 进程 + 删 pidfile（runner 心跳也会自退）双保险 */
	try {
		const f = qoderProxyPidFile();
		const pid = Number((fs.readFileSync(f, 'utf8') || '').trim());
		if (pid && pid !== process.pid) {
			try { process.kill(pid); } catch {}
		}
		fs.rmSync(f);
	} catch {}
	setQoderProxyAutostart(false);
}

/* ---------- 客户端 ---------- */
ipcMain.handle('clients:detect', () => detectClients(store.load().customPaths || {}));

/* Qoder CN IDE 一键配置 v2（Plan B）：启动前准备 + 带代理环境变量启动 */
function qoderCnLaunchOpts() {
	return {
		/* Go 客户端（QoderCN.exe）走 net/http ProxyFromEnvironment；
		 * Chromium 渲染层在 Windows 用系统代理设置，不受这些环境变量影响 */
		env: {
			HTTP_PROXY: 'http://127.0.0.1:9183',
			HTTPS_PROXY: 'http://127.0.0.1:9183',
			http_proxy: 'http://127.0.0.1:9183',
			https_proxy: 'http://127.0.0.1:9183',
			NO_PROXY: 'localhost,127.0.0.1,::1',
			no_proxy: 'localhost,127.0.0.1,::1',
		},
		preLaunch: async () => {
			/* 1) 对冲 IDE 退出清空 customModels：启动前重写 vscdb */
			try {
				const re = require('./lib/writers').reapplyQoderCn(
					{ id: 'qoder-cn', appDirs: ['QoderCN'] },
					(m) => console.log('[qoder-reapply]', m),
				);
				if (re) console.log('[qoder-launch] vscdb 已确认/重写');
			} catch (e) {
				console.log('[qoder-launch] vscdb 重写跳过：', e.message || e);
			}
		/* 2) 确保本地代理在跑（app 重启后自动恢复 / 常驻 runner 探活的场景） */
		const r = await ensureQoderProxy();
		if (!r.ok) throw new Error('本地代理启动失败：' + (r.error || '未知错误'));
		},
	};
}

ipcMain.handle('clients:launch', async (_e, clientId) => {
	if (typeof clientId !== 'string') return { status: 'failed', message: '参数无效' };
	const detected = detectClients(store.load().customPaths || {}).find((c) => c.id === clientId);
	const opts = clientId === 'qoder-cn' ? qoderCnLaunchOpts() : undefined;
	return launchClient(clientId, detected, opts);
});

ipcMain.handle('dialog:pickClientPath', async (e) => {
	const win = BrowserWindow.fromWebContents(e.sender);
	const r = await dialog.showOpenDialog(win, {
		title: '选择客户端程序（.exe）或其安装/数据目录',
		properties: ['openFile', 'openDirectory'],
		filters: [{ name: '可执行程序', extensions: ['exe'] }],
	});
	if (r.canceled || !r.filePaths.length) return null;
	return r.filePaths[0];
});

ipcMain.handle('clients:setCustomPath', (_e, clientId, p, force) => {
	if (typeof clientId !== 'string' || typeof p !== 'string' || !p) {
		return { ok: false, error: '参数无效' };
	}
	const client = getClient(clientId);
	if (!client) return { ok: false, error: '未知客户端' };
	if (!fs.existsSync(p)) return { ok: false, error: '所选路径不存在，请重新选择' };

	/* 校验所选路径是否像该客户端。matched==='none' 且用户未确认强制使用时，
	 * 不落库——返回 mismatch 让渲染层弹「路径不像 X，是否仍要使用？」确认条，
	 * 用户点「仍要使用」才会带 force=true 二次提交。避免把 Trae 误指到 Qoder
	 * 的目录后，配置写进去了、启动却起的是另一个程序。 */
	const v = validateCustomPath(client, p);
	if (!force && v.matched === 'none') {
		return {
			ok: false, mismatch: true, matched: v.matched, reason: v.reason,
			picked: p, clients: detectClients(store.load().customPaths || {}),
		};
	}

	const data = store.load();
	const customPaths = { ...(data.customPaths || {}), [clientId]: p };
	store.save({ customPaths });
	return { ok: true, matched: v.matched, reason: v.reason, resolvedExe: v.exe, clients: detectClients(customPaths) };
});

ipcMain.handle('clients:clearCustomPath', (_e, clientId) => {
	if (typeof clientId !== 'string') return { ok: false, error: '参数无效' };
	const data = store.load();
	const customPaths = { ...(data.customPaths || {}) };
	delete customPaths[clientId];
	store.save({ customPaths });
	return { ok: true, clients: detectClients(customPaths) };
});

ipcMain.handle('key:verify', async (_e, apiBase, apiKey) => {
	if (typeof apiBase !== 'string' || typeof apiKey !== 'string' || !apiKey) {
		return { ok: false, error: '参数无效' };
	}
	try {
		const res = await fetch(apiBase.replace(/\/+$/, '') + '/models', {
			headers: { Authorization: 'Bearer ' + apiKey },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) {
			let msg = 'HTTP ' + res.status;
			try {
				const err = await res.json();
				const m = (err.error && (err.error.message || err.error)) || err.message;
				if (m) msg = typeof m === 'string' ? m : JSON.stringify(m);
			} catch {}
			return { ok: false, error: msg };
		}
		const data = await res.json();
		const raw = data.data || data.models || [];
		const models = raw.map((m) => (typeof m === 'string' ? m : m.id || m.model || '')).filter(Boolean);
		return { ok: true, models };
	} catch (e) {
		return { ok: false, error: e.name === 'TimeoutError' ? '连接超时' : '网络错误，无法连接服务' };
	}
});

ipcMain.handle('config:apply', async (_e, clientId, cfg) => {
	if (typeof clientId !== 'string' || !cfg || typeof cfg !== 'object') {
		return { ok: false, error: '参数无效' };
	}
	/* Trae 系写入器需要可执行文件路径（要带调试端口启动客户端），从检测结果里取 */
	const detected = detectClients(store.load().customPaths || {}).find((c) => c.id === clientId);
	const mitm =
		cfg.cursorMitm && typeof cfg.cursorMitm === 'object'
			? { enabled: !!cfg.cursorMitm.enabled, port: Number(cfg.cursorMitm.port) || undefined }
			: undefined;
	/* Qoder CN IDE v2：先用无窗口 Electron 子进程把平台密钥加密成 QoderCN 的
	 * v10 blob（safeStorage 密钥从 QoderCN userData 的 Local State 派生），
	 * 写入 vscdb 的 apiKey secret 用。失败则跳过 vscdb 通道（CLI 通道仍有效）。 */
	if (clientId === 'qoder-cn') {
		const blob = await encryptQoderSecret(String(cfg.apiKey || ''));
		if (blob) cfg.qoderSecretBlob = blob;
	}
	const result = await applyConfig(
		clientId,
		{
			apiKey: String(cfg.apiKey || ''),
			apiBase: String(cfg.apiBase || ''),
			anthropicBase: String(cfg.anthropicBase || ''),
			models: Array.isArray(cfg.models) ? cfg.models.map(String) : [],
			defaultModel: String(cfg.defaultModel || ''),
			/* Cursor MITM 代理模式（模仿 cursor-agent）：{ enabled, port } */
			cursorMitm: mitm,
			/* Qoder CN v2：v10 加密 blob（可能为空，vscdb 通道降级跳过） */
			qoderSecretBlob: cfg.qoderSecretBlob || '',
		},
		detected,
	);
	/* Qoder CN IDE：写入成功后确保本地代理在跑（重定向 sk-ccb 推理请求到中转站） */
	if (clientId === 'qoder-cn' && result && result.ok) {
		const pr = await ensureQoderProxy({
			models: Array.isArray(cfg.models) ? cfg.models.map(String) : [],
			relayBaseUrl: String(cfg.apiBase || '') || undefined,
		});
		result.proxy = pr;
	}
	/* MITM 模式写入成功后自动拉起本地代理；切回 BYOK 则停掉 */
	if (clientId === 'cursor' && result && result.ok) {
		if (mitm && mitm.enabled) {
			const pr = await cursorproxy.start({
				port: mitm.port,
				upstream: cursorProxyUpstream({
					apiKey: cfg.apiKey,
					baseUrl: cfg.apiBase,
					models: cfg.models,
					defaultModel: cfg.defaultModel,
				}),
			});
			result.proxy = pr;
		} else {
			cursorproxy.stop();
		}
	}
	return result;
});

ipcMain.handle('config:rollback', (_e, clientId) => {
	if (typeof clientId !== 'string') return { ok: false, error: '参数无效' };
	/* WorkBuddy 回滚要还原界面上的默认模型（localStorage），同样需要可执行文件路径 */
	const detected = detectClients(store.load().customPaths || {}).find((c) => c.id === clientId);
	if (clientId === 'cursor') cursorproxy.stop();
	/* Qoder CN IDE：回滚时停掉本地代理（进程内 + 常驻 runner + 自启动项）；
	 * writers.rollbackQoder 会移除 settings.json 里的代理字段 */
	if (clientId === 'qoder-cn') stopQoderProxy();
	return rollbackConfig(clientId, detected);
});

/* ---------- Cursor MITM 代理（模仿 cursor-agent：settings.json → 本地代理 → CCB 中转） ---------- */
function cursorProxyUpstream(overrides = {}) {
	const c = store.load();
	/* store 里的 models 是 [{id,selected}] 对象数组，必须映射成字符串 ID */
	const storedModels = Array.isArray(c.models)
		? c.models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
		: [];
	const overrideModels = Array.isArray(overrides.models)
		? overrides.models.map(String).filter(Boolean)
		: [];
	/* 高级上游参数：渲染层「高级选项」写入 store.cursorUpstream，缺省值由
	 * cursorupstream.normalize 兜底，这里只做「覆盖优先于持久化值」的合并 */
	const adv = c.cursorUpstream && typeof c.cursorUpstream === 'object' ? c.cursorUpstream : {};
	const pick = (k) => (overrides[k] !== undefined ? overrides[k] : adv[k]);
	return {
		baseUrl: String(overrides.baseUrl || c.apiBaseUrl || ''),
		/* sk-ccb-* 平台密钥属敏感信息，不入 store：优先用调用方（渲染层 currentKey）传入的值 */
		apiKey: String(overrides.apiKey || ''),
		models: overrideModels.length ? overrideModels : storedModels,
		defaultModel: String(overrides.defaultModel || c.defaultModel || ''),
		apiKeyHeader: pick('apiKeyHeader'),
		apiFormat: pick('apiFormat'),
		maxTokens: pick('maxTokens'),
		temperature: pick('temperature'),
		timeout: pick('timeout'),
		contextTokenLimit: pick('contextTokenLimit'),
		compression: pick('compression'),
	};
}

ipcMain.handle('cursorproxy:status', () => cursorproxy.status());

/* app 启动时恢复 Cursor MITM 代理：条件是 MITM 模式 + 已登录 + Cursor 配置仍指向本机代理 */
async function resumeCursorProxy() {
	const c = store.load();
	if (c.cursorMode !== 'mitm' || !c.token) return;
	/* 必须用 getClient 的原始定义（带 appDirs）：detectClients 的检测结果只有
	 * details.apps，没有 appDirs 字段，传进去 isCursorProxyActive 永远查不到 */
	const cursorDef = getClient('cursor');
	if (!cursorDef || !isCursorProxyActive(cursorDef)) return;
	const r = await api.getCurrentKey('openai');
	const apiKey =
		r && !r.error && r.key
			? typeof r.key === 'string'
				? r.key
				: r.key.apiKey || r.key.key || null
			: null;
	if (!apiKey) {
		console.log('[cursorproxy] 自动恢复跳过：未取到平台密钥');
		return;
	}
	const started = await cursorproxy.start({ upstream: cursorProxyUpstream({ apiKey }) });
	console.log('[cursorproxy] 已自动恢复：' + JSON.stringify(started));
}

ipcMain.handle('cursorproxy:start', (_e, cfg) => {
	const c = cfg && typeof cfg === 'object' ? cfg : {};
	return cursorproxy.start({
		port: Number(c.port) || undefined,
		upstream: cursorProxyUpstream(c),
	});
});

ipcMain.handle('cursorproxy:stop', () => cursorproxy.stop());

ipcMain.handle('cursorproxy:installCa', () => cursorproxy.installCa());

ipcMain.handle('cursorproxy:uninstallCa', () => cursorproxy.uninstallCa());

/* ---------- Qoder CN IDE MITM 代理（1.30+ 自定义模型可用性的前提：BYOK 配置注入） ---------- */
ipcMain.handle('qoderproxy:status', () => qoderproxy.status());

ipcMain.handle('qoderproxy:start', async (_e, cfg) => {
	const c = cfg && typeof cfg === 'object' ? cfg : {};
	const stored = store.load();
	const storedModels = Array.isArray(stored.models)
		? stored.models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
		: [];
	const overrideModels = Array.isArray(c.models) ? c.models.map(String).filter(Boolean) : [];
	return ensureQoderProxy({
		port: Number(c.port) || undefined,
		relayBaseUrl: String(c.baseUrl || stored.apiBaseUrl || '') || undefined,
		models: overrideModels.length ? overrideModels : storedModels,
	});
});

ipcMain.handle('qoderproxy:stop', () => stopQoderProxy());

ipcMain.handle('qoderproxy:installCa', () => qoderproxy.installCa());

ipcMain.handle('qoderproxy:uninstallCa', () => qoderproxy.uninstallCa());

/* 清理 1.0.0 版写到注册表的 Kiro 环境变量（Kiro 已下架，卡片不再出现） */
ipcMain.handle('config:cleanupLegacyEnv', () => cleanupLegacyKiroEnv(() => {}));

/* 渲染进程只允许更新非敏感字段，token/user 只能由主进程 auth 模块写入 */
ipcMain.handle('store:get', () => {
	const { token, user, customPaths, ...rest } = store.load();
	return { ...rest, hasToken: !!token, user: user || null };
});

ipcMain.handle('store:set', (_e, partial) => {
	if (!partial || typeof partial !== 'object') return store.load();
	const clean = {};
	/* onboarded：新手引导是否已看过（渲染层写入，只影响引导是否自动弹出） */
	for (const key of ['apiBaseUrl', 'anthropicBaseUrl', 'accountApiBase', 'models', 'defaultModel', 'onboarded', 'cursorMode', 'cursorUpstream', 'dismissedUpdate']) {
		if (key in partial) clean[key] = partial[key];
	}
	const saved = store.save(clean);
	const { token, ...safe } = saved;
	return { ...safe, hasToken: !!token };
});

ipcMain.handle('shell:reveal', (_e, target) => {
	if (typeof target !== 'string') return;
	if (fs.existsSync(target)) shell.showItemInFolder(target);
});

ipcMain.handle('shell:open', async (_e, target) => {
	if (typeof target !== 'string') return { ok: false, error: '参数无效' };
	if (/^https?:\/\//.test(target)) {
		await shell.openExternal(target);
		return { ok: true };
	}
	return { ok: true, opened: await shell.openPath(target) };
});
