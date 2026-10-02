const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccb', {
	appInfo: () => ipcRenderer.invoke('app:info'),

	/* 检查更新 / 自动更新（electron-updater） */
	update: {
		check: () => ipcRenderer.invoke('update:check'),
		download: () => ipcRenderer.invoke('update:download'),
		install: () => ipcRenderer.invoke('update:install'),
		state: () => ipcRenderer.invoke('update:state'),
		onState: (cb) => {
			const fn = (_e, s) => {
				if (typeof cb === 'function') cb(s);
			};
			ipcRenderer.on('update:state', fn);
			return () => ipcRenderer.removeListener('update:state', fn);
		},
	},

	/* 账号（用户名 + 密码，无需邮箱） */
	auth: {
		login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
		register: (username, password) => ipcRenderer.invoke('auth:register', username, password),
		logout: () => ipcRenderer.invoke('auth:logout'),
		status: () => ipcRenderer.invoke('auth:status'),
	},

	/* 后端 API（余额 / 兑换 / 平台密钥 / 模型） */
	api: {
		profile: () => ipcRenderer.invoke('api:profile'),
		models: () => ipcRenderer.invoke('api:models'),
		currentKey: (provider) => ipcRenderer.invoke('api:currentKey', provider),
		redeem: (code) => ipcRenderer.invoke('api:redeem', code),
	},

	/* 客户端 */
	detectClients: () => ipcRenderer.invoke('clients:detect'),
	launchClient: (clientId) => ipcRenderer.invoke('clients:launch', clientId),
	pickClientPath: () => ipcRenderer.invoke('dialog:pickClientPath'),
	setCustomPath: (clientId, p, force) => ipcRenderer.invoke('clients:setCustomPath', clientId, p, force),
	clearCustomPath: (clientId) => ipcRenderer.invoke('clients:clearCustomPath', clientId),

	verifyKey: (apiBase, apiKey) => ipcRenderer.invoke('key:verify', apiBase, apiKey),
	applyConfig: (clientId, cfg) => ipcRenderer.invoke('config:apply', clientId, cfg),
	rollbackConfig: (clientId) => ipcRenderer.invoke('config:rollback', clientId),

	/* Cursor MITM 代理（模仿 cursor-agent） */
	cursorProxy: {
		status: () => ipcRenderer.invoke('cursorproxy:status'),
		start: (cfg) => ipcRenderer.invoke('cursorproxy:start', cfg),
		stop: () => ipcRenderer.invoke('cursorproxy:stop'),
		installCa: () => ipcRenderer.invoke('cursorproxy:installCa'),
		uninstallCa: () => ipcRenderer.invoke('cursorproxy:uninstallCa'),
	},

	/* Qoder CN IDE 1.30+ 本地 MITM 代理（BYOK 配置注入，自定义模型可用性的前提） */
	qoderProxy: {
		status: () => ipcRenderer.invoke('qoderproxy:status'),
		start: (cfg) => ipcRenderer.invoke('qoderproxy:start', cfg),
		stop: () => ipcRenderer.invoke('qoderproxy:stop'),
		installCa: () => ipcRenderer.invoke('qoderproxy:installCa'),
		uninstallCa: () => ipcRenderer.invoke('qoderproxy:uninstallCa'),
	},

	getState: () => ipcRenderer.invoke('store:get'),
	saveState: (partial) => ipcRenderer.invoke('store:set', partial),

	revealPath: (target) => ipcRenderer.invoke('shell:reveal', target),
	openExternal: (target) => ipcRenderer.invoke('shell:open', target),
});
