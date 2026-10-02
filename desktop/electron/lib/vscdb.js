/**
 * VS Code 系 IDE（Trae / Cursor / Qoder）的 state.vscdb 读写工具
 *
 * 这些 IDE 把模型、密钥等配置存在 `%APPDATA%\<产品>\User\globalStorage\state.vscdb`
 * 的 ItemTable 表中，value 为 JSON 字符串。本模块使用 Electron 内置的 node:sqlite
 * （Electron 44 / Node 24 起可用，无需任何原生模块），以「读 → 改 JSON → 写回」方式
 * 精确更新单个 key，不触碰表结构。
 *
 * 安全约束：必须在目标 IDE 完全退出后写入。IDE 运行时会持有数据库并在退出时回写
 * 内存状态，届时我们的修改会被覆盖；同时并发写有损坏风险。调用方需先用
 * proc.js 的 isRunning 检查。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ITEM_TABLE = 'ItemTable';

/** state.vscdb 路径（appDataDir 为 %APPDATA%\<产品名>） */
function stateDbPath(appDataDir) {
	return path.join(appDataDir, 'User', 'globalStorage', 'state.vscdb');
}

function open(file, readOnly) {
	return new DatabaseSync(file, { readOnly: !!readOnly });
}

/** 读取单个 key 的字符串值；不存在返回 null */
function readItem(file, key) {
	const db = open(file, true);
	try {
		const row = db.prepare(`SELECT value FROM ${ITEM_TABLE} WHERE key = ?`).get(key);
		return row && row.value != null ? String(row.value) : null;
	} finally {
		db.close();
	}
}

/** 按 LIKE 模式列出 key（用于发现带 uid 前缀的动态 key，如 `<uid>_AI.agent.model.model_list_map`） */
function listKeys(file, like) {
	const db = open(file, true);
	try {
		return db
			.prepare(`SELECT key FROM ${ITEM_TABLE} WHERE key LIKE ?`)
			.all(like)
			.map((r) => r.key);
	} finally {
		db.close();
	}
}

/** 读取并解析 JSON 值；解析失败返回 null（不抛错，交由调用方决定是否覆盖） */
function readJson(file, key) {
	const raw = readItem(file, key);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** 备份整库（连同 WAL/SHM），已存在备份则覆盖为最新 */
function backupDb(file, log) {
	if (!fs.existsSync(file)) return false;
	for (const suffix of ['', '-wal', '-shm']) {
		const src = file + suffix;
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, file + '.ccb.bak' + suffix);
		}
	}
	if (log) log(`已备份数据库 ${path.basename(file)} → ${path.basename(file)}.ccb.bak`);
	return true;
}

/** 写入单个 key（字符串或对象）。写入前整库备份。 */
function writeItem(file, key, value) {
	const db = open(file, false);
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		// ItemTable 的 key 声明为 UNIQUE ON CONFLICT REPLACE，用 INSERT OR REPLACE 完成 upsert
		db.prepare(`INSERT OR REPLACE INTO ${ITEM_TABLE} (key, value) VALUES (?, ?)`).run(key, text);
	} finally {
		db.close();
	}
}

/** 删除单个 key（回滚用）；返回是否确实删除了行 */
function deleteItem(file, key) {
	const db = open(file, false);
	try {
		const r = db.prepare(`DELETE FROM ${ITEM_TABLE} WHERE key = ?`).run(key);
		return !!(r && r.changes);
	} finally {
		db.close();
	}
}

/** 恢复备份（回滚用）；返回是否恢复成功 */
function restoreDb(file, log) {
	const bak = file + '.ccb.bak';
	if (!fs.existsSync(bak)) return false;
	for (const suffix of ['', '-wal', '-shm']) {
		const src = bak + suffix;
		const dst = file + suffix;
		if (fs.existsSync(src)) fs.copyFileSync(src, dst);
		else if (fs.existsSync(dst) && suffix) fs.rmSync(dst);
	}
	if (log) log(`已从备份恢复 ${path.basename(file)}`);
	return true;
}

module.exports = {
	ITEM_TABLE,
	stateDbPath,
	readItem,
	readJson,
	listKeys,
	writeItem,
	deleteItem,
	backupDb,
	restoreDb,
};
