// Finds the Minecraft profiles (instances) people play from on this PC, so a
// server can be built from one, or checked against one.
// Supported: CurseForge app, Prism Launcher and the Modrinth App.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileHash, mapLimit } = require('./http');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function curseForgeRoots() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
    path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'),
    path.join(home, 'OneDrive', 'Documents', 'curseforge', 'minecraft', 'Instances'),
  ];
  return [...new Set(candidates)].filter(isDir);
}

/** "neoforge-21.1.264" / "forge-47.4.20" / "fabric-0.18.4-1.21.11" -> { loader, loaderVersion } */
function parseCurseForgeLoader(baseModLoader) {
  if (!baseModLoader || !baseModLoader.name) return { loader: 'vanilla', loaderVersion: null };
  const [loader, ...rest] = baseModLoader.name.split('-');
  if (loader === 'fabric' || loader === 'quilt') return { loader, loaderVersion: rest[0] || null };
  if (loader === 'forge' || loader === 'neoforge') {
    return { loader, loaderVersion: baseModLoader.forgeVersion || rest.join('-') || null };
  }
  return { loader, loaderVersion: rest.join('-') || null };
}

function curseForgeProfiles() {
  const profiles = [];
  for (const root of curseForgeRoots()) {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const info = readJson(path.join(dir, 'minecraftinstance.json'));
      if (!info) continue;
      const { loader, loaderVersion } = parseCurseForgeLoader(info.baseModLoader);
      const pack = info.installedModpack;
      profiles.push({
        launcher: 'curseforge',
        launcherName: 'CurseForge',
        name: info.name || name,
        dir,
        gameDir: dir,
        minecraft: info.gameVersion || null,
        loader,
        loaderVersion,
        lastPlayed: info.lastPlayed || null,
        modpack: pack
          ? {
              name: pack.name,
              version: (pack.installedFile && (pack.installedFile.displayName || pack.installedFile.fileName)) || null,
              url: pack.webSiteURL || null,
            }
          : null,
      });
    }
  }
  return profiles;
}

const PRISM_COMPONENTS = {
  'net.neoforged': 'neoforge',
  'net.minecraftforge': 'forge',
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
};

function prismProfiles() {
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), '.local', 'share'), 'PrismLauncher', 'instances');
  if (!isDir(root)) return [];
  const profiles = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const pack = readJson(path.join(dir, 'mmc-pack.json'));
    if (!pack || !pack.components) continue;
    let minecraft = null;
    let loader = 'vanilla';
    let loaderVersion = null;
    for (const c of pack.components) {
      if (c.uid === 'net.minecraft') minecraft = c.version;
      if (PRISM_COMPONENTS[c.uid]) {
        loader = PRISM_COMPONENTS[c.uid];
        loaderVersion = c.version;
      }
    }
    let displayName = name;
    try {
      const cfg = fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8');
      const m = cfg.match(/^name=(.*)$/m);
      if (m) displayName = m[1].trim();
    } catch {
      // keep folder name
    }
    const gameDir = ['minecraft', '.minecraft'].map((d) => path.join(dir, d)).find(isDir) || path.join(dir, 'minecraft');
    profiles.push({
      launcher: 'prism',
      launcherName: 'Prism Launcher',
      name: displayName,
      dir,
      gameDir,
      minecraft,
      loader,
      loaderVersion,
      lastPlayed: null,
      modpack: null,
    });
  }
  return profiles;
}

/** Every profile found on this PC, most recently played first. */
// ---------- Modrinth App ----------

const MODRINTH_LOADERS = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge', quilt: 'quilt', vanilla: 'vanilla' };

function modrinthRoots() {
  const appData = process.env.APPDATA || path.join(os.homedir(), '.local', 'share');
  // Current versions use ModrinthApp; older ones used com.modrinth.theseus.
  return [path.join(appData, 'ModrinthApp'), path.join(appData, 'com.modrinth.theseus')].filter(isDir);
}

function toIso(value) {
  if (!value) return null;
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Profiles from the Modrinth App database (app.db, SQLite). */
function modrinthDbProfiles(root) {
  const dbFile = path.join(root, 'app.db');
  if (!fs.existsSync(dbFile)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('SELECT * FROM profiles').all();
    return rows.map((row) => {
      const folder = row.path || row.name;
      const loader = MODRINTH_LOADERS[String(row.mod_loader || row.loader || 'vanilla').toLowerCase()] || 'vanilla';
      return {
        launcher: 'modrinth',
        launcherName: 'Modrinth App',
        name: row.name || folder,
        dir: path.join(root, 'profiles', folder),
        gameDir: path.join(root, 'profiles', folder),
        minecraft: row.game_version || null,
        loader,
        loaderVersion: loader === 'vanilla' ? null : row.mod_loader_version || row.loader_version || null,
        lastPlayed: toIso(row.last_played),
        modpack: null,
      };
    });
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {
      // already closed
    }
  }
}

/** Older Modrinth App versions kept a profile.json in each profile folder. */
function modrinthJsonProfiles(root) {
  const profilesDir = path.join(root, 'profiles');
  if (!isDir(profilesDir)) return [];
  const out = [];
  for (const folder of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, folder);
    const json = readJson(path.join(dir, 'profile.json'));
    if (!json) continue;
    const meta = json.metadata || json;
    const loader = MODRINTH_LOADERS[String(meta.loader || 'vanilla').toLowerCase()] || 'vanilla';
    const lv = meta.loader_version;
    out.push({
      launcher: 'modrinth',
      launcherName: 'Modrinth App',
      name: meta.name || folder,
      dir,
      gameDir: dir,
      minecraft: meta.game_version || null,
      loader,
      loaderVersion: loader === 'vanilla' ? null : (lv && (lv.id || lv)) || null,
      lastPlayed: toIso(meta.last_played),
      modpack: null,
    });
  }
  return out;
}

function modrinthProfiles() {
  const out = [];
  for (const root of modrinthRoots()) out.push(...(modrinthDbProfiles(root) || modrinthJsonProfiles(root)));
  return out.filter((p) => isDir(p.gameDir));
}

function listProfiles() {
  const profiles = [...curseForgeProfiles(), ...prismProfiles(), ...modrinthProfiles()].map((p) => ({
    ...p,
    id: `${p.launcher}:${p.dir}`,
    modCount: listModJars(p.gameDir).length,
  }));
  return profiles.sort((a, b) => (b.lastPlayed || '').localeCompare(a.lastPlayed || ''));
}

function findProfile(profileId) {
  const profile = listProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('That game profile was not found on this PC');
  return profile;
}

function listModJars(gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  if (!isDir(modsDir)) return [];
  return fs
    .readdirSync(modsDir)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .map((f) => path.join(modsDir, f));
}

/** [{ fileName, sha1, path }] for every enabled mod jar in a profile. */
async function hashModJars(gameDir) {
  return mapLimit(listModJars(gameDir), 8, async (file) => ({
    fileName: path.basename(file),
    sha1: await fileHash(file, 'sha1'),
    path: file,
  }));
}

module.exports = { listProfiles, findProfile, listModJars, hashModJars, parseCurseForgeLoader };
