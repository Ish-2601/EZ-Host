// Electron main process: owns the ServerManager and exposes it to the UI over IPC.
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { ServerManager } = require('../engine/manager');
const modrinth = require('../engine/modrinth');

// Keep data in %APPDATA%\self-host-mc whether running from source or installed
// (the installed app would otherwise use its product name, "Self-Host MC").
app.setPath('userData', path.join(app.getPath('appData'), 'self-host-mc'));

// One window only: opening the app again focuses the running one, so two
// copies never fight over the same servers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let manager = null;
let quitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'Self-Host MC',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'server';
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => fn(...args));
}

function registerIpc() {
  handle('modrinth:search', (query, opts) => modrinth.searchModpacks(query, opts));
  handle('modrinth:versions', (projectId) => modrinth.getModpackVersions(projectId));

  handle('servers:list', () => manager.list());
  handle('servers:get', (id) => manager.describe(id));
  handle('servers:console', (id) => manager.consoleHistory(id));
  handle('servers:createFromModrinth', (opts) => manager.createFromModrinth(opts));
  handle('servers:createFromFile', async (opts) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Modrinth modpack',
      filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return manager.createFromFile({ ...opts, filePath: result.filePaths[0] });
  });
  handle('servers:acceptEula', (id) => manager.acceptEula(id));
  handle('servers:start', (id) => manager.start(id));
  handle('servers:stop', (id) => manager.stop(id));
  handle('servers:command', (id, command) => manager.sendCommand(id, command));
  handle('servers:update', (id, patch) => {
    // Only let the UI change user-editable settings.
    const allowed = {};
    if (typeof patch.name === 'string' && patch.name.trim()) allowed.name = patch.name.trim().slice(0, 64);
    if (Number.isInteger(patch.memoryMb) && patch.memoryMb >= 1024 && patch.memoryMb <= 65536) {
      allowed.memoryMb = patch.memoryMb;
    }
    return manager.updateConfig(id, allowed);
  });
  handle('servers:properties', (id) => manager.readProperties(id));
  handle('servers:setProperties', (id, patch) => manager.writeProperties(id, patch));
  handle('servers:delete', (id) => manager.remove(id));
  handle('servers:openFolder', (id) => shell.openPath(manager.serverDir(id)));
  handle('system:totalMemoryMb', () => Math.floor(require('os').totalmem() / 1024 / 1024));
  handle('system:copy', (text) => clipboard.writeText(String(text)));

  handle('playit:status', () => manager.playitStatus());
  handle('playit:link', () => {
    // Runs in the background; progress arrives as 'playit' events.
    manager.linkPlayit((url) => shell.openExternal(url)).catch(() => {});
  });
  handle('playit:unlink', () => manager.unlinkPlayit());
  handle('playit:retry', (id) => manager.startTunnel(id));
  handle('servers:players', (id) => manager.players(id));

  handle('profiles:list', () => manager.listProfiles());
  handle('servers:createFromProfile', (opts) => manager.createFromProfile(opts));
  handle('servers:checkProfile', (id, profileId) => manager.checkProfile(id, profileId));
  handle('servers:joinInfo', (id) => manager.joinInfo(id));
  handle('servers:clientNeeds', async (id) => {
    const needs = await manager.clientNeeds(id);
    return { ...needs, modCount: needs.mods.length, mods: undefined };
  });
  handle('servers:exportClientPack', async (id) => {
    const config = manager.readConfig(id);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save the pack for CurseForge',
      defaultPath: path.join(app.getPath('downloads'), `${safeFileName(config.name)} (CurseForge).zip`),
      filters: [{ name: 'CurseForge profile', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await manager.exportClientPack(id, result.filePath, {
      onProgress: (done, total) => send('server:export', id, { done, total }),
    });
    shell.showItemInFolder(result.filePath);
    return result.filePath;
  });
  handle('servers:exportMrpack', async (id) => {
    const config = manager.readConfig(id);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save the Modrinth pack',
      defaultPath: path.join(app.getPath('downloads'), `${safeFileName(config.name)}.mrpack`),
      filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await manager.exportMrpack(id, result.filePath);
    shell.showItemInFolder(result.filePath);
    return result.filePath;
  });

  manager.on('console', (id, line) => send('server:console', id, line));
  manager.on('status', (id, status) => send('server:status', id, status));
  manager.on('install', (id, event) => send('server:install', id, event));
  manager.on('changed', () => send('servers:changed'));
  manager.on('playit', (state) => send('playit:status', state));
  manager.on('players', (id, players) => send('server:players', id, players));
}

app.whenReady().then(() => {
  manager = new ServerManager(path.join(app.getPath('userData'), 'data'));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Never leave a server running headless after the window closes: save and stop first.
app.on('before-quit', (event) => {
  if (quitting || !manager) return;
  event.preventDefault();
  quitting = true;
  manager.stopAll().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
