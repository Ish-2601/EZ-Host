// Electron main process: owns the ServerManager and exposes it to the UI over IPC.
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, safeStorage, nativeImage } = require('electron');
const { ServerManager } = require('../engine/manager');
const modrinth = require('../engine/modrinth');
const cohostAuth = require('../engine/cohost-auth');
const { startSftpHost } = require('../engine/sftp-host');
const { createStatusServer } = require('../engine/status-server');

// Keep data in %APPDATA%\self-host-mc whether running from source or installed
// (the installed app would otherwise use its product name, "Self-Host MC").
// SELF_HOST_MC_DATA points a test run at a separate folder so it never touches real servers.
app.setPath('userData', process.env.SELF_HOST_MC_DATA || path.join(app.getPath('appData'), 'self-host-mc'));

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
let activeCohost = null;
let sftpHost = null;
let statusHost = null;
const authFailures = new Map();
const COHOST_PERMISSIONS = ['server', 'console', 'players', 'files', 'backups', 'settings', 'tools'];
const CHANNEL_PERMISSION = {
  'servers:list': 'server', 'servers:get': 'server', 'servers:console': 'console', 'servers:start': 'server', 'servers:stop': 'server',
  'servers:acceptEula': 'server', 'servers:players': 'server', 'profiles:list': 'server', 'servers:checkProfile': 'server',
  'servers:command': 'console', 'servers:update': 'settings', 'servers:properties': 'settings', 'servers:setProperties': 'settings',
  'servers:delete': 'settings', 'servers:openFolder': 'settings', 'servers:players': 'players', 'players:list': 'players',
  'whitelist:status': 'players', 'whitelist:add': 'players', 'whitelist:remove': 'players', 'whitelist:enable': 'players', 'whitelist:deny': 'players',
  'players:details': 'players', 'players:action': 'players', 'map:dimensions': 'server', 'map:regions': 'server', 'map:tile': 'server',
  'map:players': 'players', 'map:forceloaded': 'server', 'map:forceload': 'server', 'servers:joinInfo': 'server', 'servers:clientNeeds': 'server',
  'servers:exportClientPack': 'server', 'servers:exportMrpack': 'server', 'servers:newAddress': 'settings', 'servers:tunnel': 'server',
  'servers:pregen': 'server', 'servers:installChunky': 'settings', 'servers:pregenStart': 'server', 'servers:pregenPause': 'server',
  'servers:pregenContinue': 'server', 'servers:pregenCancel': 'server', 'playit:status': 'server', 'playit:link': 'settings',
  'playit:unlink': 'settings', 'playit:retry': 'settings', 'files:list': 'files', 'files:read': 'files', 'files:write': 'files',
  'files:mkdir': 'files', 'files:rename': 'files', 'files:delete': 'files', 'files:upload': 'files', 'files:download': 'files',
  'files:archive': 'files', 'files:extract': 'files', 'backups:list': 'backups', 'backups:create': 'backups', 'backups:restore': 'backups',
  'backups:settings': 'backups', 'backups:setSettings': 'backups', 'tasks:list': 'backups', 'tasks:save': 'backups', 'tasks:run': 'backups',
  'servers:activity': 'server', 'servers:metrics': 'server', 'servers:commands': 'tools', 'servers:setCommands': 'tools',
  'servers:setDiskWarning': 'settings',
  'servers:changeSoftware': 'settings', 'plugins:search': 'tools', 'plugins:install': 'tools', 'modrinth:compareUpdate': 'settings',
  'modrinth:update': 'settings', 'servers:installBedrock': 'tools', 'share:export': 'server', 'settings:hostName': 'server', 'settings:setHostName': 'settings',
  'servers:exportStatusPage': 'server', 'system:copy': 'server', 'system:totalMemoryMb': 'server',
  'settings:notifications': 'settings', 'settings:setNotifications': 'settings',
  'minecraft:versions': 'server',
  'zomboid:localConfigs': 'server', 'servers:createZomboid': 'settings', 'servers:retryZomboidSetup': 'settings', 'zomboid:settings': 'settings', 'zomboid:saveSettings': 'settings',
  'zomboid:collections': 'server', 'zomboid:previewCollection': 'server', 'zomboid:installCollection': 'settings', 'zomboid:sandbox': 'settings', 'zomboid:items': 'players', 'zomboid:serverOptions': 'settings', 'zomboid:saveServerOptions': 'settings', 'zomboid:saveSandbox': 'settings',
  'settings:app': 'server', 'settings:setApp': 'settings',
  'mods:overview': 'server', 'mods:setEnabled': 'settings',
  'perf:advice': 'server', 'perf:applySettings': 'settings', 'perf:installMods': 'settings', 'servers:setMemory': 'settings',
  'servers:icon': 'server', 'servers:chooseIcon': 'settings', 'servers:removeIcon': 'settings',
  'sftp:start': 'settings', 'sftp:stop': 'settings', 'sftp:status': 'settings',
  'status:start': 'settings', 'status:stop': 'settings', 'status:state': 'settings', 'status:open': 'settings',
};

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

