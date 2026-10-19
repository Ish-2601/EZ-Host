// Renders src/renderer/icon.svg to build/icon.png for the installer and window.
//   npx electron scripts/make-icon.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  win.webContents.on('paint', (_event, _dirty, image) => {
    if (image.isEmpty()) return;
    fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
    console.log('wrote', out);
    app.exit(0);
  });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  setTimeout(() => app.exit(1), 10000);
});
