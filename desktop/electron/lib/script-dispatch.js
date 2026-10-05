/**
 * 打包版无窗口子进程脚本派发
 *
 * 打包后的 CCB.exe 无法「以 JS 文件为入口」起新进程：Electron 打包应用忽略
 * 文件参数，总是运行自身的 main.js。v1.0.12 生产事故：qoder-secret-helper /
 * qoder-proxy-runner 两处 spawn 在打包版全部拉起了带窗口的完整应用实例——
 * 密钥加密静默失败 → vscdb 写不进（IDE「自定义模型服务异常」），常驻 runner
 * 形同虚设。因此打包模式下无窗口子进程统一改用标记启动，由 main.js 顶部派发：
 *
 *   CCB.exe --ccb-script=<lib 下的文件名> <原参数…>
 *
 * 派发时把 argv 规整成与「electron.exe <脚本路径> <参数>」完全一致的布局，
 * 被派发模块（按 argv[2]/argv[3] 位置解析参数）无需任何改动。
 */
'use strict';

const path = require('path');

const SCRIPT_MARKER_RE = /^--ccb-script=([\w.-]+\.js)$/;
/* 白名单：仅允许这两个无窗口子进程，防止借标记 require 任意模块 */
const DISPATCHABLE = new Set(['qoder-secret-helper.js', 'qoder-proxy-runner.js']);

/**
 * 解析派发标记。普通启动返回 null；命中标记返回
 *   { name, argv } —— argv 规整为 [execPath, name, ...标记后的原参数]
 *   { name, error } —— 标记命中但脚本不在白名单（由调用方报错退出）
 */
function parseScriptDispatch(argv) {
	const list = Array.isArray(argv) ? argv : [];
	const idx = list.findIndex((a, i) => i > 0 && SCRIPT_MARKER_RE.test(String(a || '')));
	if (idx === -1) return null;
	const name = SCRIPT_MARKER_RE.exec(String(list[idx]))[1];
	if (!DISPATCHABLE.has(name)) return { name, error: '不支持的派发脚本：' + name };
	return { name, argv: [list[0], name, ...list.slice(idx + 1)] };
}

/**
 * 子进程启动参数：dev 用脚本路径（electron.exe <script> 可直接运行脚本），
 * 打包后用 --ccb-script=<文件名> 标记（由 main.js 顶部派发接管）。
 */
function buildScriptArgs(isPackaged, scriptPath, ...rest) {
	return isPackaged ? ['--ccb-script=' + path.basename(scriptPath), ...rest] : [scriptPath, ...rest];
}

module.exports = { parseScriptDispatch, buildScriptArgs };
