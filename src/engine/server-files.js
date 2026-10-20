// Safe server-root file operations used by the desktop file manager.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { safeJoin } = require('./paths');

const INTERNAL = new Set(['selfhost.json', '.selfhost']);

async function checkedPath(root, relative, { allowRoot = false } = {}) {
  if (allowRoot && (!relative || relative === '.')) return path.resolve(root);
  const target = safeJoin(root, relative);
  const rel = path.relative(root, target).split(path.sep);
  if (rel.some((part) => INTERNAL.has(part))) throw new Error('App data is not available in the file manager');
  let cursor = path.resolve(root);
  for (const part of rel) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Links outside the server folder are not allowed');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return target;
}

async function list(root, relative = '.') {
  const dir = await checkedPath(root, relative, { allowRoot: true });
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (INTERNAL.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.lstat(full);
    result.push({ name: entry.name, path: path.relative(root, full).replace(/\\/g, '/'), directory: entry.isDirectory(), size: stat.isFile() ? stat.size : 0, modifiedAt: stat.mtime.toISOString() });
  }
  return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

async function readText(root, relative) {
  const file = await checkedPath(root, relative);
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Only text files up to 2 MB can be edited here');
  const data = await fsp.readFile(file);
  if (data.includes(0)) throw new Error('This file is binary and cannot be opened in the text editor');
  return data.toString('utf8');
}

async function writeText(root, relative, content) {
  const file = await checkedPath(root, relative);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Text files are limited to 2 MB');
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('Choose a file to edit');
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  await fsp.rename(temp, file);
}

async function createFolder(root, parent, name) {
  if (!/^[^<>:"/\\|?*\x00-\x1f.][^<>:"/\\|?*\x00-\x1f]*$/.test(name || '') || name === '.' || name === '..') throw new Error('Choose a valid folder name');
  const base = await checkedPath(root, parent || '.', { allowRoot: true });
  const target = await checkedPath(root, path.relative(root, path.join(base, name)).replace(/\\/g, '/'));
  await fsp.mkdir(target);
}

async function rename(root, relative, newName) {
  if (!/^[^<>:"/\\|?*\x00-\x1f.][^<>:"/\\|?*\x00-\x1f]*$/.test(newName || '') || newName === '.' || newName === '..') throw new Error('Choose a valid name');
  const source = await checkedPath(root, relative);
  const parent = path.dirname(source);
  const dest = await checkedPath(root, path.relative(root, path.join(parent, newName)).replace(/\\/g, '/'));
  await fsp.rename(source, dest);
}

async function remove(root, relative) {
  const target = await checkedPath(root, relative);
  await fsp.rm(target, { recursive: true, force: false });
}

async function copyInto(root, relative, sourceFile) {
  const dest = await checkedPath(root, path.join(relative || '.', path.basename(sourceFile)).replace(/\\/g, '/'));
  await fsp.copyFile(sourceFile, dest);
}

async function copyOut(root, relative, dest) {
  const source = await checkedPath(root, relative);
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw new Error('Choose a file to download');
  await fsp.copyFile(source, dest);
}

async function createZip(root, relative, dest) {
  const source = await checkedPath(root, relative);
  const stat = await fsp.stat(source);
  if (!stat.isDirectory()) throw new Error('Choose a folder to archive');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise((resolve, reject) => execFile(tar, ['-a', '-c', '-f', dest, '-C', path.dirname(source), '--', path.basename(source)], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
    if (err) reject(new Error(stderr || err.message)); else resolve();
  }));
}

async function extractZip(root, relative) {
  const archive = await checkedPath(root, relative);
  const stat = await fsp.stat(archive);
  if (!stat.isFile() || path.extname(archive).toLowerCase() !== '.zip') throw new Error('Choose a .zip file to extract');
  const targetDir = path.dirname(archive);
  const temp = path.join(targetDir, `.extract-${crypto.randomBytes(5).toString('hex')}`);
  await fsp.mkdir(temp);
  try {
    for (const entry of new AdmZip(archive).getEntries()) {
      if (entry.isDirectory) continue;
      const staged = safeJoin(temp, entry.entryName.replace(/\\/g, '/'));
      const target = await checkedPath(root, path.relative(root, staged).replace(/\\/g, '/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, entry.getData());
    }
    for (const name of await fsp.readdir(temp)) {
      const target = await checkedPath(root, path.relative(root, path.join(targetDir, name)).replace(/\\/g, '/'));
      if (fs.existsSync(target)) throw new Error(`Cannot extract because "${name}" already exists`);
    }
    for (const name of await fsp.readdir(temp)) {
      await fsp.rename(path.join(temp, name), path.join(targetDir, name));
    }
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { list, readText, writeText, createFolder, rename, remove, copyInto, copyOut, createZip, extractZip, checkedPath };
