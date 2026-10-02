/**
 * Qoder CN 本地 MITM 代理 —— 常驻后台 runner（无窗口子进程）
 *
 * 背景：config:apply / 启动按钮拉起的进程内代理会随 CCB 桌面端退出而死掉，
 * 而 Qoder IDE 的 User/settings.json（app.configAdvancedProxyMode）持久指向
 * 127.0.0.1:9183 —— 代理一死，IDE 的 Go 客户端所有请求失败（「连接失败，请
 * 检查您的网络连接或 VPN」）。因此代理必须独立于 CCB 主进程存活：
 *
 *   <CCB.exe> qoder-proxy-runner.js <port>      （完整 Electron，无窗口）
 *
 * - 以 detached 子进程启动，CCB 关闭后继续运行；pid 写入 ~/.ccb/qoder-proxy.pid
 * - userData 重定向到 ~/.ccb/qoder-proxy-userdata（避免与主应用 / 其他实例冲突）
 * - 兼容纯 Node 直接运行（node qoder-proxy-runner.js <port>），便于无头测试：
 *   require('electron') 在纯 Node 下不可用时跳过 app 生命周期，直接起服务
 * - 收到 SIGTERM/SIGINT 时清 pidfile 退出（rollback 用）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function parsePort() {
	const a = process.argv.slice(2);
	const i = a.indexOf('--port');
	if (i !== -1 && a[i + 1]) return Number(a[i + 1]) || 9183;
	for (const v of a) {
		const n = Number(v);
		if (n >= 1 && n <= 65535) return n;
	}
	return 9183;
}
const PORT = parsePort();
const HOME = os.homedir();
const CCB_DIR = path.join(HOME, '.ccb');
const PID_FILE = path.join(CCB_DIR, 'qoder-proxy.pid');

let electronApp = null;
try {
	const electron = require('electron');
	if (electron && typeof electron === 'object' && electron.app) electronApp = electron.app;
} catch { /* 纯 Node 模式 */ }

function writePid() {
	try {
		fs.mkdirSync(CCB_DIR, { recursive: true });
		fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
	} catch { /* 尽力而为 */ }
}
function clearPid() {
	try {
		if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE);
	} catch { /* 尽力而为 */ }
}

/* 文件日志：detached 启动 stdio 被忽略，控制台输出全部丢失——排障（拦截计数、
 * BYOK 注入、重定向详情）必须落盘。追加写 + 简单截断保护（>2MB 重开）。 */
const LOG_FILE = path.join(CCB_DIR, 'qoder-proxy.log');
function fileLog(line) {
	try {
		try {
			if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.rmSync(LOG_FILE);
		} catch { /* 文件不存在 */ }
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
	} catch { /* 磁盘满等：日志尽力而为，不影响代理 */ }
}

function runServer() {
	const qoderproxy = require('./qoderproxy.js');
	qoderproxy.init({
		log: (m) => {
			console.log('[qoder-proxy-runner]', m);
			fileLog(m);
		},
	});
	qoderproxy.start({ port: PORT }).then((r) => {
		if (!r.ok) {
			console.error('[qoder-proxy-runner] 启动失败：', r.error || '未知错误');
			clearPid();
			if (electronApp) electronApp.exit(1);
			else process.exit(1);
			return;
		}
		writePid();
		fileLog(`running on ${r.port} pid ${process.pid}`);
		console.log('[qoder-proxy-runner] running on', r.port, 'pid', process.pid);
		/* 模型热更新：config:apply 重写 qoder-models.json 时重载
		 * （常驻 runner 收不到主进程的 setModels 调用，只能靠文件通知） */
		try {
			const modelsFile = path.join(CCB_DIR, 'qoder-models.json');
			let watchTimer = null;
			fs.watchFile(modelsFile, { interval: 2000 }, () => {
				clearTimeout(watchTimer);
				watchTimer = setTimeout(() => {
					try {
						const list = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
						if (Array.isArray(list) && list.length) {
							qoderproxy.setModels(list);
							console.log('[qoder-proxy-runner] 模型清单已热更新（' + list.length + ' 个）');
						}
					} catch { /* 解析失败保留旧清单 */ }
				}, 500);
			});
		} catch { /* watch 失败不影响代理 */ }
		/* relay 地址热更新：同一文件通道（qoder-relay.json，纯 URL 字符串） */
		try {
			const relayFile = path.join(CCB_DIR, 'qoder-relay.json');
			let relayTimer = null;
			fs.watchFile(relayFile, { interval: 2000 }, () => {
				clearTimeout(relayTimer);
				relayTimer = setTimeout(() => {
					try {
						const v = JSON.parse(fs.readFileSync(relayFile, 'utf8'));
						if (typeof v === 'string' && v) {
							qoderproxy.setRelayBaseUrl(v);
							console.log('[qoder-proxy-runner] relay 地址已热更新 →', v);
						}
					} catch { /* 解析失败保留旧地址 */ }
				}, 500);
			});
		} catch { /* watch 失败不影响代理 */ }
		/* 心跳：pidfile 被外部删除（rollback）视为停止指令 */
		setInterval(() => {
			try { fs.readFileSync(PID_FILE); } catch {
				console.log('[qoder-proxy-runner] pidfile 已移除，退出');
				clearPid();
				if (electronApp) electronApp.exit(0);
				else process.exit(0);
			}
		}, 3000).unref();
	});

	const shutdown = () => {
		clearPid();
		if (electronApp) electronApp.exit(0);
		else process.exit(0);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

if (electronApp) {
	/* 隔离 userData：避免与 CCB 主应用共用（LevelDB / Local State 并发冲突） */
	electronApp.setPath('userData', path.join(CCB_DIR, 'qoder-proxy-userdata'));
	/* 无窗口：window-all-closed 不退出 */
	electronApp.on('window-all-closed', (e) => { e.preventDefault(); });
	electronApp.whenReady().then(runServer).catch((e) => {
		console.error('[qoder-proxy-runner] init 失败：', e.message || e);
		electronApp.exit(1);
	});
} else {
	/* 纯 Node（无头测试）：直接跑 */
	runServer();
}
