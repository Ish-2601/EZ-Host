// Small HTTP helpers on top of Node's built-in fetch: JSON requests,
// streamed downloads with progress, and hash verification.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'Ish-2601/EZ-Host/0.2.2 (github.com/Ish-2601/EZ-Host)';

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status} ${res.statusText}): ${url}`);
  }
  return res;
}

async function getJson(url) {
  const res = await request(url);
  return res.json();
}

async function getText(url) {
  const res = await request(url);
  return res.text();
}

/**
 * Download `url` to `dest`. Writes to a temp file first and renames on
 * success so a half-finished download never looks complete.
 * `hashes` maps algorithm names (sha1, sha256, sha512) to expected hex digests.
 */
async function download(url, dest, { hashes = {}, onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await request(url);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;

  // Only hash with the algorithms we were given an expected digest for.
  const hashers = Object.entries(hashes)
    .filter(([, expected]) => expected)
    .map(([algo, expected]) => ({ algo, expected: expected.toLowerCase(), hash: crypto.createHash(algo) }));
  let received = 0;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    for (const h of hashers) h.hash.update(chunk);
    if (onProgress) onProgress(received, total);
  });

  try {
    await pipeline(body, fs.createWriteStream(tmp));
    for (const h of hashers) {
      if (h.hash.digest('hex') !== h.expected) {
        throw new Error(`${h.algo} checksum mismatch for ${url}`);
      }
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Hash an existing file so we can skip re-downloading it. */
async function fileHash(file, algo) {
  const hash = crypto.createHash(algo);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Run async `worker` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = { USER_AGENT, request, getJson, getText, download, fileHash, mapLimit };
