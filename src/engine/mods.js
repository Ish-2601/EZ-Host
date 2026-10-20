// The mods on a server: list them, turn them on and off, and remember which
// ones caused problems. Turned-off mods live in mods-disabled/ next to mods/.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readModInfo } = require('./mod-metadata');

const ENABLED_DIR = 'mods';
const DISABLED_DIR = 'mods-disabled';
// Earlier versions of the app (and manual fixes) used this folder name.
const LEGACY_DISABLED = ['mods-disabled (client-only)'];

function cacheFile(serverDir) {
  return path.join(serverDir, '.selfhost', 'mods-cache.json');
}

function readCache(serverDir) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(serverDir), 'utf8'));
  } catch {
    return {};
  }
}

function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/** Move jars from old disabled-folder names into mods-disabled/. */
function migrateDisabled(serverDir) {
  for (const legacy of LEGACY_DISABLED) {
    const dir = path.join(serverDir, legacy);
    if (!fs.existsSync(dir)) continue;
    fs.mkdirSync(path.join(serverDir, DISABLED_DIR), { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.renameSync(path.join(dir, f), path.join(serverDir, DISABLED_DIR, f));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every mod jar on the server, on or off:
 * [{ fileName, enabled, name, version, description, ids, depends, sha1, size, environment }]
 * Jar metadata is cached by name, size and date so later calls are quick.
 */
function listMods(serverDir) {
  migrateDisabled(serverDir);
  const cache = readCache(serverDir);
  const nextCache = {};
  const out = [];
  for (const [dir, enabled] of [[ENABLED_DIR, true], [DISABLED_DIR, false]]) {
    const full = path.join(serverDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const fileName of fs.readdirSync(full)) {
      if (!fileName.toLowerCase().endsWith('.jar')) continue;
      const file = path.join(full, fileName);
      const stat = fs.statSync(file);
      const key = `${fileName}|${stat.size}|${Math.round(stat.mtimeMs)}`;
      let info = cache[key];
      if (!info) {
        const meta = readModInfo(file) || {};
        info = {
          name: meta.name || fileName.replace(/\.jar$/i, ''),
          version: meta.version || null,
          description: meta.description ? String(meta.description).slice(0, 300) : null,
          ids: meta.ids || [],
          depends: meta.depends || [],
          environment: meta.environment || '*',
          sha1: sha1File(file),
        };
      }
      nextCache[key] = info;
      out.push({ fileName, enabled, size: stat.size, ...info });
    }
  }
  fs.mkdirSync(path.dirname(cacheFile(serverDir)), { recursive: true });
  fs.writeFileSync(cacheFile(serverDir), JSON.stringify(nextCache));
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function checkFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.jar') || /[\\/]/.test(fileName) || fileName.startsWith('.')) {
    throw new Error('Invalid mod file');
  }
}

/** Turn one mod on or off by moving it between mods/ and mods-disabled/. */
async function setModEnabled(serverDir, fileName, enabled) {
  checkFileName(fileName);
  migrateDisabled(serverDir);
  const from = path.join(serverDir, enabled ? DISABLED_DIR : ENABLED_DIR, fileName);
  const to = path.join(serverDir, enabled ? ENABLED_DIR : DISABLED_DIR, fileName);
  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return; // already in that state
    throw new Error('That mod is no longer on the server');
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

/** Enabled mods whose ids match `modIds` (from a crash report). */
function findByModIds(mods, modIds) {
  const wanted = new Set(modIds.map((m) => m.toLowerCase()));
  return mods.filter((m) => m.enabled && m.ids.some((id) => wanted.has(String(id).toLowerCase())));
}

/** For each mod, the enabled mods that need it (so turning it off would break them). */
function dependents(mods) {
  const byId = new Map();
  for (const m of mods) for (const id of m.ids) byId.set(String(id).toLowerCase(), m.fileName);
  const out = {};
  for (const m of mods) {
    if (!m.enabled) continue;
    for (const dep of m.depends) {
      const file = byId.get(String(dep).toLowerCase());
      if (!file) continue;
      (out[file] = out[file] || []).push(m.name);
    }
  }
  return out;
}

module.exports = { listMods, setModEnabled, findByModIds, dependents, ENABLED_DIR, DISABLED_DIR };
