// ServerManager ties the engine together: it creates servers from modpacks,
// installs Java and the loader, and starts/stops server processes.
// It does not depend on Electron, so scripts and tests can drive it directly.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { dataPaths } = require('./paths');
const { download, getJson } = require('./http');
const modrinth = require('./modrinth');
const { installMrpack } = require('./mrpack');
const { requiredJavaVersion, listReleases } = require('./minecraft');
const { ensureJava } = require('./java');
const { installLoader } = require('./loaders');
const { ServerProcess } = require('./server-process');
const launchers = require('./launchers');
const clientPack = require('./client-pack');
const { pruneClientOnlyMods } = require('./mod-metadata');
const { Playit } = require('./playit');
const { Rcon } = require('./rcon');
const playersLib = require('./players');
const { parseSnbt, plain: plainNbt } = require('./nbt');
const worldMap = require('./world-map');

const CONFIG_FILE = 'selfhost.json';

/**
 * Events:
 *   'console'  (serverId, { text, stream })
 *   'status'   (serverId, status)
 *   'install'  (serverId, { message?, progress?: { label, done, total } })
 *   'changed'  ()  the server list or a server's config changed
 */
class ServerManager extends EventEmitter {
  constructor(dataRoot) {
    super();
    this.paths = dataPaths(dataRoot);
    this.processes = new Map();
    this.installing = new Set();
    this.installLogs = new Map();
    this.tunnels = new Map();
    this.rcons = new Map();
    this.pregen = new Map();
    this.nameCache = new Map();
    this.refused = new Map(); // server id -> names turned away by the whitelist this session
    this.mapRenderer = new worldMap.MapRenderer();
    this.playit = new Playit(dataRoot);
    this.playit.on('status', (state) => this.emit('playit', state));
    this.playit.on('log', (line) => this.emit('playit-log', line));
    fs.mkdirSync(this.paths.servers, { recursive: true });
  }

