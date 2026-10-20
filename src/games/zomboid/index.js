// Project Zomboid support for ServerManager. A server's selfhost.json has
// game: 'zomboid'; everything game-specific goes through this class, and the
// manager keeps doing the shared parts (config, events, tunnels, console).
//
// Layout on disk:
//   <data>/games/steamcmd/          SteamCMD
//   <data>/games/zomboid-server/    the dedicated server (shared by all Zomboid servers)
//   <server>/Zomboid/               this server's own data (-cachedir): Server/<name>.ini, Saves, db, logs
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ensureSteamCmd, appUpdate } = require('./steamcmd');
const { ZomboidProcess } = require('./process');
const zcfg = require('./config');
const zmods = require('./mods');

const APP_ID = 380870;
const NAME_RE = /^[A-Za-z0-9_ .-]{1,32}$/;
const ACCESS_LEVELS = ['admin', 'moderator', 'overseer', 'gm', 'observer', 'none'];

const quote = (s) => `"${String(s).replace(/["\r\n]/g, '')}"`;

class ZomboidGame {
  constructor(manager) {
    this.m = manager;
    this.installDir = path.join(manager.paths.root, 'games', 'zomboid-server');
    this.steamcmdDir = path.join(manager.paths.root, 'games', 'steamcmd');
    this.updating = null;
  }

  cacheDir(id) {
    return path.join(this.m.serverDir(id), 'Zomboid');
  }

  iniFile(id) {
    const config = this.m.readConfig(id);
    return path.join(this.cacheDir(id), 'Server', `${config.serverName}.ini`);
  }

  ini(id) {
    return zcfg.readIni(this.iniFile(id));
  }

  writeIni(id, patch) {
    zcfg.writeIni(this.iniFile(id), patch);
  }

  /** The host's own Zomboid servers (made in the game), which a new server can copy. */
  localConfigs() {
    return zcfg.localServerConfigs();
  }

  /** Two UDP game ports and an RCON port that no other server uses. */
  freePorts(exceptId) {
    const used = new Set();
    for (const s of this.m.list()) {
      if (s.id === exceptId || s.game !== 'zomboid') continue;
      used.add(Number(s.port));
    }
    let port = 16261;
    while (used.has(port)) port += 2;
    return { port, udpPort: port + 1, rconPort: 27015 + (port - 16261) / 2 };
  }

  /** Install (first time) or update the shared dedicated server. Players must be on the same version. */
  async ensureServerInstalled({ log = () => {}, progress = () => {} } = {}) {
    if (this.updating) return this.updating;
    this.updating = (async () => {
      const steamcmd = await ensureSteamCmd(this.steamcmdDir, log);
      const first = !fs.existsSync(path.join(this.installDir, 'java', 'projectzomboid.jar'));
      log(first ? 'Downloading the Project Zomboid dedicated server (several GB, one time only)...' : 'Checking for Project Zomboid server updates...');
      const run = () => appUpdate(steamcmd, this.installDir, APP_ID, {
        log,
        validate: first,
        onProgress: (percent, label) => progress(`Zomboid server: ${label}`, Math.round(percent), 100),
      });
      try {
        await run();
      } catch (err) {
        // SteamCMD updates itself on its first run and then exits; the second run installs.
        log('SteamCMD updated itself; trying again...');
        await run();
      }
    })().finally(() => {
      this.updating = null;
    });
    return this.updating;
  }

  /** Create a Zomboid server, optionally copying one of the host's own server configs. */
  async create({ name, memoryMb = 6144, copyFrom = null }) {
    if (copyFrom && !this.localConfigs().some((c) => c.name === copyFrom)) throw new Error('That Zomboid server config was not found');
    const id = await this.m.createConfig(name || copyFrom || 'Zomboid server', memoryMb, { type: 'zomboid', copyFrom });
    const ports = this.freePorts(id);
    // Server names end up in file names; keep them plain.
    const serverName = `selfhost_${id.replace(/[^a-z0-9]/g, '').slice(-10)}`;
    await this.m.updateConfig(id, {
      game: 'zomboid',
      serverName,
      port: ports.port,
      udpPort: ports.udpPort,
      rconPort: ports.rconPort,
      rconPassword: crypto.randomBytes(12).toString('hex'),
      adminPassword: crypto.randomBytes(12).toString('hex'),
      eulaAccepted: true, // Zomboid has no separate server licence prompt
    });

    this.m.installing.add(id);
    this.m.emit('status', id, 'installing');
    const lines = [];
    this.m.installLogs.set(id, lines);
    const log = (message) => {
      lines.push({ text: message, stream: 'system', time: Date.now() });
      this.m.emit('install', id, { message });
    };
    const progress = (label, done, total) => this.m.emit('install', id, { progress: { label, done, total } });

    (async () => {
      await this.ensureServerInstalled({ log, progress });
      const serverDir = path.join(this.cacheDir(id), 'Server');
      await fsp.mkdir(serverDir, { recursive: true });
      if (copyFrom) {
        for (const { suffix, file } of zcfg.serverConfigFiles(copyFrom)) {
          await fsp.copyFile(file, path.join(serverDir, `${serverName}${suffix}`));
        }
        log(`Copied your "${copyFrom}" settings, mods and world options.`);
      }
      this.applyNetworkSettings(id);
      const config = this.m.readConfig(id);
      const ini = this.ini(id);
      const listOn = this.m.appSettings ? this.m.appSettings().defaultWhitelist : false;
      this.writeIni(id, {
        PublicName: ini.PublicName && copyFrom ? ini.PublicName : config.name,
        Public: ini.Public || 'false',
        Open: copyFrom && ini.Open ? ini.Open : String(!listOn),
      });
      await this.m.updateConfig(id, { installed: true, installError: null, packName: copyFrom ? `Copy of ${copyFrom}` : 'Project Zomboid' });
      log('Install complete. Press Start.');
    })()
      .catch(async (err) => {
        log(`Install failed: ${err.message}`);
        await this.m.updateConfig(id, { installError: err.message }).catch(() => {});
      })
      .finally(() => {
        this.m.installing.delete(id);
        this.m.emit('status', id, 'stopped');
        this.m.emit('changed');
      });
    return this.m.describe(id);
  }

