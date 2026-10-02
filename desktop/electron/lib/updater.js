/**
 * 桌面端「检查更新」与自动更新（electron-updater + generic provider）
 *
 * 更新源 = 账号服务地址 + /download，即 Worker 的 /download/* 路由（见 src/index.js）：
 *   GET /download/latest.yml                electron-builder 产出的版本元数据
 *   GET /download/ccb-setup-<ver>.exe       安装包（302 → dl.btluo.com，支持 Range）
 *   GET /download/ccb-setup-<ver>.exe.blockmap  差量更新用
 *
 * generic provider 不会自动上传，发版后需手动传 R2（bucket: ccb-downloads）：
 *   npx wrangler r2 object put ccb-downloads/latest.yml --file "desktop/dist/latest.yml"
 *   npx wrangler r2 object put ccb-downloads/ccb-setup-<ver>.exe --file "desktop/dist/ccb-setup-<ver>.exe"
 *   npx wrangler r2 object put ccb-downloads/ccb-setup-<ver>.exe.blockmap --file "desktop/dist/ccb-setup-<ver>.exe.blockmap"
 *   官网固定链接 ccb-setup.exe 另传一份同名副本；便携版同理（ccb-portable-<ver>.exe / ccb-portable.exe）
 *
 * 分两段，各管一件事：
 *   1) check() 只读 /api/latest（小 JSON）拿版本号/更新说明/下载地址，自己比版本 ——
 *      便携版、开发模式等「装不了」的场景也能提示有新版本，走「手动下载」。
 *   2) download()/install() 交给 electron-updater：拉 latest.yml、校验 sha512、跑 NSIS 静默安装。
 */

'use strict';

const api = require('./api');
const store = require('./store');

/* ================= 版本比较（纯函数，便于单测） ================= */

function parseVersion(value) {
	const m = String(value == null ? '' : value)
		.trim()
		.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/);
	if (!m) return null;
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/* 返回 -1 / 0 / 1。任一侧无法解析时返回 0（按「一样新」处理：宁可漏报，不误报） */
function compareVersions(a, b) {
	const va = parseVersion(a);
	const vb = parseVersion(b);
	if (!va || !vb) return 0;
	for (let i = 0; i < 3; i += 1) {
		if (va.nums[i] !== vb.nums[i]) return va.nums[i] > vb.nums[i] ? 1 : -1;
	}
	if (va.pre === vb.pre) return 0;
	if (!va.pre) return 1; /* 正式版 > 预发布版 */
	if (!vb.pre) return -1;
	return va.pre > vb.pre ? 1 : -1;
}

const isNewer = (latest, current) => compareVersions(latest, current) > 0;

/* 更新源地址。账号服务地址可在「高级设置」里改，本地联调时指向 dev 即可换源 */
function feedUrl(base) {
	const b = String(base == null ? store.load().accountApiBase || '' : base).replace(/\/+$/, '');
	return b ? b + '/download' : '';
}

/* 把 electron-updater 的报错翻成用户能看懂的一句话 */
function shortMessage(err) {
	const code = String((err && err.code) || '');
	const raw = String((err && err.message) || err || '');
	if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /\b404\b/.test(raw)) {
		return '更新服务上还没有发布新版安装包';
	}
	if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return '安装包校验未通过，已中止更新';
	if (code === 'ERR_UPDATER_NO_CHECKSUM' || code === 'ERR_UPDATER_INVALID_UPDATE_INFO') {
		return '更新元数据异常，请改用「手动下载」';
	}
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up|network/i.test(code + raw)) {
		return '网络错误，无法连接更新服务';
	}
	return raw.split('\n')[0].slice(0, 200) || '更新失败';
}

/* ================= 运行时状态 ================= */

const state = {
	/* idle | checking | latest | available | downloading | ready | error */
	status: 'idle',
	current: '',
	latest: '',
	notes: '',
	downloadUrl: '',
	portableUrl: '',
	percent: 0,
	error: '',
	canAutoUpdate: false,
};

let onState = null;
let updater = null;
let devMode = false;

function emit(patch) {
	Object.assign(state, patch);
	if (onState) onState(getState());
}

function getState() {
	return { ...state };
}

