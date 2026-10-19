// World map: region tiles rendered from the save, cached on disk, plus helpers
// for player positions and force-loaded chunks.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');

const DIMENSIONS = [
  { id: 'minecraft:overworld', label: 'Overworld', legacy: 'region' },
  { id: 'minecraft:the_nether', label: 'Nether', legacy: path.join('DIM-1', 'region') },
  { id: 'minecraft:the_end', label: 'The End', legacy: path.join('DIM1', 'region') },
];

/** Where a dimension's region files live (newer versions use dimensions/<ns>/<name>/region). */
function regionDir(world, dimId) {
  const [ns, name] = dimId.split(':');
  const modern = path.join(world, 'dimensions', ns, name, 'region');
  const known = DIMENSIONS.find((d) => d.id === dimId);
  const candidates = [modern, known ? path.join(world, known.legacy) : null].filter(Boolean);
  let best = null;
  let bestCount = -1;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const count = fs.readdirSync(dir).filter((f) => f.endsWith('.mca')).length;
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

/** Dimensions that have any region files, including modded ones. */
function listDimensions(world) {
  const found = [];
  for (const d of DIMENSIONS) if (regionDir(world, d.id)) found.push({ id: d.id, label: d.label });
  const dimsRoot = path.join(world, 'dimensions');
  if (fs.existsSync(dimsRoot)) {
    for (const ns of fs.readdirSync(dimsRoot)) {
      const nsDir = path.join(dimsRoot, ns);
      if (!fs.statSync(nsDir).isDirectory()) continue;
      for (const name of fs.readdirSync(nsDir)) {
        const id = `${ns}:${name}`;
        if (found.some((f) => f.id === id)) continue;
        if (fs.existsSync(path.join(nsDir, name, 'region'))) {
          found.push({ id, label: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) });
        }
      }
    }
  }
  return found;
}

class MapRenderer {
  constructor() {
    this.worker = null;
    this.jobs = new Map();
    this.nextJob = 1;
    this.inflight = new Map(); // cache file -> promise, so one tile renders once at a time
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    // Packaged builds unpack this file next to app.asar so a worker can load it.
    const file = path.join(__dirname, 'map-worker.js').replace('app.asar', 'app.asar.unpacked');
    this.worker = new Worker(file);
    this.worker.on('message', ({ jobId, ...result }) => {
      const job = this.jobs.get(jobId);
      if (!job) return;
      this.jobs.delete(jobId);
      // Let the app exit while the worker is idle.
      if (!this.jobs.size) this.worker.unref();
      if (result.error) job.reject(new Error(result.error));
      else job.resolve(result);
    });
    this.worker.on('error', (err) => {
      for (const job of this.jobs.values()) job.reject(err);
      this.jobs.clear();
      this.worker = null;
    });
    return this.worker;
  }

  render(file) {
    return new Promise((resolve, reject) => {
      const jobId = this.nextJob++;
      this.jobs.set(jobId, { resolve, reject });
      const worker = this.ensureWorker();
      worker.ref();
      worker.postMessage({ jobId, file });
    });
  }

  /**
   * One region tile as { png (data URL), chunks (base64 bitmap of 1024 chunks) },
   * re-rendered only when the region file changed since the cached copy.
   */
  async tile(regionFile, cacheDir) {
    const base = path.join(cacheDir, path.basename(regionFile, '.mca'));
    const pngFile = `${base}.png`;
    const chunkFile = `${base}.chunks`;
    const regionTime = fs.statSync(regionFile).mtimeMs;
    if (fs.existsSync(pngFile) && fs.existsSync(chunkFile) && fs.statSync(pngFile).mtimeMs >= regionTime) {
      return { png: `data:image/png;base64,${fs.readFileSync(pngFile).toString('base64')}`, chunks: fs.readFileSync(chunkFile).toString('base64') };
    }
    if (!this.inflight.has(pngFile)) {
      this.inflight.set(
        pngFile,
        (async () => {
          const { png, chunks } = await this.render(regionFile);
          await fsp.mkdir(cacheDir, { recursive: true });
          await fsp.writeFile(pngFile, Buffer.from(png));
          await fsp.writeFile(chunkFile, Buffer.from(chunks));
        })().finally(() => this.inflight.delete(pngFile))
      );
    }
    await this.inflight.get(pngFile);
    return { png: `data:image/png;base64,${fs.readFileSync(pngFile).toString('base64')}`, chunks: fs.readFileSync(chunkFile).toString('base64') };
  }
}

/** Parse "[x, z]" or "x, z" chunk pairs out of /forceload query output. */
function parseForceloadQuery(text) {
  const out = [];
  const re = /\[?(-?\d+),\s*(-?\d+)\]?/g;
  const listPart = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
  let m;
  while ((m = re.exec(listPart))) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

module.exports = { DIMENSIONS, regionDir, listDimensions, MapRenderer, parseForceloadQuery };
