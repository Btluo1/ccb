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
 *   dev：<electron.exe> qoder-secret-helper.js encrypt         → stdin 收明文，stdout: {"ok":true,"b64":"..."}
 *        <electron.exe> qoder-secret-helper.js decrypt <base64> → stdout: {"ok":true,"plain":"..."}
 *   打包：<CCB.exe> --ccb-script=qoder-secret-helper.js encrypt（main.js 顶部派发，
 *        argv 已规整为 [execPath, 脚本名, mode]，解析位置与 dev 完全一致）
 *
 * 注意：ELECTRON_RUN_AS_NODE 必须未设置（父进程是正常 Electron 应用，继承环境即可）。
 * encrypt 的明文走 stdin 而不是 argv：命令行参数可被 tasklist / wmic / 日志采集看到，
 * 密钥落进命令行等于明文外泄；父进程以 stdio:['pipe','pipe','ignore'] 启动并写 stdin。
 */
'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

const MODE = process.argv[2] || '';
/* decrypt 的 base64 密文仍走 argv（非敏感）；encrypt 明文只从 stdin 读 */
const ARG = process.argv[3] || '';

/** 收集 stdin 直到 end（父进程写完明文即关闭写端） */
function readStdin() {
	return new Promise((resolve) => {
		let buf = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (c) => { buf += c; });
		process.stdin.on('end', () => resolve(buf));
		process.stdin.on('error', () => resolve(buf));
		process.stdin.resume();
	});
}

async function main() {
	/* stdout.write 是异步 flush：立即 app.exit 可能截断输出（父进程按整段 JSON
	 * 解析，截断即失败）。必须在 write 回调里退出，保证字节完整落到管道。 */
	const reply = (obj, code) => {
		process.stdout.write(JSON.stringify(obj), () => app.exit(code || 0));
	};
	if (MODE !== 'encrypt' && MODE !== 'decrypt') {
		reply({ ok: false, error: 'usage: encrypt(stdin)|decrypt <arg>' });
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
			const plain = await readStdin();
			const blob = safeStorage.encryptString(plain);
			/* roundtrip 自检，杜绝写入无法解密的 blob */
			const back = safeStorage.decryptString(blob);
			if (back !== plain) {
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
	process.stdout.write(JSON.stringify({ ok: false, error: e.message || String(e) }), () => app.exit(1));
});
