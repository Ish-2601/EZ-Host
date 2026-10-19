// Renders one region file (32x32 chunks) to a 512x512 top-down image, one
// pixel per block, colored by the highest block. Runs in a worker thread
// (see world-map.js) because decoding thousands of chunks takes a while.
const fs = require('fs');
const zlib = require('zlib');
const { readNbt, T } = require('./nbt');

// Colors for common surface blocks; anything else falls back to keyword
// matching and then to a color derived from the block's name.
const EXACT = {
  'minecraft:grass_block': [96, 156, 64],
  'minecraft:water': [52, 92, 196],
  'minecraft:bubble_column': [52, 92, 196],
  'minecraft:ice': [150, 180, 240],
  'minecraft:packed_ice': [140, 170, 235],
  'minecraft:blue_ice': [120, 160, 235],
  'minecraft:snow': [240, 244, 250],
  'minecraft:snow_block': [240, 244, 250],
  'minecraft:powder_snow': [235, 240, 248],
  'minecraft:sand': [219, 207, 163],
  'minecraft:red_sand': [190, 102, 33],
  'minecraft:sandstone': [216, 203, 155],
  'minecraft:gravel': [136, 126, 126],
  'minecraft:clay': [160, 166, 179],
  'minecraft:lava': [207, 92, 15],
  'minecraft:netherrack': [111, 54, 52],
  'minecraft:soul_sand': [84, 64, 51],
  'minecraft:soul_soil': [75, 57, 46],
  'minecraft:basalt': [80, 80, 86],
  'minecraft:blackstone': [42, 36, 41],
  'minecraft:crimson_nylium': [130, 31, 31],
  'minecraft:warped_nylium': [43, 114, 101],
  'minecraft:end_stone': [219, 222, 158],
  'minecraft:obsidian': [20, 18, 30],
  'minecraft:bedrock': [85, 85, 85],
  'minecraft:mycelium': [111, 99, 105],
  'minecraft:podzol': [91, 63, 24],
  'minecraft:mud': [60, 57, 60],
  'minecraft:moss_block': [89, 109, 45],
  'minecraft:short_grass': [96, 156, 64],
  'minecraft:tall_grass': [96, 156, 64],
  'minecraft:fern': [86, 140, 60],
  'minecraft:lily_pad': [32, 128, 48],
  'minecraft:seagrass': [52, 92, 196],
  'minecraft:kelp': [52, 92, 196],
  'minecraft:kelp_plant': [52, 92, 196],
};

const KEYWORDS = [
  ['leaves', [58, 105, 40]],
  ['water', [52, 92, 196]],
  ['log', [102, 81, 51]],
  ['wood', [102, 81, 51]],
  ['planks', [162, 130, 78]],
  ['stairs', [140, 120, 90]],
  ['slab', [140, 120, 90]],
  ['deepslate', [80, 80, 82]],
  ['stone', [125, 125, 125]],
  ['andesite', [136, 136, 137]],
  ['diorite', [188, 188, 188]],
  ['granite', [149, 103, 85]],
  ['cobble', [118, 118, 118]],
  ['tuff', [108, 109, 102]],
  ['calcite', [223, 224, 220]],
  ['dirt', [134, 96, 67]],
  ['farmland', [110, 75, 45]],
  ['path', [148, 122, 65]],
  ['terracotta', [152, 94, 67]],
  ['concrete', [150, 150, 150]],
  ['wool', [200, 200, 200]],
  ['glass', [175, 210, 220]],
  ['snow', [240, 244, 250]],
  ['ice', [150, 180, 240]],
  ['sand', [219, 207, 163]],
  ['flower', [180, 160, 60]],
  ['tulip', [190, 90, 90]],
  ['rose', [190, 50, 50]],
  ['mushroom', [150, 110, 90]],
  ['cactus', [80, 128, 40]],
  ['bamboo', [100, 150, 50]],
  ['vine', [58, 105, 40]],
  ['coral', [200, 90, 150]],
  ['brick', [150, 90, 70]],
  ['iron', [200, 200, 200]],
  ['copper', [190, 110, 80]],
  ['nether', [111, 54, 52]],
  ['crimson', [130, 31, 31]],
  ['warped', [43, 114, 101]],
  ['end_', [219, 222, 158]],
  ['purpur', [169, 125, 169]],
];

const colorCache = new Map();
function blockColor(name) {
  let c = colorCache.get(name);
  if (c) return c;
  c = EXACT[name];
  if (!c) {
    const short = name.slice(name.indexOf(':') + 1);
    const kw = KEYWORDS.find(([k]) => short.includes(k));
    if (kw) c = kw[1];
  }
  if (!c) {
    // Stable, muted color from the name so modded blocks still look distinct.
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    c = [90 + (h & 63), 90 + ((h >> 6) & 63), 90 + ((h >> 12) & 63)];
  }
  colorCache.set(name, c);
  return c;
}

// ---------- chunk decoding (1.18+ format) ----------

