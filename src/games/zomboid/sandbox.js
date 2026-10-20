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

/** Write new values ({ 'ZombieLore.Speed': 2, ... }), keeping comments and layout. */
function writeSandbox(file, values) {
  const fields = new Map(readSandbox(file).map((f) => [f.path, f]));
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
    const field = fields.get(path);
    let v = values[path];
    if (field.type === 'bool') v = v === true || v === 'true' ? 'true' : 'false';
    else if (field.type === 'string') v = `"${String(v).replace(/["\\\r\n]/g, '')}"`;
    else {
      let n = Number(v);
      if (!Number.isFinite(n)) return line;
      if (field.min !== undefined) n = Math.max(field.min, n);
      if (field.max !== undefined) n = Math.min(field.max, n);
      if (field.type === 'choice' && !field.choices.some((c) => c.value === n)) return line;
      v = field.decimal ? (Number.isInteger(n) ? n.toFixed(1) : String(n)) : String(Math.round(n));
    }
    return `${m[1]}${m[2]} = ${v},`;
  });
  fs.writeFileSync(file, out.join('\n'));
}

// The options most people change, shown first.
const COMMON = [
  'Zombies', 'Distribution', 'ZombieLore.Speed', 'ZombieLore.Strength', 'ZombieLore.Toughness', 'ZombieLore.Transmission',
  'DayLength', 'StartMonth', 'StartTime', 'WaterShut', 'ElecShut', 'WaterShutModifier', 'ElecShutModifier',
  'FoodLootNew', 'WeaponLootNew', 'RangedWeaponLootNew', 'MedicalLootNew', 'Helicopter', 'CharacterFreePoints',
  'StarterKit', 'MultiplierConfig.Global',
];

module.exports = { parseSandbox, readSandbox, writeSandbox, COMMON };
