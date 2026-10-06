/**
 * 客户端启动 / 重启
 *
 * - tasklist 检测进程是否运行
 * - 运行中先优雅关闭（taskkill 不带 /F，等待其退出），超时再强制终止整棵进程树
 * - 重新启动（detached spawn，不阻塞 CCB）
 *
 * 为什么必须有强制终止兜底：托盘类 Electron 应用（WorkBuddy 等）不响应 WM_CLOSE
 * ——关掉主窗口只是收进托盘，主进程/daemon/CLI 子进程都还在。实测
 * `taskkill /IM WorkBuddy.exe`（不带 /F）对 8 个 WorkBuddy 进程里的 daemon、renderer、
 * CLI 全部返回「只能强制终止此进程」，主进程也不退出，于是 12 秒后判定失败，
 * 一键配置并启动直接报「客户端正在运行且未能自动退出」。必须用 /F /T 兜底。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getClient, appxInfo } = require('./clients');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tasklistHas(exeName) {
	try {
		const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], {
			encoding: 'utf8',
			timeout: 8000,
			windowsHide: true,
		});
		if (r.status === 0 && r.stdout) {
			return r.stdout.toLowerCase().includes('"' + exeName.toLowerCase() + '"');
		}
	} catch {}
	return false;
}

function isClientRunning(client) {
	if (client.exeNames) return client.exeNames.some(tasklistHas);
	return false;
}

/* 优雅关闭给 4 秒：正常响应的客户端（VS Code 分支等）都在 1~3 秒内退出，
 * 托盘类应用不响应 WM_CLOSE，多等无益，直接进强制终止。 */
const GRACEFUL_WAIT_MS = 4000;
/* 强制终止给 8 秒：/F /T 基本是立即生效，留足余量等内核回收进程句柄 */
const FORCE_WAIT_MS = 8000;

function taskkill(args) {
	try {
		return spawnSync('taskkill', args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
	} catch {
		return null;
	}
}

async function waitAllExit(exeNames, waitMs) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (!exeNames.some(tasklistHas)) return true;
		if (Date.now() >= deadline) return !exeNames.some(tasklistHas);
		await sleep(700);
	}
}

/**
 * 关闭正在运行的客户端。
 * @returns {{ wasRunning: boolean, stopped: boolean }}
 */
async function stopClient(client) {
	const exeNames = client.exeNames || [];
	if (!exeNames.some(tasklistHas)) return { wasRunning: false, stopped: true };

	/* 托盘类应用（WorkBuddy）不能走优雅关闭：关掉主窗口只是收进托盘，而 `taskkill` 不带 /F
	 * 会先把 daemon 子进程终止、主进程却还活着，主进程随后往已断的管道写数据直接崩
	 * ——实测的 EPIPE 崩溃报告就是这么来的（main 进程 writeDaemonStdioFrame）。直接 /F /T
	 * 结束整棵树，实测不再产生崩溃报告。 */
	if (!client.trayApp) {
		for (const exeName of exeNames) {
			if (tasklistHas(exeName)) taskkill(['/IM', exeName]);
		}
		if (await waitAllExit(exeNames, GRACEFUL_WAIT_MS)) return { wasRunning: true, stopped: true };
	}

	/* 兜底：强制终止该进程及其子进程树（托盘类应用只能走这条路） */
	for (const exeName of exeNames) {
		if (tasklistHas(exeName)) taskkill(['/F', '/T', '/IM', exeName]);
	}
	return { wasRunning: true, stopped: await waitAllExit(exeNames, FORCE_WAIT_MS) };
}

/* 解析可执行文件路径：自定义路径 > 注册表 > 常规安装位置 */
function findLaunchExe(client, detected) {
	const d = (detected && detected.details) || {};
	const isExe = (p) => !!p && /\.exe$/i.test(p) && fs.existsSync(p);

	if (d.customPath) {
		if (isExe(d.customPath)) return d.customPath;
		for (const exeName of client.exeNames || []) {
			if (fs.existsSync(path.join(d.customPath, exeName))) {
				return path.join(d.customPath, exeName);
			}
		}
	}
	if (isExe(d.exePath)) return d.exePath;
	if (Array.isArray(d.apps)) {
		for (const a of d.apps) {
			if (isExe(a.exe)) return a.exe;
		}
	}
	return null;
}

