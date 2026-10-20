// Minecraft NBT: read/write binary NBT (player .dat files, region chunks) and
// parse SNBT text (what `/data get` prints).
//
// Binary NBT is read into typed nodes ({ type, value }) so it can be edited
// and written back without losing types; `plain()` turns a node into
// ordinary JS values for display.
const zlib = require('zlib');

const T = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

// ---------- binary reader ----------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u8() { return this.buf.readUInt8(this.pos++); }
  i8() { return this.buf.readInt8(this.pos++); }
  i16() { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i64() { const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  f32() { const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str() { const n = this.u16(); const v = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return v; }

  payload(type) {
    switch (type) {
      case T.BYTE: return this.i8();
      case T.SHORT: return this.i16();
      case T.INT: return this.i32();
      case T.LONG: return this.i64();
      case T.FLOAT: return this.f32();
      case T.DOUBLE: return this.f64();
      case T.BYTE_ARRAY: { const n = this.i32(); const v = Array.from(this.buf.subarray(this.pos, this.pos + n), (b) => (b << 24) >> 24); this.pos += n; return v; }
      case T.STRING: return this.str();
      case T.LIST: {
        const itemType = this.u8();
        const n = this.i32();
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.payload(itemType));
        return { itemType, items };
      }
      case T.COMPOUND: {
        const out = {};
        for (;;) {
          const t = this.u8();
          if (t === T.END) break;
          const name = this.str();
          out[name] = { type: t, value: this.payload(t) };
        }
        return out;
      }
      case T.INT_ARRAY: { const n = this.i32(); const v = []; for (let i = 0; i < n; i++) v.push(this.i32()); return v; }
      case T.LONG_ARRAY: { const n = this.i32(); const v = []; for (let i = 0; i < n; i++) v.push(this.i64()); return v; }
      default: throw new Error(`Unknown NBT tag type ${type}`);
    }
  }
}

/** Parse uncompressed NBT. Returns the root node { type: COMPOUND, value, name }. */
function readNbt(buf) {
  const r = new Reader(buf);
  const type = r.u8();
  const name = r.str();
  return { type, name, value: r.payload(type) };
}

/** Parse NBT that may be gzip- or zlib-compressed. */
function readNbtAuto(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return readNbt(zlib.gunzipSync(buf));
  if (buf[0] === 0x78) return readNbt(zlib.inflateSync(buf));
  return readNbt(buf);
}

// ---------- binary writer ----------

function writeNbt(root) {
  const parts = [];
  const push = (b) => parts.push(b);
  const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v); push(b); };
  const str = (s) => { const d = Buffer.from(s, 'utf8'); const b = Buffer.alloc(2); b.writeUInt16BE(d.length); push(b); push(d); };
  const payload = (type, v) => {
    const b = (n, fn) => { const x = Buffer.alloc(n); fn(x); push(x); };
    switch (type) {
      case T.BYTE: return b(1, (x) => x.writeInt8(v));
      case T.SHORT: return b(2, (x) => x.writeInt16BE(v));
      case T.INT: return b(4, (x) => x.writeInt32BE(v));
      case T.LONG: return b(8, (x) => x.writeBigInt64BE(BigInt(v)));
      case T.FLOAT: return b(4, (x) => x.writeFloatBE(v));
      case T.DOUBLE: return b(8, (x) => x.writeDoubleBE(v));
      case T.BYTE_ARRAY: b(4, (x) => x.writeInt32BE(v.length)); return push(Buffer.from(v.map((n) => n & 0xff)));
      case T.STRING: return str(v);
      case T.LIST:
        u8(v.items.length ? v.itemType : v.itemType || T.END);
        b(4, (x) => x.writeInt32BE(v.items.length));
        return v.items.forEach((item) => payload(v.itemType, item));
      case T.COMPOUND:
        for (const [name, child] of Object.entries(v)) {
          u8(child.type);
          str(name);
          payload(child.type, child.value);
        }
        return u8(T.END);
      case T.INT_ARRAY: b(4, (x) => x.writeInt32BE(v.length)); return v.forEach((n) => b(4, (x) => x.writeInt32BE(n)));
      case T.LONG_ARRAY: b(4, (x) => x.writeInt32BE(v.length)); return v.forEach((n) => b(8, (x) => x.writeBigInt64BE(BigInt(n))));
      default: throw new Error(`Unknown NBT tag type ${type}`);
    }
  };
  u8(root.type);
  str(root.name || '');
  payload(root.type, root.value);
  return Buffer.concat(parts);
}

// ---------- typed tree -> plain values ----------

function plainPayload(type, v) {
  switch (type) {
    case T.LONG: return Number(v);
    case T.LONG_ARRAY: return v.map(Number);
    case T.LIST: return v.items.map((item) => plainPayload(v.itemType, item));
    case T.COMPOUND: {
      const out = {};
      for (const [k, child] of Object.entries(v)) out[k] = plainPayload(child.type, child.value);
      return out;
    }
    default: return v;
  }
}

function plain(node) {
  return plainPayload(node.type, node.value);
}

// ---------- SNBT (text) parser ----------

/** Parse SNBT into plain JS values (numbers lose their b/s/l/f/d suffixes). */
function parseSnbt(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const expect = (c) => {
    ws();
    if (text[i] !== c) throw new Error(`SNBT: expected "${c}" at ${i}`);
    i++;
  };
  const quoted = () => {
    const q = text[i++];
    let out = '';
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') { i++; out += text[i++]; } else out += text[i++];
    }
    i++;
    return out;
  };
  const bare = () => {
    const start = i;
    while (i < text.length && /[0-9A-Za-z_\-.+]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  const scalar = (raw) => {
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[bBsSlLfFdD]?$/.test(raw)) {
      return Number(raw.replace(/[bBsSlLfFdD]$/, ''));
    }
    if (raw === 'true') return 1;
    if (raw === 'false') return 0;
    return raw;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out = {};
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare();
        expect(':');
        out[key] = value();
        ws();
        if (text[i] === ',') { i++; continue; }
        expect('}');
        return out;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (/[BIL]/.test(text[i]) && text[i + 1] === ';') i += 2; // typed arrays
      const out = [];
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        expect(']');
        return out;
      }
    }
    if (c === '"' || c === "'") return quoted();
    return scalar(bare());
  };
  return value();
}

module.exports = { T, readNbt, readNbtAuto, writeNbt, plain, parseSnbt };
