/* 一次性脚本：把 public/logo.svg 光栅化为应用图标 PNG（Electron 已安装，无需额外依赖） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'public', 'logo.svg'), 'utf8');

const TARGETS = [
	{ file: path.join(__dirname, 'build', 'icon.png'), size: 512 },       // electron-builder → Windows .ico
	{ file: path.join(ROOT, 'public', 'apple-touch-icon.png'), size: 180 }, // iOS 主屏图标
];

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
svg{display:block}
</style></head><body>${svg}</body></html>`;

async function render(win, size) {
	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
	return win.webContents.executeJavaScript(`(() => {
		document.querySelector('svg').setAttribute('width', '${size}');
		document.querySelector('svg').setAttribute('height', '${size}');
		const s = new XMLSerializer().serializeToString(document.querySelector('svg'));
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const c = document.createElement('canvas');
				c.width = ${size}; c.height = ${size};
				const ctx = c.getContext('2d');
				ctx.drawImage(img, 0, 0, ${size}, ${size});
				resolve(c.toDataURL('image/png'));
			};
			img.onerror = () => reject(new Error('SVG 解码失败'));
			img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
		});
	})()`);
}

app.whenReady().then(async () => {
	const win = new BrowserWindow({ width: 520, height: 520, show: false });
	for (const { file, size } of TARGETS) {
		const dataUrl = await render(win, size);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
		console.log('written', file, size + 'x' + size);
	}
	app.exit(0);
});