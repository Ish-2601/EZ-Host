// Reads the metadata inside mod jars (Fabric, Quilt, Forge, NeoForge) so the
// server can tell which mods depend on which, and what Java they need.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Some mods put raw newlines/tabs inside strings.
    return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
  }
}

function minJavaFromRange(range) {
  const ranges = Array.isArray(range) ? range : [range];
  let min = 0;
  for (const r of ranges) {
    const m = String(r).match(/>=?\s*(\d+)/);
    if (m) min = Math.max(min, Number(m[1]));
  }
  return min;
}

function fromFabric(json) {
  const ids = [json.id, ...(json.provides || [])].filter(Boolean);
  const depends = Object.keys(json.depends || {});
  return {
    ids,
    depends: depends.filter((d) => !['minecraft', 'java', 'fabricloader', 'fabric', 'quilt_loader'].includes(d)),
    javaMin: json.depends && json.depends.java ? minJavaFromRange(json.depends.java) : 0,
    name: json.name || json.id || null,
    version: json.version || null,
    description: typeof json.description === 'string' ? json.description : null,
    environment: json.environment || '*',
  };
}

function fromQuilt(json) {
  const loader = json.quilt_loader || {};
  const ids = [loader.id, ...(loader.provides || []).map((p) => (typeof p === 'string' ? p : p.id))].filter(Boolean);
  const depends = [];
  let javaMin = 0;
  for (const d of loader.depends || []) {
    const id = typeof d === 'string' ? d : d.id;
    if (!id || (typeof d === 'object' && d.optional)) continue;
    if (id === 'java') javaMin = Math.max(javaMin, minJavaFromRange(d.versions || ''));
    else if (!['minecraft', 'quilt_loader', 'fabricloader'].includes(id)) depends.push(id);
  }
  const meta = loader.metadata || {};
  const env = json.minecraft && json.minecraft.environment;
  return { ids, depends, javaMin, name: meta.name || loader.id || null, version: loader.version || null, description: meta.description || null, environment: env === 'client' ? 'client' : '*' };
}

/** Minimal parse of mods.toml / neoforge.mods.toml: mod ids and required, server-relevant dependencies. */
function fromModsToml(text) {
  const ids = [];
  const depends = [];
  let name = null;
  let version = null;
  let description = null;
  const blocks = text.split(/^\s*\[\[/m);
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf(']]'));
    const field = (name) => {
      const m = block.match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\r\\n#]+)["']?`, 'm'));
      return m ? m[1].trim() : null;
    };
    if (header === 'mods') {
      const id = field('modId');
      if (id) ids.push(id);
      if (!name) name = field('displayName');
      const v = field('version');
      if (!version && v && !v.includes('${')) version = v;
      const d = block.match(/^\s*description\s*=\s*'''([\s\S]*?)'''|^\s*description\s*=\s*"([^"]*)"/m);
      if (!description && d) description = (d[1] || d[2] || '').trim();
    } else if (header.startsWith('dependencies')) {
      const id = field('modId');
      const mandatory = field('mandatory');
      const type = field('type');
      const side = (field('side') || 'BOTH').toUpperCase();
      const required = type ? type.toLowerCase() === 'required' : mandatory === 'true';
      if (id && required && side !== 'CLIENT' && !['minecraft', 'forge', 'neoforge'].includes(id)) depends.push(id);
    }
  }
  return { ids, depends, javaMin: 0, name, version, description, environment: '*' };
}

/** { ids, depends, javaMin, name, version, description, environment } for a mod jar, or null if it has no metadata we understand. */
function readModInfo(jarPath) {
  let zip;
  try {
    zip = new AdmZip(jarPath);
  } catch {
    return null;
  }
  const text = (name) => {
    const entry = zip.getEntry(name);
    return entry ? entry.getData().toString('utf8') : null;
  };
  try {
    const fabric = text('fabric.mod.json');
    if (fabric) return fromFabric(parseJsonLoose(fabric));
    const quilt = text('quilt.mod.json');
    if (quilt) return fromQuilt(parseJsonLoose(quilt));
    const toml = text('META-INF/neoforge.mods.toml') || text('META-INF/mods.toml');
    if (toml) return fromModsToml(toml);
  } catch {
    // Broken metadata: treat as unknown.
  }
  return null;
}

/**
 * Remove client-only mods from a server's mods folder, except ones another
 * kept mod requires (removing those stops the server from starting).
 * `clientOnly(fileName)` says whether a jar was flagged as client-only.
 * Returns { removed: [fileName], kept: [fileName], javaMin }.
 */
function pruneClientOnlyMods(modsDir, clientOnly) {
  const jars = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')) : [];
  const info = new Map(jars.map((f) => [f, readModInfo(path.join(modsDir, f))]));
  const remove = new Set(jars.filter((f) => clientOnly(f)));
  const keptForDeps = [];

  // Put back any flagged mod that a remaining mod depends on, until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    const needed = new Set();
    for (const f of jars) {
      if (remove.has(f)) continue;
      const i = info.get(f);
      if (i) i.depends.forEach((d) => needed.add(d));
    }
    for (const f of [...remove]) {
      const i = info.get(f);
      if (i && i.ids.some((id) => needed.has(id))) {
        remove.delete(f);
        keptForDeps.push(f);
        changed = true;
      }
    }
  }

  for (const f of remove) fs.rmSync(path.join(modsDir, f), { force: true });
  let javaMin = 0;
  for (const f of jars) {
    if (remove.has(f)) continue;
    const i = info.get(f);
    if (i) javaMin = Math.max(javaMin, i.javaMin);
  }
  return { removed: [...remove], kept: keptForDeps, javaMin };
}

module.exports = { readModInfo, pruneClientOnlyMods };
