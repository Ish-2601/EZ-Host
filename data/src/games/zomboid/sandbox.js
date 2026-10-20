// Read and edit <servername>_SandboxVars.lua, the world rules of a Zomboid
// server (zombie count, speed, day length, loot, XP, ...). The game writes the
// file with a comment above every option, so the options, their choices and
// ranges are read from the file itself and stay correct across game versions.
const fs = require('fs');

const VALUE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?),?\s*$/;
const TABLE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*$/;

function parseValue(raw) {
  const v = raw.trim().replace(/,$/, '');
  if (v === 'true' || v === 'false') return { type: 'bool', value: v === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { type: 'number', value: Number(v), decimal: v.includes('.') };
  const s = v.match(/^"(.*)"$/);
  if (s) return { type: 'string', value: s[1] };
  return null;
}

/**
 * All options: [{ path, group, key, type, value, label, help, choices?, min?, max?, decimal? }]
 * `choices` is [{ value, label }] for numbered lists ("-- 1 = Insane").
 */
function parseSandbox(text) {
  const fields = [];
  const stack = [];
  let comments = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      comments.push(trimmed.replace(/^--\s?/, ''));
      continue;
    }
    const table = line.match(TABLE_RE);
    if (table) {
      stack.push(table[1]);
      comments = [];
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      stack.pop();
      comments = [];
      continue;
    }
    const m = line.match(VALUE_RE);
    if (m && stack.length >= 1) {
      const parsed = parseValue(m[3]);
      const key = m[2];
      if (parsed && key !== 'VERSION') {
        const choices = comments
          .map((c) => c.match(/^(-?\d+)\s*=\s*(.+)$/))
          .filter(Boolean)
          .map((c) => ({ value: Number(c[1]), label: c[2].trim() }));
        const text = comments.filter((c) => !/^(-?\d+)\s*=/.test(c)).join(' ');
        const range = text.match(/Min(?:imum)?[:=]\s*(-?[\d.,]+)\s*Max(?:imum)?[:=]\s*(-?[\d.,]+)/i);
        const group = stack.slice(1).join('.') || 'General';
        fields.push({
          path: [...stack.slice(1), key].join('.'),
          group,
          key,
          type: choices.length && parsed.type === 'number' ? 'choice' : parsed.type,
          value: parsed.value,
          decimal: parsed.decimal || false,
          label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '),
          help: text.replace(/\s*Min(?:imum)?[:=].*$/i, '').replace(/\s*Default\s*[:=].*$/i, '').trim(),
          choices: choices.length ? choices : undefined,
          min: range ? Number(range[1].replace(/,/g, '')) : undefined,
          max: range ? Number(range[2].replace(/,/g, '')) : undefined,
        });
      }
    }
    comments = [];
  }
  return fields;
}

function readSandbox(file) {
  if (!fs.existsSync(file)) return null;
  return parseSandbox(fs.readFileSync(file, 'utf8'));
}

function formatValue(field, v) {
  if (field.type === 'bool') return v === true || v === 'true' ? 'true' : 'false';
  if (field.type === 'string') return `"${String(v).replace(/["\\\r\n]/g, '')}"`;
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (field.min !== undefined) n = Math.max(field.min, n);
  if (field.max !== undefined) n = Math.min(field.max, n);
  if (field.type === 'choice' && !field.choices.some((c) => c.value === n)) return null;
  return field.decimal ? (Number.isInteger(n) ? n.toFixed(1) : String(n)) : String(Math.round(n));
}

/**
 * Write new values ({ 'ZombieLore.Speed': 2, ... }), keeping comments and layout.
 * `extra` describes options the file may not have yet (mod options before the
 * server has run with the mod); those are added in their table.
 */
function writeSandbox(file, values, extra = []) {
  const fields = new Map(readSandbox(file).map((f) => [f.path, f]));
  const extraByPath = new Map(extra.map((f) => [f.path, f]));
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const stack = [];
  const out = lines.map((line) => {
    const table = line.match(TABLE_RE);
    if (table) {
      stack.push(table[1]);
      return line;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      stack.pop();
      return line;
    }
    const m = line.match(VALUE_RE);
    if (!m) return line;
    const path = [...stack.slice(1), m[2]].join('.');
    if (!(path in values) || !fields.has(path)) return line;
    const field = { ...fields.get(path), ...(extraByPath.get(path) || {}) };
    const v = formatValue(field, values[path]);
    return v === null ? line : `${m[1]}${m[2]} = ${v},`;
  });
  // Options not in the file yet: group by table, then add them.
  const missing = new Map();
  for (const [p, v] of Object.entries(values)) {
    const field = extraByPath.get(p);
    if (fields.has(p) || !field || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(p)) continue;
    const value = formatValue(field, v);
    if (value === null) continue;
    const [table, key] = p.split('.');
    if (!missing.has(table)) missing.set(table, []);
    missing.get(table).push(`        ${key} = ${value},`);
  }
  for (const [table, lines] of missing) {
    const start = out.findIndex((l) => new RegExp(`^\\s{4}${table}\\s*=\\s*\\{\\s*$`).test(l));
    if (start >= 0) {
      const end = out.findIndex((l, i) => i > start && /^\s{4}\},?\s*$/.test(l));
      if (end > start) {
        out.splice(end, 0, ...lines);
        continue;
      }
    }
    const close = out.map((l) => /^\}\s*$/.test(l)).lastIndexOf(true);
    if (close < 0) continue;
    out.splice(close, 0, `    ${table} = {`, ...lines, '    },');
  }
  fs.writeFileSync(file, out.join('\n'));
}

/**
 * The game's own presets (media/lua/shared/Sandbox/*.lua, "return { Zombies = 4, ZombieLore = { ... } }")
 * as [{ id, values: { 'ZombieLore.Speed': 2, ... } }].
 */
function readPresets(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.lua') && f !== 'SandboxVars.lua')) {
    const values = {};
    const stack = [];
    for (const line of fs.readFileSync(require('path').join(dir, file), 'utf8').split(/\r?\n/)) {
      if (/^\s*return\s*\{\s*$/.test(line)) { stack.push('__root'); continue; }
      const table = line.match(TABLE_RE);
      if (table) { stack.push(table[1]); continue; }
      if (/^\s*\},?\s*$/.test(line)) { stack.pop(); continue; }
      const m = line.match(VALUE_RE);
      if (!m || !stack.length || m[2] === 'Version') continue;
      const parsed = parseValue(m[3]);
      if (parsed) values[[...stack.slice(1), m[2]].join('.')] = parsed.value;
    }
    out.push({ id: file.slice(0, -4), values });
  }
  return out;
}

// The options most people change, shown first.
const COMMON = [
  'Zombies', 'Distribution', 'ZombieLore.Speed', 'ZombieLore.Strength', 'ZombieLore.Toughness', 'ZombieLore.Transmission',
  'DayLength', 'StartMonth', 'StartTime', 'WaterShut', 'ElecShut', 'WaterShutModifier', 'ElecShutModifier',
  'FoodLootNew', 'WeaponLootNew', 'RangedWeaponLootNew', 'MedicalLootNew', 'Helicopter', 'CharacterFreePoints',
  'StarterKit', 'MultiplierConfig.Global',
];

module.exports = { parseSandbox, readSandbox, writeSandbox, readPresets, COMMON };