function init(opts) {
	const o = opts || {};
	state.current = String(o.version || '');
	/* 便携版是绿色免安装，没有可被覆盖的安装目录，electron-updater 装不了 */
	state.canAutoUpdate = !o.isPortable;
	/* 未打包时 electron-updater 默认拒绝工作，打开开关便于本地联调 */
	devMode = !o.isPackaged;
	onState = typeof o.onState === 'function' ? o.onState : null;
}

/* ================= 检查 ================= */

async function check() {
	emit({ status: 'checking', error: '' });
	const info = await api.getLatest();
	if (!info || info.error) {
		const error = (info && info.error) || '网络错误，无法连接更新服务';
		emit({ status: 'error', error });
		return { ok: false, error, current: state.current };
	}

	const latest = String(info.version || '');
	if (!latest || !isNewer(latest, state.current)) {
		emit({
			status: 'latest',
			latest: latest || state.current,
			notes: '',
			downloadUrl: String(info.downloadUrl || ''),
			portableUrl: String(info.portableUrl || ''),
			percent: 0,
			error: '',
		});
		return { ok: true, hasUpdate: false, current: state.current, latest: latest || state.current };
	}

	emit({
		status: 'available',
		latest,
		notes: String(info.notes || ''),
		downloadUrl: String(info.downloadUrl || ''),
		portableUrl: String(info.portableUrl || ''),
		percent: 0,
		error: '',
	});
	return {
		ok: true,
		hasUpdate: true,
		current: state.current,
		latest,
		notes: String(info.notes || ''),
		downloadUrl: String(info.downloadUrl || ''),
		portableUrl: String(info.portableUrl || ''),
		canAutoUpdate: state.canAutoUpdate,
	};
}

/* ================= 下载 / 安装 ================= */

function getUpdater() {
	if (updater) return updater;
	let NsisUpdater;
	try {
		({ NsisUpdater } = require('electron-updater'));
	} catch {
		return null;
	}
	const url = feedUrl();
	if (!url) return null;

	updater = new NsisUpdater({ provider: 'generic', url, channel: 'latest' });
	/* 不在「退出应用」时偷偷装：本工具可能正在写别的客户端配置，
	 * 必须由用户点「重启并安装」才动 */
	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = false;
	updater.forceDevUpdateConfig = devMode;

	updater.on('download-progress', (p) => {
		const percent = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
		emit({ status: 'downloading', percent });
	});
	updater.on('update-downloaded', (info) => {
		emit({ status: 'ready', latest: String((info && info.version) || state.latest), percent: 100, error: '' });
	});
	updater.on('error', (e) => {
		emit({ status: 'error', error: shortMessage(e) });
	});
	return updater;
}

async function download() {
	if (!state.canAutoUpdate) {
		return { ok: false, error: '当前版本不支持应用内自动更新，请点「手动下载」安装新版' };
	}
	const u = getUpdater();
	if (!u) return { ok: false, error: '当前环境不支持应用内自动更新，请点「手动下载」' };

	emit({ status: 'downloading', percent: 0, error: '' });
	try {
		const r = await u.checkForUpdates();
		if (!r || !r.updateInfo) {
			const error = '更新服务上还没有发布新版安装包';
			emit({ status: 'error', error });
			return { ok: false, error };
		}
		await u.downloadUpdate();
		emit({ status: 'ready', latest: String(r.updateInfo.version || state.latest), percent: 100, error: '' });
		return { ok: true, version: r.updateInfo.version };
	} catch (e) {
		/* 下载过程中的异步错误已由 error 事件写过一次，避免文案被堆栈覆盖 */
		const error = state.status === 'error' && state.error ? state.error : shortMessage(e);
		emit({ status: 'error', error });
		return { ok: false, error };
	}
}

function install() {
	if (state.status !== 'ready' || !updater) return { ok: false, error: '更新还没下载完，请稍候' };
	/* 静默安装（/S）+ 装完自动拉起，用户只需点一次 */
	updater.quitAndInstall(true, true);
	return { ok: true };
}

module.exports = {
	init,
	check,
	download,
	install,
	getState,
	/* 供单测使用的纯函数 */
	parseVersion,
	compareVersions,
	isNewer,
	feedUrl,
	shortMessage,
};