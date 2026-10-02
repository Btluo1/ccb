import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* store 桩：updater.js 是 CJS，其内部 require('./store') 不走 vitest 的 mock 注册表，
 * 实际读到的仍是真实 store（测试环境下 app.getPath 抛错 → 回落默认值，结果确定）。
 * 这里保留桩以表达意图；需要改地址的分支改用 store 支持的 CCB_API_BASE 环境变量。 */
const storeStub = vi.hoisted(() => ({ base: 'https://ccb.btluo.com' }));

vi.mock('../electron/lib/store', () => ({
	load: () => ({ accountApiBase: storeStub.base, token: null }),
	save: vi.fn(),
}));

import updater from '../electron/lib/updater';

const {
	parseVersion,
	compareVersions,
	isNewer,
	feedUrl,
	shortMessage,
	init,
	check,
	download,
	install,
	getState,
} = updater;

function mockFetch(handler) {
	global.fetch = vi.fn(handler);
}

const latestResponse = (body) => async () => ({ ok: true, status: 200, json: async () => body });

describe('检查更新：版本比较', () => {
	it('parseVersion 解析三段版本号与预发布标记', () => {
		expect(parseVersion('v1.0.4')).toEqual({ nums: [1, 0, 4], pre: '' });
		expect(parseVersion('1.2.3-beta.1')).toEqual({ nums: [1, 2, 3], pre: 'beta.1' });
		expect(parseVersion('1.0')).toBe(null);
		expect(parseVersion('')).toBe(null);
	});

	it('按数字段比较，逐段回退', () => {
		expect(compareVersions('1.0.4', '1.0.3')).toBe(1);
		expect(compareVersions('1.0.3', '1.0.4')).toBe(-1);
		expect(compareVersions('1.0.4', '1.0.4')).toBe(0);
		expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
		expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
	});

	it('正式版比同号预发布版新', () => {
		expect(compareVersions('1.0.4', '1.0.4-beta.1')).toBe(1);
		expect(compareVersions('1.0.4-beta.1', '1.0.4')).toBe(-1);
	});

	it('无法解析的版本号按「一样新」处理（宁可漏报不误报）', () => {
		expect(compareVersions('abc', '1.0.4')).toBe(0);
		expect(compareVersions('1.0.4', undefined)).toBe(0);
		expect(isNewer('1.0.4', 'abc')).toBe(false);
	});

	it('isNewer 只在严格更新时为真', () => {
		expect(isNewer('1.0.4', '1.0.3')).toBe(true);
		expect(isNewer('1.0.3', '1.0.3')).toBe(false);
		expect(isNewer('1.0.2', '1.0.3')).toBe(false);
	});
});

describe('检查更新：更新源地址', () => {
	it('账号服务地址 + /download，尾斜杠不重复', () => {
		expect(feedUrl('https://ccb.btluo.com')).toBe('https://ccb.btluo.com/download');
		expect(feedUrl('https://ccb.btluo.com/')).toBe('https://ccb.btluo.com/download');
		expect(feedUrl('http://127.0.0.1:8787//')).toBe('http://127.0.0.1:8787/download');
	});

	it('不传参时读账号服务地址（默认生产地址）', () => {
		expect(feedUrl()).toBe('https://ccb.btluo.com/download');
	});

	it('账号服务地址为空时返回空串（调用方据此放弃自动更新）', () => {
		expect(feedUrl('')).toBe('');
	});
});

describe('检查更新：错误文案', () => {
	it('元数据 404 提示「还没发布新版安装包」', () => {
		const e = Object.assign(new Error('Cannot find channel "latest.yml"'), {
			code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
		});
		expect(shortMessage(e)).toBe('更新服务上还没有发布新版安装包');
	});

	it('网络类错误提示网络问题', () => {
		expect(shortMessage(Object.assign(new Error('getaddrinfo ENOTFOUND ccb.btluo.com'), { code: 'ENOTFOUND' }))).toBe(
			'网络错误，无法连接更新服务'
		);
	});

	it('签名校验失败单独提示', () => {
		expect(shortMessage(Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }))).toBe(
			'安装包校验未通过，已中止更新'
		);
	});

	it('未知错误取首行，不把堆栈整段抛给用户', () => {
		expect(shortMessage(new Error('第一行\n第二行'))).toBe('第一行');
		expect(shortMessage(null)).toBe('更新失败');
	});
});

