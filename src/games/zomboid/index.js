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
const sandbox = require('./sandbox');
const workshop = require('./workshop');
const { listItems, listVehicles } = require('./items');
const { ZomboidMap, playerPositions } = require('./map');
const { modSandboxFields } = require('./mod-sandbox');
const serverOptions = require('./server-options');

const APP_ID = 380870;
const NAME_RE = /^[A-Za-z0-9_ .-]{1,32}$/;
const ACCESS_LEVELS = ['admin', 'moderator', 'overseer', 'gm', 'observer', 'none'];
// Skills that /addxp accepts (Build 42 perk ids).
const PERKS = ['Fitness', 'Strength', 'Sprinting', 'Lightfoot', 'Nimble', 'Sneak', 'Axe', 'Blunt', 'SmallBlunt', 'LongBlade', 'SmallBlade', 'Spear', 'Maintenance', 'Woodwork', 'Cooking', 'Farming', 'Doctor', 'Electricity', 'MetalWelding', 'Mechanics', 'Tailoring', 'Aiming', 'Reloading', 'Fishing', 'Trapping', 'PlantScavenging', 'FlintKnapping', 'Masonry', 'Pottery', 'Carving', 'Husbandry', 'Tracking', 'Blacksmith', 'Butchering', 'Glassmaking'];
const ID_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

const quote = (s) => `"${String(s).replace(/["\r\n]/g, '')}"`;

class ZomboidGame {
  constructor(manager) {
    this.m = manager;
    this.installDir = path.join(manager.paths.root, 'games', 'zomboid-server');
    this.steamcmdDir = path.join(manager.paths.root, 'games', 'steamcmd');
    this.updating = null;
  }

  /** Workshop mods on this PC: the host's Steam downloads plus ones the app fetched. */
  workshop() {
    return zcfg.scanWorkshop([workshop.steamcmdWorkshopRoot(path.join(this.steamcmdDir, 'steamcmd.exe'))]);
  }

  /** Vehicles that can be spawned next to a player (game plus turned-on mods). */
  vehicles(id) {
    const enabled = zcfg.splitList(zcfg.readIni(this.iniFile(id)).Mods);
    const key = `v|${enabled.join(';')}`;
    this.itemCache = this.itemCache || new Map();
    if (this.itemCache.has(key)) return this.itemCache.get(key);
    const wanted = new Set(enabled);
    const list = listVehicles(this.installDir, this.workshop().flatMap((w) => w.mods).filter((m) => wanted.has(m.id) && m.dir));
    this.itemCache.set(key, list);
    return list;
  }

  /** The in-game map (tiles from the server's own files). */
  map() {
    if (!this.mapReader) this.mapReader = new ZomboidMap(this.installDir);
    return this.mapReader;
  }

  mapInfo() {
    return this.map().mapInfo();
  }

  /** One map tile as a data URL, or null. */
  mapTile(level, tx, ty) {
    const png = this.map().tile(level, tx, ty);
    return png ? `data:image/png;base64,${png.toString('base64')}` : null;
  }

  /** Where each character was when the server last saved: [{ username, character, x, y, z, dead, online }]. */
  playerPositions(id) {
    const config = this.m.readConfig(id);
    const online = new Set(((this.m.processes.get(id) || {}).players ? [...this.m.processes.get(id).players] : []).map((n) => n.toLowerCase()));
    return playerPositions(path.join(this.cacheDir(id), 'Saves', 'Multiplayer', config.serverName, 'players.db'))
      .map((p) => ({ ...p, online: online.has(p.username.toLowerCase()) }));
  }

