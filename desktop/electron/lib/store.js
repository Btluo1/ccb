const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
	apiBaseUrl: 'https://code.btluo.com/v1',
	anthropicBaseUrl: 'https://code.btluo.com',
	accountApiBase: 'https://ccb.btluo.com',
};

const ENC_PREFIX = 'enc:';

function storeFile() {
	return path.join(app.getPath('userData'), 'config.json');
}

function encryptToken(plaintext) {
	if (!plaintext) return plaintext;
	if (!safeStorage.isEncryptionAvailable()) return plaintext;
	try {
		return ENC_PREFIX + safeStorage.encryptString(plaintext).toString('base64');
	} catch {
		return plaintext;
	}
}

function decryptToken(stored) {
	if (!stored || typeof stored !== 'string') return stored;
	if (!stored.startsWith(ENC_PREFIX)) return stored;
	if (!safeStorage.isEncryptionAvailable()) return null;
	try {
		return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
	} catch {
		return null;
	}
}

/* 读取磁盘上的持久化配置（解密 token），文件不存在时返回空配置 */
function readPersisted() {
	try {
		const raw = fs.readFileSync(storeFile(), 'utf8');
		const data = JSON.parse(raw);
		if (data.token) data.token = decryptToken(data.token);
		return data;
	} catch {
		return { token: null, user: null, models: [], defaultModel: '' };
	}
}

/* 补齐缺省服务地址 */
function withDefaults(data) {
	return {
		...data,
		apiBaseUrl: data.apiBaseUrl || DEFAULTS.apiBaseUrl,
		anthropicBaseUrl: data.anthropicBaseUrl || DEFAULTS.anthropicBaseUrl,
		accountApiBase: data.accountApiBase || DEFAULTS.accountApiBase,
	};
}

function load() {
	const data = withDefaults(readPersisted());
	/* 本地联调：CCB_API_BASE=http://127.0.0.1:8787 electron . 可将账号服务指向本地 dev（仅运行时生效） */
	const envAccountBase = process.env.CCB_API_BASE || '';
	return envAccountBase ? { ...data, accountApiBase: envAccountBase } : data;
}

function save(partial) {
	/* 基于已持久化数据合并，避免把 CCB_API_BASE 注入值写入 config.json */
	const data = withDefaults({ ...readPersisted(), ...partial });
	const file = storeFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + '.tmp';
	const toWrite = { ...data, token: encryptToken(data.token) };
	fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
	fs.renameSync(tmp, file);
	return data;
}

module.exports = { load, save, DEFAULTS };
