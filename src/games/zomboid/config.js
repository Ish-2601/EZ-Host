// Project Zomboid server settings (<servername>.ini), the host's own Zomboid
// setup (server configs and Steam Workshop mods), and mod.info parsing.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- .ini files (key=value lines, # comments) ----------

function readIni(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return values;
}

/** Update keys in an .ini file, keeping every other line as it is. */
function writeIni(file, patch) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const remaining = { ...patch };
  const out = lines.map((line) => {
    const i = line.indexOf('=');
    if (line.startsWith('#') || i <= 0) return line;
    const key = line.slice(0, i).trim();
    if (key in remaining) {
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) out.push(`${key}=${value}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'));
}

const splitList = (value) => String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
const joinList = (list) => [...new Set(list)].join(';');

// ---------- the host's own Zomboid folder ----------

function userZomboidDir() {
  return path.join(os.homedir(), 'Zomboid');
}

/** Servers the host made in the game (Host menu), from Zomboid/Server/*.ini. */
function localServerConfigs() {
  const dir = path.join(userZomboidDir(), 'Server');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ini'))
    .map((f) => {
      const name = f.slice(0, -4);
      const ini = readIni(path.join(dir, f));
      return {
        name,
        mods: splitList(ini.Mods).length,
        workshopItems: splitList(ini.WorkshopItems).length,
        map: ini.Map || null,
        maxPlayers: Number(ini.MaxPlayers) || null,
        modified: fs.statSync(path.join(dir, f)).mtimeMs,
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

/** Files that belong to an in-game server config, so a copy keeps its world settings. */
function serverConfigFiles(name) {
  const dir = path.join(userZomboidDir(), 'Server');
  return ['.ini', '_SandboxVars.lua', '_spawnpoints.lua', '_spawnregions.lua']
    .map((suffix) => ({ suffix, file: path.join(dir, `${name}${suffix}`) }))
    .filter((x) => fs.existsSync(x.file));
}

// ---------- Steam Workshop mods ----------

/** Steam library folders, from the registry path and libraryfolders.vdf. */
function steamLibraries() {
  const candidates = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
  const libs = new Set();
  for (const root of candidates) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  return [...libs];
}

/** Parse mod.info: name, id, requirements and (Build 42) incompatibilities. */
function parseModInfo(file) {
  const info = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (!(key in info)) info[key] = value;
  }
  const list = (v) => String(v || '').split(/[,;]/).map((s) => s.trim().replace(/^\\+/, '')).filter(Boolean);
  const rawId = info.id || '';
  return {
    id: rawId.includes('/') ? rawId.slice(rawId.lastIndexOf('/') + 1) : rawId,
    name: info.name || rawId,
    description: info.description || '',
    require: list(info.require).map((r) => (r.includes('/') ? r.slice(r.lastIndexOf('/') + 1) : r)),
    incompatible: list(info.incompatible).map((r) => (r.includes('/') ? r.slice(r.lastIndexOf('/') + 1) : r)),
  };
}

/**
 * Every Workshop item the host is subscribed to for Project Zomboid, with the
 * mods inside it: [{ workshopId, title, mods: [{ id, name, require, incompatible }] }].
 * Build 42 mods keep their files in a "42" (or "42.x") subfolder; the newest one wins.
 */
function scanWorkshop(extraRoots = []) {
  const items = [];
  const seen = new Set();
  // The host's own Steam downloads first, then items the app downloaded itself.
  const roots = [...steamLibraries().map((lib) => path.join(lib, 'steamapps', 'workshop', 'content', '108600')), ...extraRoots];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const workshopId of fs.readdirSync(root)) {
      if (seen.has(workshopId)) continue;
      const modsDir = path.join(root, workshopId, 'mods');
      if (!fs.existsSync(modsDir)) continue;
      const mods = [];
      for (const folder of fs.readdirSync(modsDir)) {
        const base = path.join(modsDir, folder);
        const versioned = fs.existsSync(base) && fs.statSync(base).isDirectory()
          ? fs.readdirSync(base).filter((d) => /^\d+(\.\d+)*$/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          : [];
        const candidates = [...versioned.reverse().map((v) => path.join(base, v, 'mod.info')), path.join(base, 'mod.info')];
        const infoFile = candidates.find((f) => fs.existsSync(f));
        if (!infoFile) continue;
        try {
          const info = parseModInfo(infoFile);
          if (info.id) mods.push(info);
        } catch {
          // unreadable mod.info
        }
      }
      if (mods.length) {
        seen.add(workshopId);
        items.push({ workshopId, title: mods[0].name, mods });
      }
    }
  }
  return items;
}

module.exports = {
  readIni,
  writeIni,
  splitList,
  joinList,
  userZomboidDir,
  localServerConfigs,
  serverConfigFiles,
  scanWorkshop,
  parseModInfo,
};