  /** World-wide admin actions for the Tools tab. */
  async serverAction(id, action, args = {}) {
    if (!this.m.isRunning(id)) throw new Error('Start the server first');
    const commands = {
      message: () => {
        const text = String(args.text || '').replace(/["\r\n]/g, ' ').trim().slice(0, 200);
        if (!text) throw new Error('Type a message');
        return `servermsg ${quote(text)}`;
      },
      save: () => 'save',
      'rain-start': () => 'startrain',
      'rain-stop': () => 'stoprain',
      helicopter: () => 'chopper',
      gunshot: () => 'gunshot',
      'check-mods': () => 'checkModsNeedUpdate',
    };
    if (!commands[action]) throw new Error('Unknown action');
    return this.m.rcon(id, commands[action]());
  }

  /** Items players can be given: the game's plus the server's turned-on mods. Cached until mods change. */
  items(id) {
    const enabled = zcfg.splitList(zcfg.readIni(this.iniFile(id)).Mods);
    const key = `${this.installDir}|${enabled.join(';')}`;
    this.itemCache = this.itemCache || new Map();
    if (this.itemCache.has(key)) return this.itemCache.get(key);
    const wanted = new Set(enabled);
    const mods = this.workshop().flatMap((w) => w.mods).filter((m) => wanted.has(m.id) && m.dir);
    const items = listItems(this.installDir, mods);
    this.itemCache.set(key, items);
    return items;
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
  async create({ name, memoryMb = 6144, copyFrom = null, collectionId = null, settings = null, preset = null, options = null }) {
    if (copyFrom && !this.localConfigs().some((c) => c.name === copyFrom)) throw new Error('That Zomboid server config was not found');
    // What Zomboid needs to start: a name, a player limit and (for a new world) a map.
    if (!String(name || '').trim()) throw new Error('Give the server a name');
    if (settings && settings.MaxPlayers !== undefined && !(Number(settings.MaxPlayers) >= 1 && Number(settings.MaxPlayers) <= 100)) throw new Error('Max players must be between 1 and 100');
    if (!copyFrom && settings && typeof settings.Map === 'string' && !settings.Map.trim()) throw new Error('Choose a map');
    const id = await this.m.createConfig(name, memoryMb, { type: 'zomboid', copyFrom });
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
      setupOptions: { copyFrom, collectionId, settings, preset, options },
    });

    return this.beginSetup(id, { copyFrom, collectionId, settings, preset, options });
  }

  /** Continue an interrupted first-time setup without creating another server. */
  async retrySetup(id) {
    const config = this.m.readConfig(id);
    if (config.game !== 'zomboid') throw new Error('This is not a Project Zomboid server');
    if (config.installed) return this.m.describe(id);
    if (this.m.installing.has(id)) throw new Error('Project Zomboid setup is already running');
    const options = config.setupOptions || {};
    return this.beginSetup(id, {
      copyFrom: options.copyFrom ?? (config.source && config.source.copyFrom) ?? null,
      collectionId: options.collectionId || null,
      settings: options.settings || null,
      preset: options.preset || null,
      options: options.options || null,
    });
  }

  beginSetup(id, { copyFrom = null, collectionId = null, settings = null, preset = null, options = null } = {}) {
    this.m.installing.add(id);
    this.m.emit('status', id, 'installing');
    const lines = this.m.installLogs.get(id) || [];
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
      const hasGeneratedSettings = fs.existsSync(this.iniFile(id)) && fs.existsSync(this.sandboxFile(id));
      if (!copyFrom && !hasGeneratedSettings) await this.prepareFreshWorld(id, { log, progress });
      const config = this.m.readConfig(id);
      const ini = this.ini(id);
      const listOn = this.m.appSettings ? this.m.appSettings().defaultWhitelist : false;
      this.writeIni(id, {
        PublicName: ini.PublicName && copyFrom ? ini.PublicName : config.name,
        Public: ini.Public || 'false',
        Open: copyFrom && ini.Open ? ini.Open : String(!listOn),
      });
      if (settings) this.saveSettings(id, settings);
      if (preset && !copyFrom) {
        const chosen = this.presets().find((p) => p.id === preset);
        if (chosen) {
          sandbox.writeSandbox(this.sandboxFile(id), chosen.values);
          log(`Applied the "${chosen.name}" world preset.`);
        }
      }
      if (options) {
        // Server settings go to the .ini; anything else (like loot respawn) is a world rule.
        const iniPatch = serverOptions.cleanServerOptions(this.iniFile(id), options);
        this.writeIni(id, iniPatch);
        const rules = Object.fromEntries(Object.entries(options).filter(([k]) => !(k in iniPatch)));
        if (Object.keys(rules).length && fs.existsSync(this.sandboxFile(id))) sandbox.writeSandbox(this.sandboxFile(id), rules);
      }
      if (collectionId) await this.applyCollection(id, collectionId, { log, progress });
      await this.m.updateConfig(id, {
        installed: true,
        installError: null,
        packName: copyFrom ? `Copy of ${copyFrom}` : collectionId ? 'Workshop collection' : 'Project Zomboid',
        worldSetupPending: !copyFrom,
        setupOptions: null,
      });
      log(copyFrom ? 'Install complete. Press Start.' : 'Install complete. Choose your world rules in Settings, then press Start.');
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

  /**
   * A fresh server has no settings files yet; the game writes them (with every
   * option and its description) the first time it starts. Start it once, stop
   * it, and remove the world it made, so the host's choices apply to the real
   * first world.
   */
  async prepareFreshWorld(id, { log = () => {}, progress = () => {} } = {}) {
    const config = this.m.readConfig(id);
    log('Creating the world settings files (the server starts once in the background)...');
    const proc = new ZomboidProcess({
      installDir: this.installDir,
      cacheDir: this.cacheDir(id),
      serverName: config.serverName,
      memoryMb: Math.min(config.memoryMb, 4096),
      adminPassword: config.adminPassword,
    });
    proc.on('progress', (state) => progress('Preparing world settings', state.percent, 100));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('The server took too long on its first run'));
      }, 10 * 60 * 1000);
      proc.on('status', (status) => {
        if (status === 'running') proc.stop();
      });
      proc.on('exit', () => {
        clearTimeout(timer);
        if (fs.existsSync(path.join(this.cacheDir(id), 'Server', `${config.serverName}_SandboxVars.lua`))) resolve();
        else reject(new Error(proc.failure ? proc.failure.summary : 'The server did not create its settings files'));
      });
      proc.start();
    });
    // Throw away the throwaway world; keep the settings and the admin account.
    await fsp.rm(path.join(this.cacheDir(id), 'Saves', 'Multiplayer', config.serverName), { recursive: true, force: true });
    await fsp.rm(path.join(this.cacheDir(id), 'Saves', 'Multiplayer', `${config.serverName}_player`), { recursive: true, force: true });
    log('World settings ready.');
  }

  sandboxFile(id) {
    const config = this.m.readConfig(id);
    return path.join(this.cacheDir(id), 'Server', `${config.serverName}_SandboxVars.lua`);
  }

  /** The game's world presets with their names: [{ id, name, description, values }]. */
  presets() {
    const media = path.join(this.installDir, 'media');
    let ui = {};
    try {
      ui = JSON.parse(fs.readFileSync(path.join(media, 'lua', 'shared', 'Translate', 'EN', 'UI.json'), 'utf8').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      // names fall back to file names
    }
    const order = ['Apocalypse', 'Survivor', 'Builder', 'Outbreak', 'Rising', 'Extinction', 'SixMonthsLater'];
    return sandbox.readPresets(path.join(media, 'lua', 'shared', 'Sandbox'))
      .map((p) => ({ ...p, name: ui[`UI_NewGame_${p.id}`] || p.id.replace(/([a-z])([A-Z])/g, '$1 $2'), description: ui[`UI_NewGame_${p.id}_desc`] || '' }))
      .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  }

  /** Apply a preset to an existing server's world rules. */
  async applyPreset(id, presetId) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before changing world rules');
    const chosen = this.presets().find((p) => p.id === presetId);
    if (!chosen) throw new Error('Unknown preset');
    sandbox.writeSandbox(this.sandboxFile(id), chosen.values);
    return this.sandbox(id);
  }

  /** World rule options added by the server's turned-on mods. */
  modSandbox(id) {
    const wanted = new Set(zcfg.splitList(zcfg.readIni(this.iniFile(id)).Mods));
    return modSandboxFields(this.workshop().flatMap((w) => w.mods).filter((m) => wanted.has(m.id) && m.dir));
  }

  /** World rules for the editor: { fields, common }. Mod options carry their own names and choices. */
  sandbox(id) {
    const fields = sandbox.readSandbox(this.sandboxFile(id));
    if (!fields) return { fields: [], common: [], missing: true };
    const byPath = new Map(fields.map((f) => [f.path, f]));
    for (const mf of this.modSandbox(id)) {
      const have = byPath.get(mf.path);
      if (have) Object.assign(have, { ...mf, value: have.value, type: mf.type === 'choice' && have.type === 'number' ? 'choice' : have.type === 'number' && mf.type === 'number' ? 'number' : mf.type });
      else fields.push({ ...mf, fresh: true });
    }
    return { fields, common: sandbox.COMMON.filter((p) => byPath.has(p)) };
  }

  async saveSandbox(id, values) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before changing world rules');
    sandbox.writeSandbox(this.sandboxFile(id), values || {}, this.modSandbox(id));
    await this.m.updateConfig(id, { worldSetupPending: false });
    return this.sandbox(id);
  }

  /** Every server option from the .ini, with the game's descriptions: { fields }. */
  serverOptions(id) {
    const fields = serverOptions.readServerOptions(this.iniFile(id));
    return fields ? { fields } : { fields: [], missing: true };
  }

  async saveServerOptions(id, values) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before changing server options');
    this.writeIni(id, serverOptions.cleanServerOptions(this.iniFile(id), values));
    return this.serverOptions(id);
  }

  // ---------- Workshop collections ----------

  listCollections() {
    return workshop.listCollections();
  }

  async previewCollection(link) {
    const id = workshop.parseCollectionLink(link);
    const items = await workshop.collectionItems(id);
    const details = await workshop.itemDetails([id]);
    return { id, title: (details.get(id) || {}).title || `Collection ${id}`, items: items.length };
  }

  /**
   * Turn on every mod in a collection: download items this PC does not have
   * (anonymously), read their mod IDs, and add them to Mods= and WorkshopItems=.
   */
  async applyCollection(id, collectionLink, { log = () => {}, progress = () => {} } = {}) {
    const collectionId = workshop.parseCollectionLink(collectionLink);
    log('Reading the Workshop collection...');
    const items = await workshop.collectionItems(collectionId);
    const have = new Set(this.workshop().map((w) => w.workshopId));
    const missing = items.filter((w) => !have.has(w));
    if (missing.length) {
      const steamcmd = await ensureSteamCmd(this.steamcmdDir, log);
      log(`Downloading ${missing.length} Workshop item(s) to read their mod IDs...`);
      await workshop.downloadItems(steamcmd, missing, { log, onProgress: (done, total) => progress('Workshop mods', done, total) });
    }
    const byItem = new Map(this.workshop().map((w) => [w.workshopId, w]));
    const iniFile = this.iniFile(id);
    const ini = zcfg.readIni(iniFile);
    const mods = zcfg.splitList(ini.Mods);
    const ids = zcfg.splitList(ini.WorkshopItems);
    let added = 0;
    const unreadable = [];
    for (const itemId of items) {
      const item = byItem.get(itemId);
      if (!ids.includes(itemId)) ids.push(itemId);
      if (!item) {
        unreadable.push(itemId);
        continue;
      }
      // Items with several mods inside often hold optional variants; turn on the first (main) one.
      const main = item.mods[0];
      if (main && !mods.includes(main.id)) {
        mods.push(main.id);
        added++;
      }
    }
    zcfg.writeIni(iniFile, { Mods: zcfg.joinList(mods), WorkshopItems: zcfg.joinList(ids) });
    // Put requirements in front of the mods that need them.
    for (const m of [...mods]) zmods.setModEnabled(iniFile, m, true, this.workshop());
    log(`Turned on ${added} mod(s) from the collection.${unreadable.length ? ` ${unreadable.length} item(s) could not be read; they are still downloaded by the server.` : ''}`);
    return { items: items.length, added, unreadable: unreadable.length };
  }

  async installCollection(id, collectionLink) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before adding mods');
    const log = (text) => this.m.emit('console', id, { text, stream: 'system' });
    const result = await this.applyCollection(id, collectionLink, { log, progress: (label, done, total) => this.m.emit('install', id, { progress: { label, done, total } }) });
    this.m.emit('mods', id);
    return result;
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

  /**
   * Take Workshop items out of the server's lists: from WorkshopItems, and their
   * mods from Mods. Returns the mod IDs removed.
   */
  dropWorkshopItems(id, itemIds) {
    const drop = new Set(itemIds.map(String));
    if (!drop.size) return [];
    const ini = zcfg.readIni(this.iniFile(id));
    const modsOf = new Set(this.workshop().filter((w) => drop.has(w.workshopId)).flatMap((w) => w.mods.map((m) => m.id)));
    const mods = zcfg.splitList(ini.Mods);
    zcfg.writeIni(this.iniFile(id), {
      WorkshopItems: zcfg.joinList(zcfg.splitList(ini.WorkshopItems).filter((w) => !drop.has(w))),
      Mods: zcfg.joinList(mods.filter((m) => !modsOf.has(m))),
    });
    this.itemCache = null;
    return mods.filter((m) => modsOf.has(m));
  }

  /** Before a start: Workshop items Steam no longer has would stop the server, so leave them out. */
  async removeMissingWorkshopItems(id, log) {
    const ids = zcfg.splitList(zcfg.readIni(this.iniFile(id)).WorkshopItems);
    if (!ids.length) return;
    let found;
    try {
      found = await workshop.itemDetails(ids);
    } catch {
      return; // Steam's web API is unreachable; let the server try on its own
    }
    if (!found.size) return; // nothing came back at all: do not trust it
    const missing = ids.filter((w) => !found.has(w));
    if (!missing.length) return;
    const mods = this.dropWorkshopItems(id, missing);
    log(`Left out ${missing.length} Workshop item(s) that are no longer on Steam (${missing.join(', ')})${mods.length ? `, with their mods: ${mods.join(', ')}` : ''}. They would stop the server from starting.`);
    this.m.emit('mods', id);
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
    await this.removeMissingWorkshopItems(id, log);
    if (config.worldSetupPending) await this.m.updateConfig(id, { worldSetupPending: false });
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
      case 'xp': {
        if (!PERKS.includes(args.perk)) throw new Error('Choose a skill');
        const amount = Math.max(1, Math.min(100000, Math.floor(Number(args.amount) || 0)));
        return [`addxp ${n} ${args.perk}=${amount}`];
      }
      case 'vehicle': {
        const vehicle = String(args.vehicle || '').trim();
        if (!ID_RE.test(vehicle)) throw new Error('Choose a vehicle');
        return [`addvehicle ${quote(vehicle)} ${n}`];
      }
      case 'noclip': return [`noclip ${n} -${args.on === false ? 'false' : 'true'}`];
      case 'horde': {
        const count = Math.max(1, Math.min(200, Math.floor(Number(args.count) || 10)));
        return [`createhorde ${count} ${n}`];
      }
      case 'lightning': return [`lightning ${n}`];
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
    return { game: 'zomboid', running, ...zmods.overview(this.iniFile(id), this.workshop()) };
  }

  setModEnabled(id, modId, enabled) {
    const running = Boolean(this.m.processes.get(id) && this.m.processes.get(id).child);
    if (running) throw new Error('Stop the server before changing mods');
    return zmods.setModEnabled(this.iniFile(id), modId, enabled, this.workshop());
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
      Open: ini.Open || 'true',
      modCount: zcfg.splitList(ini.Mods).length,
    };
  }

  saveSettings(id, values) {
    const patch = {};
    if (typeof values.PublicName === 'string') patch.PublicName = values.PublicName.replace(/[\r\n]/g, ' ').slice(0, 64);
    if (typeof values.PublicDescription === 'string') patch.PublicDescription = values.PublicDescription.replace(/\r?\n/g, '\\n').slice(0, 1000);
    if (values.MaxPlayers !== undefined) patch.MaxPlayers = String(Math.max(1, Math.min(100, Math.floor(Number(values.MaxPlayers) || 32))));
    if (typeof values.Password === 'string') patch.Password = values.Password.replace(/[\r\n]/g, '').slice(0, 64);
    for (const key of ['PVP', 'Public', 'PauseEmpty', 'Open']) if (typeof values[key] === 'boolean') patch[key] = String(values[key]);
    if (typeof values.Map === 'string' && values.Map.trim()) patch.Map = values.Map.replace(/[\r\n]/g, '').slice(0, 300);
    this.writeIni(id, patch);
    return this.settings(id);
  }

  joinInfo(id) {
    const config = this.m.readConfig(id);
    return { port: config.port, udpPort: config.udpPort };
  }
}

module.exports = { ZomboidGame, APP_ID, PERKS };
