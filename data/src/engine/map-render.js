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

// Biome colors, close to the ones seed-map sites use.
const BIOMES = {
  ocean: [0, 0, 112], deep_ocean: [0, 0, 48], warm_ocean: [0, 0, 172], lukewarm_ocean: [0, 0, 144],
  deep_lukewarm_ocean: [0, 0, 64], cold_ocean: [32, 32, 112], deep_cold_ocean: [32, 32, 56],
  frozen_ocean: [112, 112, 214], deep_frozen_ocean: [64, 64, 144], river: [0, 0, 255], frozen_river: [160, 160, 255],
  plains: [141, 179, 96], sunflower_plains: [181, 219, 136], snowy_plains: [255, 255, 255], ice_spikes: [180, 220, 220],
  desert: [250, 148, 24], swamp: [7, 249, 178], mangrove_swamp: [44, 204, 142],
  forest: [5, 102, 33], flower_forest: [45, 142, 73], birch_forest: [48, 116, 68], old_growth_birch_forest: [88, 156, 108],
  dark_forest: [64, 81, 26], taiga: [11, 102, 89], snowy_taiga: [49, 85, 74], old_growth_pine_taiga: [89, 102, 81],
  old_growth_spruce_taiga: [129, 142, 121], jungle: [83, 123, 9], sparse_jungle: [98, 139, 23], bamboo_jungle: [118, 142, 20],
  savanna: [189, 178, 95], savanna_plateau: [167, 157, 100], windswept_savanna: [229, 218, 135],
  badlands: [217, 69, 21], eroded_badlands: [255, 109, 61], wooded_badlands: [176, 151, 101],
  windswept_hills: [96, 96, 96], windswept_gravelly_hills: [136, 136, 136], windswept_forest: [80, 112, 80],
  meadow: [96, 164, 69], cherry_grove: [255, 145, 200], grove: [71, 114, 108], snowy_slopes: [196, 196, 196],
  frozen_peaks: [160, 160, 160], jagged_peaks: [220, 220, 200], stony_peaks: [123, 143, 116],
  beach: [250, 222, 85], snowy_beach: [250, 240, 192], stony_shore: [162, 162, 132], mushroom_fields: [255, 0, 255],
  dripstone_caves: [134, 96, 67], lush_caves: [40, 120, 40], deep_dark: [10, 20, 30], pale_garden: [180, 190, 180],
  nether_wastes: [191, 59, 59], soul_sand_valley: [94, 56, 48], crimson_forest: [221, 8, 8], warped_forest: [73, 144, 123],
  basalt_deltas: [64, 54, 54], the_end: [128, 128, 255], end_highlands: [181, 181, 54], end_midlands: [255, 255, 128],
  small_end_islands: [144, 144, 255], end_barrens: [112, 112, 204], the_void: [0, 0, 0],
};
const BIOME_KEYWORDS = [
  ['deep', [0, 0, 64]], ['ocean', [0, 0, 112]], ['sea', [0, 0, 112]], ['river', [0, 0, 255]], ['beach', [250, 222, 85]],
  ['desert', [250, 148, 24]], ['dune', [250, 148, 24]], ['badlands', [217, 69, 21]], ['mesa', [217, 69, 21]],
  ['savanna', [189, 178, 95]], ['jungle', [83, 123, 9]], ['swamp', [7, 249, 178]], ['marsh', [7, 249, 178]],
  ['bog', [7, 249, 178]], ['taiga', [11, 102, 89]], ['tundra', [196, 214, 214]], ['snow', [240, 240, 240]],
  ['frozen', [200, 220, 240]], ['ice', [180, 220, 220]], ['glacier', [180, 220, 220]], ['mountain', [123, 143, 116]],
  ['peak', [160, 160, 160]], ['alp', [160, 160, 160]], ['hill', [96, 120, 80]], ['highland', [110, 130, 90]],
  ['forest', [5, 102, 33]], ['wood', [5, 102, 33]], ['grove', [71, 114, 108]], ['plain', [141, 179, 96]],
  ['meadow', [96, 164, 69]], ['prairie', [160, 190, 100]], ['steppe', [170, 180, 110]], ['field', [141, 179, 96]],
  ['shrub', [150, 160, 90]], ['cherry', [255, 145, 200]], ['mushroom', [255, 0, 255]], ['cave', [90, 90, 90]],
  ['nether', [191, 59, 59]], ['crimson', [221, 8, 8]], ['warped', [73, 144, 123]], ['end', [128, 128, 255]],
];
const biomeCache = new Map();
function biomeColor(name) {
  let c = biomeCache.get(name);
  if (c) return c;
  const short = name.slice(name.indexOf(':') + 1);
  c = BIOMES[short];
  if (!c) {
    const kw = BIOME_KEYWORDS.find(([k]) => short.includes(k));
    c = kw ? kw[1] : null;
  }
  if (!c) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    c = [70 + (h & 127), 70 + ((h >> 7) & 127), 70 + ((h >> 14) & 127)];
  }
  biomeCache.set(name, c);
  return c;
}

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

