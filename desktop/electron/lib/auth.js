/**
 * 账号登录 / 注册（用户名 + 密码，无需邮箱）
 *
 * 请求由主进程直接发起，带 X-CCB-Client 标识：服务端据此跳过 Turnstile 人机验证
 * （桌面端渲染层是 file:// 来源，Cloudflare Turnstile 不支持该来源）。
 * 账号写入 users 表时 email 恒为 NULL，与中转站网页邮箱流程互不影响。
 */

const api = require('./api');
const store = require('./store');

/** 登录/注册成功后持久化登录态并拉取最新档案 */
async function adoptSession(res, fallbackError) {
	if (!res || res.error || !res.token) {
		return { ok: false, error: (res && res.error) || fallbackError };
	}
	store.save({ token: res.token, user: res.user || null });
	api.setToken(res.token);
	const profile = await api.getProfile();
	if (profile && profile.user) {
		store.save({ user: profile.user });
		return { ok: true, user: profile.user };
	}
	/* 档案拉取失败不影响登录本身：token 已存，用注册/登录返回的用户信息兜底 */
	return { ok: true, user: res.user || null };
}

async function loginWithPassword(username, password) {
	if (!api.getBaseUrl()) return { ok: false, error: '未配置账号服务地址' };
	return adoptSession(await api.login(username, password), '登录失败，请重试');
}

async function registerWithPassword(username, password) {
	if (!api.getBaseUrl()) return { ok: false, error: '未配置账号服务地址' };
	return adoptSession(await api.register(username, password), '注册失败，请重试');
}

async function logout() {
	try {
		await api.logout();
	} catch {}
	store.save({ token: null, user: null });
	api.setToken(null);
	return { ok: true };
}

module.exports = { loginWithPassword, registerWithPassword, logout };