function accountsFile() { return path.join(app.getPath('userData'), 'cohosts.json'); }

async function readCohosts() {
  try { return JSON.parse(await fs.readFile(accountsFile(), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function currentActor() { return activeCohost ? activeCohost.username : 'Host'; }

function lanIPv4() {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i.test(name)) continue;
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
  }
  return [...new Set(addresses)];
}

function cohostPermission(channel) {
  if (!activeCohost || channel.startsWith('auth:')) return;
  const required = CHANNEL_PERMISSION[channel];
  if (!required || !activeCohost.permissions.includes(required)) throw new Error(`This co-host account does not have permission to use ${required || 'this feature'}.`);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    cohostPermission(channel);
    if (manager) manager.setActor(currentActor());
    const result = await fn(...args);
    if (manager && channel === 'servers:command') await manager.audit(args[0], 'Ran a console command', { command: String(args[1] || '').slice(0, 160) });
    if (manager && channel === 'players:action') await manager.audit(args[0], 'Used a player control', { action: args[2] });
    return result;
  });
}

function registerIpc() {
  handle('auth:current', () => activeCohost ? { username: activeCohost.username, permissions: activeCohost.permissions } : { username: 'Host', permissions: COHOST_PERMISSIONS, host: true });
  handle('auth:list', async () => {
    if (activeCohost) throw new Error('Only the host can manage co-host accounts.');
    return (await readCohosts()).map(({ username, permissions, totpSecret }) => ({ username, permissions, twoFactor: Boolean(totpSecret) }));
  });
  handle('auth:create', async ({ username, password, permissions, twoFactor }) => {
    if (activeCohost) throw new Error('Only the host can create co-host accounts.');
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(name)) throw new Error('Use a username with 3–24 letters, numbers, dots, dashes, or underscores.');
    if (String(password || '').length < 10 || String(password || '').length > 128) throw new Error('Use a password with 10–128 characters.');
    const accounts = await readCohosts();
    if (accounts.some((account) => account.username.toLowerCase() === name.toLowerCase())) throw new Error('That co-host username already exists.');
    const selected = [...new Set((Array.isArray(permissions) ? permissions : []).filter((permission) => COHOST_PERMISSIONS.includes(permission)))];
    if (!selected.length) throw new Error('Select at least one permission.');
    if (!selected.includes('server')) throw new Error('Co-hosts need Server overview access to select a server.');
    const passwordRecord = cohostAuth.hashPassword(password);
    let secret = null;
    if (twoFactor) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this Windows account.');
      secret = cohostAuth.createTotpSecret();
    }
    accounts.push({ username: name, salt: passwordRecord.salt, passwordHash: passwordRecord.hash, permissions: selected, totpSecret: secret ? safeStorage.encryptString(secret).toString('base64') : null, createdAt: new Date().toISOString() });
    await fs.writeFile(accountsFile(), JSON.stringify(accounts, null, 2));
    return { username: name, permissions: selected, twoFactorSecret: secret };
  });
  handle('auth:login', async ({ username, password, code }) => {
    const name = String(username || '').trim().toLowerCase();
    if (String(password || '').length > 128) throw new Error('The password is too long.');
    const now = Date.now();
    const failures = authFailures.get(name) || { count: 0, since: now };
    if (now - failures.since > 15 * 60 * 1000) { failures.count = 0; failures.since = now; }
    if (failures.count >= 5) throw new Error('Too many sign-in attempts. Wait 15 minutes and try again.');
    const account = (await readCohosts()).find((item) => item.username.toLowerCase() === name);
    let valid = Boolean(account && cohostAuth.checkPassword(password, account));
    if (valid && account.totpSecret) {
      try { valid = cohostAuth.verifyTotp(safeStorage.decryptString(Buffer.from(account.totpSecret, 'base64')), code); }
      catch { valid = false; }
    }
    if (!valid) {
      failures.count += 1;
      authFailures.set(name, failures);
      throw new Error('Username, password, or authenticator code is incorrect.');
    }
    authFailures.delete(name);
    activeCohost = { username: account.username, permissions: account.permissions };
    manager.setActor(account.username);
    send('auth:changed', { username: account.username, permissions: account.permissions, host: false });
    return { username: account.username, permissions: account.permissions };
  });
  handle('auth:logout', () => {
    activeCohost = null;
    manager.setActor('Host');
    const user = { username: 'Host', permissions: COHOST_PERMISSIONS, host: true };
    send('auth:changed', user);
    return user;
  });
  handle('auth:remove', async (username) => {
    if (activeCohost) throw new Error('Only the host can remove co-host accounts.');
    const accounts = await readCohosts();
    const next = accounts.filter((item) => item.username !== username);
    if (next.length === accounts.length) return false;
    await fs.writeFile(accountsFile(), JSON.stringify(next, null, 2));
    return true;
  });

  handle('modrinth:search', (query, opts) => modrinth.searchModpacks(query, opts));
  handle('modrinth:versions', (projectId) => modrinth.getModpackVersions(projectId));
  handle('plugins:search', (query, options) => manager.searchPlugins(query, options));
  handle('plugins:install', (id, projectId) => manager.installPlugin(id, projectId));
  handle('servers:installBedrock', (id) => manager.installBedrockBridge(id));

  handle('servers:list', () => manager.list());
  handle('servers:get', (id) => manager.describe(id));
  handle('servers:console', (id) => manager.consoleHistory(id));
  handle('servers:metrics', (id) => manager.serverMetrics(id));
  handle('servers:setDiskWarning', (id, gigabytes) => manager.setDiskWarningLimit(id, gigabytes));
  handle('servers:activity', (id) => manager.activity(id));
  handle('servers:commands', (id) => manager.commandButtons(id));
  handle('servers:setCommands', (id, buttons) => manager.setCommandButtons(id, buttons));
  handle('servers:changeSoftware', (id, software, minecraft) => manager.changeSoftware(id, software, minecraft));
  handle('modrinth:compareUpdate', (id) => manager.compareModpackUpdate(id));
  handle('modrinth:update', (id, versionId) => manager.updateModpack(id, versionId));
  handle('settings:notifications', () => manager.readSettings().notifications || { start: true, stop: true, crash: true, attention: true });
  handle('settings:setNotifications', async (preferences) => {
    const saved = Object.fromEntries(['start', 'stop', 'crash', 'attention'].map((key) => [key, preferences && preferences[key] !== false]));
    await manager.updateSettings({ notifications: saved });
    return saved;
  });
  handle('servers:exportStatusPage', async (id) => {
    const server = manager.describe(id);
    const join = manager.joinInfo(id);
    const players = manager.players(id);
    const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const address = manager.tunnelStatus(id).address || (join.lan[0] && join.lan[0].address) || join.local;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export shareable server status', defaultPath: path.join(app.getPath('documents'), `${safeFileName(server.name)}-join.html`),
      filters: [{ name: 'HTML page', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const status = server.status === 'running' ? 'Online' : server.status === 'installing' ? 'Installing' : 'Offline';
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safe(server.name)} — Minecraft server</title><style>body{margin:0;background:#14161a;color:#e7ebf2;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(640px,calc(100% - 40px));box-sizing:border-box;padding:28px;background:#20242b;border:1px solid #3a404b;border-radius:16px}h1{margin-top:0}.tag{color:#8bd5ff}.address{padding:12px;background:#14161a;border-radius:8px;font:600 20px ui-monospace,monospace;word-break:break-all}li{margin:6px 0}</style><main class="card"><h1>${safe(server.name)}</h1><p class="tag">${safe(status)} · Minecraft ${safe(server.minecraft || 'version not set')}</p><h2>Join address</h2><div class="address">${safe(address)}</div><p>Java Edition players can add this address in Multiplayer. Use the Minecraft version shown above${server.loader && server.loader !== 'vanilla' ? ` with ${safe(server.loader)} ${safe(server.loaderVersion || '')} and the server's modpack` : ''}.</p><h2>Players online</h2><p>${players.length ? players.map(safe).join(', ') : 'No players right now.'}</p><p>Shared from Self-Host MC.</p></main></html>`;
    await fs.writeFile(result.filePath, html, 'utf8');
    shell.showItemInFolder(result.filePath);
    return result.filePath;
  });
  handle('sftp:status', (id) => sftpHost
    ? { active: true, otherServer: sftpHost.serverId !== id, serverName: manager.describe(sftpHost.serverId).name, port: sftpHost.port, host: sftpHost.host, username: 'minecraft', fingerprint: sftpHost.fingerprint }
    : { active: false });
  handle('sftp:start', async (id, { port = 2222, lanAccess = false } = {}) => {
    const listenPort = Math.max(1024, Math.min(65535, Math.floor(Number(port) || 2222)));
    if (sftpHost) { await sftpHost.close(); sftpHost = null; }
    const password = require('crypto').randomBytes(24).toString('base64url');
    const service = await startSftpHost({
      root: manager.serverDir(id), hostKeyPath: path.join(app.getPath('userData'), 'sftp-host-key'),
      password, port: listenPort, lanAccess: Boolean(lanAccess),
      onChange: (action, details) => manager.audit(id, action, details, 'SFTP client'),
    });
    sftpHost = { ...service, serverId: id };
    await manager.audit(id, 'Started SFTP access', { port: listenPort, lanAccess: Boolean(lanAccess) });
    const addresses = lanAccess ? lanIPv4() : ['127.0.0.1'];
    return { active: true, port: listenPort, host: service.host, addresses, username: service.username, password, fingerprint: service.fingerprint };
  });
  handle('sftp:stop', async (id) => {
    if (!sftpHost) return false;
    const activeServerId = sftpHost.serverId;
    await sftpHost.close();
    sftpHost = null;
    await manager.audit(activeServerId, 'Stopped SFTP access');
    return true;
  });
  handle('status:state', (id) => statusHost
    ? { active: true, otherServer: statusHost.serverId !== id, serverName: manager.describe(statusHost.serverId).name, host: statusHost.host, port: statusHost.port, lanAccess: statusHost.lanAccess, addresses: statusHost.addresses }
    : { active: false });
  handle('status:open', async (id) => {
    if (!statusHost || statusHost.serverId !== id) throw new Error('Start the live status page first.');
    await shell.openExternal(`http://127.0.0.1:${statusHost.port}/`);
    return true;
  });
  handle('status:start', async (id, { lanAccess = false } = {}) => {
    if (statusHost) { await statusHost.close(); statusHost = null; }
    const port = 27892;
    const service = await createStatusServer({ port, lanAccess: Boolean(lanAccess), getStatus: async () => {
      const server = manager.describe(id);
      const join = manager.joinInfo(id);
      const tunnel = manager.tunnelStatus(id);
      const address = tunnel.address || (join.lan[0] && join.lan[0].address) || join.local;
      return {
        name: server.name, online: server.status === 'running', version: server.minecraft,
        software: server.software || null, loader: server.loader, loaderVersion: server.loaderVersion,
        address, players: server.status === 'running' ? manager.players(id) : [], updatedAt: new Date().toISOString(),
      };
    } });
    const addresses = lanAccess ? lanIPv4() : ['127.0.0.1'];
    statusHost = { ...service, serverId: id, lanAccess: Boolean(lanAccess), addresses };
    await manager.audit(id, 'Started live status page', { port, lanAccess: Boolean(lanAccess) });
    return { active: true, host: service.host, port, lanAccess: Boolean(lanAccess), addresses };
  });
  handle('status:stop', async (id) => {
    if (!statusHost) return false;
    const activeServerId = statusHost.serverId;
    await statusHost.close();
    statusHost = null;
    await manager.audit(activeServerId, 'Stopped live status page');
    return true;
  });
  handle('backups:list', (id) => manager.listBackups(id));
  handle('backups:create', (id, reason) => manager.createBackup(id, reason));
  handle('backups:restore', (id, backupId) => manager.restoreBackup(id, backupId));
  handle('backups:settings', (id) => manager.backupSettings(id));
  handle('backups:setSettings', (id, patch) => manager.setBackupSettings(id, patch));
  handle('tasks:list', (id) => manager.listTasks(id));
  handle('tasks:save', (id, tasks) => manager.saveTasks(id, tasks));
  handle('tasks:run', (id, taskId) => manager.runTaskNow(id, taskId));
  handle('files:list', (id, dir) => manager.listFiles(id, dir));
  handle('files:read', (id, file) => manager.readServerFile(id, file));
  handle('files:write', (id, file, text) => manager.writeServerFile(id, file, text));
  handle('files:mkdir', (id, dir, name) => manager.createServerFolder(id, dir, name));
  handle('files:rename', (id, file, name) => manager.renameServerFile(id, file, name));
  handle('files:delete', (id, file) => manager.deleteServerFile(id, file));
  handle('files:upload', async (id, dir) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Upload server files', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return false;
    for (const file of result.filePaths) await manager.uploadServerFile(id, dir, file);
    return true;
  });
  handle('files:download', async (id, file) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Download server file', defaultPath: path.join(app.getPath('downloads'), path.basename(file)),
    });
    if (result.canceled || !result.filePath) return false;
    await manager.downloadServerFile(id, file, result.filePath);
    shell.showItemInFolder(result.filePath);
    return true;
  });
  handle('files:archive', async (id, folder) => {
    const name = path.basename(folder) || 'server-files';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Create a ZIP archive', defaultPath: path.join(app.getPath('downloads'), `${safeFileName(name)}.zip`),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await manager.archiveServerFolder(id, folder, result.filePath);
    shell.showItemInFolder(result.filePath);
    return true;
  });
  handle('files:extract', (id, file) => manager.extractServerArchive(id, file));
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
    if (typeof patch.autoRestart === 'boolean') allowed.autoRestart = patch.autoRestart;
    if (Number.isInteger(patch.memoryMb) && patch.memoryMb >= 1024 && patch.memoryMb <= 65536) {
      allowed.memoryMb = patch.memoryMb;
    }
    return manager.updateConfig(id, allowed);
  });
  handle('servers:properties', (id) => manager.readProperties(id));
  handle('servers:setProperties', (id, patch) => {
    const allowed = {};
    const values = patch && typeof patch === 'object' ? patch : {};
    const valid = {
      motd: (value) => String(value).slice(0, 256).replace(/[\r\n]/g, ' '),
      difficulty: (value) => ['peaceful', 'easy', 'normal', 'hard'].includes(value) ? value : undefined,
      gamemode: (value) => ['survival', 'creative', 'adventure', 'spectator'].includes(value) ? value : undefined,
      'server-port': (value) => Number.isInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 65535 ? String(Number(value)) : undefined,
      'max-players': (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 200 ? String(Number(value)) : undefined,
      'spawn-protection': (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000 ? String(Number(value)) : undefined,
      pvp: (value) => ['true', 'false'].includes(String(value)) ? String(value) : undefined,
      'enable-command-block': (value) => ['true', 'false'].includes(String(value)) ? String(value) : undefined,
      'force-gamemode': (value) => ['true', 'false'].includes(String(value)) ? String(value) : undefined,
    };
    for (const [key, value] of Object.entries(values)) if (valid[key]) { const safe = valid[key](value); if (safe !== undefined) allowed[key] = safe; }
    return manager.writeProperties(id, allowed);
  });
  handle('servers:delete', async (id) => {
    if (sftpHost && sftpHost.serverId === id) { await sftpHost.close(); sftpHost = null; }
    if (statusHost && statusHost.serverId === id) { await statusHost.close(); statusHost = null; }
    return manager.remove(id);
  });
  handle('servers:openFolder', (id) => shell.openPath(manager.serverDir(id)));
  handle('system:totalMemoryMb', () => Math.floor(require('os').totalmem() / 1024 / 1024));
  handle('system:copy', (text) => { clipboard.writeText(String(text)); return true; });

  handle('playit:status', () => manager.playitStatus());
  handle('playit:link', () => {
    // Runs in the background; progress arrives as 'playit' events.
    manager.linkPlayit((url) => shell.openExternal(url)).catch(() => {});
  });
  handle('playit:unlink', () => manager.unlinkPlayit());
  handle('playit:retry', (id) => manager.startTunnel(id));
  handle('servers:players', (id) => manager.players(id));
  handle('servers:tunnel', (id) => manager.tunnelStatus(id));
  handle('servers:pregen', (id) => manager.pregenStatus(id));
  handle('players:list', (id) => manager.listPlayersWithNames(id));
  handle('whitelist:status', (id) => manager.whitelistStatus(id));
  handle('whitelist:add', (id, name, password) => manager.whitelistAdd(id, name, password));
  handle('whitelist:remove', (id, name) => manager.whitelistRemove(id, name));
  handle('whitelist:enable', (id, on) => manager.setWhitelistEnabled(id, Boolean(on)));
  handle('whitelist:deny', (id, name) => manager.denyJoiner(id, name));
  handle('settings:hostName', () => manager.hostName());
  handle('zomboid:localConfigs', () => manager.zomboid.localConfigs());
  handle('servers:createZomboid', (opts) => manager.zomboid.create(opts || {}));
  handle('servers:retryZomboidSetup', (id) => manager.zomboid.retrySetup(id));
  handle('zomboid:settings', (id) => manager.zomboid.settings(id));
  handle('zomboid:saveSettings', (id, values) => manager.zomboid.saveSettings(id, values || {}));
  handle('zomboid:collections', () => manager.zomboid.listCollections());
  handle('zomboid:previewCollection', (link) => manager.zomboid.previewCollection(link));
  handle('zomboid:installCollection', (id, link) => manager.zomboid.installCollection(id, link));
  handle('zomboid:sandbox', (id) => manager.zomboid.sandbox(id));
  handle('zomboid:items', (id) => manager.zomboid.items(id));
  handle('zomboid:serverOptions', (id) => manager.zomboid.serverOptions(id));
  handle('zomboid:saveServerOptions', (id, values) => manager.zomboid.saveServerOptions(id, values || {}));
  handle('zomboid:saveSandbox', (id, values) => manager.zomboid.saveSandbox(id, values || {}));
  handle('settings:app', () => manager.appSettings());
  handle('settings:setApp', async (patch) => {
    const next = await manager.setAppSettings(patch || {});
    if (typeof (patch || {}).startWithWindows === 'boolean' && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.startWithWindows });
    }
    return next;
  });
  handle('settings:setHostName', (name) => manager.setHostName(name));
  handle('map:dimensions', (id) => manager.mapDimensions(id));
  handle('map:regions', (id, dim) => manager.mapRegions(id, dim));
  handle('map:tile', (id, dim, rx, rz, mode) => manager.mapTile(id, dim, rx, rz, mode));
  handle('map:players', (id) => manager.playerPositions(id));
  handle('map:forceloaded', (id, dim) => manager.forceloaded(id, dim));
  handle('map:forceload', (id, dim, rect, add) => manager.forceload(id, dim, rect, add));
  handle('players:details', (id, uuid) => manager.playerDetails(id, uuid));
  handle('players:action', (id, uuid, action, args) => manager.playerAction(id, uuid, action, args));
  handle('servers:installChunky', (id) => manager.installChunky(id));
  handle('mods:overview', (id) => manager.modsOverview(id));
  handle('mods:setEnabled', (id, fileName, enabled) => manager.setModEnabled(id, fileName, Boolean(enabled)));
  handle('perf:advice', (id) => manager.performanceAdvice(id));
  handle('perf:applySettings', (id) => manager.applyPerformanceSettings(id));
  handle('perf:installMods', (id, slugs) => manager.installPerformanceMods(id, Array.isArray(slugs) ? slugs : []));
  handle('servers:setMemory', (id, mb) => {
    const value = Math.round(Number(mb) / 512) * 512;
    if (!(value >= 1024 && value <= 65536)) throw new Error('Invalid memory amount');
    return manager.updateConfig(id, { memoryMb: value });
  });
  handle('servers:icon', (id) => manager.serverIcon(id));
  handle('servers:removeIcon', (id) => manager.setServerIcon(id, null));
  handle('servers:chooseIcon', async (id) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a server icon',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw new Error('That file is not an image Self-Host MC can read');
    // Minecraft only shows a 64x64 PNG: crop to a centred square, then resize.
    const { width, height } = image.getSize();
    const side = Math.min(width, height);
    const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    const png = square.resize({ width: 64, height: 64, quality: 'best' }).toPNG();
    return manager.setServerIcon(id, png);
  });
  handle('servers:pregenStart', (id, radius) => manager.startPregen(id, radius));
  handle('servers:pregenPause', (id) => manager.pausePregen(id));
  handle('servers:pregenContinue', (id) => manager.continuePregen(id));
  handle('servers:pregenCancel', (id) => manager.cancelPregen(id));
  handle('servers:newAddress', (id) => manager.newAddress(id));
  handle('servers:createVanilla', (opts) => manager.createVanilla(opts));
  handle('minecraft:versions', () => manager.listMinecraftVersions());
  handle('system:openExternal', (url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });

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

  const notify = (kind, title, body) => {
    const prefs = manager.readSettings().notifications || {};
    if (prefs[kind] === false || !Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  };
  manager.on('console', (id, line) => send('server:console', id, line));
  manager.on('startup', (id, state) => send('server:startup', id, state));
  manager.on('status', (id, status) => {
    send('server:status', id, status);
    const server = manager.describe(id);
    if (status === 'running') notify('start', `${server.name} is online`, 'The Minecraft server has started.');
    else if (status === 'stopped' && server.crashed) notify('crash', `${server.name} stopped unexpectedly`, 'Automatic restart is being attempted. Check the console if it does not recover.');
    else if (status === 'stopped') notify('stop', `${server.name} is offline`, 'The Minecraft server has stopped.');
    if (status === 'stopped') manager.audit(id, server.crashed ? 'Server crashed' : 'Server stopped', { crashed: server.crashed }).catch(() => {});
    if (status === 'running') manager.audit(id, 'Server started').catch(() => {});
  });
  manager.on('install', (id, event) => send('server:install', id, event));
  manager.on('changed', () => send('servers:changed'));
  manager.on('playit', (state) => send('playit:status', state));
  manager.on('players', (id, players) => send('server:players', id, players));
  manager.on('tunnel', (id, state) => send('server:tunnel', id, state));
  manager.on('pregen', (id, state) => send('server:pregen', id, state));
  manager.on('whitelist', (id, state) => send('server:whitelist', id, state));
  manager.on('backup', (id, state) => send('server:backup', id, state));
  manager.on('mods', (id) => send('server:mods', id));
  manager.on('task', (id, state) => send('server:task', id, state));
  manager.on('attention', (id, state) => {
    send('server:attention', id, state);
    const server = manager.describe(id);
    notify('attention', `${server.name} needs attention`, state === 'crash-loop' ? 'Automatic restarts were paused after repeated crashes.' : String(state));
  });
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
  Promise.allSettled([sftpHost && sftpHost.close(), statusHost && statusHost.close()]).finally(() => {
    sftpHost = null; statusHost = null; return manager.stopAll();
  }).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
