// Player data: who has played on a server, their health, hunger, inventory
// and ender chest, and edits to them. Online players are read and changed
// with commands over RCON; offline players through their .dat file.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const nbt = require('./nbt');

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const ITEM_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$|^[a-z0-9_./-]+$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function worldDir(serverDir, props) {
  return path.join(serverDir, props['level-name'] || 'world');
}

/** Everyone who has joined: from usercache.json and the playerdata folder. */
function listPlayers(serverDir, props, onlineNames = []) {
  const byUuid = new Map();
  for (const entry of readJson(path.join(serverDir, 'usercache.json'), [])) {
    if (entry && entry.uuid && entry.name) byUuid.set(entry.uuid, { uuid: entry.uuid, name: entry.name });
  }
  const dataDir = path.join(worldDir(serverDir, props), 'playerdata');
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      const m = f.match(/^([0-9a-f-]{36})\.dat$/);
      if (!m) continue;
      const p = byUuid.get(m[1]) || { uuid: m[1], name: null };
      p.lastPlayed = fs.statSync(path.join(dataDir, f)).mtimeMs;
      p.hasData = true;
      byUuid.set(m[1], p);
    }
  }
  const ops = new Set(readJson(path.join(serverDir, 'ops.json'), []).map((o) => o.uuid));
  const online = new Set(onlineNames.map((n) => n.toLowerCase()));
  return [...byUuid.values()]
    .map((p) => ({ ...p, op: ops.has(p.uuid), online: Boolean(p.name && online.has(p.name.toLowerCase())) }))
    .sort((a, b) => b.online - a.online || (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

function datFile(serverDir, props, uuid) {
  if (!/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('Invalid player id');
  return path.join(worldDir(serverDir, props), 'playerdata', `${uuid}.dat`);
}

function readDat(serverDir, props, uuid) {
  const file = datFile(serverDir, props, uuid);
  if (!fs.existsSync(file)) throw new Error('No saved data for this player yet');
  return nbt.readNbtAuto(fs.readFileSync(file));
}

async function writeDat(serverDir, props, uuid, root) {
  const file = datFile(serverDir, props, uuid);
  // Keep the previous file next to it, like Minecraft does with .dat_old.
  await fsp.copyFile(file, `${file}.selfhost-backup`).catch(() => {});
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, zlib.gzipSync(nbt.writeNbt(root)));
  await fsp.rename(tmp, file);
}

// ---------- turning raw player NBT into something to show ----------

function normalizeItem(raw) {
  if (!raw || !raw.id) return null;
  const count = raw.count ?? raw.Count ?? 1;
  const components = raw.components || {};
  let name = null;
  const custom = components['minecraft:custom_name'] ?? (raw.tag && raw.tag.display && raw.tag.display.Name);
  if (typeof custom === 'string') {
    try {
      const parsed = JSON.parse(custom);
      name = typeof parsed === 'string' ? parsed : parsed.text || null;
    } catch {
      name = custom.replace(/^"|"$/g, '');
    }
  }
  const enchanted = Boolean(components['minecraft:enchantments'] || (raw.tag && raw.tag.Enchantments));
  return { id: raw.id, count: Number(count), name, enchanted, damage: components['minecraft:damage'] ?? (raw.tag && raw.tag.Damage) ?? null };
}

function maxHealthOf(data) {
  for (const a of data.attributes || data.Attributes || []) {
    const id = a.id || a.Name;
    if (id === 'minecraft:max_health' || id === 'minecraft:generic.max_health' || id === 'generic.maxHealth') {
      return Number(a.base ?? a.Base) || 20;
    }
  }
  return 20;
}

/** Plain player NBT -> { health, food, inventory slots, ender chest, ... }. */
function playerView(data) {
  const slots = {}; // 'inv:0'..'inv:35', 'armor:head', ..., 'offhand'
  for (const raw of data.Inventory || []) {
    const item = normalizeItem(raw);
    const s = raw.Slot;
    if (!item || s === undefined) continue;
    if (s >= 0 && s <= 35) slots[`inv:${s}`] = item;
    else if (s === 100) slots['armor:feet'] = item;
    else if (s === 101) slots['armor:legs'] = item;
    else if (s === 102) slots['armor:chest'] = item;
    else if (s === 103) slots['armor:head'] = item;
    else if (s === -106) slots.offhand = item;
  }
  // 1.21.5+ keeps armor and the offhand in an "equipment" compound.
  const eq = data.equipment || {};
  for (const [key, raw] of Object.entries(eq)) {
    const item = normalizeItem(raw);
    if (!item) continue;
    if (key === 'offhand') slots.offhand = item;
    else if (['head', 'chest', 'legs', 'feet'].includes(key)) slots[`armor:${key}`] = item;
  }
  const ender = {};
  for (const raw of data.EnderItems || []) {
    const item = normalizeItem(raw);
    if (item && raw.Slot !== undefined) ender[raw.Slot] = item;
  }
  return {
    health: Number(data.Health ?? 20),
    maxHealth: maxHealthOf(data),
    food: Number(data.foodLevel ?? 20),
    saturation: Number(data.foodSaturationLevel ?? 0),
    xpLevel: Number(data.XpLevel ?? 0),
    gameMode: GAME_MODES[data.playerGameType ?? 0] || 'survival',
    dimension: data.Dimension || 'minecraft:overworld',
    pos: Array.isArray(data.Pos) ? data.Pos.map((n) => Math.round(Number(n) * 10) / 10) : null,
    selectedSlot: data.SelectedItemSlot ?? 0,
    slots,
    ender,
  };
}

// ---------- commands for online players ----------

/** The /item slot name for one of our slot keys. */
function commandSlot(key) {
  const [area, n] = key.split(':');
  if (area === 'inv') return Number(n) < 9 ? `hotbar.${n}` : `inventory.${Number(n) - 9}`;
  if (area === 'armor') return `armor.${n}`;
  if (area === 'offhand') return 'weapon.offhand';
  if (area === 'ender') return `enderchest.${n}`;
  throw new Error('Unknown slot');
}

/** Commands that perform `action` on an online player. */
function onlineCommands(name, action, args = {}) {
  if (!NAME_RE.test(name)) throw new Error('Invalid player name');
  switch (action) {
    case 'heal':
      return [`effect give ${name} minecraft:instant_health 1 10 true`, `effect give ${name} minecraft:regeneration 5 4 true`];
    case 'feed':
      return [`effect give ${name} minecraft:saturation 1 20 true`];
    case 'give': {
      const item = String(args.item || '').trim().toLowerCase();
      const count = Math.max(1, Math.min(6400, Math.floor(Number(args.count) || 1)));
      if (!ITEM_RE.test(item)) throw new Error('Type an item id like minecraft:diamond');
      return [`give ${name} ${item.includes(':') ? item : `minecraft:${item}`} ${count}`];
    }
    case 'remove':
      return [`item replace entity ${name} ${commandSlot(args.slot)} with minecraft:air`];
    case 'clear':
      return [`clear ${name}`];
    case 'gamemode':
      if (!GAME_MODES.includes(args.mode)) throw new Error('Unknown game mode');
      return [`gamemode ${args.mode} ${name}`];
    case 'xp': {
      const level = Math.max(0, Math.min(10000, Math.floor(Number(args.level) || 0)));
      return [`xp set ${name} ${level} levels`];
    }
    case 'op':
      return [`op ${name}`];
    case 'deop':
      return [`deop ${name}`];
    case 'kick':
      return [`kick ${name} ${String(args.reason || 'Kicked by the host').replace(/[\r\n]/g, ' ').slice(0, 100)}`];
    default:
      throw new Error('Unknown action');
  }
}

// ---------- edits to an offline player's .dat file ----------

const F = (value) => ({ type: nbt.T.FLOAT, value });
const I = (value) => ({ type: nbt.T.INT, value });

function editOffline(root, action, args = {}) {
  const c = root.value;
  switch (action) {
    case 'heal':
      c.Health = F(maxHealthOf(nbt.plain(root)));
      return;
    case 'feed':
      c.foodLevel = I(20);
      c.foodSaturationLevel = F(5);
      return;
    case 'gamemode': {
      const i = GAME_MODES.indexOf(args.mode);
      if (i < 0) throw new Error('Unknown game mode');
      c.playerGameType = I(i);
      return;
    }
    case 'xp':
      c.XpLevel = I(Math.max(0, Math.min(10000, Math.floor(Number(args.level) || 0))));
      return;
    case 'clear':
      if (c.Inventory) c.Inventory.value.items = [];
      if (c.equipment) c.equipment.value = {};
      return;
    case 'remove': {
      const [area, n] = String(args.slot).split(':');
      const removeFromList = (tag, slot) => {
        if (!c[tag]) return;
        c[tag].value.items = c[tag].value.items.filter((it) => !(it.Slot && it.Slot.value === slot));
      };
      if (area === 'inv') return removeFromList('Inventory', Number(n));
      if (area === 'ender') return removeFromList('EnderItems', Number(n));
      const legacy = { feet: 100, legs: 101, chest: 102, head: 103 };
      if (area === 'armor') {
        removeFromList('Inventory', legacy[n]);
        if (c.equipment) delete c.equipment.value[n];
        return;
      }
      if (area === 'offhand') {
        removeFromList('Inventory', -106);
        if (c.equipment) delete c.equipment.value.offhand;
        return;
      }
      throw new Error('Unknown slot');
    }
    default:
      throw new Error('That change needs the player to be online');
  }
}

/** Offline op/deop by editing ops.json (only while the server is stopped). */
async function setOpOffline(serverDir, player, op) {
  if (!player.name) throw new Error("This player's name is not known yet; start the server to change ops");
  const file = path.join(serverDir, 'ops.json');
  const ops = readJson(file, []).filter((o) => o.uuid !== player.uuid);
  if (op) ops.push({ uuid: player.uuid, name: player.name, level: 4, bypassesPlayerLimit: false });
  await fsp.writeFile(file, JSON.stringify(ops, null, 2));
}

module.exports = {
  GAME_MODES,
  listPlayers,
  readDat,
  writeDat,
  playerView,
  onlineCommands,
  editOffline,
  setOpOffline,
};
