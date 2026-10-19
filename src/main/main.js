// Electron main process: owns the ServerManager and exposes it to the UI over IPC.
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { ServerManager } = require('../engine/manager');
const modrinth = require('../engine/modrinth');

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

  manager.on('console', (id, line) => send('server:console', id, line));
  manager.on('status', (id, status) => send('server:status', id, status));
  manager.on('install', (id, event) => send('server:install', id, event));
  manager.on('changed', () => send('servers:changed'));
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