const child = (compound, key) => (compound && compound[key] ? compound[key].value : undefined);

/** Unpack `count` values of `bits` bits from 64-bit longs (no value spans two longs). */
function unpack(longs, bits, count) {
  const out = new Uint16Array(count);
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const long = longs[Math.floor(i / perLong)];
    if (long === undefined) break;
    out[i] = Number((BigInt.asUintN(64, long) >> BigInt((i % perLong) * bits)) & mask);
  }
  return out;
}

/** 16x16 top block names and heights for one chunk, or null if it is not ready. */
function chunkTop(root) {
  const c = root.value;
  const status = child(c, 'Status');
  if (status && !/(full|light|spawn|initialize_light|heightmaps)/.test(status)) return null;
  const heightmaps = child(c, 'Heightmaps');
  const surface = child(heightmaps, 'WORLD_SURFACE') || child(heightmaps, 'MOTION_BLOCKING');
  const sectionsTag = child(c, 'sections');
  if (!surface || !sectionsTag) return null;
  const minY = (child(c, 'yPos') ?? -4) * 16;
  const heights = unpack(surface, 9, 256);

  const sections = new Map();
  for (const sec of sectionsTag.items) {
    const y = child(sec, 'Y');
    const states = child(sec, 'block_states');
    if (y === undefined || !states) continue;
    const palette = child(states, 'palette');
    if (!palette) continue;
    sections.set(y, { palette: palette.items.map((p) => child(p, 'Name')), data: child(states, 'data') || null, decoded: null });
  }

  const names = new Array(256);
  const ys = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let y = heights[i] - 1 + minY;
    ys[i] = y;
    const x = i & 15;
    const z = i >> 4;
    // Step down past air in case the heightmap is slightly out of date.
    for (let tries = 0; tries < 4; tries++) {
      const sec = sections.get(Math.floor(y / 16));
      if (!sec) break;
      let idx = 0;
      if (sec.palette.length > 1 && sec.data) {
        if (!sec.decoded) {
          const bits = Math.max(4, Math.ceil(Math.log2(sec.palette.length)));
          sec.decoded = unpack(sec.data, bits, 4096);
        }
        idx = sec.decoded[((y & 15) << 8) | (z << 4) | x];
      }
      const name = sec.palette[idx] || 'minecraft:air';
      if (!name.endsWith(':air') && !name.endsWith('_air')) {
        names[i] = name;
        break;
      }
      y -= 1;
      ys[i] = y;
    }
  }
  return { names, ys };
}

/**
 * Render a region file. Returns { rgba (512*512*4), chunks: Uint8Array(1024) }
 * where chunks[i] is 1 for every chunk that exists in the file.
 */
function renderRegion(file) {
  const buf = fs.readFileSync(file);
  const rgba = new Uint8ClampedArray(512 * 512 * 4);
  const chunks = new Uint8Array(1024);
  const heightGrid = new Int16Array(512 * 512).fill(-32768);
  if (buf.length < 8192) return { rgba, chunks };

  for (let i = 0; i < 1024; i++) {
    const sector = buf.readUIntBE(i * 4, 3);
    if (!sector) continue;
    chunks[i] = 1;
    const off = sector * 4096;
    if (off + 5 > buf.length) continue;
    const len = buf.readUInt32BE(off);
    const comp = buf[off + 4];
    let top = null;
    try {
      const raw = buf.subarray(off + 5, off + 4 + len);
      const data = comp === 2 ? zlib.inflateSync(raw) : comp === 1 ? zlib.gunzipSync(raw) : comp === 3 ? raw : null;
      if (data) top = chunkTop(readNbt(data));
    } catch {
      top = null;
    }
    const cx = (i & 31) * 16;
    const cz = (i >> 5) * 16;
    for (let b = 0; b < 256; b++) {
      const px = cx + (b & 15);
      const pz = cz + (b >> 4);
      const p = (pz * 512 + px) * 4;
      if (!top || !top.names[b]) {
        // Generated but not finished, or unreadable: show it as explored ground.
        rgba[p] = 70; rgba[p + 1] = 76; rgba[p + 2] = 70; rgba[p + 3] = 255;
        continue;
      }
      const [r, g, bl] = blockColor(top.names[b]);
      rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = bl; rgba[p + 3] = 255;
      heightGrid[pz * 512 + px] = top.ys[b];
    }
  }

  // Simple relief shading: lighter where the ground rises to the north-west.
  for (let z = 1; z < 512; z++) {
    for (let x = 1; x < 512; x++) {
      const h = heightGrid[z * 512 + x];
      const n = heightGrid[(z - 1) * 512 + x];
      if (h === -32768 || n === -32768) continue;
      const shade = h > n ? 1.12 : h < n ? 0.86 : 1;
      if (shade === 1) continue;
      const p = (z * 512 + x) * 4;
      rgba[p] *= shade; rgba[p + 1] *= shade; rgba[p + 2] *= shade;
    }
  }
  return { rgba, chunks };
}

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { renderRegion, encodePng, blockColor, T };
