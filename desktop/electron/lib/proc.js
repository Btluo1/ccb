/**
 * 进程检测：判断目标客户端是否正在运行
 *
 * 用途：Trae / Cursor / Qoder 的配置存在 SQLite 数据库中，必须在客户端完全退出后
 * 才能安全写入——运行中的客户端会持有数据库，并在退出时用内存状态回写，导致我们的
 * 修改被覆盖，并发写还有损坏风险。写入前先检查，运行中则拒绝并提示用户先退出。
 */

const { spawnSync } = require('child_process');

function normalize(name) {
	return /\.exe$/i.test(name) ? name : name + '.exe';
}

/**
 * 从 tasklist 的 CSV 输出里取出真实进程名（已去重）。
 *
 * 用 CSV（`/FO CSV`）而不是表格输出：表格输出靠「非空白字符 + .exe」切分，
 * 而进程名里可能带空格（Trae CN.exe / TRAE SOLO CN.exe / CodeBuddy CN.exe），
 * 那样会一个都匹配不到 —— 曾因此让「运行中拒绝写入」的守卫完全失效，
 * 导致写入被运行中的客户端回写覆盖。CSV 的进程名带引号，可安全解析。
 */
function parseTasklistNames(stdout) {
	const found = new Set();
	for (const line of String(stdout || '').split(/\r?\n/)) {
		// CSV 行形如："Trae CN.exe","1234","Console","1","123,456 K"
		const m = /^\s*"([^"]+\.exe)"/i.exec(line);
		if (m) found.add(m[1]);
	}
	return [...found];
}

/**
 * 返回正在运行的进程名（取自 tasklist 实际输出，已去重）。
 *
 * 注意：Windows 的 IMAGENAME 过滤不区分大小写，而 clients.js 里同一客户端的多个
 * 候选名可能互为大小写变体（如 `Trae CN.exe` / `TRAE CN.exe`），会被同一个进程同时命中。
 * 因此这里解析 tasklist 输出中的真实进程名并去重，避免把 1 个进程报成 3 个。
 */
function runningAmong(exeNames) {
	const found = new Set();
	for (const raw of exeNames || []) {
		const name = normalize(raw);
		let out = '';
		try {
			const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
				encoding: 'utf8',
				timeout: 8000,
				windowsHide: true,
			});
			if (r.status !== 0 || !r.stdout) continue;
			out = r.stdout;
		} catch {
			continue;
		}
		for (const n of parseTasklistNames(out)) found.add(n);
	}
	return [...found];
}

/** 单个可执行文件是否在运行 */
function isRunning(exeName) {
	return runningAmong([exeName]).length > 0;
}

module.exports = { isRunning, runningAmong, parseTasklistNames };