describe('检查更新：check()', () => {
	beforeEach(() => {
		global.fetch = undefined;
	});

	it('服务端版本更新：置 available 并把下载地址带出来', async () => {
		const events = [];
		init({ version: '1.0.3', isPackaged: true, isPortable: false, onState: (s) => events.push(s) });
		mockFetch(
			latestResponse({
				version: '1.0.4',
				downloadUrl: 'https://ccb.btluo.com/download/ccb-setup.exe',
				portableUrl: 'https://ccb.btluo.com/download/ccb-portable.exe',
				notes: '新增检查更新',
			})
		);

		const r = await check();
		expect(r).toMatchObject({ ok: true, hasUpdate: true, current: '1.0.3', latest: '1.0.4', canAutoUpdate: true });
		expect(getState()).toMatchObject({
			status: 'available',
			latest: '1.0.4',
			notes: '新增检查更新',
			downloadUrl: 'https://ccb.btluo.com/download/ccb-setup.exe',
			error: '',
		});
		expect(events.at(-1).status).toBe('available');
	});

	it('版本相同：置 latest，不显示横幅', async () => {
		init({ version: '1.0.4', isPackaged: true, isPortable: false, onState: null });
		mockFetch(latestResponse({ version: '1.0.4' }));

		const r = await check();
		expect(r).toMatchObject({ ok: true, hasUpdate: false, latest: '1.0.4' });
		expect(getState().status).toBe('latest');
	});

	it('服务端版本更旧（回滚场景）不提示更新', async () => {
		init({ version: '1.0.4', isPackaged: true, isPortable: false, onState: null });
		mockFetch(latestResponse({ version: '1.0.3' }));
		expect((await check()).hasUpdate).toBe(false);
	});

	it('接口报错：置 error 且给出可读原因', async () => {
		init({ version: '1.0.3', isPackaged: true, isPortable: false, onState: null });
		mockFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: '服务器开小差了' }) }));

		const r = await check();
		expect(r.ok).toBe(false);
		expect(r.error).toBe('服务器开小差了');
		expect(getState().status).toBe('error');
	});

	it('网络异常：置 error 且提示网络问题', async () => {
		init({ version: '1.0.3', isPackaged: true, isPortable: false, onState: null });
		mockFetch(async () => {
			throw new TypeError('fail to fetch');
		});

		const r = await check();
		expect(r.ok).toBe(false);
		expect(r.error).toContain('网络错误');
	});
});

describe('检查更新：便携版不支持应用内安装', () => {
	it('便携版仍能提示新版本，但 canAutoUpdate 为 false', async () => {
		init({ version: '1.0.3', isPackaged: true, isPortable: true, onState: null });
		mockFetch(latestResponse({ version: '1.0.4', portableUrl: 'https://ccb.btluo.com/download/ccb-portable.exe' }));

		const r = await check();
		expect(r.hasUpdate).toBe(true);
		expect(r.canAutoUpdate).toBe(false);
		expect(getState().portableUrl).toBe('https://ccb.btluo.com/download/ccb-portable.exe');
	});

	it('便携版调 download() 直接拒绝，不触碰 electron-updater', async () => {
		init({ version: '1.0.3', isPackaged: true, isPortable: true, onState: null });
		const r = await download();
		expect(r.ok).toBe(false);
		expect(r.error).toContain('手动下载');
	});
});

describe('检查更新：下载 / 安装分支', () => {
	afterEach(() => {
		delete process.env.CCB_API_BASE;
		storeStub.base = 'https://ccb.btluo.com';
	});

	it('更新源地址解析为空：放弃自动更新，引导手动下载', async () => {
		/* '/' 去掉尾斜杠后为空串，等价于「没配账号服务地址」。
		 * 同时写 store 桩与环境变量，保证无论哪条路径生效都命中该分支 */
		storeStub.base = '/';
		process.env.CCB_API_BASE = '/';
		init({ version: '1.0.3', isPackaged: true, isPortable: false, onState: null });

		expect(feedUrl()).toBe('');
		const r = await download();
		expect(r.ok).toBe(false);
		expect(r.error).toContain('手动下载');
	});

	it('还没下载完就点安装：拒绝并提示稍候，不触发安装流程', () => {
		init({ version: '1.0.3', isPackaged: true, isPortable: false, onState: null });
		expect(install()).toEqual({ ok: false, error: '更新还没下载完，请稍候' });
	});
});