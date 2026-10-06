'use strict';

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
function toast(msg) {
	const t = $('#toast');
	t.textContent = msg;
	t.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function copyText(text) {
	try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const state = {
	user: null,
	usage: null,     // { today, total }：/api/user/profile 返回的用量（美元，北京时间口径）
	models: [],
	client: null,
	clients: [],
	clientsReady: false,   // 是否已完成过一次客户端检测（决定「未检测到」提示是否可信）
	onboarded: false,      // 新手引导是否已看过（持久化在 config.json）
	selection: {},
	selectionInit: false,
	keys: {},        // provider -> { apiKey, baseUrl }
	apiBase: 'https://code.btluo.com/v1',
	anthropicBase: 'https://code.btluo.com',
	accountApiBase: 'https://ccb.btluo.com',
	defaultModel: '',
	/* Cursor 接入模式：'byok'（官方自定义模型）| 'mitm'（本地代理接管，模仿 cursor-agent） */
	cursorMode: 'byok',
	/* Cursor MITM 上游高级参数（apiFormat / apiKeyHeader / maxTokens / temperature /
	 * timeout / contextTokenLimit / compression），持久化在 config.json.cursorUpstream */
	cursorUpstream: {},
	/* 高级选项折叠面板是否展开（仅界面状态，不持久化） */
	cuOpen: false,
	lastLog: {},
	results: {},     // clientId -> { ok, text, launch }
	running: {},
	/* 已点「稍后」的新版本号：同一版本不再自动弹横幅，点「检查更新」仍会提示 */
	dismissedUpdate: '',
	/* 路径校验待确认：用户选了「看起来不像该客户端」的路径，弹确认条等其决定。
	 * pendingPath 为待定路径；pendingClient 为对应客户端 id。null 表示无待确认项。 */
	pendingMismatch: null,
};

const selectedModels = () => state.models;
const modelIds = () => state.models.map((m) => m.id);
const fmtCredits = (n) => '$' + Number(n || 0).toFixed(2);
/* 用量金额常小到 $0.000x 级别，固定 2 位小数会显示成 $0.00，这里用 4 位 */
const fmtUsage = (n) => {
	const v = Number(n || 0);
	return v === 0 ? '$0.00' : '$' + v.toFixed(4);
};

function maskedKey(key) {
	if (!key) return 'YOUR_API_KEY';
	if (key.length <= 12) return key.slice(0, 4) + '••••';
	return key.slice(0, 7) + '••••••' + key.slice(-4);
}

function ensureDefaultModel() {
	const ids = modelIds();
	if (!ids.includes(state.defaultModel)) state.defaultModel = ids[0] || '';
}

function persist() {
	window.ccb.saveState({
		apiBaseUrl: state.apiBase,
		anthropicBaseUrl: state.anthropicBase,
		accountApiBase: state.accountApiBase,
		models: state.models.map((m) => ({ id: m.id, selected: true })),
	defaultModel: state.defaultModel,
	cursorMode: state.cursorMode,
	cursorUpstream: state.cursorUpstream || {},
});
}

/* ================= 视图切换 ================= */
function showAuth() {
	$('#viewAuth').hidden = false;
	$('#viewMain').hidden = true;
}

function enterMain() {
	$('#viewAuth').hidden = true;
	$('#viewMain').hidden = false;
	renderUser();
	renderClients();
	renderModels();
	renderUpdate();
	/* 静默检查一次更新：有新版本才弹横幅，失败不打扰 */
	setTimeout(() => checkUpdate(false), 600);
	/* 首次使用：进主界面后自动弹出三步引导（已看过则不再打扰） */
	if (!state.onboarded && !guideShownThisSession) setTimeout(startGuide, 350);
}

function setUser(user, usage) {
	state.user = user || null;
	/* 旧服务端 profile 无 usage 字段时保留上次值，登出时统一清空 */
	if (usage) state.usage = usage;
	renderUser();
}

function renderUser() {
	if (!state.user) return;
	$('#userChip').textContent = `${state.user.username || state.user.email || '用户'} · ${fmtCredits(state.user.credits)}`;
	const v = $('#balanceValue');
	v.textContent = fmtCredits(state.user.credits);
	v.classList.toggle('low', !(Number(state.user.credits) > 0));
	/* 今日 / 累计用量：客户端跑模型按量扣费后，这里能看到花了多少 */
	const t = $('#usageToday');
	const tot = $('#usageTotal');
	if (state.usage) {
		t.textContent = fmtUsage(state.usage.today);
		tot.textContent = fmtUsage(state.usage.total);
	} else {
		t.textContent = '—';
		tot.textContent = '—';
	}
	renderGuideHints();
}

/* ================= 登录 / 注册 / 登出 ================= */
let authMode = 'login';

function setAuthStatus(kind, msg) {
	const el = $('#authStatus');
	if (!kind) { el.className = 'status'; el.textContent = ''; return; }
	const icon = { ok: '✓', err: '✕', wait: '⟳' }[kind] || '';
	el.className = 'status ' + kind;
	el.textContent = (icon ? icon + ' ' : '') + msg;
}

function setAuthMode(mode) {
	authMode = mode === 'register' ? 'register' : 'login';
	const reg = authMode === 'register';
	$('#tabLogin').classList.toggle('on', !reg);
	$('#tabRegister').classList.toggle('on', reg);
	$('#fPass2Row').hidden = !reg;
	$('#authBtn').textContent = reg ? '注册并登录' : '登录';
	$('#fPass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
	setAuthStatus('', '');
}

function clearAuthForm() {
	$('#fUser').value = '';
	$('#fPass').value = '';
	$('#fPass2').value = '';
}

async function submitAuth() {
	const reg = authMode === 'register';
	const username = $('#fUser').value.trim();
	const password = $('#fPass').value;

	if (!username) { setAuthStatus('err', '请输入用户名'); $('#fUser').focus(); return; }
	if (!password) { setAuthStatus('err', '请输入密码'); $('#fPass').focus(); return; }
	if (reg && password !== $('#fPass2').value) {
		setAuthStatus('err', '两次输入的密码不一致');
		$('#fPass2').focus();
		return;
	}

	$('#authBtn').disabled = true;
	$('#tabLogin').disabled = true;
	$('#tabRegister').disabled = true;
	setAuthStatus('wait', reg ? '正在注册…' : '正在登录…');

	const r = reg
		? await window.ccb.auth.register(username, password)
		: await window.ccb.auth.login(username, password);

	$('#authBtn').disabled = false;
	$('#tabLogin').disabled = false;
	$('#tabRegister').disabled = false;

	if (!r.ok) {
		setAuthStatus('err', r.error || (reg ? '注册失败，请重试' : '登录失败，请重试'));
		return;
	}

	clearAuthForm();
	setAuthStatus('ok', `欢迎，${(r.user && r.user.username) || '用户'}！`);
	setUser(r.user);
	enterMain();
	loadModelsSilently();
	/* 登录接口的返回不含用量数据，进主界面后静默补拉一次今日 / 累计用量 */
	window.ccb.api
		.profile()
		.then((p) => {
			if (p && p.user) setUser(p.user, p.usage);
		})
		.catch(() => {});
	toast(reg ? '注册成功，已自动登录' : '登录成功');
}

async function doLogout() {
	await window.ccb.auth.logout();
	state.user = null;
	state.usage = null;
	state.keys = {};
	state.results = {};
	state.running = {};
	clearAuthForm();
	setAuthMode('login');
	showAuth();
	toast('已退出登录');
}

/* ================= 模型 ================= */
async function loadModelsSilently() {
	/* 每次启动都静默刷新：服务端模型目录会持续新增，本地缓存只在请求失败时兜底，
	   否则老用户会永远停在首次配置时的旧模型列表（v1.0.13 及之前的缺陷） */
	try {
		const m = await window.ccb.api.models();
		if (m && Array.isArray(m.models)) {
			const list = m.models.filter((x) => x && x.id && x.available !== false);
			if (list.length) {
				state.models = list.map((x) => ({ id: x.id, codebuddyModel: x.codebuddyModel || x.id, selected: true }));
				ensureDefaultModel();
				persist();
				renderModels();
			}
		}
	} catch {
		/* 网络异常：保留本地缓存列表 */
	}
}

function renderModels() {
	const box = $('#modelsBox');
	$('#modelCnt2').textContent = state.models.length;
	box.style.display = state.models.length ? '' : 'none';
	$('#modelChips').innerHTML = state.models.length
		? state.models.map((m) => `<span class="chip">${esc(m.id)}</span>`).join('')
		: '';
}

/* ================= 平台密钥（按 provider 缓存） ================= */
async function ensureKey(provider) {
	if (!provider) return null;
	if (state.keys[provider]) return state.keys[provider];
	const r = await window.ccb.api.currentKey(provider);
	if (!r || r.error) return null;
	let apiKey = null;
	if (r.key && typeof r.key === 'object') apiKey = r.key.apiKey || r.key.key || null;
	else if (typeof r.key === 'string') apiKey = r.key;
	if (!apiKey) return null;
	state.keys[provider] = { apiKey, baseUrl: r.baseUrl || null };
	return state.keys[provider];
}

function clientKey(c) {
	return state.keys[c.provider || 'openai'] || null;
}

/* 客户端对应的 base 地址（服务端下发优先） */
function clientApiBase(c) {
	const k = clientKey(c);
	return (k && k.baseUrl) || state.apiBase;
}

/* WorkBuddy / CodeBuddy 使用平台为 CodeBuddy 映射的模型名 */
function clientModelIds(c) {
	return c.writer === 'workbuddy' || c.writer === 'codebuddy'
		? state.models.map((m) => m.codebuddyModel || m.id)
		: modelIds();
}

/* ================= 兑换卡 ================= */
async function doRedeem() {
	const input = $('#redeemInput');
	const code = input.value.trim();
	const el = $('#redeemStatus');
	if (!code) { el.className = 'status err'; el.textContent = '✕ 请输入兑换卡卡密'; input.focus(); return; }

	const btn = $('#redeemBtn');
	btn.disabled = true;
	btn.textContent = '兑换中…';
	const r = await window.ccb.api.redeem(code);
	btn.disabled = false;
	btn.textContent = '兑换';

	if (r && !r.error) {
		input.value = '';
		const p = await window.ccb.api.profile();
		if (p && p.user) setUser(p.user, p.usage);
		el.className = 'status ok';
		el.textContent = `✓ 兑换成功，获得 ${fmtCredits(r.credits)}，当前余额 ${fmtCredits(state.user ? state.user.credits : 0)}`;
		toast('兑换成功');
		if (guideOpen()) renderGuideStep(); /* 引导停在第 1 步时刷新文案为「已就绪」 */
	} else {
		el.className = 'status err';
		el.textContent = '✕ ' + ((r && r.error) || '兑换失败，请核对卡密');
	}
}

/* ================= 购买兑换卡弹窗 ================= */
const buyCardOpen = () => !$('#buyCardModal').hidden;
function openBuyCard() {
	$('#buyCardDim').hidden = false;
	$('#buyCardModal').hidden = false;
}
function closeBuyCard() {
	$('#buyCardDim').hidden = true;
	$('#buyCardModal').hidden = true;
}

/* ================= 客户端卡片 ================= */
/* 客户端图标：优先用真实品牌图标（icons/<brand>.png），加载失败回退到字母徽标 */
function clientIcon(c, cls) {
	if (c.icon) {
		return `<div class="cicon img ${cls || ''}" style="--a:${c.accent}"><img src="icons/${esc(c.icon)}.png" alt="" loading="lazy" onerror="this.parentNode.classList.remove('img');this.remove();this.parentNode.innerHTML='<span>${esc(c.glyph || '')}</span>';" /></div>`;
	}
	const wide = c.glyph && c.glyph.length > 1;
	return `<div class="cicon ${cls || ''}" style="--a:${c.accent}"><span class="${wide ? 'wide' : ''}">${esc(c.glyph)}</span></div>`;
}

/* Qoder IDE 系（qoder-intl 国际版 / qoder-cn 中国版）暂不可用：两者的聊天推理都在
 * Qoder 云端执行，模型端点由服务端按「服务商」写死，客户端无法指向第三方中转。逐步取证：
 *   1) CN IDE 的推理请求发往 gateway.qoder.com.cn/algo/api/v2/service/pro/sse/
 *      agent_chat_generation，鉴权用 Qoder 登录 token（不是 per-model 的 sk-ccb 密钥），
 *      请求体 CosyClient 加密（Encode=1）→ 本地 MITM 既识别不出、也改不了。
 *   2) 自定义模型的「服务商」是服务端下发的固定 7 家（bailian/qwencloud-cn/zhipu/kimi/
 *      minimax/deepseek/xiaomi-china），fields 只有 api_key，没有 endpoint/base_url 输入项。
 *   3) 实测两点互证（2026-10-07）：provider='custom'（自造 key）→ 云端 100400
 *      「Failed to generate custom pool」；provider='zhipu'（官方已知 key）→ 池建起来了，
 *      但按智谱官方端点鉴权我们的 sk-ccb → 「自定义模型认证失败」。即端点永远在官方，
 *      条目里的 baseUrl 不被采用（v3 挂 deepseek 时也是同一结论）。
 * 客户端仍保留写入器（老用户可回滚），但不再出现在一键配置清单里。
 * 已打通的是：Qoder CN 桌面版（qoder-app-cn，本机运行 worker + qoderbridge 桥）、
 * QoderWork 系（qoderwork-cn / qoderwork-intl，同 worker 桥方案）。 */
const UNSUPPORTED = new Set(['qoder-intl', 'qoder-cn']);

function clientStatus(c) {
	if (UNSUPPORTED.has(c.id)) return { cls: 'st-unsupported', label: '暂不可用' };
	if (!c.installed) return { cls: 'st-missing', label: '未检测到' };
	/* 用户强制的自定义路径与该客户端对不上（如把 Trae 指到 Qoder 目录），
	 * 或之前指定的路径已失效：仍允许配置/启动，但卡片标黄提示「路径待核对」。 */
	if (c.details && (c.details.pathMatched === 'none' || c.details.pathMatched === 'stale'))
		return { cls: 'st-warn', label: '路径待核对' };
	if (state.running[c.id]) return { cls: 'st-running', label: '配置中…' };
	const r = state.results[c.id];
	if (!r) return { cls: 'st-pending', label: '待配置' };
	return r.ok
		? { cls: 'st-done', label: '已配置 ✓' }
		: { cls: 'st-fail', label: '失败 · 点详情' };
}

/* 按 id 取当前检测结果（事件回调里多处用到） */
function c0(id) { return state.clients.find((x) => x.id === id); }

/* 保存路径后的提示语，按匹配等级区分，让用户知道是否需要进一步核对 */
function pathMatchToast(r, c) {
	const name = (c && c.name) || '客户端';
	if (!r || !r.ok) return `${name} 路径已保存`;
	if (r.matched === 'strong') return `${name} 路径已保存，已定位程序`;
	if (r.matched === 'medium') return `${name} 路径已保存，但程序名未确认，建议核对`;
	return `${name} 路径已保存`;
}

function renderClients() {
	/* 暂不可用的客户端（UNSUPPORTED）直接隐藏，不渲染卡片 */
	const visible = state.clients.filter((c) => !UNSUPPORTED.has(c.id));
	$('#clientGrid').innerHTML = visible.map((c) => {
		const st = clientStatus(c);
		const checked = !!state.selection[c.id];
		const unsupported = UNSUPPORTED.has(c.id);
		const disabled = !c.installed || unsupported;
		return `
		<div class="client-card ${checked && !disabled ? 'sel' : ''} ${disabled ? 'disabled' : ''} ${unsupported ? 'unsupported' : ''}" data-client="${c.id}">
			<div class="cc-check"><input type="checkbox" ${checked && !unsupported ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="选择 ${esc(c.name)}" /></div>
			<div class="cc-top">
				${clientIcon(c)}
				<div class="cc-name">${esc(c.name)}${c.variant ? `<span class="variant">${esc(c.variant)}</span>` : ''}</div>
			</div>
			<div class="cc-desc">${esc(c.vendor)} · ${unsupported ? '暂不可用' : '全自动写入'}</div>
			<div class="cc-badges">
				<span class="badge ${st.cls}">${st.label}</span>
				<button class="btn sm ghost detail-btn" data-detail="${c.id}" type="button">详情</button>
			</div>
		</div>`;
	}).join('');
	renderGuideHints();
}

function selectableClients() {
	return state.clients.filter((c) => c.installed && !UNSUPPORTED.has(c.id));
}

/* 单选模式：每次只能配置并启动一个客户端，默认选中第一个可配置的 */
function defaultSelection() {
	if (state.selectionInit) return;
	state.selectionInit = true;
	const first = selectableClients()[0];
	if (first) state.selection[first.id] = true;
}

/* 点卡片切换选择：选中新卡片时自动取消其它（单选）；再点已选中的卡片则取消选择 */
function toggleSelect(id) {
	if (state.selection[id]) {
		state.selection = {};
	} else {
		state.selection = { [id]: true };
	}
	renderClients();
}

/* ================= 一键配置并启动 ================= */
const BTN_HTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg> 一键配置并启动`;

async function applyAll() {
	const btn = $('#applyAllBtn');
	btn.disabled = true;
	btn.innerHTML = '正在自动配置…';

	try {
		/* 1. 校验登录态并刷新余额 */
		const p = await window.ccb.api.profile();
		if (p.error || !p.user) {
			toast('登录已过期，请重新登录');
			await doLogout();
			return;
		}
		setUser(p.user, p.usage);
		if (!(Number(p.user.credits) > 0)) toast('提示：当前余额为 0，建议先在上方兑换卡密');

		/* 2. 获取模型列表 */
		let list = [];
		const m = await window.ccb.api.models();
		if (m && Array.isArray(m.models)) {
			list = m.models.filter((x) => x && x.id && x.available !== false);
		}
		if (!list.length) {
			const k = await ensureKey('openai');
			if (k) {
				const v = await window.ccb.verifyKey(k.baseUrl || state.apiBase, k.apiKey);
				if (v.ok) list = v.models.map((id) => ({ id }));
			}
		}
		if (!list.length) {
			toast('未获取到可用模型，请稍后重试');
			return;
		}
		state.models = list.map((x) => ({ id: x.id, codebuddyModel: x.codebuddyModel || x.id, selected: true }));
		ensureDefaultModel();
		persist();
		renderModels();

		/* 3. 选中的客户端（单选：每次只配置并启动一个；slice 兜底防状态异常多选） */
		const selected = state.clients.filter((c) => state.selection[c.id] && c.installed).slice(0, 1);
		if (!selected.length) {
			toast('请先选择要配置的客户端');
			return;
		}

		/* 4. 拉取各 provider 的平台密钥 */
		const providers = [...new Set(selected.map((c) => c.provider).filter(Boolean))];
		for (const prov of providers) {
			const k = await ensureKey(prov);
			if (!k) toast(`获取 ${prov} 平台密钥失败，相关客户端可能配置不完整`);
		}

		/* 5. 写入全部客户端配置 */
		state.results = {};
		state.running = {};
		for (const c of selected) {
			const k = clientKey(c) || {};
			state.running[c.id] = true;
			renderClients();
			const r = await window.ccb.applyConfig(c.id, {
				apiKey: k.apiKey || '',
				apiBase: clientApiBase(c),
				anthropicBase: state.keys['anthropic'] ? (state.keys['anthropic'].baseUrl || state.anthropicBase) : state.anthropicBase,
				models: clientModelIds(c),
				defaultModel: state.defaultModel,
			cursorMitm: c.id === 'cursor' ? { enabled: state.cursorMode === 'mitm' } : undefined,
		});
		const text = (r.log || []).concat(r.ok ? [] : [r.error || '写入失败']).join('\n');
			state.lastLog[c.id] = { ok: !!r.ok, text };
			state.results[c.id] = { ok: !!r.ok, text, warning: r.warning || null, launch: null };
			state.running[c.id] = false;
			renderClients();
		}

		/* 6. 启动 / 重启全部选中客户端 */
		for (const c of selected) {
			if (!state.results[c.id]) state.results[c.id] = { ok: null, text: '', launch: null };
			const l = await window.ccb.launchClient(c.id);
			state.results[c.id].launch = l;
			renderClients();
		}

	showSummary(selected);
	const doneNames = selected.filter((c) => state.results[c.id] && state.results[c.id].ok).map((c) => c.name);
	const needLoginNames = selected.filter((c) => {
		const r = state.results[c.id] || {};
		return clientLoginReq(c) && (!r.ok || r.warning);
	}).map((c) => c.name);
	const warnN = selected.filter((c) => {
		const r = state.results[c.id] || {};
		return r.ok && r.warning && !clientLoginReq(c);
	}).length;
	if (needLoginNames.length) {
		toast(`${needLoginNames.join('、')} 还差一步：先在客户端登录，再回来重新配置`);
	} else if (doneNames.length && warnN) {
		toast(`${doneNames.join('、')} 配置完成，需在客户端模型选择器里选一次 CCB 模型`);
	} else if (doneNames.length) {
		toast(`${doneNames.join('、')} 已配置并启动，即可直接使用`);
	}
	$('#allSummary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	} finally {
		btn.disabled = false;
		btn.innerHTML = BTN_HTML;
	}
}

/* ================= 使用前提 / 后续步骤 =================
 * 各客户端的写入方式对「客户端登录态」的依赖不同（均为实测结论，勿凭产品名臆测）：
 *   - Trae 系（traeui）：自定义模型保存在 Trae 账号里，客户端未登录时界面上没有模型选择器，
 *     写入会被跳过 —— 必须先登录，再回来重跑一键配置。
 *   - WorkBuddy（workbuddyui）：界面默认模型按登录账号 uid 写入，未登录取不到 uid，
 *     只能把模型登记进列表、默认模型设不上 —— 登录后重跑，或在模型列表里手动选一次。
 *   - 其余客户端（CodeBuddy / ZCode / Cursor 等）：写入不依赖登录，打开即用；
 *     个别情况下界面当前模型没设上（写入器会带 warning），按提示手动选一次即可。
 * 一键配置完成后按实际结果给这些客户端醒目提示，省得用户以为「配置成功了却没效果」。
 */
const TRAE_IDS = new Set(['trae-intl', 'trae-cn', 'traework-intl', 'traework-cn']);

/** 该客户端是否要求先在客户端里登录才能写入；返回 null 表示打开即用 */
function clientLoginReq(c) {
	if (TRAE_IDS.has(c.id)) return 'Trae 账号';
	if (c.writer === 'workbuddy') return 'WorkBuddy 账号';
	/* QoderWork：BYOK 模型目录按登录账号存（~/.qoderworkcn/.models/<uid>），
	 * 未登录过则 .models 不存在，写入器会直接报「先启动并登录一次」 */
	if (c.writer === 'qoderwork') return 'Qoder 账号';
	return null;
}

/** 一键配置后的「后续步骤」块；返回空串表示该客户端不需要用户再做什么 */
function nextStepsHtml(c) {
	const r = state.results[c.id] || {};
	const name = esc(c.name + (c.variant ? ' · ' + c.variant : ''));
	const login = clientLoginReq(c);

	/* 1) 写入失败：Trae 系 / WorkBuddy 基本都是「客户端还没登录」 */
	if (!r.ok) {
		if (!login) return '';
		return `<div class="as-steps fail">
			<div class="as-steps-head">${ICON_WARN}<span><b>${name}</b> 还差一步：先在客户端登录，再回来重新配置</span></div>
			<ol class="as-steps-list">
				<li>打开 <b>${name}</b>，用你的 <b>${login}</b> 登录。</li>
				<li>回到本窗口，重新点一次「一键配置并启动」。登录后全部模型会写进账号并自动设为当前模型，不需要在模型选择器里手动切换。</li>
			</ol>
			<div class="as-steps-note">自定义模型保存在客户端账号里，未登录时客户端不提供模型选择器，CCB 无法写入。</div>
		</div>`;
	}

	/* 2) 写入成功，但界面默认模型没设上（未登录 / 界面取不到模型选择器） */
	if (r.warning) {
		const steps = login
			? [
					`打开 <b>${name}</b>，用你的 <b>${login}</b> 登录。`,
					'回到本窗口点「一键配置并启动」（或在「详情」里点「重新写入配置」）—— 登录后界面默认模型会自动设为 CCB 的。',
					`不想重配也行：打开 <b>${name}</b>，在模型选择器里选一次带 <b>CCB</b> 的模型。`,
				]
			: [`打开 <b>${name}</b>，在模型选择器里选一次带 <b>CCB</b> 的模型。`];
		return `<div class="as-steps warn">
			<div class="as-steps-head">${ICON_WARN}<span><b>${name}</b>：模型已写入，但还差一步才能用上</span></div>
			<div class="as-steps-text">${esc(r.warning)}</div>
			<ol class="as-steps-list">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
		</div>`;
	}

	/* 3) 需要登录的客户端写入成功 = 当时已登录，明确告知不用再手动切模型 */
	if (login) {
		return `<div class="as-steps ok">
			<div class="as-steps-head">${ICON_OK}<span><b>${name}</b>：模型已随登录账号写入并设为当前模型，<b>不需要再手动切换</b>（若打开后仍显示别的模型，在模型选择器里选一次带 CCB 的即可）</span></div>
		</div>`;
	}
	return '';
}

function showSummary(selected) {
	const el = $('#allSummary');
	const lines = selected.map((c) => {
		const r = state.results[c.id] || {};
		const launch = r.launch || {};
		const launched = launch.status === 'launched' || launch.status === 'restarted';
		const name = esc(c.name + (c.variant ? ' · ' + c.variant : ''));

		if (r.ok && launched && r.warning) {
			return `<div class="as-line warn"><b>${name}</b>：模型已写入，但${esc(r.warning)}。可稍后在「详情」中重试。</div>`;
		}
		if (r.ok && launched) {
			return `<div class="as-line ok"><b>${name}</b>：已写入全部模型并${launch.status === 'restarted' ? '自动重启' : '启动'}，打开即可使用。</div>`;
		}
		if (r.ok) {
			return `<div class="as-line warn"><b>${name}</b>：配置已写入，但${esc(launch.message || '启动失败')}。可稍后在「详情」中重试。</div>`;
		}
		return `<div class="as-line fail"><b>${name}</b>：${esc(r.error || '配置失败')}，点击「详情」查看日志。</div>`;
	});

	/* 后续步骤：写入完成后还需要用户回客户端补一步的（登录 / 选模型），逐客户端写明 */
	const steps = selected.map(nextStepsHtml).filter(Boolean);

	el.innerHTML = lines.join('') + steps.join('');
	el.style.display = lines.length || steps.length ? '' : 'none';
}

/* ================= 详情面板 ================= */
function noKeyWarn(c) {
	const k = clientKey(c);
	if (k) return '';
	return `<div class="warnbox"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
	<div>平台密钥尚未获取，正在自动获取…（也可点击「一键配置」）</div></div>`;
}

function autoPanel(c) {
	const k = clientKey(c) || {};
	const ids = clientModelIds(c);
	const ready = !!k.apiKey && ids.length > 0;
	const logHtml = state.lastLog[c.id]
		? `<div class="logbox ${state.lastLog[c.id].ok ? 'ok' : 'err'}">${esc(state.lastLog[c.id].text)}</div>`
		: '';

	return `
	<div class="summary">
		<div class="sum-item"><span class="si-label">服务地址</span><span class="si-value">${esc(clientApiBase(c))}</span><button class="btn sm ghost btn-copy" data-copy="${esc(clientApiBase(c))}" type="button">复制</button></div>
		<div class="sum-item"><span class="si-label">API 密钥</span><span class="si-value">${esc(maskedKey(k.apiKey))}</span><button class="btn sm ghost btn-copy" data-copy="${esc(k.apiKey || '')}" type="button">复制</button></div>
		<div class="sum-item"><span class="si-label">模型数量</span><span class="si-value">${ids.length} 个</span></div>
		<div class="sum-item"><span class="si-label">默认模型</span>
			<select class="model-select" id="defaultModelSel">
				${ids.map((id) => `<option value="${esc(id)}" ${id === state.defaultModel ? 'selected' : ''}>${esc(id)}</option>`).join('')}
			</select></div>
	</div>
	<div class="actionrow">
		<button class="btn primary big" id="applyBtn" type="button" ${ready ? '' : 'disabled'}>重新写入配置</button>
		<button class="btn ghost" id="launchBtn" type="button">启动 / 重启</button>
		<button class="btn danger" id="rollbackBtn" type="button">回滚</button>
		<span class="rolldesc">写入前自动备份原文件，回滚可恢复</span>
	</div>
	${noKeyWarn(c)}${logHtml}`;
}

/* ---- 客户端路径区 ---- */
/* 展示规则：
 *   - 自定义路径优先显示，并附「解析到的程序」一行，让用户直观确认指向对不对
 *   - pathMatched==='none'（强制使用的对不上路径）→ 黄色告警条 + 重新选择/清除
 *   - staleCustomPath（已失效）→ 红色告警条 + 重新选择
 *   - 未检测到 → 蓝色引导条，强调「手动选择路径」按钮 */
function pathSection(c) {
	const d = c.details || {};
	const custom = d.customPath || '';
	const stale = d.staleCustomPath || '';
	const resolved = d.customResolvedExe || '';
	const matched = d.pathMatched || '';
	const reason = d.pathReason || '';
	const evidence = (c.evidence || []).length ? c.evidence.map(esc).join('<br>') : '';

	const customLine = custom
		? `<div class="pb-line custom">用户指定：<span>${esc(custom)}</span></div>`
			+ (resolved && resolved !== custom ? `<div class="pb-line resolved">解析程序：<span>${esc(resolved)}</span></div>` : '')
		: '';

	const matchedBar = (custom && matched === 'none')
		? `<div class="pb-mismatch"><span>${ICON_WARN}<span>路径看起来不是 ${esc(c.name)}：${esc(reason)}。配置可能写不进或启动到别的程序。</span></span>
				<button class="btn sm ghost" id="rePickBtn" type="button">重新选择</button>
				<button class="btn sm ghost" id="clearPathBtn" type="button">清除</button></div>`
		: '';

	const staleBar = stale
		? `<div class="pb-stale"><span>${ICON_WARN}<span>自定义路径已失效（不存在）：<span>${esc(stale)}</span>。请重新选择正确位置。</span></span>
				<button class="btn sm ghost" id="rePickBtn" type="button">重新选择</button>
				<button class="btn sm ghost" id="clearPathBtn" type="button">清除</button></div>`
		: '';

	const missingHint = (!c.installed && !custom && !stale)
		? `<div class="pb-hint">未检测到 ${esc(c.name)}${c.variant ? ' · ' + esc(c.variant) : ''}。若已安装到非默认位置（自定义盘符 / 绿色版 / 便携包），点「手动选择路径」选中它的 <b>.exe 程序</b>或<b>安装目录</b>即可。</div>`
		: '';

	const evidenceLine = evidence
		? `<div class="pb-line">${evidence}</div>`
		: (!custom && !stale ? '<div class="pb-line">（自动检测未发现）</div>' : '');

	/* 待确认条：用户刚选了个对不上的路径，等其决定是否仍要使用 */
	const pending = (state.pendingMismatch && state.pendingMismatch.clientId === c.id)
		? `<div class="pb-pending"><span>${ICON_WARN}<span>所选路径 ${esc(state.pendingMismatch.picked)} 不像 ${esc(c.name)}：${esc(state.pendingMismatch.reason)}</span></span>
				<button class="btn sm primary" id="forcePathBtn" type="button">仍要使用此路径</button>
				<button class="btn sm ghost" id="rePickBtn" type="button">重新选择</button>
				<button class="btn sm ghost" id="dismissMismatchBtn" type="button">取消</button></div>`
		: '';

	return `
	<div class="pathblock">
		<div class="pb-head">
			<span class="pb-title">客户端路径</span>
			<div class="pb-actions">
				<button class="btn sm ghost" id="pickPathBtn" type="button">${custom ? '更改路径' : '手动选择路径'}</button>
				${custom ? '<button class="btn sm ghost" id="clearPathBtn" type="button">清除自定义路径</button>' : ''}
			</div>
		</div>
		${customLine}${matchedBar}${staleBar}${evidenceLine}${pending}${missingHint}
	</div>`;
}

/* ---- Cursor MITM 上游高级参数（对应 cursor-agent proxy_ca_config.json 的 upstream / compression）----
 * 留空即用内置缺省（OpenAI 兼容 + Authorization: Bearer + 600s 超时 + 200k 上下文 + 自动压缩），
 * 所以新手完全不用碰；折叠起来避免干扰。 */
const CU_DEFAULTS = {
	apiFormat: 'openai',
	apiKeyHeader: 'Authorization',
	timeoutSec: 600,
	contextTokenLimit: 200000,
	tailTurns: 20,
};

function cursorUpstreamAdvanced() {
	const u = state.cursorUpstream || {};
	const cp = u.compression || {};
	const d = CU_DEFAULTS;
	const temp = u.temperature === undefined || u.temperature === null ? '' : u.temperature;
	const timeoutSec = Math.round((Number(u.timeout) || d.timeoutSec * 1000) / 1000);
	return `
	<details class="adv-details" id="cuDetails" ${state.cuOpen ? 'open' : ''}>
		<summary>高级选项 <em>一般不用改</em></summary>
		<div class="adv-grid">
			<label class="adv-item"><span>接口格式</span>
				<select id="cuApiFormat">
					<option value="openai" ${u.apiFormat === 'anthropic' ? '' : 'selected'}>OpenAI 兼容</option>
					<option value="anthropic" ${u.apiFormat === 'anthropic' ? 'selected' : ''}>Anthropic</option>
				</select>
			</label>
			<label class="adv-item"><span>认证头</span>
				<input type="text" id="cuApiKeyHeader" value="${esc(u.apiKeyHeader || '')}" placeholder="${d.apiKeyHeader}">
			</label>
			<label class="adv-item"><span>单次回复上限</span>
				<input type="number" id="cuMaxTokens" min="0" value="${Number(u.maxTokens) || ''}" placeholder="0 = 上游默认">
			</label>
			<label class="adv-item"><span>温度</span>
				<input type="number" id="cuTemperature" min="0" max="2" step="0.1" value="${esc(String(temp))}" placeholder="留空 = 不传">
			</label>
			<label class="adv-item"><span>请求超时（秒）</span>
				<input type="number" id="cuTimeout" min="30" value="${timeoutSec}">
			</label>
			<label class="adv-item"><span>上下文上限（tokens）</span>
				<input type="number" id="cuContextLimit" min="8000" value="${Number(u.contextTokenLimit) || d.contextTokenLimit}">
			</label>
		</div>
		<div class="adv-check">
			<label><input type="checkbox" id="cuCompress" ${cp.enabled === false ? '' : 'checked'}> 超长上下文自动压缩</label>
			<label>保留最近 <input type="number" id="cuTailTurns" min="2" value="${Number(cp.tailTurns) || d.tailTurns}"> 轮原文</label>
		</div>
		<div class="mitm-note">改动后点「停止代理 / 启动代理」或「重新写入配置」生效。</div>
	</details>`;
}

function saveCursorUpstream() {
	const u = { ...(state.cursorUpstream || {}) };
	u.apiFormat = $('#cuApiFormat').value === 'anthropic' ? 'anthropic' : 'openai';
	u.apiKeyHeader = $('#cuApiKeyHeader').value.trim();
	u.maxTokens = Math.max(0, Number($('#cuMaxTokens').value) || 0);
	const t = $('#cuTemperature').value.trim();
	u.temperature = t === '' ? null : Math.max(0, Number(t));
	u.timeout = Math.max(30, Number($('#cuTimeout').value) || CU_DEFAULTS.timeoutSec) * 1000;
	u.contextTokenLimit = Math.max(
		8000,
		Number($('#cuContextLimit').value) || CU_DEFAULTS.contextTokenLimit,
	);
	u.compression = {
		...(u.compression || {}),
		enabled: $('#cuCompress').checked,
		tailTurns: Math.max(2, Number($('#cuTailTurns').value) || CU_DEFAULTS.tailTurns),
	};
	state.cursorUpstream = u;
	persist();
	toast('已保存高级选项；重启代理后生效');
}

/* ---- Cursor MITM 代理模式（模仿 cursor-agent） ----
 * BYOK：官方自定义模型通道，稳定但只覆盖普通聊天；
 * MITM：本地代理（cursorproxy）接管 Cursor 全部 AI 流量转发 CCB 中转，解锁 Agent 等全功能（实验）。 */
function cursorMitmSection(c) {
	if (c.id !== 'cursor') return '';
	const mitm = state.cursorMode === 'mitm';
	return `
<div class="pathblock mitmblock">
	<div class="pb-head"><span class="pb-title">接入模式</span></div>
	<div class="mode-row">
		<label class="mode-pill ${mitm ? '' : 'on'}">
			<input type="radio" name="cursorMode" value="byok" ${mitm ? '' : 'checked'}>
			<span class="mode-name">官方自定义模型</span>
			<span class="mode-desc">稳定推荐：聊天中可选 CCB 模型；Agent / Tab 补全仍走 Cursor 官方</span>
		</label>
		<label class="mode-pill ${mitm ? 'on' : ''}">
			<input type="radio" name="cursorMode" value="mitm" ${mitm ? 'checked' : ''}>
			<span class="mode-name">MITM 代理模式 <em>实验</em></span>
			<span class="mode-desc">本地代理接管 Cursor 全部 AI 流量（仿 cursor-agent），尝试解锁 Agent 等全功能</span>
		</label>
	</div>
	${
		mitm
			? `
	<div class="mitm-status" id="mitmStatus">正在查询代理状态…</div>
	<div class="actionrow mitm-actions">
		<button class="btn sm" id="caInstallBtn" type="button">安装根证书</button>
		<button class="btn sm ghost" id="proxyToggleBtn" type="button">启动代理</button>
		<button class="btn sm ghost" id="caUninstallBtn" type="button">卸载根证书</button>
	</div>
	<div class="mitm-note">
		启用后 Cursor 的 AI 请求经本机代理 <code>127.0.0.1:9182</code> 转发到 CCB 中转：<br>
		① 先点「安装根证书」（Windows 会弹一次安全警告，点「是」）② 点「重新写入配置」③ 重启 Cursor。
		使用期间需保持本窗口运行；「回滚」会移除代理配置并停止代理。
	</div>
	${cursorUpstreamAdvanced()}`
			: ''
	}
</div>`;
}

async function refreshMitmStatus() {
	const el = $('#mitmStatus');
	if (!el) return;
	let s;
	try {
		s = await window.ccb.cursorProxy.status();
	} catch (e) {
		el.innerHTML = `<span class="dot red"></span>状态查询失败：${esc(e.message || e)}`;
		return;
	}
	if (!$('#mitmStatus')) return; /* 查询期间用户切走了 */
	el.innerHTML = `
		<span class="mitm-line"><span class="dot ${s.running ? 'green' : 'gray'}"></span>代理：${s.running ? `运行中（127.0.0.1:${s.port}）` : '未运行'}</span>
		<span class="mitm-line"><span class="dot ${s.caInstalled ? 'green' : 'amber'}"></span>根证书：${s.caInstalled ? '已安装' : '未安装（Cursor 会报证书错误）'}</span>
		${
			s.running
				? `<span class="mitm-line dim">已拦截 ${s.stats.intercepted} · 隧道 ${s.stats.tunneled} · 转发 ${s.stats.passthrough}</span>`
				: ''
		}`;
	const toggle = $('#proxyToggleBtn');
	if (toggle) toggle.textContent = s.running ? '停止代理' : '启动代理';
	const caBtn = $('#caInstallBtn');
	if (caBtn) {
		caBtn.disabled = !!s.caInstalled;
		caBtn.textContent = s.caInstalled ? '根证书已安装' : '安装根证书';
	}
}

async function toggleProxy() {
	const c = state.clients.find((x) => x.id === state.client);
	const s = await window.ccb.cursorProxy.status();
	if (s.running) {
		await window.ccb.cursorProxy.stop();
		toast('代理已停止');
	} else {
		const k = (c && clientKey(c)) || {};
		const r = await window.ccb.cursorProxy.start({
			apiKey: k.apiKey || '',
			baseUrl: c ? clientApiBase(c) : state.apiBase,
			models: c ? clientModelIds(c) : modelIds(),
			defaultModel: state.defaultModel,
		});
		toast(r.ok ? `代理已启动（127.0.0.1:${r.port}）` : '代理启动失败：' + (r.error || ''));
	}
	refreshMitmStatus();
}

/* ---- Qoder CN IDE 1.30+ 本地代理方案说明（v2：预定义 provider + 推理重定向） ----
 * 架构：模型挂官方预定义 provider（deepseek）过 UI 校验；apiKey 用 CCB 平台密钥；
 * 本地 MITM 代理拦截 Go 客户端发往 Qoder 网关的推理请求（按 sk-ccb 密钥识别），
 * 直接重定向到 CCB 中转站。代理通过 IDE 官方代理设置接入（任意方式启动均生效），
 * 且以独立后台进程常驻（CCB 关闭 / 电脑重启后仍在），不再依赖启动按钮。 */
function qoderProxySection(c) {
	if (c.id !== 'qoder-cn') return '';
	return `
<div class="pathblock mitmblock">
	<div class="pb-head"><span class="pb-title">Qoder CN IDE 本地代理模式</span></div>
	<div class="mitm-note">
		<b>「写入配置」后，从任意方式（开始菜单 / 桌面图标 / CCB 启动按钮）启动 IDE 均可使用。</b><br>
		原因：新版 IDE 的推理请求由内置 Go 客户端发往 Qoder 官方网关（忽略自定义
		<code>base_url</code>）。CCB 方案：模型挂官方预定义 provider 通过界面校验，
		密钥使用 CCB 平台密钥；本地代理常驻后台（CCB 写入配置时自动启动，并加入
		开机自启动），把携带 CCB 密钥的推理请求直接重定向到 CCB 中转站
		（首次使用会安装一张本地根证书，弹窗请点「是」）。<br>
		点击「回滚配置」会自动停掉本地代理、清理代理设置与自启动项。
	</div>
</div>`;
}

/* ---- Codex 桌面版说明 ----
 * 它的安装形态与其它客户端都不同：MSIX 应用包（开始菜单里显示为 ChatGPT），
 * 配置写在应用根 ~/.codex/config.toml 的 [model_providers.ccb] 里，密钥内联在该条目
 * （experimental_bearer_token）——不写全局环境变量、不碰 ChatGPT 登录凭据 auth.json。 */
function codexSection(c) {
	if (c.id !== 'codex') return '';
	return `
<div class="pathblock mitmblock">
	<div class="pb-head"><span class="pb-title">Codex 桌面版的接入方式</span></div>
	<div class="mitm-note">
		写入位置：<code>~/.codex/config.toml</code>（默认供应商指向 CCB，密钥内联在
		<code>[model_providers.ccb]</code> 条目里）。<br>
		<b>不会改动你的 ChatGPT 登录凭据</b>（<code>auth.json</code> 不写）：应用要求登录时，
		用你自己的账号登录即可，与 CCB 配置互不影响。<br>
		配置在应用启动时读取，写入后 CCB 会自动重启它；回滚会把 <code>config.toml</code>
		还原成配置前的样子。
	</div>
</div>`;
}

function renderPanel() {
	const el = $('#panel');
	const c = state.clients.find((x) => x.id === state.client);
	if (!c) {
		el.innerHTML = '<div class="empty"><div>点击客户端卡片上的「详情」查看配置详情、日志与回滚。</div></div>';
		return;
	}
	if (UNSUPPORTED.has(c.id)) {
		el.innerHTML = `
	<div class="panel">
		<div class="panel-head">
			${clientIcon(c)}
			<div>
				<div class="panel-title">${esc(c.name)}${c.variant ? ' · ' + esc(c.variant) : ''}</div>
				<div class="panel-sub">${esc(c.vendor)} · <b>暂不可用</b></div>
			</div>
		</div>
		<div class="panel-body">
				<div class="pathblock mitmblock">
					<div class="pb-head"><span class="pb-title">为什么暂不可用</span></div>
					<div class="mitm-note">
						Qoder IDE 系的聊天推理在 <b>Qoder 云端</b>执行：请求发往官方网关、用你的 Qoder 登录态鉴权，
						模型端点由服务端按「服务商」写死（服务商为固定的厂商列表，没有可填的地址项），
						请求体还是加密的 —— 第三方中转既接不进去，本地也改不了。<br><br>
						<b>可正常使用的是</b>：Qoder CN 桌面版、QoderWork（国际版 / 中国版），
						以及 Trae 系 / CodeBuddy / WorkBuddy / ZCode / Cursor / Codex。
					</div>
				</div>
			</div>
	</div>`;
		return;
	}
	ensureDefaultModel();
	el.innerHTML = `
	<div class="panel">
		<div class="panel-head">
			${clientIcon(c)}
			<div>
				<div class="panel-title">${esc(c.name)}${c.variant ? ' · ' + esc(c.variant) : ''} 配置</div>
				<div class="panel-sub">${esc(c.vendor)} · 支持<b>全自动写入</b></div>
			</div>
		</div>
		<div class="panel-body">${autoPanel(c)}${cursorMitmSection(c)}${qoderProxySection(c)}${codexSection(c)}${pathSection(c)}</div>
	</div>`;
	if (c.id === 'cursor' && state.cursorMode === 'mitm') refreshMitmStatus();
}

/* ================= 单客户端操作 ================= */
async function applyOne(c) {
	const btn = $('#applyBtn');
	if (btn) { btn.disabled = true; btn.textContent = '正在写入…'; }
	await ensureKey(c.provider);
	const k = clientKey(c) || {};
	const r = await window.ccb.applyConfig(c.id, {
		apiKey: k.apiKey || '',
		apiBase: clientApiBase(c),
		anthropicBase: state.keys['anthropic'] ? (state.keys['anthropic'].baseUrl || state.anthropicBase) : state.anthropicBase,
		models: clientModelIds(c),
		defaultModel: state.defaultModel,
		cursorMitm: c.id === 'cursor' ? { enabled: state.cursorMode === 'mitm' } : undefined,
	});
	const text = (r.log || []).concat(r.ok ? [] : [r.error || '写入失败']).join('\n');
	state.lastLog[c.id] = { ok: !!r.ok, text };
	state.results[c.id] = { ok: !!r.ok, text, warning: r.warning || null, launch: (state.results[c.id] || {}).launch || null };
	renderClients();
	renderPanel();
	showSummary([c]);
	const needLogin = clientLoginReq(c) && (!r.ok || r.warning);
	if (needLogin) {
		toast(`${c.name} 还差一步：先在客户端登录，再回来重新配置`);
	} else if (r.ok && r.warning) {
		toast(`${c.name} 配置已写入，需在模型选择器里选一次 CCB 模型`);
	} else {
		toast(r.ok ? `${c.name} 配置已写入` : '写入失败，请查看日志');
	}
}

async function launchOne(c) {
	const r = await window.ccb.launchClient(c.id);
	if (state.results[c.id]) state.results[c.id].launch = r;
	else state.results[c.id] = { ok: null, text: '', launch: r };
	toast(r.status === 'failed' ? `${c.name}：${r.message}` : `${c.name} ${r.message}`);
	renderClients();
}

async function rollbackOne(c) {
	const r = await window.ccb.rollbackConfig(c.id);
	state.lastLog[c.id] = { ok: !!r.ok, text: (r.log || []).concat(r.ok ? [] : [r.error || '回滚失败']).join('\n') };
	delete state.results[c.id];
	renderClients();
	renderPanel();
	toast(r.ok ? '回滚完成' : '回滚失败：' + (r.error || ''));
}

async function rescan() {
	state.clients = await window.ccb.detectClients();
	state.clientsReady = true;
	defaultSelection();
	renderClients();
	renderPanel();
	toast('客户端检测已刷新');
}

/* ================= 新手引导 & 上下文提示 =================
 * 一次性引导：首次进入主界面自动弹出三步（余额 → 选择客户端 → 一键配置），
 *   完成后写入 config.json 的 onboarded，之后不再自动弹出（页脚「使用引导」可重看）。
 * 常驻提示：余额为 0 / 未选择客户端 / 未检测到客户端时，在对应卡片内给出提示条。
 */

const ICON_WARN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_INFO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const ICON_OK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

let guideIndex = 0;
let guideShownThisSession = false;

/* target 用选择器指向要高亮的区块；text 可为函数，按当前状态给出不同文案 */
const GUIDE_STEPS = [
	{
		target: '#acctCard',
		title: '第 1 步 · 先看账户余额',
		text: () =>
			Number(state.user && state.user.credits) > 0
				? `当前余额 <code>${fmtCredits(state.user.credits)}</code>，已就绪，直接进入下一步即可。`
				: '全部模型按官方定价 <b>2 折</b> 计费，按 token 用量从余额扣费。余额为 0 时，先把兑换卡卡密粘到高亮区域里的输入框并点「兑换」，充值立即生效。',
	},
	{
		target: '#clientGrid',
		title: '第 2 步 · 选择要配置的客户端',
		text: () => {
			const n = selectableClients().length;
			return n
				? `已自动检测到 <b>${n}</b> 个客户端并默认选中第一个。点卡片可改选其它客户端（每次只配置一个），卡片上的徽标会显示「待配置 / 已配置」。没检测到的客户端可先安装，再点右上角「重新检测」。`
				: '暂未检测到已安装的客户端。请先安装你常用的 AI 编程客户端（Trae / Qoder / CodeBuddy / Cursor 等），再点右上角「重新检测」。';
		},
	},
	{
		target: '#applyAllBtn',
		title: '第 3 步 · 点「一键配置并启动」',
		text: '点这一个按钮就够了：CCB 自动获取平台密钥、把全部可用模型写进选中的客户端，并自动启动（运行中的会自动重启）。每次配置一个客户端，完成后可再选下一个。配置写入前会自动备份，随时可在「详情」里回滚。',
	},
];

function clearGuideFocus() {
	$$('.guide-focus').forEach((el) => el.classList.remove('guide-focus'));
}

/* 引导可见性：遮罩与引导卡是两个独立的固定层（遮罩不拦点击，卡片浮在最上） */
function setGuideVisible(v) {
	$('#guideDim').hidden = !v;
	$('#guideCard').hidden = !v;
	document.body.classList.toggle('guide-open', v);
}

const guideOpen = () => !$('#guideCard').hidden;

function focusGuideTarget(sel, smooth) {
	clearGuideFocus();
	const el = $(sel);
	if (!el) return;
	if (el.scrollIntoView) el.scrollIntoView({ behavior: smooth === false ? 'auto' : 'smooth', block: 'center' });
	el.classList.add('guide-focus');
}

function renderGuideStep() {
	const step = GUIDE_STEPS[guideIndex];
	if (!step) return;
	$('#guideProgress').textContent = `${guideIndex + 1} / ${GUIDE_STEPS.length}`;
	$('#guideTitle').textContent = step.title;
	$('#guideText').innerHTML = typeof step.text === 'function' ? step.text() : step.text;
	$('#guidePrev').disabled = guideIndex === 0;
	$('#guideNext').textContent = guideIndex === GUIDE_STEPS.length - 1 ? '知道了，开始使用' : '下一步';
	focusGuideTarget(step.target, false);
}

function startGuide() {
	guideIndex = 0;
	guideShownThisSession = true;
	setGuideVisible(true);
	renderGuideStep();
}

function endGuide(msg) {
	setGuideVisible(false);
	clearGuideFocus();
	if (!state.onboarded) {
		state.onboarded = true;
		window.ccb.saveState({ onboarded: true });
	}
	if (msg) toast(msg);
}

function guideNext() {
	if (guideIndex >= GUIDE_STEPS.length - 1) {
		endGuide('引导结束 · 之后可点页脚「使用引导」重看');
		return;
	}
	guideIndex += 1;
	renderGuideStep();
}

function guidePrev() {
	if (guideIndex === 0) return;
	guideIndex -= 1;
	renderGuideStep();
}

function setHint(el, kind, html) {
	if (!el) return;
	if (!html) { el.hidden = true; el.innerHTML = ''; return; }
	el.hidden = false;
	el.className = 'hintbar ' + kind;
	el.innerHTML = html;
}

/* 常驻提示：不依赖一次性引导，任何时候都能自查下一步该做什么 */
function renderGuideHints() {
	setHint(
		$('#balanceHint'),
		'warn',
		state.user && !(Number(state.user.credits) > 0)
			? ICON_WARN +
				'<div><b>余额为 0</b>：建议先用兑换卡充值再配置客户端——否则配置虽然会成功写入，但客户端调用模型时会因余额不足失败。在右侧输入卡密点「兑换」即可，立即生效。</div>'
			: ''
	);

	const sel = $('#selectHint');
	if (!state.clientsReady) { setHint(sel, 'info', ''); return; }
	const installed = selectableClients();
	if (!installed.length) {
		setHint(
			sel,
			'info',
			ICON_INFO +
				'<div>未检测到已安装的客户端。请先安装常用的 AI 编程客户端（Trae / Qoder / CodeBuddy / Cursor 等），安装后回到这里点右上角「重新检测」，无需其它设置，选中即可一键写入。</div>'
		);
		return;
	}
	const picked = installed.filter((c) => state.selection[c.id])[0];
	if (!picked) {
		setHint(sel, 'warn', ICON_WARN + '<div>还没有选择客户端：点下方卡片选中一个要配置的客户端，再点「一键配置并启动」。</div>');
		return;
	}
	setHint(
		sel,
		'ok',
		ICON_OK + `<div>已选择 <b>${esc(picked.name)}</b>。点下方「一键配置并启动」即可自动写入全部模型并启动，完成后可再选择下一个客户端。</div>`
	);
}

/* ================= 帮助文档（页面底部「遇到问题？」） =================
 * 内容内置在客户端本地（断网也能看），按「现象 → 解决办法」组织；页脚「常见问题」可直接跳转。
 * 顶部搜索框按关键词过滤（匹配问题标题与正文，命中时自动展开条目）。
 * 条目均来自实际排障经验，改动时请与各写入器（writers.js / traeui.js 等）的实际行为保持一致。 */
const HELP_ITEMS = [
	{
		q: '配置完成后，客户端里还是原来的模型 / 找不到 CCB 模型',
		a: `<ol class="qa-steps">
			<li>打开客户端，在<b>模型选择器</b>里选一次带 <b>CCB</b> 前缀的模型（形如 <code>CCB glm-5.3</code>）。</li>
			<li>Trae 系（Trae / TraeCode / TraeWork）、WorkBuddy、QoderWork 的模型保存在你的客户端账号里：先在客户端登录，再回到本窗口重新点「一键配置并启动」。</li>
			<li>注意别选错：客户端自带模型可能与 CCB 模型同名（比如都叫 glm-5.3），只有带 <b>CCB</b> 前缀的才是走中转的。</li>
		</ol>`,
	},
	{
		q: '提示「还差一步：先在客户端登录，再回来重新配置」',
		a: `<p>这条提示只出现在部分客户端：它们的自定义模型保存在你的客户端账号里，未登录时无法写入。</p>
		<ol class="qa-steps">
			<li>打开该客户端，用你的账号登录。</li>
			<li>回到本窗口，再点一次「一键配置并启动」。</li>
		</ol>
		<div class="qa-note">登录后模型会自动写进账号并设为当前模型，不需要在模型选择器里手动切换。</div>`,
	},
	{
		q: '没检测到我的客户端 / 卡片显示「路径待核对」',
		a: `<ol class="qa-steps">
			<li>客户端装在非默认位置（自定义盘符 / 绿色版 / 便携包）时：点卡片上的「详情」→「手动选择路径」，选中它的安装目录或 <code>.exe</code> 程序。</li>
			<li>刚安装完新客户端：点第 2 步右上角「重新检测」再扫一次。</li>
			<li>显示「路径待核对」：说明之前指定的路径对不上，在详情里按提示「重新选择」或「清除自定义路径」。</li>
		</ol>`,
	},
	{
		q: '提示余额不足 / 怎么充值，怎么计费',
		a: `<ol class="qa-steps">
			<li>全部模型按官方定价 <b>2 折</b> 计费，按输入 / 输出 token 用量从余额扣费。</li>
			<li>在第 1 步「账户余额」里粘贴兑换卡卡密，点「兑换」立即到账。</li>
			<li>没有卡密：点「购买兑换卡」，复制淘宝链接下单后即可获得卡密。</li>
		</ol>
		<div class="qa-note">余额为 0 时也能完成配置，但客户端调用模型会失败——建议先充值再使用。</div>`,
	},
	{
		q: '写入失败，提示「请先完全退出客户端」',
		a: `<p>客户端运行时会锁定自己的配置文件，CCB 无法写入。</p>
		<ol class="qa-steps">
			<li>完全退出该客户端（包括托盘里的后台进程）。</li>
			<li>回到本窗口，在该客户端的「详情」里点「重新写入配置」。</li>
		</ol>`,
	},
	{
		q: 'Cursor 代理模式报证书错误 / 没反应',
		a: `<ol class="qa-steps">
			<li>在 Cursor「详情」→「接入模式」里选「MITM 代理模式」。</li>
			<li>① 点「安装根证书」（Windows 弹安全警告点「是」）→ ② 点「重新写入配置」→ ③ 重启 Cursor。</li>
			<li>使用期间请保持本窗口运行：代理运行在你的电脑上，CCB 退出后代理会停止。</li>
		</ol>
		<div class="qa-note">只在聊天里用 CCB 模型的话，「官方自定义模型」模式更简单稳定，不用装证书。</div>`,
	},
	{
		q: 'Kimi 的模型选择器里看不到 CCB 模型',
		a: `<p>这是 Kimi 桌面版的限制：配置已写入并对聊天生效，但模型不会出现在它的选择器里，属正常现象。</p>
		<p>若 Kimi 官方启动时同步覆盖了当前模型，回到本窗口重新点一次「一键配置并启动」即可。</p>`,
	},
	{
		q: 'Codex 桌面版在开始菜单里叫「ChatGPT」，会改写我的 ChatGPT 账号吗？',
		a: `<p>不会。CCB 只写应用根目录下的 <code>~/.codex/config.toml</code>：把默认供应商指向
		<code>[model_providers.ccb]</code>，密钥内联在该条目里。</p>
		<ol class="qa-steps">
			<li><b>不碰登录凭据</b>：<code>~/.codex/auth.json</code> 与 ChatGPT 账号登录态完全不动；应用要求登录时，用你自己的账号登录即可。</li>
			<li><b>配置在应用启动时读取</b>：CCB 写入后会自动重启它；如果你自己启动过，完全退出再打开即可生效。</li>
			<li><b>要恢复原样</b>：在「详情」里点「回滚」，<code>config.toml</code> 会还原成配置前的样子。</li>
		</ol>`,
	},
	{
		q: '想撤销配置 / 恢复原样',
		a: `<ol class="qa-steps">
			<li>打开对应客户端的「详情」，点「回滚」。</li>
			<li>CCB 写入前会自动备份原文件（<code>*.bak</code>），回滚会完整恢复写入前的配置。</li>
		</ol>`,
	},
	{
		q: '其他异常：聊天报错 / 没反应 / 很慢',
		a: `<ol class="qa-steps">
			<li>先确认余额大于 0（见第 1 步「账户余额」）。</li>
			<li>重启客户端后重试；仍不行就回到本窗口，在「详情」里点「重新写入配置」。</li>
			<li>以上都无效：到官网 <code>ccb.btluo.com</code> 查看最新说明。</li>
		</ol>`,
	},
];

/* 搜索关键词（仅界面状态，不持久化） */
let helpFilter = '';

/* 去掉 HTML 标签后参与匹配，避免搜 li、b 等标签名时误命中全部条目 */
const helpText = (it) => (it.q + ' ' + it.a.replace(/<[^>]+>/g, ' ')).toLowerCase();

function renderHelp() {
	const kw = (helpFilter || '').trim().toLowerCase();
	const items = kw ? HELP_ITEMS.filter((it) => helpText(it).includes(kw)) : HELP_ITEMS;
	$('#helpEmpty').hidden = !kw || items.length > 0;
	$('#helpClear').hidden = !kw;
	/* 搜索命中时自动展开，省得用户再逐条点开 */
	$('#helpList').innerHTML = items
		.map(
			(it) =>
				`<details class="qa"${kw ? ' open' : ''}><summary><span class="qa-q">${esc(it.q)}</span></summary><div class="qa-a">${it.a}</div></details>`,
		)
		.join('');
}

/* ================= events ================= */
function bindEvents() {
	$('#authForm').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(); });
	$('#tabLogin').addEventListener('click', () => setAuthMode('login'));
	$('#tabRegister').addEventListener('click', () => setAuthMode('register'));
	$('#logoutBtn').addEventListener('click', doLogout);
	$('#redeemBtn').addEventListener('click', doRedeem);
	$('#redeemInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRedeem(); });

	/* 购买兑换卡弹窗（遮罩点击 / 关闭按钮 / Escape 均可关闭） */
	$('#buyCardBtn').addEventListener('click', openBuyCard);
	$('#buyCardClose').addEventListener('click', closeBuyCard);
	$('#buyCardDim').addEventListener('click', closeBuyCard);

	$('#applyAllBtn').addEventListener('click', applyAll);
	$('#rescanBtn').addEventListener('click', rescan);

	/* 检查更新 / 新版本横幅 */
	$('#checkUpdateBtn').addEventListener('click', () => checkUpdate(true));
	$('#verChip').addEventListener('click', () => checkUpdate(true));
	$('#updateActionBtn').addEventListener('click', (e) => doUpdateAction(e.currentTarget.dataset.action));
	$('#updateManualBtn').addEventListener('click', manualDownload);
	$('#updateCloseBtn').addEventListener('click', () => {
		state.dismissedUpdate = upd.latest;
		window.ccb.saveState({ dismissedUpdate: upd.latest });
		renderUpdate();
		toast('已隐藏本次提示，随时可点右上角「检查更新」查看');
	});

	/* 新手引导 */
	$('#guideBtn').addEventListener('click', startGuide);
	$('#guideNext').addEventListener('click', guideNext);
	$('#guidePrev').addEventListener('click', guidePrev);
	$('#guideSkip').addEventListener('click', () => endGuide('已跳过引导 · 需要时可点页脚「使用引导」重看'));
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && buyCardOpen()) { closeBuyCard(); return; }
		if (!guideOpen()) return;
		if (e.key === 'Escape') endGuide('');
		else if (e.key === 'ArrowRight') guideNext();
		else if (e.key === 'ArrowLeft') guidePrev();
	});

	/* 帮助文档：搜索过滤 + 页脚「常见问题」跳转到底部文档区 */
	$('#helpSearch').addEventListener('input', (e) => { helpFilter = e.target.value; renderHelp(); });
	$('#helpClear').addEventListener('click', () => {
		helpFilter = '';
		$('#helpSearch').value = '';
		renderHelp();
		$('#helpSearch').focus();
	});
	$('#helpBtn').addEventListener('click', () => {
		$('#helpCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
		$('#helpSearch').focus({ preventScroll: true });
	});
	$('#helpSiteBtn').addEventListener('click', () => window.ccb.openExternal('https://ccb.btluo.com'));

	$('#userChip').addEventListener('click', () => window.ccb.openExternal(state.accountApiBase + '/app/'));
	$('#openSiteBtn').addEventListener('click', () => window.ccb.openExternal('https://ccb.btluo.com'));
	$('#endpointChip').addEventListener('click', async () => {
		if (await copyText(state.apiBase)) toast('服务地址已复制');
	});

	$('#advAccountBase').addEventListener('change', (e) => {
		const v = e.target.value.trim().replace(/\/+$/, '');
		if (!v) { e.target.value = state.accountApiBase; return; }
		state.accountApiBase = v; persist();
	});
	$('#advApiBase').addEventListener('change', (e) => {
		const v = e.target.value.trim().replace(/\/+$/, '');
		if (!v) { e.target.value = state.apiBase; return; }
		state.apiBase = v; persist(); renderPanel();
	});
	$('#advAnthropicBase').addEventListener('change', (e) => {
		const v = e.target.value.trim().replace(/\/+$/, '');
		if (!v) { e.target.value = state.anthropicBase; return; }
		state.anthropicBase = v; persist(); renderPanel();
	});

	document.addEventListener('click', async (e) => {
		const copyBtn = e.target.closest('.btn-copy');
		if (copyBtn) {
			if (await copyText(copyBtn.dataset.copy)) {
				const old = copyBtn.textContent;
				copyBtn.textContent = '已复制';
				copyBtn.classList.add('done');
				setTimeout(() => { copyBtn.textContent = old; copyBtn.classList.remove('done'); }, 1400);
			}
			return;
		}

		const detailBtn = e.target.closest('.detail-btn');
		if (detailBtn) {
			state.client = detailBtn.dataset.detail;
			renderClients();
			renderPanel();
			const c = state.clients.find((x) => x.id === state.client);
			if (c && c.provider && !state.keys[c.provider]) {
				await ensureKey(c.provider);
				renderPanel();
			}
			$('#panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			return;
		}

		const card = e.target.closest('.client-card');
		if (card) {
			const c = state.clients.find((x) => x.id === card.dataset.client);
			if (c && c.installed) toggleSelect(c.id);
			return;
		}

		if (e.target.closest('#applyBtn')) { applyOne(state.clients.find((x) => x.id === state.client)); return; }
		if (e.target.closest('#launchBtn')) { launchOne(state.clients.find((x) => x.id === state.client)); return; }
		if (e.target.closest('#rollbackBtn')) { rollbackOne(state.clients.find((x) => x.id === state.client)); return; }

		/* Cursor MITM 代理控制 */
		if (e.target.closest('#caInstallBtn')) {
			const btn = e.target.closest('#caInstallBtn');
			btn.disabled = true;
			btn.textContent = '正在安装…';
			const r = await window.ccb.cursorProxy.installCa();
			toast(r.ok ? (r.already ? '根证书此前已安装' : '根证书已安装') : '安装失败：' + (r.error || ''));
			refreshMitmStatus();
			return;
		}
		if (e.target.closest('#caUninstallBtn')) {
			const r = await window.ccb.cursorProxy.uninstallCa();
			toast(r.ok ? '根证书已卸载' : '卸载失败：' + (r.error || ''));
			refreshMitmStatus();
			return;
		}
		if (e.target.closest('#proxyToggleBtn')) { toggleProxy(); return; }

	if (e.target.closest('#pickPathBtn')) {
		const p = await window.ccb.pickClientPath();
		if (!p) return;
		const r = await window.ccb.setCustomPath(state.client, p);
		if (r.ok) {
			state.clients = r.clients;
			state.pendingMismatch = null;
			renderClients(); renderPanel();
			toast(pathMatchToast(r, c0(state.client)));
		} else if (r.mismatch) {
			/* 路径像别的客户端：不落库，弹确认条让用户决定。clients 已是最新检测（未改动）。 */
			state.clients = r.clients;
			state.pendingMismatch = { clientId: state.client, picked: p, reason: r.reason };
			renderClients(); renderPanel();
		} else {
			toast(r.error || '保存失败');
		}
		return;
	}
	if (e.target.closest('#forcePathBtn')) {
		/* 用户确认「仍要使用此路径」：带 force=true 二次提交 */
		const pm = state.pendingMismatch;
		if (pm) {
			const r = await window.ccb.setCustomPath(pm.clientId, pm.picked, true);
			if (r.ok) {
				state.clients = r.clients;
				state.pendingMismatch = null;
				renderClients(); renderPanel();
				toast('已按用户指定保存路径（程序名未确认，启动/写入可能异常）');
			} else {
				toast(r.error || '保存失败');
			}
		}
		return;
	}
	if (e.target.closest('#dismissMismatchBtn')) {
		state.pendingMismatch = null;
		renderPanel();
		return;
	}
	if (e.target.closest('#rePickBtn')) {
		state.pendingMismatch = null;
		renderPanel();   /* 先收起确认条再弹选择框 */
		const p = await window.ccb.pickClientPath();
		if (!p) return;
		const r = await window.ccb.setCustomPath(state.client, p);
		if (r.ok) {
			state.clients = r.clients;
			renderClients(); renderPanel();
			toast(pathMatchToast(r, c0(state.client)));
		} else if (r.mismatch) {
			state.clients = r.clients;
			state.pendingMismatch = { clientId: state.client, picked: p, reason: r.reason };
			renderClients(); renderPanel();
		} else {
			toast(r.error || '保存失败');
		}
		return;
	}
	if (e.target.closest('#clearPathBtn')) {
		const r = await window.ccb.clearCustomPath(state.client);
		if (r.ok) {
			state.clients = r.clients;
			state.pendingMismatch = null;
			renderClients(); renderPanel();
			toast('已清除自定义路径');
		}
		return;
	}
	});

	document.addEventListener('change', (e) => {
		if (e.target.id === 'defaultModelSel') {
			state.defaultModel = e.target.value;
			persist();
		}
	if (e.target.name === 'cursorMode') {
		state.cursorMode = e.target.value === 'mitm' ? 'mitm' : 'byok';
		persist();
		renderPanel();
		toast(
			state.cursorMode === 'mitm'
				? '已切换到 MITM 代理模式：请先安装根证书，再点「重新写入配置」并重启 Cursor'
				: '已切换到官方自定义模型模式：请点「重新写入配置」并重启 Cursor',
		);
	}
	if (
		[
			'cuApiFormat',
			'cuApiKeyHeader',
			'cuMaxTokens',
			'cuTemperature',
			'cuTimeout',
			'cuContextLimit',
			'cuCompress',
			'cuTailTurns',
		].includes(e.target.id)
	) {
		saveCursorUpstream();
	}
});

/* details 的 toggle 不冒泡，必须用捕获阶段；否则面板重渲染后会折叠回去 */
document.addEventListener(
	'toggle',
	(e) => {
		if (e.target && e.target.id === 'cuDetails') state.cuOpen = !!e.target.open;
	},
	true,
);
}

/* ================= 检查更新 ================= */
/* 主进程（desktop/electron/lib/updater.js）负责拉版本、下载、安装，
 * 这里只做展示：右上角版本号 + 「检查更新」按钮 + 顶部新版本横幅。 */
const upd = {
	status: 'idle',      // idle | checking | latest | available | downloading | ready | error
	current: '',
	latest: '',
	notes: '',
	downloadUrl: '',
	portableUrl: '',
	percent: 0,
	error: '',
	canAutoUpdate: false,
	busy: false,         // 手动点「检查更新」进行中（按钮转圈）
};

function setUpdState(s) {
	if (!s) return;
	Object.assign(upd, s);
	renderUpdate();
}

/* 横幅当前该显示什么；返回 null 表示不显示 */
function updateBanner() {
	const hasNew = !!upd.latest && upd.latest !== upd.current;
	if (!hasNew) return null;

	if (upd.status === 'downloading') {
		return {
			kind: 'info',
			title: `正在下载新版本 v${upd.latest}…`,
			sub: `已完成 <b>${upd.percent}%</b>，下载期间可以继续使用；下完再点「重启并安装」即可。`,
			action: 'downloading',
			manual: false,
			closable: false,
		};
	}
	if (upd.status === 'ready') {
		return {
			kind: 'ok',
			title: `新版本 v${upd.latest} 已下载完成`,
			sub: '点「重启并安装」会自动关闭本程序、静默安装并重新打开，无需其它操作。',
			action: 'install',
			manual: false,
			closable: false,
		};
	}
	if (upd.status === 'error') {
		return {
			kind: 'warn',
			title: `更新失败：${upd.error || '未知错误'}`,
			sub: upd.canAutoUpdate ? '可以点「重试」再试一次，或直接手动下载安装包覆盖安装。' : '请手动下载安装包覆盖安装。',
			action: 'retry',
			manual: upd.canAutoUpdate,
			closable: true,
		};
	}
	if (upd.status === 'available') {
		/* 点过「稍后」的版本不再自动打扰 */
		if (state.dismissedUpdate === upd.latest) return null;
		return {
			kind: 'info',
			title: `发现新版本 v${upd.latest}（当前 v${upd.current}）`,
			sub: esc(upd.notes || '建议更新到最新版本，以获得更好的客户端兼容性。'),
			action: upd.canAutoUpdate ? 'download' : 'manual',
			manual: upd.canAutoUpdate,
			closable: true,
		};
	}
	return null;
}

const UPDATE_ACTION_LABEL = {
	download: '立即更新',
	manual: '手动下载',
	retry: '重试',
	install: '重启并安装',
	downloading: '下载中…',
};

function renderUpdate() {
	const hasNew = !!upd.latest && upd.latest !== upd.current;

	const chip = $('#verChip');
	chip.textContent = hasNew ? `v${upd.current} → v${upd.latest}` : `v${upd.current}`;
	chip.classList.toggle('has-new', hasNew);
	chip.classList.toggle('busy', upd.busy || upd.status === 'checking' || upd.status === 'downloading');

	const busy = upd.busy || upd.status === 'checking' || upd.status === 'downloading';
	$('#checkUpdateLabel').textContent = upd.busy ? '检查中…' : '检查更新';
	$('#checkUpdateBtn').disabled = busy;

	const bar = $('#updateBar');
	const m = updateBanner();
	if (!m) { bar.hidden = true; return; }

	bar.hidden = false;
	bar.className = 'updatebar ' + m.kind;
	$('#updateTitle').textContent = m.title;
	$('#updateSub').innerHTML = m.sub;

	const progress = $('#updateProgress');
	progress.hidden = m.action !== 'downloading';
	if (!progress.hidden) $('#updateProgressFill').style.width = upd.percent + '%';

	const act = $('#updateActionBtn');
	act.textContent = UPDATE_ACTION_LABEL[m.action] || '立即更新';
	act.disabled = m.action === 'downloading';
	act.dataset.action = m.action;
	$('#updateManualBtn').hidden = !m.manual;
	$('#updateCloseBtn').hidden = !m.closable;
}

function manualDownload() {
	/* 便携版/免安装场景优先给便携版链接，安装版优先给安装包 */
	const url = upd.canAutoUpdate
		? upd.downloadUrl || upd.portableUrl
		: upd.portableUrl || upd.downloadUrl;
	window.ccb.openExternal(url || 'https://ccb.btluo.com/#download');
}

async function checkUpdate(manual) {
	if (upd.busy || upd.status === 'checking' || upd.status === 'downloading') return;
	upd.busy = true;
	renderUpdate();
	const r = await window.ccb.update.check();
	upd.busy = false;
	renderUpdate();
	if (!r || r.ok === false) {
		if (manual) toast('检查更新失败：' + ((r && r.error) || '未知错误'));
		return;
	}
	if (!manual) return;
	toast(r.hasUpdate ? `发现新版本 v${r.latest}，请看页面顶部提示` : `已是最新版本 v${r.current}`);
}

async function doUpdateAction(action) {
	if (action === 'manual') { manualDownload(); return; }
	if (action === 'install') {
		const r = await window.ccb.update.install();
		if (r && r.ok === false) toast(r.error || '安装失败');
		return;
	}
	if (action === 'download' || action === 'retry') {
		toast('开始下载新版本…');
		const r = await window.ccb.update.download();
		if (r && r.ok === false) toast('更新失败：' + r.error);
	}
}

/* ================= init ================= */
async function init() {
	const info = await window.ccb.appInfo();
	upd.current = info.version;

	/* 更新状态由主进程推送（下载进度等），先订阅，等本地状态读完再同步一次 */
	window.ccb.update.onState(setUpdState);

	const saved = await window.ccb.getState();
	state.apiBase = saved.apiBaseUrl || state.apiBase;
	state.anthropicBase = saved.anthropicBaseUrl || state.anthropicBase;
	state.accountApiBase = saved.accountApiBase || state.accountApiBase;
	state.onboarded = !!saved.onboarded;
	state.dismissedUpdate = saved.dismissedUpdate || '';
	setUpdState(await window.ccb.update.state());
	state.cursorMode = saved.cursorMode === 'mitm' ? 'mitm' : 'byok';
	state.cursorUpstream =
		saved.cursorUpstream && typeof saved.cursorUpstream === 'object' ? saved.cursorUpstream : {};
	if (Array.isArray(saved.models)) {
		state.models = saved.models;
		state.models.forEach((m) => { m.selected = true; });
	}
	ensureDefaultModel();

	$('#advAccountBase').value = state.accountApiBase;
	$('#advApiBase').value = state.apiBase;
	$('#advAnthropicBase').value = state.anthropicBase;
	$('#endpointChip').textContent = state.apiBase.replace(/^https?:\/\//, '');

	state.clients = await window.ccb.detectClients();
	state.clientsReady = true;
	defaultSelection();
	renderClients();
	renderModels();
	renderHelp();
	bindEvents();

	/* 自动登录：本地 token 拉取档案，失败则回登录页 */
	const st = await window.ccb.auth.status();
	if (st.loggedIn) {
		const p = await window.ccb.api.profile();
		if (p && p.user) {
			setUser(p.user, p.usage);
			enterMain();
			loadModelsSilently();
			return;
		}
		await window.ccb.auth.logout();
	}
	setAuthMode('login');
	showAuth();
}

if (!window.ccb) {
	document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#17203a;background:#ffffff;height:100vh">请在 CCB 桌面应用中打开此页面。</div>';
} else {
	init();
}