  /** Ports, RCON and the server's admin login, written before every start. */
  applyNetworkSettings(id) {
    const config = this.m.readConfig(id);
    this.writeIni(id, {
      DefaultPort: config.port,
      UDPPort: config.udpPort,
      RCONPort: config.rconPort,
      RCONPassword: config.rconPassword,
      // playit.gg provides the outside address; the game's own router setup (UPnP) is not needed.
      UPnP: 'false',
    });
  }

  rconInfo(id) {
    const config = this.m.readConfig(id);
    return { port: Number(config.rconPort), password: config.rconPassword, multiPacket: false };
  }

  /** Start the server: update it first so players on the latest version can join. */
  async createProcess(id, { log, progress }) {
    const config = this.m.readConfig(id);
    try {
      await this.ensureServerInstalled({ log, progress });
    } catch (err) {
      log(`Could not check for server updates (${err.message}); starting the installed version.`);
    }
    this.applyNetworkSettings(id);
    return new ZomboidProcess({
      installDir: this.installDir,
      cacheDir: this.cacheDir(id),
      serverName: config.serverName,
      memoryMb: config.memoryMb,
      adminPassword: config.adminPassword,
      lastStartMs: config.lastStartMs || 0,
    });
  }

  /** Online player names from /players ("Players connected (2): \n-Ana\n-Bo"). */
  async syncOnline(id) {
    const out = await this.m.rcon(id, 'players');
    const names = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('-')).map((l) => l.slice(1).trim()).filter(Boolean);
    const proc = this.m.processes.get(id);
    if (proc) proc.setPlayers(names);
    return names;
  }

  /** Accounts from the server database (whitelist table), plus who is online. */
  listPlayers(id) {
    const config = this.m.readConfig(id);
    const dbFile = path.join(this.cacheDir(id), 'db', `${config.serverName}.db`);
    const online = new Set(this.m.players(id).map((n) => n.toLowerCase()));
    const out = [];
    if (fs.existsSync(dbFile)) {
      let db;
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(dbFile, { readOnly: true });
        const roles = new Map(db.prepare('SELECT id, name FROM role').all().map((r) => [r.id, r.name]));
        const banned = new Set(db.prepare('SELECT username FROM bannedip').all().map((r) => (r.username || '').toLowerCase()));
        for (const row of db.prepare('SELECT username, lastConnection, role FROM whitelist').all()) {
          if (!row.username || row.username === 'admin') continue;
          const role = roles.get(row.role) || '';
          out.push({
            uuid: `zomboid:${row.username}`,
            name: row.username,
            online: online.has(row.username.toLowerCase()),
            op: /admin/i.test(role),
            role,
            banned: banned.has(row.username.toLowerCase()),
            whitelisted: true,
            lastPlayed: row.lastConnection ? Date.parse(row.lastConnection) || null : null,
            hasData: false,
          });
        }
      } catch {
        // database busy or missing tables: fall back to the online list
      } finally {
        try {
          if (db) db.close();
        } catch {
          // ignore
        }
      }
    }
    for (const name of this.m.players(id)) {
      if (!out.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        out.push({ uuid: `zomboid:${name}`, name, online: true, op: false, banned: false, whitelisted: false, hasData: false });
      }
    }
    return out.sort((a, b) => b.online - a.online || (b.lastPlayed || 0) - (a.lastPlayed || 0));
  }

  /** Commands for the player menu. Zomboid has no heal/feed/inventory editing over RCON. */
  playerCommands(name, action, args = {}) {
    if (!NAME_RE.test(name)) throw new Error('Invalid player name');
    const n = quote(name);
    switch (action) {
      case 'op': return [`setaccesslevel ${n} "admin"`];
      case 'deop': return [`setaccesslevel ${n} "none"`];
      case 'role':
        if (!ACCESS_LEVELS.includes(args.level)) throw new Error('Unknown access level');
        return [`setaccesslevel ${n} ${quote(args.level)}`];
      case 'kick': return [`kick ${n}`];
      case 'ban': return [`banuser ${n}`];
      case 'pardon': return [`unbanuser ${n}`];
      case 'tp-to':
        if (!NAME_RE.test(args.target || '')) throw new Error('Choose who to teleport to');
        return [`teleportplayer ${n} ${quote(args.target)}`];
      case 'tp-from':
        if (!NAME_RE.test(args.target || '')) throw new Error('Choose who to teleport');
        return [`teleportplayer ${quote(args.target)} ${n}`];
      case 'godmode': return [`godmodeplayer ${n} -${args.on === false ? 'false' : 'true'}`];
      case 'invisible': return [`invisibleplayer ${n} -${args.on === false ? 'false' : 'true'}`];
      case 'give': {
        const item = String(args.item || '').trim();
        if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(item)) throw new Error('Type an item id like Base.Axe');
        const count = Math.max(1, Math.min(500, Math.floor(Number(args.count) || 1)));
        return [`additem ${n} ${quote(item)} ${count}`];
      }
      default:
        throw new Error('That action is not available in Project Zomboid');
    }
  }

  async playerAction(id, name, action, args) {
    if (!this.m.isRunning(id)) throw new Error('Start the server first');
    const outs = [];
    for (const cmd of this.playerCommands(name, action, args)) outs.push(await this.m.rcon(id, cmd));
    return outs.join('\n');
  }

  // ---------- whitelist (Open=false means only accounts on the list can join) ----------

  whitelistStatus(id) {
    const ini = this.ini(id);
    return {
      enabled: ini.Open === 'false',
      players: this.listPlayers(id).filter((p) => p.whitelisted).map((p) => ({ uuid: p.name, name: p.name })),
      refused: [],
      needsPassword: true,
    };
  }

  async setWhitelistEnabled(id, enabled) {
    this.writeIni(id, { Open: String(!enabled) });
    if (this.m.isRunning(id)) {
      await this.m.rcon(id, `changeoption Open "${!enabled}"`);
      await this.m.rcon(id, 'reloadoptions').catch(() => {});
    }
  }

  /** Zomboid accounts have passwords; a new one is made up and returned so the host can pass it on. */
  async whitelistAdd(id, name, password) {
    if (!NAME_RE.test(name || '')) throw new Error('Usernames can use letters, numbers, spaces and _ . -');
    if (!this.m.isRunning(id)) throw new Error('Start the server to add players (Zomboid keeps accounts in the running server)');
    const pass = password || crypto.randomBytes(4).toString('hex');
    const out = await this.m.rcon(id, `adduser ${quote(name)} ${quote(pass)}`);
    if (/already exist/i.test(out)) throw new Error(`${name} already has an account on this server`);
    return { name, password: pass, message: out };
  }

  async whitelistRemove(id, name) {
    if (!this.m.isRunning(id)) throw new Error('Start the server to remove players');
    return this.m.rcon(id, `removeuserfromwhitelist ${quote(name)}`);
  }

  // ---------- mods ----------

  modsOverview(id) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    return { game: 'zomboid', running, ...zmods.overview(this.iniFile(id)) };
  }

  setModEnabled(id, modId, enabled) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before changing mods');
    return zmods.setModEnabled(this.iniFile(id), modId, enabled);
  }

  // ---------- settings shown in the app ----------

  settings(id) {
    const ini = this.ini(id);
    return {
      PublicName: ini.PublicName || '',
      PublicDescription: (ini.PublicDescription || '').replace(/\\n/g, '\n'),
      MaxPlayers: ini.MaxPlayers || '32',
      Password: ini.Password || '',
      PVP: ini.PVP || 'true',
      Public: ini.Public || 'false',
      Map: ini.Map || '',
      PauseEmpty: ini.PauseEmpty || 'true',
    };
  }

  saveSettings(id, values) {
    const patch = {};
    if (typeof values.PublicName === 'string') patch.PublicName = values.PublicName.replace(/[\r\n]/g, ' ').slice(0, 64);
    if (typeof values.PublicDescription === 'string') patch.PublicDescription = values.PublicDescription.replace(/\r?\n/g, '\\n').slice(0, 1000);
    if (values.MaxPlayers !== undefined) patch.MaxPlayers = String(Math.max(1, Math.min(100, Math.floor(Number(values.MaxPlayers) || 32))));
    if (typeof values.Password === 'string') patch.Password = values.Password.replace(/[\r\n]/g, '').slice(0, 64);
    for (const key of ['PVP', 'Public', 'PauseEmpty']) if (typeof values[key] === 'boolean') patch[key] = String(values[key]);
    this.writeIni(id, patch);
    return this.settings(id);
  }

  joinInfo(id) {
    const config = this.m.readConfig(id);
    return { port: config.port, udpPort: config.udpPort };
  }
}

module.exports = { ZomboidGame, APP_ID };