  serverDir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid server id');
    return path.join(this.paths.servers, id);
  }

  readConfig(id) {
    const file = path.join(this.serverDir(id), CONFIG_FILE);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  async writeConfig(config) {
    const file = path.join(this.serverDir(config.id), CONFIG_FILE);
    await fsp.writeFile(file, JSON.stringify(config, null, 2));
    this.emit('changed');
    return config;
  }

  async updateConfig(id, patch) {
    return this.writeConfig({ ...this.readConfig(id), ...patch });
  }

  list() {
    if (!fs.existsSync(this.paths.servers)) return [];
    return fs
      .readdirSync(this.paths.servers)
      .filter((id) => fs.existsSync(path.join(this.paths.servers, id, CONFIG_FILE)))
      .map((id) => this.describe(id))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  describe(id) {
    const config = this.readConfig(id);
    const proc = this.processes.get(id);
    let status = proc ? proc.status : 'stopped';
    if (this.installing.has(id)) status = 'installing';
    const crashed = Boolean(proc && proc.crashed && status === 'stopped');
    return { ...config, status, crashed, dir: this.serverDir(id) };
  }

  /** Install messages followed by the running server's console lines. */
  consoleHistory(id) {
    const proc = this.processes.get(id);
    return [...(this.installLogs.get(id) || []), ...(proc ? proc.history : [])];
  }

  newId(name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'server';
    return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  }

  /** Create a server from a Modrinth modpack version and install it. */
  async createFromModrinth({ name, projectId, versionId, memoryMb = 4096 }) {
    const [project, versions] = await Promise.all([
      modrinth.getProject(projectId),
      modrinth.getModpackVersions(projectId),
    ]);
    const version = versions.find((v) => v.id === versionId);
    if (!version) throw new Error('That modpack version has no server-installable .mrpack file');

    const id = await this.createConfig(name || project.title, memoryMb, {
      type: 'modrinth',
      projectId: project.id,
      slug: project.slug,
      title: project.title,
      iconUrl: project.iconUrl,
      versionId: version.id,
      versionNumber: version.versionNumber,
    });
    this.runInstall(id, async (log, progress) => {
      const mrpack = await this.downloadModrinthPack(version, progress, log);
      return this.installPackFile(id, mrpack, log, progress);
    });
    return this.describe(id);
  }

  /** Create a server from a .mrpack file on disk and install it. */
  async createFromFile({ name, filePath, memoryMb = 4096 }) {
    const base = path.basename(filePath, '.mrpack');
    const id = await this.createConfig(name || base, memoryMb, { type: 'file', fileName: path.basename(filePath) });
    this.runInstall(id, async (log, progress) => {
      // Keep a copy so the client pack can be exported later.
      const copy = path.join(this.paths.cache, 'packs', `${id}.mrpack`);
      await fsp.mkdir(path.dirname(copy), { recursive: true });
      await fsp.copyFile(filePath, copy);
      return this.installPackFile(id, copy, log, progress);
    });
    return this.describe(id);
  }

  /**
   * Create a server from a game profile on this PC (CurseForge, Prism), so the
   * server runs exactly the mods that profile plays with.
   */
  async createFromProfile({ name, profileId, memoryMb = 4096 }) {
    const profile = launchers.findProfile(profileId);
    if (!profile.minecraft) throw new Error('Could not tell which Minecraft version that profile uses');
    const id = await this.createConfig(name || profile.name, memoryMb, {
      type: 'profile',
      launcher: profile.launcher,
      launcherName: profile.launcherName,
      profileName: profile.name,
      profileId: profile.id,
      gameDir: profile.gameDir,
      modpack: profile.modpack,
    });
    this.runInstall(id, async (log, progress) => {
      const serverDir = this.serverDir(id);
      log(`Copying mods and configs from ${profile.launcherName} profile "${profile.name}"...`);
      const jars = await launchers.hashModJars(profile.gameDir);

      let clientOnly = new Set();
      try {
        clientOnly = await modrinth.findClientOnlyFiles(jars.map((j) => j.sha1));
      } catch (err) {
        log(`Could not check mods against Modrinth (${err.message}); copying all of them`);
      }
      const modsDir = path.join(serverDir, 'mods');
      await fsp.mkdir(modsDir, { recursive: true });
      let done = 0;
      for (const jar of jars) {
        await fsp.copyFile(jar.path, path.join(modsDir, jar.fileName));
        progress('Mods', ++done, jars.length);
      }
      const flagged = new Set(jars.filter((j) => clientOnly.has(j.sha1)).map((j) => j.fileName));
      const pruned = pruneClientOnlyMods(modsDir, (fileName) => flagged.has(fileName));
      if (pruned.removed.length) log(`Left out ${pruned.removed.length} client-only mod(s) the server does not need`);
      if (pruned.kept.length) log(`Kept ${pruned.kept.length} client-only mod(s) that other mods require`);
      log(`Copied ${jars.length - pruned.removed.length} mod(s) to the server`);

      for (const folder of ['config', 'defaultconfigs', 'kubejs', 'scripts', 'global_packs']) {
        const src = path.join(profile.gameDir, folder);
        if (fs.existsSync(src)) await fsp.cp(src, path.join(serverDir, folder), { recursive: true });
      }
      return {
        name: profile.modpack ? profile.modpack.name : profile.name,
        versionId: profile.modpack ? profile.modpack.version : null,
        minecraft: profile.minecraft,
        loader: profile.loader,
        loaderVersion: profile.loaderVersion,
        javaMin: pruned.javaMin,
        clientMods: jars.map((j) => ({ fileName: j.fileName, sha1: j.sha1 })),
      };
    });
    return this.describe(id);
  }

  /** Create a plain Minecraft server with no mods. */
  async createVanilla({ name, minecraft, memoryMb = 2048 }) {
    const releases = await listReleases();
    if (!releases.some((r) => r.id === minecraft)) throw new Error(`Unknown Minecraft version ${minecraft}`);
    const id = await this.createConfig(name || `Minecraft ${minecraft}`, memoryMb, { type: 'vanilla' });
    this.runInstall(id, async () => ({ name: 'Minecraft', versionId: minecraft, minecraft, loader: 'vanilla', loaderVersion: null }));
    return this.describe(id);
  }

  listMinecraftVersions() {
    return listReleases();
  }

  async createConfig(name, memoryMb, source) {
    const id = this.newId(name);
    const port = this.freePort(id);
    await fsp.mkdir(this.serverDir(id), { recursive: true });
    await this.writeConfig({
      id,
      name,
      source,
      port,
      memoryMb,
      eulaAccepted: false,
      installed: false,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async downloadModrinthPack(version, progress = () => {}, log = () => {}) {
    const mrpack = path.join(this.paths.cache, 'packs', version.file.filename);
    if (fs.existsSync(mrpack)) return mrpack;
    log(`Downloading ${version.file.filename}...`);
    await download(version.file.url, mrpack, {
      hashes: { sha512: version.file.hashes.sha512 },
      onProgress: (d, t) => progress('Modpack', d, t),
    });
    return mrpack;
  }

  async installPackFile(id, mrpack, log, progress) {
    const pack = await installMrpack(mrpack, this.serverDir(id), {
      log,
      onProgress: (d, t) => progress('Mods', d, t),
    });
    return { ...pack, packFile: mrpack };
  }

  /** The .mrpack a server was built from, downloading it again if needed. */
  async ensurePackFile(id) {
    const config = this.readConfig(id);
    if (config.packFile && fs.existsSync(config.packFile)) return config.packFile;
    if (config.source.type !== 'modrinth') throw new Error('The modpack file for this server is missing');
    const versions = await modrinth.getModpackVersions(config.source.projectId);
    const version = versions.find((v) => v.id === config.source.versionId);
    if (!version) throw new Error('That modpack version is no longer on Modrinth');
    const packFile = await this.downloadModrinthPack(version);
    await this.updateConfig(id, { packFile });
    return packFile;
  }

  /**
   * Run the shared install pipeline in the background. `prepare` puts the
   * mods in place and returns { name, versionId, minecraft, loader, loaderVersion, ... };
   * this then installs Java and the loader. Progress and errors arrive as 'install' events.
   */
  runInstall(id, prepare) {
    this.installing.add(id);
    this.emit('status', id, 'installing');
    const lines = [];
    this.installLogs.set(id, lines);
    const log = (message) => {
      lines.push({ text: message, stream: 'system', time: Date.now() });
      this.emit('install', id, { message });
    };
    const progress = (label, done, total) => this.emit('install', id, { progress: { label, done, total } });

    const work = (async () => {
      const serverDir = this.serverDir(id);
      const { name, versionId, minecraft, loader, loaderVersion, javaMin = 0, ...extra } = await prepare(log, progress);

      // Some mods need a newer Java than Minecraft itself does.
      const required = Math.max(await requiredJavaVersion(minecraft), javaMin);
      const { javaPath, major } = await ensureJava(required, this.paths.java, {
        log,
        onProgress: (d, t) => progress(`Java`, d, t),
      });

      const launch = await installLoader({ serverDir, minecraft, loader, loaderVersion, javaPath, log });

      await this.updateConfig(id, {
        ...extra,
        packName: name,
        packVersion: versionId,
        minecraft,
        loader,
        loaderVersion,
        javaMajor: major,
        launch,
        installed: true,
        installError: null,
      });
      log('Install complete. Accept the Minecraft EULA, then press Start.');
    })();

    work
      .catch(async (err) => {
        log(`Install failed: ${err.message}`);
        try {
          await this.updateConfig(id, { installError: err.message });
        } catch {
          // Config may be gone if the server was deleted mid-install.
        }
      })
      .finally(() => {
        this.installing.delete(id);
        this.emit('status', id, 'stopped');
        this.emit('changed');
      });
    return work;
  }

  // ---------- playing with friends ----------

  /** What a player's game needs to join: { minecraft, loader, loaderVersion, mods }. */
  async clientNeeds(id) {
    const config = this.readConfig(id);
    if (!config.installed) throw new Error('Server is not installed yet');
    if (config.source.type === 'vanilla') {
      return { minecraft: config.minecraft, loader: 'vanilla', loaderVersion: null, mods: [] };
    }
    if (config.source.type === 'profile') {
      return {
        minecraft: config.minecraft,
        loader: config.loader,
        loaderVersion: config.loaderVersion,
        mods: config.clientMods || [],
      };
    }
    const fromPack = clientPack.clientModsFromMrpack(await this.ensurePackFile(id));
    return { ...fromPack, minecraft: config.minecraft, loader: config.loader, loaderVersion: config.loaderVersion };
  }

  listProfiles() {
    return launchers.listProfiles();
  }

  /** Check a game profile on this PC against the server. */
  async checkProfile(id, profileId) {
    return clientPack.compareProfile(await this.clientNeeds(id), launchers.findProfile(profileId));
  }

  /**
   * Write a CurseForge-importable zip with everything a player's game needs
   * for this server. `onProgress(done, total)` reports files copied.
   */
  async exportClientPack(id, outFile, { onProgress } = {}) {
    const config = this.readConfig(id);
    const staging = path.join(this.paths.cache, 'export', id);
    const common = {
      name: config.name,
      version: config.packVersion,
      minecraft: config.minecraft,
      loader: config.loader,
      loaderVersion: config.loaderVersion,
      outFile,
      staging,
    };
    if (config.source.type === 'profile') {
      if (!fs.existsSync(config.source.gameDir)) {
        throw new Error(`The ${config.source.launcherName} profile "${config.source.profileName}" is no longer on this PC`);
      }
      return clientPack.buildCurseForgeZip({
        ...common,
        addFiles: (overrides) => clientPack.addProfileFiles(config.source.gameDir, overrides),
      });
    }
    const packFile = await this.ensurePackFile(id);
    return clientPack.buildCurseForgeZip({
      ...common,
      addFiles: (overrides) =>
        clientPack.addMrpackClientFiles(packFile, overrides, path.join(this.paths.cache, 'files'), onProgress),
    });
  }

  /** Copy the original .mrpack, for Modrinth App or Prism players. */
  async exportMrpack(id, outFile) {
    await fsp.copyFile(await this.ensurePackFile(id), outFile);
    return outFile;
  }

  /** Addresses players can use to join. */
  joinInfo(id) {
    const props = this.readProperties(id);
    const port = Number(props['server-port']) || 25565;
    const lan = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        // Skip virtual adapters (WSL, Hyper-V, VirtualBox, VPNs) that friends cannot reach.
        if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i.test(name)) continue;
        lan.push({ adapter: name, address: `${a.address}:${port}` });
      }
    }
    return { port, local: `localhost:${port}`, lan };
  }

  /** The user agreed to https://aka.ms/MinecraftEULA in the app. */
  async acceptEula(id) {
    await fsp.writeFile(
      path.join(this.serverDir(id), 'eula.txt'),
      `# Accepted in Self-Host MC on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`
    );
    return this.updateConfig(id, { eulaAccepted: true });
  }

  async start(id) {
    const config = this.readConfig(id);
    if (this.installing.has(id)) throw new Error('Server is still installing');
    if (!config.installed) throw new Error('Server is not installed');
    if (!config.eulaAccepted) throw new Error('Accept the Minecraft EULA before starting the server');
    const existing = this.processes.get(id);
    if (existing && existing.child) throw new Error('Server is already running');

    await this.prepareNetwork(id);
    await this.setupWhitelist(id);
    const { javaPath } = await ensureJava(config.javaMajor, this.paths.java, {
      log: (message) => this.emit('console', id, { text: message, stream: 'system' }),
    });
    const proc = new ServerProcess({
      javaPath,
      serverDir: this.serverDir(id),
      launch: config.launch,
      memoryMb: config.memoryMb,
    });
    proc.on('line', (text, stream) => {
      this.emit('console', id, { text, stream });
      this.trackPregen(id, text);
      const refused = text.match(/Disconnecting (\w{3,16}) .*not white-listed/);
      if (refused) {
        this.refusedNames(id).add(refused[1]);
        // A new attempt brings back someone who was dismissed earlier.
        const config = this.readConfig(id);
        if ((config.dismissedJoiners || []).includes(refused[1])) {
          this.updateConfig(id, { dismissedJoiners: config.dismissedJoiners.filter((n) => n !== refused[1]) }).catch(() => {});
        }
        this.emit('whitelist', id, { ...this.whitelistStatus(id), justRefused: refused[1] });
      }
    });
    proc.on('status', (status) => this.emit('status', id, status));
    proc.on('players', (players) => this.emit('players', id, players));
    proc.on('exit', () => {
      this.closeRcon(id);
      const pregen = this.pregen.get(id);
      if (pregen && pregen.state === 'running') this.setPregen(id, { state: 'paused' });
      const tunnel = this.tunnels.get(id);
      if (tunnel) this.setTunnel(id, { ...tunnel, state: 'stopped', message: '' });
      // Stop the playit agent once no server is left running.
      const anyRunning = [...this.processes.values()].some((p) => p.child);
      if (!anyRunning) this.playit.stop().catch(() => {});
    });
    this.processes.set(id, proc);
    proc.start();
    if (this.playit.isLinked()) this.startTunnel(id).catch(() => {});
    return this.describe(id);
  }

  // ---------- ports and online addresses ----------

  serverPort(id) {
    const config = this.readConfig(id);
    return Number(this.readProperties(id)['server-port']) || config.port || 25565;
  }

  /** A game port no other server uses, starting at Minecraft's default. */
  freePort(exceptId) {
    const used = new Set();
    for (const s of this.list()) {
      if (s.id === exceptId) continue;
      try {
        used.add(this.serverPort(s.id));
      } catch {
        // ignore broken configs
      }
    }
    let port = 25565;
    while (used.has(port) || used.has(port + 10000)) port++;
    return port;
  }

  /**
   * Before each start: give the server a port no other server uses, so each
   * one can run at the same time with its own address, and turn on RCON
   * (local remote control) so the app can read player data and run commands.
   */
  async prepareNetwork(id) {
    const config = this.readConfig(id);
    let port = this.serverPort(id);
    const others = this.list().filter((s) => s.id !== id).map((s) => this.serverPort(s.id));
    if (others.includes(port)) {
      port = this.freePort(id);
      this.emit('console', id, { text: `Port ${this.serverPort(id)} is used by another server; this one now uses ${port}.`, stream: 'system' });
    }
    const rconPassword = config.rconPassword || crypto.randomBytes(16).toString('hex');
    await this.writeProperties(id, {
      'server-port': port,
      'enable-rcon': 'true',
      'rcon.port': port + 10000,
      'rcon.password': rconPassword,
      'broadcast-rcon-to-ops': 'false',
    });
    if (config.port !== port || config.rconPassword !== rconPassword) await this.updateConfig(id, { port, rconPassword });
  }

  setTunnel(id, state) {
    this.tunnels.set(id, state);
    this.emit('tunnel', id, state);
  }

  tunnelStatus(id) {
    const config = this.readConfig(id);
    return this.tunnels.get(id) || { state: 'stopped', address: config.address || null };
  }

  /** Open (or re-point) the playit.gg tunnel for one server. Progress arrives as 'tunnel' events. */
  async startTunnel(id) {
    const config = this.readConfig(id);
    const log = (line) => this.emit('console', id, { text: line, stream: 'system' });
    this.setTunnel(id, { state: 'starting', address: config.address || null, message: 'Getting your online address…' });
    try {
      await this.playit.startAgent(log);
      const claimed = this.list()
        .filter((s) => s.id !== id && s.tunnelId)
        .map((s) => s.tunnelId);
      const { tunnelId, address, notices } = await this.playit.ensureTunnel({
        tunnelId: config.tunnelId,
        port: this.serverPort(id),
        name: config.name,
        claimed,
      });
      if (config.tunnelId !== tunnelId || config.address !== address) await this.updateConfig(id, { tunnelId, address });
      const warning = notices.find((n) => n.priority === 'Critical' || n.priority === 'High');
      const proc = this.processes.get(id);
      this.setTunnel(id, {
        state: proc && proc.child ? 'online' : 'stopped',
        address,
        message: warning ? warning.message : '',
        resolveLink: warning ? warning.resolve_link : null,
      });
      log(`Online address for friends: ${address}`);
      return address;
    } catch (err) {
      this.setTunnel(id, { state: 'error', address: config.address || null, message: err.message });
      throw err;
    }
  }

  /** Throw away this server's playit address and get a new random one. */
  async newAddress(id) {
    const config = this.readConfig(id);
    if (config.tunnelId) await this.playit.deleteTunnel(config.tunnelId);
    await this.updateConfig(id, { tunnelId: null, address: null });
    this.setTunnel(id, { state: 'stopped', address: null });
    const proc = this.processes.get(id);
    if (proc && proc.child) return this.startTunnel(id);
    return null;
  }

  /** Link playit.gg; `openUrl` opens the approval page in the user's browser. */
  async linkPlayit(openUrl) {
    await this.playit.link(openUrl);
    // Servers that are already running get their online address right away.
    for (const [id, p] of this.processes) if (p.child) this.startTunnel(id).catch(() => {});
  }

  async unlinkPlayit() {
    await this.playit.unlink();
    for (const id of this.tunnels.keys()) this.setTunnel(id, { state: 'stopped', address: null });
  }

  playitStatus() {
    return { ...this.playit.state, linked: this.playit.isLinked() };
  }

  players(id) {
    const proc = this.processes.get(id);
    return proc ? [...proc.players] : [];
  }

  // ---------- remote control (RCON) ----------

  /** Run a command on a running server and return its output. */
  async rcon(id, command, retried = false) {
    const proc = this.processes.get(id);
    if (!proc || !proc.child) throw new Error('Start the server first');
    if (proc.status !== 'running') throw new Error('Wait until the server has finished starting');
    let client = this.rcons.get(id);
    if (!client) {
      const props = this.readProperties(id);
      if (props['enable-rcon'] !== 'true') throw new Error('Restart the server once so the app can control it');
      client = new Rcon({ port: Number(props['rcon.port']), password: props['rcon.password'] });
      this.rcons.set(id, client);
    }
    try {
      return await client.command(command);
    } catch (err) {
      client.close();
      this.rcons.delete(id);
      // Minecraft 26.3 drops RCON connections that sit idle for a couple of
      // seconds; reconnect once and try again.
      if (!retried && /closed|not connected|ECONNRESET|EPIPE/i.test(err.message)) return this.rcon(id, command, true);
      throw err;
    }
  }

  /** Ask the server who is online (/list) and update the app's list to match. */
  async syncOnlinePlayers(id) {
    if (!this.isRunning(id)) return this.players(id);
    const out = await this.rcon(id, 'list');
    const m = out.match(/online:\s*(.*)$/s);
    const names = m && m[1].trim() ? m[1].split(',').map((n) => n.trim()).filter((n) => /^\w{3,16}$/.test(n)) : [];
    const proc = this.processes.get(id);
    if (proc) proc.setPlayers(names);
    return names;
  }

  closeRcon(id) {
    const client = this.rcons.get(id);
    if (client) client.close();
    this.rcons.delete(id);
  }

  // ---------- app settings ----------

  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.paths.root, 'settings.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  async updateSettings(patch) {
    const next = { ...this.readSettings(), ...patch };
    await fsp.writeFile(path.join(this.paths.root, 'settings.json'), JSON.stringify(next, null, 2));
    return next;
  }

  /** The host's Minecraft name: saved in settings, or guessed from the official launcher. */
  hostName() {
    const saved = this.readSettings().hostName;
    if (saved) return { name: saved, saved: true };
    const dir = path.join(process.env.APPDATA || os.homedir(), '.minecraft');
    for (const f of ['launcher_accounts_microsoft_store.json', 'launcher_accounts.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const accounts = j.accounts || {};
        const active = accounts[j.activeAccountLocalId] || Object.values(accounts)[0];
        const name = active && active.minecraftProfile && active.minecraftProfile.name;
        if (name) return { name, saved: false };
      } catch {
        // launcher not installed or file unreadable
      }
    }
    return { name: null, saved: false };
  }

  async setHostName(name) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name || '')) throw new Error('That is not a valid Minecraft username');
    await this.updateSettings({ hostName: name });
  }

  // ---------- whitelist ----------

  whitelistFile(id) {
    return path.join(this.serverDir(id), 'whitelist.json');
  }

  readWhitelist(id) {
    try {
      return JSON.parse(fs.readFileSync(this.whitelistFile(id), 'utf8'));
    } catch {
      return [];
    }
  }

  whitelistStatus(id) {
    const props = this.readProperties(id);
    const listed = new Set(this.readWhitelist(id).map((p) => p.name.toLowerCase()));
    const dismissed = new Set((this.readConfig(id).dismissedJoiners || []).map((n) => n.toLowerCase()));
    return {
      enabled: props['white-list'] === 'true',
      players: this.readWhitelist(id),
      refused: [...this.refusedNames(id)].filter((n) => !listed.has(n.toLowerCase()) && !dismissed.has(n.toLowerCase())),
    };
  }

  /** Names turned away by the whitelist: this session, plus the server's latest log. */
  refusedNames(id) {
    if (!this.refused.has(id)) {
      const set = new Set();
      try {
        const log = fs.readFileSync(path.join(this.serverDir(id), 'logs', 'latest.log'), 'utf8');
        for (const m of log.matchAll(/Disconnecting (\w{3,16}) .*not white-listed/g)) set.add(m[1]);
      } catch {
        // no log yet
      }
      this.refused.set(id, set);
    }
    return this.refused.get(id);
  }

  /** Hide someone from "Trying to join" without adding them. */
  async denyJoiner(id, name) {
    const config = this.readConfig(id);
    const dismissed = new Set(config.dismissedJoiners || []);
    dismissed.add(name);
    await this.updateConfig(id, { dismissedJoiners: [...dismissed] });
    this.emit('whitelist', id, this.whitelistStatus(id));
  }

  /** Look a player up with Mojang, so they can be added while the server is stopped. */
  async lookupProfile(name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name || '')) throw new Error('That is not a valid Minecraft username');
    let profile;
    try {
      profile = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    } catch {
      throw new Error(`No Minecraft account is called "${name}"`);
    }
    const hex = profile.id;
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return { uuid, name: profile.name };
  }

  async whitelistAdd(id, name) {
    if (this.isRunning(id)) {
      const out = await this.rcon(id, `whitelist add ${name}`);
      if (/does not exist|Unknown/i.test(out)) throw new Error(`No Minecraft account is called "${name}"`);
    } else {
      const profile = await this.lookupProfile(name);
      const list = this.readWhitelist(id).filter((p) => p.uuid !== profile.uuid);
      list.push(profile);
      await fsp.writeFile(this.whitelistFile(id), JSON.stringify(list, null, 2));
    }
    const refused = this.refused.get(id);
    if (refused) refused.delete(name);
    this.emit('whitelist', id, this.whitelistStatus(id));
  }

  async whitelistRemove(id, name) {
    if (this.isRunning(id)) await this.rcon(id, `whitelist remove ${name}`);
    else {
      const list = this.readWhitelist(id).filter((p) => p.name.toLowerCase() !== String(name).toLowerCase());
      await fsp.writeFile(this.whitelistFile(id), JSON.stringify(list, null, 2));
    }
    this.emit('whitelist', id, this.whitelistStatus(id));
  }

  async setWhitelistEnabled(id, enabled) {
    // enforce-whitelist kicks anyone not on the list when it is turned on.
    await this.writeProperties(id, { 'white-list': String(enabled), 'enforce-whitelist': String(enabled) });
    // Sent through the console: on 26.3, 'whitelist on' over RCON drops the RCON connection.
    if (this.isRunning(id)) this.sendCommand(id, `whitelist ${enabled ? 'on' : 'off'}`);
    this.emit('whitelist', id, this.whitelistStatus(id));
  }

  /**
   * First start of a server: every server has a public address, so turn the
   * whitelist on and put the host on it. Runs once per server.
   */
  async setupWhitelist(id) {
    const config = this.readConfig(id);
    if (config.whitelistSetUp) return;
    const host = this.readSettings().hostName;
    const props = this.readProperties(id);
    // Servers that already have a server.properties keep the owner's choice,
    // except that the host is added if the list is on (Minecraft 26.3+ turns it on by default).
    // New servers start with the list off (Minecraft 26.3+ would turn it on);
    // the host is put on the list anyway, so turning it on later never locks them out.
    const isNew = !props['white-list'];
    if (isNew) await this.writeProperties(id, { 'white-list': 'false', 'enforce-whitelist': 'false' });
    if (host && !this.readWhitelist(id).some((p) => p.name.toLowerCase() === host.toLowerCase())) {
      try {
        const profile = await this.lookupProfile(host);
        await fsp.writeFile(this.whitelistFile(id), JSON.stringify([...this.readWhitelist(id), profile], null, 2));
        this.emit('console', id, { text: `Added ${profile.name} (you) to this server's whitelist.`, stream: 'system' });
      } catch (err) {
        this.emit('console', id, { text: `Could not add ${host} to the whitelist: ${err.message}`, stream: 'system' });
      }
    }
    await this.updateConfig(id, { whitelistSetUp: true });
  }

  // ---------- players ----------

  listPlayersOf(id) {
    const list = playersLib.listPlayers(this.serverDir(id), this.readProperties(id), this.players(id));
    for (const p of list) if (!p.name && this.nameCache.has(p.uuid)) p.name = this.nameCache.get(p.uuid);
    return list;
  }

  /** Fill in names missing from usercache.json using Mojang's public profile lookup. */
  async listPlayersWithNames(id) {
    await this.syncOnlinePlayers(id).catch(() => {});
    const list = this.listPlayersOf(id);
    await Promise.all(
      list
        .filter((p) => !p.name)
        .map(async (p) => {
          try {
            const profile = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${p.uuid.replace(/-/g, '')}`);
            if (profile && profile.name) {
              this.nameCache.set(p.uuid, profile.name);
              p.name = profile.name;
            }
          } catch {
            // offline-mode or unknown player: keep the id
          }
        })
    );
    return list;
  }

  findPlayer(id, uuid) {
    const player = this.listPlayersOf(id).find((p) => p.uuid === uuid);
    if (!player) throw new Error('Player not found');
    return player;
  }

  isRunning(id) {
    const proc = this.processes.get(id);
    return Boolean(proc && proc.child && proc.status === 'running');
  }

  /** Health, hunger, inventory and ender chest; live for online players, from the save file otherwise. */
  async playerDetails(id, uuid) {
    await this.syncOnlinePlayers(id).catch(() => {});
    const player = this.findPlayer(id, uuid);
    if (player.online && this.isRunning(id)) {
      const out = await this.rcon(id, `data get entity ${player.name}`);
      const start = out.indexOf('{');
      if (start < 0) throw new Error(out || 'Could not read player data');
      return { ...player, live: true, ...playersLib.playerView(parseSnbt(out.slice(start))) };
    }
    const data = plainNbt(playersLib.readDat(this.serverDir(id), this.readProperties(id), uuid));
    return { ...player, live: false, ...playersLib.playerView(data) };
  }

  /**
   * Change a player: heal, feed, give, remove, clear, gamemode, xp, op, deop, kick.
   * Online players get commands; offline players have their save file edited.
   */
  async playerAction(id, uuid, action, args = {}) {
    await this.syncOnlinePlayers(id).catch(() => {});
    const player = this.findPlayer(id, uuid);
    const running = this.isRunning(id);
    if (player.online && running) {
      const outputs = [];
      for (const cmd of playersLib.onlineCommands(player.name, action, args)) outputs.push(await this.rcon(id, cmd));
      return outputs.join('\n');
    }
    if (action === 'op' || action === 'deop') {
      if (running) return this.rcon(id, `${action} ${player.name}`);
      await playersLib.setOpOffline(this.serverDir(id), player, action === 'op');
      return '';
    }
    if (action === 'ban' || action === 'pardon') {
      if (running) return this.rcon(id, playersLib.onlineCommands(player.name, action, args)[0]);
      await playersLib.setBanOffline(this.serverDir(id), player, action === 'ban', args.reason);
      return '';
    }
    if (['tp-to', 'tp-from', 'kill'].includes(action)) throw new Error(`${player.name} needs to be online for that`);
    if (action === 'kick') throw new Error(`${player.name} is not online`);
    if (action === 'give') throw new Error(`${player.name} needs to be online to receive items`);
    const props = this.readProperties(id);
    const root = playersLib.readDat(this.serverDir(id), props, uuid);
    playersLib.editOffline(root, action, args);
    await playersLib.writeDat(this.serverDir(id), props, uuid, root);
    return '';
  }

  // ---------- world map ----------

  worldDir(id) {
    return path.join(this.serverDir(id), this.readProperties(id)['level-name'] || 'world');
  }

  mapDimensions(id) {
    return worldMap.listDimensions(this.worldDir(id));
  }

  checkDim(dim) {
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dim)) throw new Error('Unknown dimension');
    return dim;
  }

  /** Region coordinates that exist for a dimension. */
  mapRegions(id, dim) {
    const dir = worldMap.regionDir(this.worldDir(id), this.checkDim(dim));
    if (!dir) return [];
    return fs
      .readdirSync(dir)
      .map((f) => f.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/))
      .filter(Boolean)
      .map((m) => ({ rx: Number(m[1]), rz: Number(m[2]), mtime: fs.statSync(path.join(dir, m[0])).mtimeMs }));
  }

  async mapTile(id, dim, rx, rz, mode = 'terrain') {
    const dir = worldMap.regionDir(this.worldDir(id), this.checkDim(dim));
    if (!dir || !Number.isInteger(rx) || !Number.isInteger(rz)) throw new Error('No such region');
    const file = path.join(dir, `r.${rx}.${rz}.mca`);
    if (!fs.existsSync(file)) throw new Error('No such region');
    const cacheDir = path.join(this.serverDir(id), '.selfhost', 'map', dim.replace(/[:/]/g, '_'));
    return this.mapRenderer.tile(file, cacheDir, mode === 'biomes' ? 'biomes' : 'terrain');
  }

  /** Where online players are: [{ name, uuid, x, z, dim }]. */
  async playerPositions(id) {
    if (!this.isRunning(id)) return [];
    await this.syncOnlinePlayers(id).catch(() => {});
    const known = this.listPlayersOf(id);
    const out = [];
    for (const name of this.players(id)) {
      try {
        const posText = await this.rcon(id, `data get entity ${name} Pos`);
        const dimText = await this.rcon(id, `data get entity ${name} Dimension`);
        const pos = parseSnbt(posText.slice(posText.indexOf('[')));
        const dim = (dimText.match(/"([^"]+)"/) || [])[1] || 'minecraft:overworld';
        const player = known.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase());
        out.push({ name, uuid: player ? player.uuid : null, op: Boolean(player && player.op), x: pos[0], z: pos[2], dim });
      } catch {
        // player left between calls
      }
    }
    return out;
  }

  /** Chunks kept loaded in a dimension, as [[cx, cz], ...]. Needs the server running. */
  async forceloaded(id, dim) {
    if (!this.isRunning(id)) return null;
    const text = await this.rcon(id, `execute in ${this.checkDim(dim)} run forceload query`);
    return worldMap.parseForceloadQuery(text);
  }

  /**
   * Keep a rectangle of chunks loaded (add) or stop doing so (remove).
   * Chunk coordinates are inclusive. Minecraft accepts 256 chunks per command.
   */
  async forceload(id, dim, { x1, z1, x2, z2 }, add) {
    this.checkDim(dim);
    const nums = [x1, z1, x2, z2].map(Number);
    if (!nums.every(Number.isInteger)) throw new Error('Invalid chunk area');
    const [ax, az, bx, bz] = [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
    if ((bx - ax + 1) * (bz - az + 1) > 4096) throw new Error('Select fewer chunks (4,096 at most)');
    const verb = add ? 'add' : 'remove';
    const outputs = [];
    // Split into strips of at most 256 chunks.
    const width = bx - ax + 1;
    const rowsPerCmd = Math.max(1, Math.floor(256 / width));
    for (let z = az; z <= bz; z += rowsPerCmd) {
      for (let x = ax; x <= bx; x += 256) {
        const xEnd = Math.min(bx, x + 255);
        const zEnd = Math.min(bz, z + rowsPerCmd - 1);
        outputs.push(await this.rcon(id, `execute in ${dim} run forceload ${verb} ${x * 16} ${z * 16} ${xEnd * 16} ${zEnd * 16}`));
      }
    }
    return outputs.join('\n');
  }

  // ---------- pregeneration (Chunky) ----------

  chunkyInstalled(id) {
    const modsDir = path.join(this.serverDir(id), 'mods');
    return fs.existsSync(modsDir) && fs.readdirSync(modsDir).some((f) => /^chunky.*\.jar$/i.test(f));
  }

  pregenStatus(id) {
    const config = this.readConfig(id);
    const supported = config.loader && config.loader !== 'vanilla';
    return {
      supported,
      installed: supported && this.chunkyInstalled(id),
      ...(this.pregen.get(id) || { state: 'idle' }),
    };
  }

  setPregen(id, patch) {
    const next = { ...(this.pregen.get(id) || { state: 'idle' }), ...patch };
    this.pregen.set(id, next);
    this.emit('pregen', id, this.pregenStatus(id));
  }

  /**
   * Add a Modrinth mod (and any required mods that are missing) to a server.
   * Used for Chunky; the server needs a restart to load it.
   */
  async installMod(id, slug) {
    const config = this.readConfig(id);
    if (!config.loader || config.loader === 'vanilla') throw new Error('Plain Minecraft servers cannot load mods');
    const modsDir = path.join(this.serverDir(id), 'mods');
    await fsp.mkdir(modsDir, { recursive: true });
    const jars = await launchers.hashModJars(this.serverDir(id));
    const have = await modrinth.projectIdsForHashes(jars.map((j) => j.sha1)).catch(() => new Set());
    const queue = [slug];
    const seen = new Set();
    while (queue.length) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      const version = await modrinth.getCompatibleVersion(next, config.loader, config.minecraft);
      if (!version) throw new Error(`${next} has no version for ${config.loader} ${config.minecraft}`);
      if (have.has(version.projectId)) continue;
      await download(version.file.url, path.join(modsDir, version.file.filename), {
        hashes: { sha1: version.file.hashes.sha1 },
      });
      have.add(version.projectId);
      this.emit('console', id, { text: `Added ${version.file.filename}`, stream: 'system' });
      queue.push(...version.requiredProjects);
    }
  }

  async installChunky(id) {
    await this.installMod(id, 'chunky');
    this.setPregen(id, { state: 'idle', needsRestart: Boolean(this.processes.get(id) && this.processes.get(id).child) });
  }

  /** Pregenerate a square of `radius` blocks around spawn in the overworld. */
  async startPregen(id, radius) {
    if (!this.chunkyInstalled(id)) throw new Error('Install the pregeneration tool first');
    const r = Math.max(100, Math.min(20000, Math.round(Number(radius) || 1000)));
    const out = [];
    for (const cmd of ['chunky world minecraft:overworld', 'chunky spawn', 'chunky shape square', `chunky radius ${r}`, 'chunky start']) {
      out.push(await this.rcon(id, cmd));
    }
    const last = out[out.length - 1] || '';
    if (/unknown|incorrect/i.test(out.join('\n'))) {
      throw new Error('The server did not accept the Chunky commands. Restart the server so Chunky loads.');
    }
    if (/already running/i.test(last)) await this.rcon(id, 'chunky continue');
    this.setPregen(id, { state: 'running', radius: r, percent: 0, eta: null, rate: null, needsRestart: false });
  }

  async pausePregen(id) {
    await this.rcon(id, 'chunky pause');
    this.setPregen(id, { state: 'paused' });
  }

  async continuePregen(id) {
    await this.rcon(id, 'chunky continue');
    this.setPregen(id, { state: 'running' });
  }

  async cancelPregen(id) {
    await this.rcon(id, 'chunky cancel');
    await this.rcon(id, 'chunky confirm').catch(() => {});
    this.setPregen(id, { state: 'idle', percent: 0 });
  }

  /** Chunky prints its progress to the console; turn that into status updates. */
  trackPregen(id, line) {
    if (!line.includes('Chunky') && !line.includes('Task ')) return;
    const running = line.match(/Task running for (\S+?)\.? Processed: (\d+) chunks \(([\d.,]+)%\)(?:, ETA: ([\d:]+))?(?:, Rate: ([\d.,]+) cps)?/);
    if (running) {
      this.setPregen(id, {
        state: 'running',
        chunks: Number(running[2]),
        percent: Number(running[3].replace(',', '.')),
        eta: running[4] || null,
        rate: running[5] ? Number(running[5].replace(',', '.')) : null,
      });
      return;
    }
    const finished = line.match(/Task finished for (\S+?)\.? Processed: (\d+) chunks/);
    if (finished) this.setPregen(id, { state: 'done', percent: 100, chunks: Number(finished[2]), eta: null });
    else if (/Task (stopped|paused) for/.test(line)) this.setPregen(id, { state: 'paused' });
  }

  async stop(id) {
    const proc = this.processes.get(id);
    if (proc) await proc.stop();
  }

  sendCommand(id, command) {
    const proc = this.processes.get(id);
    if (!proc || !proc.child) throw new Error('Server is not running');
    proc.send(command);
  }

  async remove(id) {
    if (this.installing.has(id)) throw new Error('Wait for the install to finish first');
    const proc = this.processes.get(id);
    if (proc && proc.child) throw new Error('Stop the server before deleting it');
    const { tunnelId } = this.readConfig(id);
    if (tunnelId && this.playit.isLinked()) await this.playit.deleteTunnel(tunnelId).catch(() => {});
    this.processes.delete(id);
    this.tunnels.delete(id);
    await fsp.rm(this.serverDir(id), { recursive: true, force: true });
    this.emit('changed');
  }

  /** Stop every running server; used when the app quits. */
  async stopAll() {
    await Promise.all([...this.processes.values()].map((p) => p.stop()));
    await this.playit.stop();
  }

  readProperties(id) {
    const file = path.join(this.serverDir(id), 'server.properties');
    if (!fs.existsSync(file)) return {};
    const props = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    return props;
  }

  /** Update keys in server.properties, keeping other lines and comments as they are. */
  async writeProperties(id, patch) {
    const file = path.join(this.serverDir(id), 'server.properties');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    const remaining = { ...patch };
    const out = lines.map((line) => {
      const i = line.indexOf('=');
      if (line.startsWith('#') || i <= 0) return line;
      const key = line.slice(0, i);
      if (key in remaining) {
        const value = remaining[key];
        delete remaining[key];
        return `${key}=${value}`;
      }
      return line;
    });
    for (const [key, value] of Object.entries(remaining)) out.push(`${key}=${value}`);
    await fsp.writeFile(file, out.join('\n').replace(/\n*$/, '\n'));
  }
}

module.exports = { ServerManager };
