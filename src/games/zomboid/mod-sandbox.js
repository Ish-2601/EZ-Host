// World rules that mods add: each mod's media/sandbox-options.txt, with names,
// descriptions and dropdown choices from its English translation files.
const fs = require('fs');
const path = require('path');

/** Sandbox_* names from Translate/EN/Sandbox.json (Build 42) or Sandbox_EN.txt (Build 41). */
function readSandboxTranslations(mediaDir, out) {
  const dir = path.join(mediaDir, 'lua', 'shared', 'Translate', 'EN');
  try {
    const json = path.join(dir, 'Sandbox.json');
    if (fs.existsSync(json)) {
      // Mod authors often leave trailing commas; strip them before parsing.
      const text = fs.readFileSync(json, 'utf8').replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1');
      for (const [k, v] of Object.entries(JSON.parse(text))) if (typeof v === 'string' && !out.has(k)) out.set(k, v.trim());
    }
  } catch {
    // broken JSON: fall back to the .txt file or raw names
  }
  try {
    const txt = path.join(dir, 'Sandbox_EN.txt');
    if (fs.existsSync(txt)) {
      for (const m of fs.readFileSync(txt, 'latin1').matchAll(/(Sandbox_[A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) if (!out.has(m[1])) out.set(m[1], m[2].trim());
    }
  } catch {
    // unreadable
  }
}

function parseOptions(text) {
  const options = [];
  for (const m of text.matchAll(/option\s+([A-Za-z0-9_.]+)\s*\{([^}]*)\}/g)) {
    const props = {};
    for (const p of m[2].matchAll(/([A-Za-z]+)\s*=\s*([^,\r\n]*)/g)) props[p[1]] = p[2].trim();
    options.push({ name: m[1], ...props });
  }
  return options;
}

function mediaDirs(modDir) {
  const dirs = [path.join(modDir, 'media')];
  if (/^\d+(\.\d+)*$/.test(path.basename(modDir))) dirs.push(path.join(path.dirname(modDir), 'common', 'media'));
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * Fields in the same shape as sandbox.js, for `mods` ([{ id, name, dir }]):
 * { path, group, key, type, value (the default), label, help, choices?, min?, max?, decimal, mod }
 */
function modSandboxFields(mods) {
  const fields = [];
  const seen = new Set();
  for (const mod of mods) {
    const dirs = mediaDirs(mod.dir);
    const file = dirs.map((d) => path.join(d, 'sandbox-options.txt')).find((f) => fs.existsSync(f));
    if (!file) continue;
    const tr = new Map();
    dirs.forEach((d) => readSandboxTranslations(d, tr));
    let options;
    try {
      options = parseOptions(fs.readFileSync(file, 'latin1'));
    } catch {
      continue;
    }
    for (const o of options) {
      if (seen.has(o.name) || !o.name.includes('.')) continue;
      seen.add(o.name);
      const key = o.name.slice(o.name.lastIndexOf('.') + 1);
      const t = o.translation || o.name.replace(/\./g, '_');
      const page = o.page || o.name.split('.')[0];
      const label = tr.get(`Sandbox_${t}`) || key.replace(/([a-z])([A-Z])/g, '$1 $2');
      const help = (tr.get(`Sandbox_${t}_tooltip`) || '').replace(/<[^>]+>/g, ' ').trim();
      const base = { path: o.name, group: `Mod: ${tr.get(`Sandbox_${page}`) || mod.name}`, key, label, help, mod: mod.name };
      if (o.type === 'boolean') fields.push({ ...base, type: 'bool', value: o.default === 'true' });
      else if (o.type === 'enum') {
        const n = Number(o.numValues) || 0;
        const vt = o.valueTranslation || t;
        const choices = Array.from({ length: n }, (_, i) => ({ value: i + 1, label: tr.get(`Sandbox_${vt}_option${i + 1}`) || `Option ${i + 1}` }));
        fields.push({ ...base, type: 'choice', value: Number(o.default) || 1, choices });
      } else if (o.type === 'integer' || o.type === 'double') {
        fields.push({
          ...base,
          type: 'number',
          value: Number(o.default) || 0,
          decimal: o.type === 'double',
          min: o.min !== undefined ? Number(o.min) : undefined,
          max: o.max !== undefined ? Number(o.max) : undefined,
        });
      } else if (o.type === 'string') fields.push({ ...base, type: 'string', value: o.default || '' });
    }
  }
  return fields;
}

module.exports = { modSandboxFields };
