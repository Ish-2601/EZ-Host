// Installs a Modrinth modpack (.mrpack) as a server.
// Format spec: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const { download, fileHash, mapLimit } = require('./http');
const { safeJoin } = require('./paths');
const { findClientOnlyFiles } = require('./modrinth');

// The spec only allows pack files to come from these hosts.
const ALLOWED_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
]);

function readIndex(zip) {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('Not a Modrinth modpack: modrinth.index.json is missing');
  const index = JSON.parse(entry.getData().toString('utf8'));
  if (index.formatVersion !== 1) {
    throw new Error(`Unsupported modpack format version ${index.formatVersion}`);
  }
  if (index.game !== 'minecraft') throw new Error(`Unsupported game ${index.game}`);
  return index;
}

/** Turn the pack's dependency map into { minecraft, loader, loaderVersion }. */
function describeDependencies(deps = {}) {
  const minecraft = deps.minecraft;
  if (!minecraft) throw new Error('Modpack does not say which Minecraft version it needs');
  const loaders = [
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
    ['fabric-loader', 'fabric'],
    ['quilt-loader', 'quilt'],
  ];
  for (const [key, loader] of loaders) {
    if (deps[key]) return { minecraft, loader, loaderVersion: deps[key] };
  }
  return { minecraft, loader: 'vanilla', loaderVersion: null };
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function alreadyHave(dest, hashes) {
  try {
    await fsp.access(dest);
  } catch {
    return false;
  }
  if (hashes.sha512) return (await fileHash(dest, 'sha512')) === hashes.sha512.toLowerCase();
  if (hashes.sha1) return (await fileHash(dest, 'sha1')) === hashes.sha1.toLowerCase();
  return false;
}

/** Copy every entry under `prefix/` in the zip into `serverDir`. */
function extractFolder(zip, prefix, serverDir) {
  let count = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name.startsWith(prefix + '/') || entry.isDirectory) continue;
    const relative = name.slice(prefix.length + 1);
    if (!relative) continue;
    const dest = safeJoin(serverDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    count++;
  }
  return count;
}

/**
 * Install the pack at `mrpackPath` into `serverDir`.
 * `log(message)` reports progress text; `onProgress(done, total)` reports file counts.
 * Returns { name, versionId, minecraft, loader, loaderVersion }.
 */
async function installMrpack(mrpackPath, serverDir, { log = () => {}, onProgress = () => {} } = {}) {
  const zip = new AdmZip(mrpackPath);
  const index = readIndex(zip);
  const deps = describeDependencies(index.dependencies);
  log(`Modpack: ${index.name} ${index.versionId} (Minecraft ${deps.minecraft}, ${deps.loader} ${deps.loaderVersion || ''})`.trim());

  await fsp.mkdir(serverDir, { recursive: true });

  let files = (index.files || []).filter((f) => {
    const server = f.env && f.env.server;
    return server !== 'unsupported';
  });
  const skipped = (index.files || []).length - files.length;
  if (skipped) log(`Skipping ${skipped} client-only file(s) marked by the pack`);

  try {
    const hashes = files.map((f) => f.hashes && f.hashes.sha1).filter(Boolean);
    const clientOnly = await findClientOnlyFiles(hashes);
    const before = files.length;
    files = files.filter((f) => !(f.hashes && f.hashes.sha1 && clientOnly.has(f.hashes.sha1.toLowerCase())));
    for (const f of index.files || []) {
      if (f.hashes && f.hashes.sha1 && clientOnly.has(f.hashes.sha1.toLowerCase())) {
        // Remove leftovers from an earlier install of the same pack.
        await fsp.rm(safeJoin(serverDir, f.path), { force: true });
      }
    }
    if (before !== files.length) {
      log(`Skipping ${before - files.length} more client-only mod(s) found via Modrinth`);
    }
  } catch (err) {
    log(`Could not check mods against Modrinth (${err.message}); installing all of them`);
  }
  log(`Downloading ${files.length} mod file(s)...`);

  let done = 0;
  onProgress(0, files.length);
  await mapLimit(files, 6, async (file) => {
    const dest = safeJoin(serverDir, file.path);
    const hashes = file.hashes || {};
    if (!(await alreadyHave(dest, hashes))) {
      const urls = (file.downloads || []).filter(isAllowedUrl);
      if (urls.length === 0) {
        throw new Error(`No allowed download URL for ${file.path}`);
      }
      let lastError;
      for (const url of urls) {
        try {
          await download(url, dest, { hashes: { sha1: hashes.sha1, sha512: hashes.sha512 } });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    }
    done++;
    onProgress(done, files.length);
  });

  // Server overrides win over shared overrides, so copy them second.
  const shared = extractFolder(zip, 'overrides', serverDir);
  const serverOnly = extractFolder(zip, 'server-overrides', serverDir);
  log(`Copied ${shared + serverOnly} config/override file(s)`);

  return {
    name: index.name,
    versionId: index.versionId,
    ...deps,
  };
}

module.exports = { installMrpack, describeDependencies, readIndex };
