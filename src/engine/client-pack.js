// What a player's game needs to join a server, checking a game profile
// against that, and exporting it as a pack friends can import.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { download, mapLimit } = require('./http');
const { readIndex, describeDependencies } = require('./mrpack');
const { hashModJars } = require('./launchers');
const { safeJoin } = require('./paths');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/**
 * Client mods from a .mrpack: every mod the pack does not mark as
 * server-only, plus jars bundled in its override folders.
 */
function clientModsFromMrpack(mrpackPath) {
  const zip = new AdmZip(mrpackPath);
  const index = readIndex(zip);
  const mods = [];
  for (const f of index.files || []) {
    if (f.env && f.env.client === 'unsupported') continue;
    if (!/^mods\/[^/]+\.jar$/i.test(f.path.replace(/\\/g, '/'))) continue;
    mods.push({ fileName: path.basename(f.path), sha1: f.hashes.sha1 });
  }
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.replace(/\\/g, '/').match(/^(?:client-)?overrides\/mods\/([^/]+\.jar)$/i);
    if (m && !entry.isDirectory) mods.push({ fileName: m[1], sha1: sha1(entry.getData()) });
  }
  return { ...describeDependencies(index.dependencies), mods };
}

/**
 * Compare a game profile with what the server needs.
 * `needs` is { minecraft, loader, loaderVersion, mods: [{ fileName, sha1 }] }.
 */
async function compareProfile(needs, profile) {
  const have = await hashModJars(profile.gameDir);
  const haveHashes = new Set(have.map((m) => m.sha1));
  const haveNames = new Set(have.map((m) => m.fileName.toLowerCase()));
  const needHashes = new Set(needs.mods.map((m) => m.sha1));
  const needNames = new Set(needs.mods.map((m) => m.fileName.toLowerCase()));

  const missing = needs.mods
    .filter((m) => !haveHashes.has(m.sha1) && !haveNames.has(m.fileName.toLowerCase()))
    .map((m) => m.fileName);
  const extra = have
    .filter((m) => !needHashes.has(m.sha1) && !needNames.has(m.fileName.toLowerCase()))
    .map((m) => m.fileName);

  const minecraftOk = profile.minecraft === needs.minecraft;
  const loaderOk = profile.loader === needs.loader;
  const loaderVersionOk = loaderOk && (!needs.loaderVersion || profile.loaderVersion === needs.loaderVersion);
  return {
    profile: { id: profile.id, name: profile.name, launcherName: profile.launcherName },
    minecraft: { need: needs.minecraft, have: profile.minecraft, ok: minecraftOk },
    loader: {
      need: `${needs.loader} ${needs.loaderVersion || ''}`.trim(),
      have: `${profile.loader} ${profile.loaderVersion || ''}`.trim(),
      ok: loaderOk,
      versionOk: loaderVersionOk,
    },
    missing,
    extra,
    ready: minecraftOk && loaderVersionOk && missing.length === 0,
  };
}

function curseForgeLoaderId(loader, loaderVersion) {
  if (!loader || loader === 'vanilla') return null;
  return `${loader}-${loaderVersion}`;
}

function zipFolder(folder, outFile) {
  // Windows 10+ ships bsdtar, which writes zip files without loading them into memory.
  // Call it by full path: a GNU tar from Git or MSYS on PATH cannot write zips.
  const tar =
    process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  return new Promise((resolve, reject) =>
    execFile(tar,['-a', '-c', '-f', outFile, '-C', folder, ...fs.readdirSync(folder)], { windowsHide: true }, (err, _o, stderr) =>
      err ? reject(new Error(`Could not create zip: ${stderr || err.message}`)) : resolve()
    )
  );
}

async function copyInto(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

/**
 * Build a CurseForge-importable profile zip (manifest.json + overrides/).
 * `addFiles(overridesDir)` puts mods, configs and so on into overrides/.
 */
async function buildCurseForgeZip({ name, version, minecraft, loader, loaderVersion, outFile, staging, addFiles }) {
  await fsp.rm(staging, { recursive: true, force: true });
  const overrides = path.join(staging, 'overrides');
  await fsp.mkdir(overrides, { recursive: true });
  await addFiles(overrides);
  const loaderId = curseForgeLoaderId(loader, loaderVersion);
  const manifest = {
    minecraft: { version: minecraft, modLoaders: loaderId ? [{ id: loaderId, primary: true }] : [] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name,
    version: version || '1.0.0',
    author: 'Self-Host MC',
    files: [],
    overrides: 'overrides',
  };
  await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.rm(outFile, { force: true });
  await zipFolder(staging, outFile);
  await fsp.rm(staging, { recursive: true, force: true });
  return outFile;
}

/** Client files of a .mrpack (downloaded into `cacheDir`) copied into `overrides`. */
async function addMrpackClientFiles(mrpackPath, overrides, cacheDir, onProgress = () => {}) {
  const zip = new AdmZip(mrpackPath);
  const index = readIndex(zip);
  const files = (index.files || []).filter((f) => !(f.env && f.env.client === 'unsupported'));
  let done = 0;
  await mapLimit(files, 6, async (f) => {
    const cached = path.join(cacheDir, `${f.hashes.sha1}${path.extname(f.path)}`);
    if (!fs.existsSync(cached)) {
      await download(f.downloads[0], cached, { hashes: { sha1: f.hashes.sha1 } });
    }
    await copyInto(cached, safeJoin(overrides, f.path));
    onProgress(++done, files.length);
  });
  // Client overrides win over shared ones, so write them second.
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entry.isDirectory || !entryName.startsWith(prefix)) continue;
      const dest = safeJoin(overrides, entryName.slice(prefix.length));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
    }
  }
}

// Folders that carry a profile's gameplay setup (not worlds, settings or caches).
const PROFILE_FOLDERS = ['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'resourcepacks', 'shaderpacks', 'global_packs', 'datapacks'];

async function addProfileFiles(gameDir, overrides) {
  for (const folder of PROFILE_FOLDERS) {
    const src = path.join(gameDir, folder);
    if (fs.existsSync(src)) await fsp.cp(src, path.join(overrides, folder), { recursive: true });
  }
}

module.exports = {
  clientModsFromMrpack,
  compareProfile,
  buildCurseForgeZip,
  addMrpackClientFiles,
  addProfileFiles,
  PROFILE_FOLDERS,
};
