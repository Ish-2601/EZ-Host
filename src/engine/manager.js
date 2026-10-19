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
const { download } = require('./http');
const modrinth = require('./modrinth');
const { installMrpack } = require('./mrpack');
const { requiredJavaVersion } = require('./minecraft');
const { ensureJava } = require('./java');
const { installLoader } = require('./loaders');
const { ServerProcess } = require('./server-process');
const launchers = require('./launchers');
const clientPack = require('./client-pack');
const { pruneClientOnlyMods } = require('./mod-metadata');
const { Playit } = require('./playit');

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

  async createConfig(name, memoryMb, source) {
    const id = this.newId(name);
    await fsp.mkdir(this.serverDir(id), { recursive: true });
    await this.writeConfig({
      id,
      name,
      source,
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

    const { javaPath } = await ensureJava(config.javaMajor, this.paths.java, {
      log: (message) => this.emit('console', id, { text: message, stream: 'system' }),
    });
    const proc = new ServerProcess({
      javaPath,
      serverDir: this.serverDir(id),
      launch: config.launch,
      memoryMb: config.memoryMb,
    });
    proc.on('line', (text, stream) => this.emit('console', id, { text, stream }));
    proc.on('status', (status) => this.emit('status', id, status));
    proc.on('players', (players) => this.emit('players', id, players));
    proc.on('exit', () => {
      // Close the tunnel once no server is left running.
      const anyRunning = [...this.processes.values()].some((p) => p.child);
      if (!anyRunning) this.playit.stop().catch(() => {});
    });
    this.processes.set(id, proc);
    proc.start();
    if (this.playit.isLinked()) this.startTunnel(id).catch(() => {});
    return this.describe(id);
  }

  /** Open (or re-point) the playit.gg tunnel for a server. Errors also arrive as 'playit' events. */
  async startTunnel(id) {
    const port = Number(this.readProperties(id)['server-port']) || 25565;
    const address = await this.playit.start(port, (line) => this.emit('console', id, { text: line, stream: 'system' }));
    this.emit('console', id, { text: `Online address for friends: ${address}`, stream: 'system' });
    return address;
  }

  /** Link playit.gg; `openUrl` opens the approval page in the user's browser. */
  async linkPlayit(openUrl) {
    await this.playit.link(openUrl);
    // If a server is already running, give it an online address right away.
    const running = [...this.processes.entries()].find(([, p]) => p.child);
    if (running) this.startTunnel(running[0]).catch(() => {});
  }

  async unlinkPlayit() {
    await this.playit.unlink();
  }

  playitStatus() {
    return { ...this.playit.state, linked: this.playit.isLinked() };
  }

  players(id) {
    const proc = this.processes.get(id);
    return proc ? [...proc.players] : [];
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
    this.processes.delete(id);
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
