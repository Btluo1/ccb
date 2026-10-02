/**
 * 后端 API 客户端（账号 / 余额 / 兑换 / 平台密钥 / 模型）
 *
 * 所有请求由主进程发起（不受渲染层 CORS 限制），登录后自动附带 Bearer Token。
 * 后端即 CCB 账号服务 https://ccb.btluo.com 的 /api/* 接口。
 */

const store = require('./store');

let _token = null;

function getBaseUrl() {
	return (store.load().accountApiBase || '').replace(/\/+$/, '');
}

function setToken(token) {
	_token = token || null;
}

async function request(pathname, options = {}) {
	const base = getBaseUrl();
	if (!base) return { error: '未配置账号服务地址' };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30000);
	let res;
	try {
		const headers = { 'Content-Type': 'application/json; charset=utf-8' };
		if (_token) headers['Authorization'] = 'Bearer ' + _token;
		res = await fetch(base + pathname, {
			...options,
			headers: { ...headers, ...(options.headers || {}) },
			signal: controller.signal,
		});
	} catch (e) {
		return { error: e && e.name === 'AbortError' ? '请求超时，请检查网络' : '网络错误，请检查网络连接' };
	} finally {
		clearTimeout(timer);
	}

	let data;
	try {
		data = await res.json();
	} catch {
		data = { error: `响应解析失败（HTTP ${res.status}）` };
	}
	if (!res.ok && !data.error) data.error = `请求失败（HTTP ${res.status}）`;
	return data;
}

/* 桌面客户端标识：服务端据此跳过 Turnstile（桌面端跑不了人机验证，见 src/index.js） */
const CLIENT_HEADER = 'X-CCB-Client';
const CLIENT_ID = 'ccb-desktop';

const get = (p) => request(p, { method: 'GET' });
const post = (p, body) =>
	request(p, {
		method: 'POST',
		body: JSON.stringify(body || {}),
		headers: { [CLIENT_HEADER]: CLIENT_ID },
	});

module.exports = {
	setToken,
	getBaseUrl,
	getProfile: () => get('/api/user/profile'),
	getModels: () => get('/api/models'),
	/* 最新桌面端版本信息（公开接口，无需登录） */
	getLatest: () => get('/api/latest'),
	getCurrentKey: (provider) =>
		get('/api/user/current-key' + (provider ? '?provider=' + encodeURIComponent(provider) : '')),
	redeem: (code) => post('/api/user/redeem', { code }),
	logout: () => post('/api/auth/logout', {}),
	login: (username, password) => post('/api/auth/login', { username, password }),
	register: (username, password) => post('/api/auth/register', { username, password }),
};
