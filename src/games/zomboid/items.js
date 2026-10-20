// Every item a Zomboid server knows: the game's own items and those added by
// the server's mods, with their English names, so the app can search them.
const fs = require('fs');
const path = require('path');

/** Item names from Translate/EN: ItemName.json (Build 42) or ItemName_EN.txt (Build 41). */
function readTranslations(mediaDir, out) {
  const dir = path.join(mediaDir, 'lua', 'shared', 'Translate', 'EN');
  try {
    const json = path.join(dir, 'ItemName.json');
    if (fs.existsSync(json)) {
      for (const [key, name] of Object.entries(JSON.parse(fs.readFileSync(json, 'utf8')))) {
        if (typeof name === 'string') out.set(key.replace(/^ItemName_/, ''), name.trim());
      }
    }
    const txt = path.join(dir, 'ItemName_EN.txt');
    if (fs.existsSync(txt)) {
      for (const m of fs.readFileSync(txt, 'latin1').matchAll(/ItemName_([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) out.set(m[1], m[2].trim());
    }
  } catch {
    // unreadable translation file: fall back to script names
  }
}

/** Items defined in media/scripts: `module X { item Y { DisplayName = ... } }`. */
function readScripts(mediaDir, out) {
  const root = path.join(mediaDir, 'scripts');
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.txt')) {
        let text;
        try {
          text = fs.readFileSync(file, 'latin1');
        } catch {
          continue;
        }
        const module = (text.match(/^\s*module\s+([A-Za-z0-9_]+)/m) || [])[1];
        if (!module) continue;
        for (const m of text.matchAll(/^\s*item\s+([A-Za-z0-9_]+)\s*\{([^}]*)/gm)) {
          const id = `${module}.${m[1]}`;
          if (out.has(id)) continue;
          const display = (m[2].match(/DisplayName\s*=\s*([^,\r\n]+)/) || [])[1];
          out.set(id, display ? display.trim() : m[1].replace(/_/g, ' '));
        }
      }
    }
  };
  walk(root);
}

/** Media folders of a mod: Build 42 keeps files in "42" plus "common"; Build 41 in the mod folder. */
function modMediaDirs(modDir) {
  const dirs = [path.join(modDir, 'media')];
  const parent = path.dirname(modDir);
  if (/^\d+(\.\d+)*$/.test(path.basename(modDir))) dirs.push(path.join(parent, 'common', 'media'));
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * [{ id: 'Base.Axe', name: 'Firefighter Axe', mod: null | 'Mod name' }] for the
 * game in `installDir` plus `mods` ([{ name, dir }]).
 */
function listItems(installDir, mods = []) {
  const all = new Map();
  const base = new Map();
  readTranslations(path.join(installDir, 'media'), base);
  readScripts(path.join(installDir, 'media'), base);
  for (const [id, name] of base) all.set(id, { id, name, mod: null });
  for (const mod of mods) {
    const found = new Map();
    for (const media of modMediaDirs(mod.dir)) {
      readTranslations(media, found);
      readScripts(media, found);
    }
    for (const [id, name] of found) {
      const existing = all.get(id);
      if (!existing) all.set(id, { id, name, mod: mod.name });
      else if (existing.mod === null && base.get(id) === id.split('.')[1]) existing.name = name;
    }
  }
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Vehicle names from Translate/EN (IGUI_VehicleName<Script>). */
function readVehicleNames(mediaDir, out) {
  const dir = path.join(mediaDir, 'lua', 'shared', 'Translate', 'EN');
  try {
    const json = path.join(dir, 'IG_UI.json');
    if (fs.existsSync(json)) {
      const text = fs.readFileSync(json, 'utf8').replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1');
      for (const [k, v] of Object.entries(JSON.parse(text))) if (k.startsWith('IGUI_VehicleName') && typeof v === 'string') out.set(k.slice(16), v.trim());
    }
    const txt = path.join(dir, 'IG_UI_EN.txt');
    if (fs.existsSync(txt)) {
      for (const m of fs.readFileSync(txt, 'latin1').matchAll(/IGUI_VehicleName([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) out.set(m[1], m[2].trim());
    }
  } catch {
    // unreadable: raw script names are used
  }
}

function readVehicleScripts(mediaDir, out) {
  const root = path.join(mediaDir, 'scripts');
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.txt')) {
        let text;
        try {
          text = fs.readFileSync(file, 'latin1');
        } catch {
          continue;
        }
        const module = (text.match(/^\s*module\s+([A-Za-z0-9_]+)/m) || [])[1];
        if (!module) continue;
        for (const m of text.matchAll(/^\s*vehicle\s+([A-Za-z0-9_]+)\s*\{/gm)) out.set(`${module}.${m[1]}`, m[1]);
      }
    }
  };
  walk(root);
}

/** Vehicles that can be spawned: [{ id: 'Base.PickUpTruck', name, mod }]. Burnt and wrecked ones are left out. */
function listVehicles(installDir, mods = []) {
  const out = new Map();
  const add = (mediaDir, mod) => {
    const names = new Map();
    const scripts = new Map();
    readVehicleNames(mediaDir, names);
    readVehicleScripts(mediaDir, scripts);
    for (const [id, script] of scripts) {
      if (out.has(id) || /Burnt|Smashed|Wreck/i.test(script)) continue;
      out.set(id, { id, name: names.get(script) || script.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '), mod });
    }
  };
  add(path.join(installDir, 'media'), null);
  for (const mod of mods) for (const media of modMediaDirs(mod.dir)) add(media, mod.name);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listItems, listVehicles };
