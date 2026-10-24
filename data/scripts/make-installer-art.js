// Draws the installer's pictures from the app logo, so they never drift out of date.
//   npx electron scripts/make-installer-art.js
// Writes build/icon.ico, build/installerSidebar.bmp, build/uninstallerSidebar.bmp and build/installerHeader.bmp.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, nativeImage } = require('electron');

app.disableHardwareAcceleration();
// Closing the first picture's window must not end the program before the next one is drawn.
app.on('window-all-closed', () => {});

const build = path.join(__dirname, '..', 'build');
const renderer = path.join(__dirname, '..', 'src', 'renderer');

/** A 24-bit bottom-up BMP, the format the NSIS installer pages need. */
function toBmp(image, width, height) {
  const bgra = image.resize({ width, height }).toBitmap();
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (height - 1 - y) * rowSize + x * 3;
      // Flatten any transparency onto the page background (near-black).
      const a = bgra[s + 3] / 255;
      for (let c = 0; c < 3; c++) pixels[d + c] = Math.round(bgra[s + c] * a + 6 * (1 - a));
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

/** An .ico holding PNG pictures at the usual sizes. */
function toIco(logo) {
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = sizes.map((s) => logo.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const head = Buffer.alloc(6 + sizes.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s === 256 ? 0 : s;
    head[e + 1] = s === 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

async function render(html, width, height) {
  const win = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const file = path.join(build, `.art-${width}x${height}.html`);
  fs.writeFileSync(file, html);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('render timed out')), 20000);
    let latest = null;
    win.webContents.on('paint', (_e, _d, image) => {
      if (!image.isEmpty()) latest = image;
    });
    win.webContents.once('did-finish-load', () => {
      // Keep asking for frames, then use the last one once fonts and the SVG have settled.
      const poke = setInterval(() => win.webContents.invalidate(), 150);
      setTimeout(() => {
        clearInterval(poke);
        clearTimeout(timer);
        fs.unlinkSync(file);
        win.destroy();
        if (latest) resolve(latest);
        else reject(new Error('nothing was drawn'));
      }, 1800);
    });
    win.loadFile(file);
  });
}

const css = `
  @font-face { font-family: 'Rajdhani'; src: url('file:///${renderer.replace(/\\/g, '/')}/fonts/Rajdhani-Bold.ttf'); font-weight: 700; }
  @font-face { font-family: 'Mono'; src: url('file:///${renderer.replace(/\\/g, '/')}/fonts/ShareTechMono-Regular.ttf'); }
  * { box-sizing: border-box; margin: 0; }
  html, body { background: #060708; color: #e9ebee; overflow: hidden; }
`;

const globe = fs.readFileSync(path.join(renderer, 'hud-globe.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
const logoSvg = fs.readFileSync(path.join(renderer, 'icon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');

app.whenReady().then(async () => {
  try {
    const logo = nativeImage.createFromPath(path.join(build, 'icon.png'));
    fs.writeFileSync(path.join(build, 'icon.ico'), toIco(logo));

    // Welcome and finish pages: 164 x 314.
    const sidebar = await render(`<style>${css}
      body { width: 164px; height: 314px; position: relative; background:
        radial-gradient(circle at 1px 1px, rgba(201,206,214,.09) 1px, transparent 1.4px) 0 0 / 14px 14px, #060708; }
      .globe { position: absolute; left: -120px; bottom: -70px; width: 330px; height: 330px; opacity: .8; }
      .globe svg { width: 100%; height: 100%; }
      .logo { position: absolute; left: 18px; top: 22px; width: 56px; height: 56px; }
      .logo svg { width: 100%; height: 100%; }
      .name { position: absolute; left: 18px; top: 92px; font: 700 34px/1 Rajdhani; letter-spacing: .08em; }
      .name small { display: block; font: 400 11px/1.5 Mono; letter-spacing: .16em; color: #868d97; margin-top: 8px; text-transform: uppercase; }
      .tick { display: inline-block; width: 7px; height: 7px; background: #ff7a1a; margin-right: 6px; }
      .rule { position: absolute; left: 18px; top: 168px; width: 40px; height: 2px; background: #ff7a1a; }
      .foot { position: absolute; left: 18px; bottom: 16px; font: 400 10px/1.5 Mono; letter-spacing: .12em; color: #868d97; text-transform: uppercase; }
    </style>
    <div class="globe">${globe}</div>
    <div class="logo">${logoSvg}</div>
    <div class="name">EZ<br>HOST<small><span class="tick"></span>Game servers</small></div>
    <div class="rule"></div>
    <div class="foot">Minecraft<br>Project Zomboid</div>`, 164, 314);
    fs.writeFileSync(path.join(build, 'installerSidebar.bmp'), toBmp(sidebar, 164, 314));
    fs.copyFileSync(path.join(build, 'installerSidebar.bmp'), path.join(build, 'uninstallerSidebar.bmp'));

    // Banner at the top of the inner pages: 150 x 57.
    const banner = await render(`<style>${css}
      body { width: 150px; height: 57px; position: relative; background:
        radial-gradient(circle at 1px 1px, rgba(201,206,214,.10) 1px, transparent 1.4px) 0 0 / 12px 12px, #060708; }
      .logo { position: absolute; left: 12px; top: 10px; width: 36px; height: 36px; }
      .logo svg { width: 100%; height: 100%; }
      .name { position: absolute; left: 58px; top: 12px; font: 700 22px/1 Rajdhani; letter-spacing: .1em; }
      .name small { display: block; font: 400 8.5px/1.4 Mono; letter-spacing: .16em; color: #ff7a1a; margin-top: 3px; text-transform: uppercase; }
    </style><div class="logo">${logoSvg}</div><div class="name">EZ HOST<small>Game servers</small></div>`, 150, 57);
    fs.writeFileSync(path.join(build, 'installerHeader.bmp'), toBmp(banner, 150, 57));

    console.log('wrote icon.ico, installerSidebar.bmp, uninstallerSidebar.bmp, installerHeader.bmp in', build);
    app.exit(0);
  } catch (err) {
    console.error(err.message);
    app.exit(1);
  }
});
