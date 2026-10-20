// Local, restorable server backups. Archives are written with Windows' built-in
// tar so large worlds are not loaded into memory by the UI process.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { safeJoin } = require('./paths');

const STORE = path.join('.selfhost', 'backups');

function validateRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some((p) => !p || p === '..')) {
    throw new Error(`Invalid server path: ${value}`);
  }
  return normalized;
}

function runTar(args) {
  const exe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  return new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (err) reject(new Error(`Backup archive failed: ${stderr || err.message}`));
    else resolve();
  }));
}

async function createBackup(serverDir, { reason = 'Manual restore point', settings = {} } = {}) {
  const store = path.join(serverDir, STORE);
  await fsp.mkdir(store, { recursive: true });
  const date = new Date();
  const id = `${date.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  const archive = path.join(store, `${id}.zip`);
  const excludes = new Set(['.selfhost', 'selfhost.json', ...(settings.exclude || []).map(validateRelative)]);
  const includes = settings.include && settings.include.length
    ? settings.include.map(validateRelative)
    : fs.readdirSync(serverDir).filter((entry) => entry !== '.selfhost' && entry !== 'selfhost.json');
  if (includes.some((entry) => entry === '.selfhost' || entry.startsWith('.selfhost/') || entry === 'selfhost.json')) {
    throw new Error('App metadata and backup folders cannot be included in a backup');
  }
  if (!includes.length) throw new Error('There are no server files to back up');
  const args = ['-a', '-c', '-f', archive, '-C', serverDir];
  for (const entry of excludes) args.push(`--exclude=${entry}`);
  args.push('--', ...includes);
  await runTar(args);
  const stat = await fsp.stat(archive);
  const item = { id, createdAt: date.toISOString(), reason, size: stat.size, fileName: `${id}.zip` };
  await fsp.writeFile(path.join(store, `${id}.json`), JSON.stringify(item, null, 2));
  return item;
}

async function listBackups(serverDir) {
  const store = path.join(serverDir, STORE);
  let names;
  try { names = await fsp.readdir(store); } catch { return []; }
  const backups = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const item = JSON.parse(await fsp.readFile(path.join(store, name), 'utf8'));
      if (item && /^[a-z0-9-]+$/.test(item.id) && await fsp.stat(path.join(store, `${item.id}.zip`))) backups.push(item);
    } catch { /* ignore incomplete backup records */ }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneBackups(serverDir, keep) {
  const store = path.join(serverDir, STORE);
  const backups = await listBackups(serverDir);
  for (const item of backups.slice(Math.max(1, Math.floor(keep)))) {
    await Promise.all([
      fsp.rm(path.join(store, `${item.id}.zip`), { force: true }),
      fsp.rm(path.join(store, `${item.id}.json`), { force: true }),
    ]);
  }
}

async function restoreBackup(serverDir, backupId, { beforeRestore } = {}) {
  if (!/^[a-z0-9-]+$/.test(backupId)) throw new Error('Invalid backup');
  const store = path.join(serverDir, STORE);
  const archivePath = path.join(store, `${backupId}.zip`);
  if (!fs.existsSync(archivePath)) throw new Error('That backup no longer exists');
  const zip = new AdmZip(archivePath);
  const temp = path.join(serverDir, '.selfhost', `restore-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(temp, { recursive: true });
  try {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const rel = entry.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
      const target = safeJoin(temp, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, entry.getData());
    }
    if (beforeRestore) await beforeRestore();
    for (const name of await fsp.readdir(serverDir)) {
      if (name === 'selfhost.json' || name === '.selfhost') continue;
      await fsp.rm(path.join(serverDir, name), { recursive: true, force: true });
    }
    for (const name of await fsp.readdir(temp)) {
      await fsp.cp(path.join(temp, name), path.join(serverDir, name), { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { createBackup, listBackups, pruneBackups, restoreBackup, validateRelative };