/** Structures that start in this chunk: [{ id, cx, cz }]. */
function chunkStructures(root) {
  const c = root.value;
  const starts = child(child(c, 'structures'), 'starts') || child(child(c, 'Structures'), 'Starts');
  if (!starts) return [];
  const out = [];
  for (const [key, node] of Object.entries(starts)) {
    const v = node.value;
    const id = child(v, 'id') || key;
    if (id === 'INVALID') continue;
    out.push({ id: key, cx: child(v, 'ChunkX') ?? child(c, 'xPos'), cz: child(v, 'ChunkZ') ?? child(c, 'zPos') });
  }
  return out;
}

/** Biome name for each of the 16 4x4 columns of a chunk, near the surface (or sea level). */
function chunkBiomes(root, ys) {
  const c = root.value;
  const sectionsTag = child(c, 'sections');
  if (!sectionsTag) return null;
  const sections = new Map();
  for (const sec of sectionsTag.items) {
    const biomes = child(sec, 'biomes');
    const y = child(sec, 'Y');
    if (!biomes || y === undefined) continue;
    const palette = child(biomes, 'palette');
    if (!palette) continue;
    sections.set(y, { palette: palette.items, data: child(biomes, 'data') || null, decoded: null });
  }
  if (!sections.size) return null;
  const out = new Array(16);
  for (let q = 0; q < 16; q++) {
    const qx = q & 3;
    const qz = q >> 2;
    const surface = ys ? ys[(qz * 4 + 1) * 16 + qx * 4 + 1] : 63;
    const y = surface > -2000 ? surface : 63;
    const sec = sections.get(Math.floor(y / 16)) || sections.get(3) || sections.values().next().value;
    let idx = 0;
    if (sec.palette.length > 1 && sec.data) {
      if (!sec.decoded) sec.decoded = unpack(sec.data, Math.ceil(Math.log2(sec.palette.length)), 64);
      const qy = (y & 15) >> 2;
      idx = sec.decoded[(qy << 4) | (qz << 2) | qx];
    }
    out[q] = sec.palette[idx] || sec.palette[0];
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
function renderRegion(file, mode = 'terrain') {
  const buf = fs.readFileSync(file);
  const rgba = new Uint8ClampedArray(512 * 512 * 4);
  const chunks = new Uint8Array(1024);
  const structures = [];
  const heightGrid = new Int16Array(512 * 512).fill(-32768);
  if (buf.length < 8192) return { rgba, chunks, structures };

  for (let i = 0; i < 1024; i++) {
    const sector = buf.readUIntBE(i * 4, 3);
    if (!sector) continue;
    chunks[i] = 1;
    const off = sector * 4096;
    if (off + 5 > buf.length) continue;
    const len = buf.readUInt32BE(off);
    const comp = buf[off + 4];
    let top = null;
    let biomes = null;
    try {
      const raw = buf.subarray(off + 5, off + 4 + len);
      const data = comp === 2 ? zlib.inflateSync(raw) : comp === 1 ? zlib.gunzipSync(raw) : comp === 3 ? raw : null;
      if (data) {
        const root = readNbt(data);
        top = chunkTop(root);
        structures.push(...chunkStructures(root));
        if (mode === 'biomes') biomes = chunkBiomes(root, top && top.ys);
      }
    } catch {
      top = null;
    }
    const cx = (i & 31) * 16;
    const cz = (i >> 5) * 16;
    if (mode === 'biomes' && biomes) {
      // Biome colors; heights (when known) still feed the relief shading below.
      for (let b = 0; b < 256; b++) {
        const px = cx + (b & 15);
        const pz = cz + (b >> 4);
        const p = (pz * 512 + px) * 4;
        const [r, g, bl] = biomeColor(biomes[((b >> 6) << 2) | ((b & 15) >> 2)]);
        rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = bl; rgba[p + 3] = 255;
        if (top) heightGrid[pz * 512 + px] = top.ys[b];
      }
      continue;
    }
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
  return { rgba, chunks, structures };
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

module.exports = { renderRegion, encodePng, blockColor, biomeColor, T };