function spawnDetached(exePath, extraEnv, extraArgs) {
	const child = spawn(exePath, Array.isArray(extraArgs) ? extraArgs : [], {
		detached: true,
		stdio: 'ignore',
		cwd: path.dirname(exePath),
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
	});
	child.unref();
}

/** 进程是否已出现（拿不到 spawn 的异步失败，用「进程出现在 tasklist 里」判定启动成功） */
async function waitProcUp(exeNames, waitMs) {
	const names = exeNames || [];
	if (!names.length) return false;
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (names.some(tasklistHas)) return true;
		if (Date.now() >= deadline) return names.some(tasklistHas);
		await sleep(400);
	}
}

/**
 * 启动 MSIX 应用（Codex 桌面版）。
 *
 * 与普通客户端不同：它装在 C:\Program Files\WindowsApps\<包全名>\app\ 下，包内路径
 * 不保证能直接执行（ACL 与「应用身份」都归 Windows 管），标准启动方式是让 shell 激活
 * AppUserModelId：explorer.exe shell:AppsFolder\<PackageFamilyName>!App，
 * 等价于用户点开始菜单图标。因此：
 *   1) 先用 shell 激活（常规路径）；
 *   2) 拉不起来（极少数环境 shell 激活失败）再退回直接执行包内 exe。
 * 用「进程出现在 tasklist 里」判定，避免把静默失败当成功。
 */
async function launchAppx(client, opts, appx, exe) {
	const names = client.exeNames || [];
	if (appx && appx.aumid) {
		const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
		try {
			spawnDetached(explorer, null, ['shell:AppsFolder\\' + appx.aumid]);
		} catch {}
		if (await waitProcUp(names, 8000)) return true;
	}
	if (exe) {
		try {
			spawnDetached(exe, opts && opts.env, opts && opts.args);
		} catch {}
		if (await waitProcUp(names, 8000)) return true;
	}
	return false;
}

/**
 * 启动（或重启）客户端。
 * @param {object} [opts] - launchOpts：
 *   { env: 额外环境变量,
 *     args: 额外命令行参数数组（如 Chromium 的 --proxy-server）,
 *     preLaunch: async () => void 启动前钩子 }
 * @returns {{ status: 'launched'|'restarted'|'failed', message: string }}
 */
async function launchClient(clientId, detected, opts) {
	const client = getClient(clientId);
	if (!client) return { status: 'failed', message: '未知客户端' };

	/* MSIX 应用（Codex 桌面版）：常规探测拿不到安装路径，补一次应用包查询；
	 * 有了 aumid 就能从任意位置启动它，不依赖 exe 路径。 */
	const appx = client.appx ? appxInfo(client.appx) : null;
	const exe = findLaunchExe(client, detected) || (appx && appx.exe) || null;
	if (!exe && !(appx && appx.aumid)) {
		return { status: 'failed', message: '未找到程序位置，请点击「详情」手动选择路径' };
	}

	const { wasRunning, stopped } = await stopClient(client);
	if (!stopped) {
		return {
			status: 'failed',
			message: '客户端正在运行且未能自动退出，请手动关闭后重试',
		};
	}
	if (wasRunning) await sleep(800);

	/* 启动前钩子（如 Qoder CN：重写 vscdb + 确保本地代理在跑） */
	if (opts && typeof opts.preLaunch === 'function') {
		try {
			await opts.preLaunch();
		} catch (e) {
			return { status: 'failed', message: '启动前准备失败：' + (e.message || e) };
		}
	}

	try {
		if (client.appx) {
			const up = await launchAppx(client, opts, appx, exe);
			if (!up) {
				return { status: 'failed', message: `启动失败：未能拉起 ${client.name}，请手动打开` };
			}
		} else {
			spawnDetached(exe, opts && opts.env, opts && opts.args);
		}
	} catch (e) {
		return { status: 'failed', message: '启动失败：' + (e.message || e) };
	}
	return {
		status: wasRunning ? 'restarted' : 'launched',
		message: wasRunning ? '已自动重启' : '已启动',
	};
}

module.exports = { launchClient, isClientRunning, findLaunchExe, stopClient };
