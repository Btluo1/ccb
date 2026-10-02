/**
 * Qoder CN IDE vscdb secret 加密 helper（无窗口 Electron 子进程）
 *
 * Qoder CN IDE 1.30+ 的自定义模型 apiKey 存在 state.vscdb 的
 * `secret://aicoding.customModel.apiKey.<id>`，值为 v10 加密 blob
 * （Electron safeStorage，密钥从 QoderCN userData 的 Local State 派生）。
 * CCB 桌面端主进程不能切换自己的 userData，因此用「自身 exe + 本脚本」
 * 起一个无窗口子进程：app.setPath('userData', %APPDATA%\QoderCN) 后
 * safeStorage.encryptString 即用 QoderCN 的密钥加密（与 Qoder IDE 互通）。
 *
 * 用法（由 main.js spawn 调用，不直接 require）：
 *   <CCB.exe> qoder-secret-helper.js encrypt <plaintext>   → stdout: {"ok":true,"b64":"..."}
 *   <CCB.exe> qoder-secret-helper.js decrypt <base64>       → stdout: {"ok":true,"plain":"..."}
 *
 * 注意：ELECTRON_RUN_AS_NODE 必须未设置（父进程是正常 Electron 应用，继承环境即可）。
 */
'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

const MODE = process.argv[2] || '';
const ARG = process.argv[3] || '';

async function main() {
	const reply = (obj) => {
		process.stdout.write(JSON.stringify(obj));
		app.exit(0);
	};
	if (MODE !== 'encrypt' && MODE !== 'decrypt') {
		reply({ ok: false, error: 'usage: encrypt|decrypt <arg>' });
		return;
	}
	/* 必须在 ready 前设置 userData（safeStorage 的密钥从该目录 Local State 派生） */
	app.setPath('userData', path.join(process.env.APPDATA || '', 'QoderCN'));
	await app.whenReady();
	if (!safeStorage.isEncryptionAvailable()) {
		reply({ ok: false, error: 'safeStorage 不可用' });
		return;
	}
	try {
		if (MODE === 'encrypt') {
			const blob = safeStorage.encryptString(ARG);
			/* roundtrip 自检，杜绝写入无法解密的 blob */
			const back = safeStorage.decryptString(blob);
			if (back !== ARG) {
				reply({ ok: false, error: 'roundtrip 校验失败' });
				return;
			}
			reply({ ok: true, b64: blob.toString('base64') });
		} else {
			reply({ ok: true, plain: safeStorage.decryptString(Buffer.from(ARG, 'base64')) });
		}
	} catch (e) {
		reply({ ok: false, error: e.message || String(e) });
	}
}

main().catch((e) => {
	process.stdout.write(JSON.stringify({ ok: false, error: e.message || String(e) }));
	app.exit(1);
});
