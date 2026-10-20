// Item pictures for the inventory view, built from the game's own files.
// The client jar of the server's Minecraft version (from the player's own
// .minecraft folder, or downloaded from Mojang into the app's cache) holds each
// item's model: flat sprites for tools and food, little 3D boxes for blocks.
// We resolve the model and hand the renderer exactly what it needs to draw the
// item the way the in-game inventory does. Nothing from the game is shipped
// with the app or committed to the repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { download } = require('./http');
const { getVersionInfo } = require('./minecraft');

const zips = new Map(); // version -> Promise<AdmZip|null>
const specs = new Map(); // "version|id" -> spec

function localJar(version) {
  const roots = [path.join(process.env.APPDATA || os.homedir(), '.minecraft'), path.join(os.homedir(), '.minecraft')];
  for (const root of roots) {
    const file = path.join(root, 'versions', version, `${version}.jar`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** The client jar for a version: the player's own, else a cached download from Mojang. */
function clientZip(version, cacheDir) {
  if (!zips.has(version)) {
    zips.set(version, (async () => {
      try {
        let file = localJar(version);
        if (!file) {
          const info = await getVersionInfo(version);
          const client = info.downloads && info.downloads.client;
          if (!client) return null;
          const dir = path.join(cacheDir, 'clients');
          fs.mkdirSync(dir, { recursive: true });
          file = path.join(dir, `${version}.jar`);
          if (!fs.existsSync(file)) await download(client.url, file, { hashes: { sha1: client.sha1 } });
        }
        return new AdmZip(file);
      } catch {
        zips.delete(version); // try again next time (offline, version unknown)
        return null;
      }
    })());
  }
  return zips.get(version);
}

const readJson = (zip, name) => {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  try {
    return JSON.parse(entry.getData().toString('utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

const split = (ref, fallbackNs = 'minecraft') => {
  const i = ref.indexOf(':');
  return i < 0 ? [fallbackNs, ref] : [ref.slice(0, i), ref.slice(i + 1)];
};

/** Which model an item uses. 1.21.4+ has items/<id>.json (with conditions); older versions use models/item/<id>.json. */
function modelRefFor(zip, id) {
  const [ns, name] = split(id);
  const def = readJson(zip, `assets/${ns}/items/${name}.json`);
  if (def) {
    const pick = (node, depth = 0) => {
      if (!node || depth > 8) return null;
      if (typeof node === 'string') return node;
      // Special models (chests, beds, banners) are drawn from entity code; their base model is what we can use.
      if (node.type === 'minecraft:special') return node.base || null;
      if (node.model && typeof node.model === 'string') return node.model;
      if (node.model && typeof node.model === 'object') return pick(node.model, depth + 1);
      switch (node.type && node.type.replace('minecraft:', '')) {
        case 'condition': return pick(node.on_false, depth + 1);
        case 'select': return pick(node.fallback || (node.cases && node.cases[0] && node.cases[0].model), depth + 1);
        case 'range_dispatch': return pick(node.fallback || (node.entries && node.entries[0] && node.entries[0].model), depth + 1);
        case 'composite': return pick(node.models && node.models[0], depth + 1);
        case 'special': return node.base || null;
        default: return null;
      }
    };
    const ref = pick(def.model || def);
    if (ref) return ref;
  }
  if (zip.getEntry(`assets/${ns}/models/item/${name}.json`)) return `${ns}:item/${name}`;
  if (zip.getEntry(`assets/${ns}/models/block/${name}.json`)) return `${ns}:block/${name}`;
  return null;
}

/** A model with its parents merged: { textures, elements, generated, entity }. */
function resolveModel(zip, ref) {
  const out = { textures: {}, elements: null, generated: false, entity: false };
  const chain = [];
  let cur = ref;
  for (let depth = 0; cur && depth < 12; depth++) {
    const [ns, name] = split(cur);
    if (name === 'builtin/generated') { out.generated = true; break; }
    if (name === 'builtin/entity') { out.entity = true; break; }
    const model = readJson(zip, `assets/${ns}/models/${name}.json`);
    if (!model) break;
    chain.push(model);
    cur = model.parent;
  }
  for (const model of chain.reverse()) {
    Object.assign(out.textures, model.textures || {});
    if (model.elements) out.elements = model.elements;
  }
  return out;
}

function textureRef(textures, value, depth = 0) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('#')) return value;
  if (depth > 10) return null;
  return textureRef(textures, textures[value.slice(1)], depth + 1);
}

function textureUrl(zip, ref) {
  const [ns, name] = split(ref);
  const entry = zip.getEntry(`assets/${ns}/textures/${name}.png`);
  return entry ? `data:image/png;base64,${entry.getData().toString('base64')}` : null;
}

/**
 * What the renderer needs to draw an item, or null when we have no picture:
 *   { type: 'flat', layers: [dataUrl] }
 *   { type: 'boxes', boxes: [{ from, to, faces: { up|north|west: { texture, uv, tint } } }], textures: { name: dataUrl } }
 */
function buildSpec(zip, id) {
  const ref = modelRefFor(zip, id);
  if (!ref) return null;
  const model = resolveModel(zip, ref);

  if (model.generated) {
    const layers = [];
    for (let i = 0; i < 5; i++) {
      const t = textureRef(model.textures, model.textures[`layer${i}`]);
      const url = t && textureUrl(zip, t);
      if (url) layers.push(url);
    }
    return layers.length ? { type: 'flat', layers } : null;
  }

  let elements = model.elements;
  if (!elements) {
    // Chests, beds, banners and shulker boxes are drawn from entity models in game;
    // show a plain box with the block's particle texture instead.
    let particle = textureRef(model.textures, model.textures.particle);
    if (!particle) {
      const [ns, name] = split(id);
      const block = resolveModel(zip, `${ns}:block/${name}`);
      particle = textureRef(block.textures, block.textures.particle);
    }
    if (!particle) return null;
    elements = [{ from: [1, 0, 1], to: [15, 14, 15], faces: { up: { texture: '#particle' }, north: { texture: '#particle' }, west: { texture: '#particle' } } }];
    model.textures = { ...model.textures, particle };
  }
  if (!elements) return null;

  const textures = {};
  const boxes = [];
  for (const el of elements) {
    if (!el.from || !el.to) continue;
    const faces = {};
    for (const side of ['up', 'north', 'west']) {
      const f = el.faces && el.faces[side];
      if (!f) continue;
      const tex = textureRef(model.textures, f.texture);
      if (!tex) continue;
      if (!(tex in textures)) {
        const url = textureUrl(zip, tex);
        if (!url) continue;
        textures[tex] = url;
      }
      faces[side] = { texture: tex, uv: f.uv || null, tint: f.tintindex !== undefined, rotation: f.rotation || 0 };
    }
    if (Object.keys(faces).length) boxes.push({ from: el.from, to: el.to, faces });
  }
  return boxes.length ? { type: 'boxes', boxes, textures } : null;
}

const modPacks = new Map(); // mods folder -> { at, byNamespace: Map<namespace, AdmZip[]> }

/** Which mod jars carry assets for which namespace, for one server's mods folder (indexed once, refreshed every 5 minutes). */
async function modIndex(modsDir) {
  const cached = modPacks.get(modsDir);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.byNamespace;
  if (indexing.has(modsDir)) return indexing.get(modsDir);
  const job = buildModIndex(modsDir).finally(() => indexing.delete(modsDir));
  indexing.set(modsDir, job);
  return job;
}

const indexing = new Map();

/** Reads the jars one at a time, yielding between them so the app stays responsive. */
async function buildModIndex(modsDir) {
  const byNamespace = new Map();
  let files = [];
  try {
    files = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar'));
  } catch {
    // no mods folder (vanilla server)
  }
  for (const f of files) {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      const zip = new AdmZip(path.join(modsDir, f));
      const namespaces = new Set();
      for (const e of zip.getEntries()) {
        const m = e.entryName.match(/^assets\/([a-z0-9_.-]+)\/(models|textures)\//);
        if (m) namespaces.add(m[1]);
      }
      for (const ns of namespaces) {
        if (ns === 'minecraft') continue;
        if (!byNamespace.has(ns)) byNamespace.set(ns, []);
        byNamespace.get(ns).push(zip);
      }
    } catch {
      // unreadable jar: skip it
    }
  }
  modPacks.set(modsDir, { at: Date.now(), byNamespace });
  return byNamespace;
}

/** The game plus the mods that own this item's namespace, looked up like one resource pack (mods first). */
async function packFor(zip, id, modsDir) {
  const ns = id.includes(':') ? id.split(':')[0] : 'minecraft';
  if (ns === 'minecraft' || !modsDir) return zip;
  const mods = (await modIndex(modsDir)).get(ns) || [];
  if (!mods.length) return null;
  return {
    getEntry: (name) => {
      for (const z of [...mods, zip]) {
        const e = z.getEntry(name);
        if (e) return e;
      }
      return null;
    },
  };
}

/** The picture spec for one item id on one Minecraft version (cached). modsDir lets modded items be drawn from the mods' own files. */
async function itemArt(version, id, cacheDir, modsDir = null) {
  if (!/^[a-z0-9_.-]+(:[a-z0-9_./-]+)?$/i.test(String(id || '')) || !/^[A-Za-z0-9_.-]+$/.test(String(version || ''))) return null;
  const key = `${version}|${id}|${id.startsWith('minecraft:') || !id.includes(':') ? '' : modsDir}`;
  if (specs.has(key)) return specs.get(key);
  const zip = await clientZip(version, cacheDir);
  if (!zip) return null; // not cached: no client yet, so ask again later
  let spec = null;
  try {
    const full = id.includes(':') ? id : `minecraft:${id}`;
    const pack = await packFor(zip, full, modsDir);
    spec = pack ? buildSpec(pack, full) : null;
  } catch {
    spec = null;
  }
  specs.set(key, spec);
  return spec;
}

module.exports = { itemArt };
