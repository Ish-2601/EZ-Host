const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Server, utils } = require('ssh2');
// ssh2 1.x exposes the SFTP constants under utils.sftp.
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const safeEqual = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function jail(root, remote) {
  const raw = String(remote || '/').replace(/\\/g, '/');
  if (raw.includes('\0') || /^[a-z]:/i.test(raw) || raw.split('/').includes('..')) throw new Error('Path is outside the shared server folder');
  const normalized = path.posix.normalize(`/${raw.replace(/^\/+/, '')}`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] === '.selfhost' || parts[0] === 'selfhost.json') throw new Error('App metadata is not available over SFTP');
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside the shared server folder');
  return { full, normalized };
}

async function assertNoSymlink(root, file) {
  const relative = path.relative(root, file);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('SFTP does not follow symbolic links');
    } catch (err) { if (err.code === 'ENOENT') break; throw err; }
  }
}

function attrsFor(stat) {
  return { mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
}

function statusFor(err) {
  if (err && err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err && err.code === 'EEXIST') return STATUS_CODE.FILE_ALREADY_EXISTS;
  if (err && ['EACCES', 'EPERM', 'EROFS'].includes(err.code)) return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function longName(name, stat) {
  const mode = stat.isDirectory() ? 'd' : '-';
  return `${mode}rwxr-xr-x 1 minecraft minecraft ${stat.size} Jan 01 00:00 ${name}`;
}

async function startSftpHost({ root, hostKeyPath, password, port = 2222, lanAccess = false, onChange = () => {} }) {
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(path.dirname(hostKeyPath), { recursive: true });
  let privateKey;
  try { privateKey = await fsp.readFile(hostKeyPath); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const keys = utils.generateKeyPairSync('ed25519');
    privateKey = Buffer.from(keys.private);
    await fsp.writeFile(hostKeyPath, privateKey, { mode: 0o600 });
  }
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const publicText = parsed.getPublicSSH();
  const publicBlob = Buffer.from(publicText.split(' ')[1], 'base64');
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`;
  const expected = crypto.createHash('sha256').update(password).digest();
  const clients = new Set();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (context.method !== 'password' || context.username !== 'minecraft') return context.reject();
      const actual = crypto.createHash('sha256').update(context.password).digest();
      return safeEqual(actual, expected) ? context.accept() : context.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let nextHandle = 1;
          const newHandle = (value) => {
            const id = nextHandle++;
            handles.set(id, value);
            const handle = Buffer.alloc(4); handle.writeUInt32BE(id, 0); return handle;
          };
          const getHandle = (handle) => handle && handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : null;
          const replyError = (reqid, err) => sftp.status(reqid, statusFor(err));
          const resolveSafe = async (remote) => {
            const item = jail(root, remote);
            await assertNoSymlink(root, item.full);
            return item;
          };
          const statReply = async (reqid, remote, follow = true) => {
            try {
              const { full } = await resolveSafe(remote);
              const stat = await (follow ? fsp.stat(full) : fsp.lstat(full));
              if (stat.isSymbolicLink()) throw Object.assign(new Error('Symlinks are not supported'), { code: 'EACCES' });
              sftp.attrs(reqid, attrsFor(stat));
            } catch (err) { replyError(reqid, err); }
          };
          sftp.on('REALPATH', async (reqid, remote) => {
            try {
              const { normalized, full } = await resolveSafe(remote);
              const stat = await fsp.stat(full);
              sftp.name(reqid, [{ filename: normalized, longname: longName(path.posix.basename(normalized) || '/', stat), attrs: attrsFor(stat) }]);
            } catch (err) { replyError(reqid, err); }
          }).on('STAT', (reqid, remote) => statReply(reqid, remote, true))
            .on('LSTAT', (reqid, remote) => statReply(reqid, remote, false))
            .on('FSTAT', async (reqid, handle) => {
              const item = getHandle(handle);
              if (!item || !item.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
              try { sftp.attrs(reqid, attrsFor(await item.file.stat())); } catch (err) { replyError(reqid, err); }
            }).on('OPENDIR', async (reqid, remote) => {
              try {
                const { full } = await resolveSafe(remote);
                const entries = (await fsp.readdir(full, { withFileTypes: true })).filter((entry) => entry.name !== '.selfhost' && entry.name !== 'selfhost.json');
                sftp.handle(reqid, newHandle({ directory: full, entries, cursor: 0 }));
              } catch (err) { replyError(reqid, err); }
            }).on('READDIR', async (reqid, handle) => {
              const item = getHandle(handle);
              if (!item || !item.entries) return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (item.cursor >= item.entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
              const entries = [];
              while (item.cursor < item.entries.length && entries.length < 100) {
                const entry = item.entries[item.cursor++];
                try {
                  const stat = await fsp.lstat(path.join(item.directory, entry.name));
                  if (stat.isSymbolicLink()) continue;
                  entries.push({ filename: entry.name, longname: longName(entry.name, stat), attrs: attrsFor(stat) });
                } catch {}
              }
              sftp.name(reqid, entries);
            }).on('OPEN', async (reqid, remote, mode) => {
              try {
                const { full } = await resolveSafe(remote);
                const read = Boolean(mode & OPEN_MODE.READ), write = Boolean(mode & OPEN_MODE.WRITE);
                let flags = read && write ? fs.constants.O_RDWR : write ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
                if (mode & OPEN_MODE.CREAT) flags |= fs.constants.O_CREAT;
                if (mode & OPEN_MODE.TRUNC) flags |= fs.constants.O_TRUNC;
                if (mode & OPEN_MODE.APPEND) flags |= fs.constants.O_APPEND;
                if (mode & OPEN_MODE.EXCL) flags |= fs.constants.O_EXCL;
                await fsp.mkdir(path.dirname(full), { recursive: true });
                const file = await fsp.open(full, flags, 0o600);
                sftp.handle(reqid, newHandle({ file, path: full, remote: jail(root, remote).normalized, writable: write }));
              } catch (err) { replyError(reqid, err); }
            }).on('READ', async (reqid, handle, offset, length) => {
              const item = getHandle(handle);
              if (!item || !item.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
              try {
                const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, length)));
                const result = await item.file.read(buffer, 0, buffer.length, Number(offset));
                if (!result.bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
                sftp.data(reqid, buffer.subarray(0, result.bytesRead));
              } catch (err) { replyError(reqid, err); }
            }).on('WRITE', async (reqid, handle, offset, data) => {
              const item = getHandle(handle);
              if (!item || !item.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
              try {
                let written = 0;
                while (written < data.length) {
                  const result = await item.file.write(data, written, data.length - written, Number(offset) + written);
                  if (!result.bytesWritten) throw new Error('Could not write SFTP data');
                  written += result.bytesWritten;
                }
                sftp.status(reqid, STATUS_CODE.OK);
              }
              catch (err) { replyError(reqid, err); }
            }).on('CLOSE', async (reqid, handle) => {
              const id = handle && handle.length === 4 ? handle.readUInt32BE(0) : -1;
              const item = handles.get(id);
              if (!item) return sftp.status(reqid, STATUS_CODE.FAILURE);
              handles.delete(id);
              try {
                if (item.file) await item.file.close();
                if (item.writable) await onChange('Uploaded or edited server file over SFTP', { path: item.remote });
                sftp.status(reqid, STATUS_CODE.OK);
              }
              catch (err) { replyError(reqid, err); }
            }).on('REMOVE', async (reqid, remote) => {
              try { const safe = await resolveSafe(remote); await fsp.unlink(safe.full); await onChange('Deleted server file over SFTP', { path: safe.normalized }); sftp.status(reqid, STATUS_CODE.OK); }
              catch (err) { replyError(reqid, err); }
            }).on('MKDIR', async (reqid, remote, attrs) => {
              try { const safe = await resolveSafe(remote); await fsp.mkdir(safe.full, { mode: attrs && attrs.mode ? attrs.mode & 0o777 : 0o755 }); await onChange('Created server folder over SFTP', { path: safe.normalized }); sftp.status(reqid, STATUS_CODE.OK); }
              catch (err) { replyError(reqid, err); }
            }).on('RMDIR', async (reqid, remote) => {
              try { const safe = await resolveSafe(remote); await fsp.rmdir(safe.full); await onChange('Removed server folder over SFTP', { path: safe.normalized }); sftp.status(reqid, STATUS_CODE.OK); }
              catch (err) { replyError(reqid, err); }
            }).on('RENAME', async (reqid, from, to) => {
              try { const source = await resolveSafe(from), target = await resolveSafe(to); await fsp.rename(source.full, target.full); await onChange('Renamed server file over SFTP', { from: source.normalized, to: target.normalized }); sftp.status(reqid, STATUS_CODE.OK); }
              catch (err) { replyError(reqid, err); }
            }).on('SETSTAT', async (reqid, remote, attrs) => {
              try {
                const { full } = await resolveSafe(remote);
                if (attrs.mode != null) await fsp.chmod(full, attrs.mode & 0o777);
                if (attrs.atime != null && attrs.mtime != null) await fsp.utimes(full, attrs.atime, attrs.mtime);
                sftp.status(reqid, STATUS_CODE.OK);
              } catch (err) { replyError(reqid, err); }
            }).on('FSETSTAT', async (reqid, handle, attrs) => {
              const item = getHandle(handle);
              if (!item || !item.file) return sftp.status(reqid, STATUS_CODE.FAILURE);
              try {
                if (attrs.mode != null) await item.file.chmod(attrs.mode & 0o777);
                if (attrs.atime != null && attrs.mtime != null) await fsp.utimes(item.path, attrs.atime, attrs.mtime);
                sftp.status(reqid, STATUS_CODE.OK);
              } catch (err) { replyError(reqid, err); }
            }).on('SYMLINK', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
            .on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
            .on('LINK', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
            .on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
          client.on('close', () => {
            for (const item of handles.values()) if (item.file) item.file.close().catch(() => {});
            handles.clear();
          });
        });
      });
    });
  });
  const host = lanAccess ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    port, host, fingerprint, username: 'minecraft', password,
    close: () => new Promise((resolve) => { for (const client of clients) client.destroy(); server.close(() => resolve()); }),
  };
}

module.exports = { startSftpHost };
