// The in-game map of Knox County, read from the server's own files
// (media/maps/Muldraugh, KY/pyramid.zip: 256px tiles, level 0 = one tile per
// 256x256 squares, each level up halves the detail), and where players are.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

class ZomboidMap {
  constructor(installDir) {
    this.dir = path.join(installDir, 'media', 'maps', 'Muldraugh, KY');
    this.zip = null;
    this.info = null;
  }

  open() {
    if (this.zip) return true;
    const file = path.join(this.dir, 'pyramid.zip');
    if (!fs.existsSync(file)) return false;
    this.zip = new AdmZip(file);
    const txt = this.zip.readAsText('pyramid.txt') || '';
    const bounds = (txt.match(/bounds=(\d+) (\d+) (\d+) (\d+)/) || []).slice(1).map(Number);
    const levels = new Set(this.zip.getEntries().map((e) => e.entryName.split('/')[0]).filter((d) => /^\d+$/.test(d)).map(Number));
    this.info = {
      minX: bounds[0] || 0,
      minY: bounds[1] || 0,
      maxX: bounds[2] || 19968,
      maxY: bounds[3] || 16128,
      tileSquares: 256,
      maxLevel: Math.max(0, ...levels),
    };
    return true;
  }

  /** { minX, minY, maxX, maxY, tileSquares, maxLevel } or null when the map files are missing. */
  mapInfo() {
    return this.open() ? this.info : null;
  }

  /** PNG bytes of one tile, or null for empty sea/edge tiles. */
  tile(level, tx, ty) {
    if (!this.open()) return null;
    const entry = this.zip.getEntry(`${Number(level)}/tile${Number(tx)}x${Number(ty)}.png`);
    return entry ? entry.getData() : null;
  }
}

/** Last saved position of each character: [{ username, character, x, y, z, dead }]. */
function playerPositions(playersDb) {
  if (!fs.existsSync(playersDb)) return [];
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(playersDb, { readOnly: true });
    return db.prepare('SELECT username, name, x, y, z, isDead FROM networkPlayers').all()
      .filter((r) => r.username)
      .map((r) => ({ username: r.username, character: r.name || '', x: Math.round(r.x), y: Math.round(r.y), z: Math.round(r.z || 0), dead: Boolean(r.isDead) }));
  } catch {
    return []; // the server is mid-save; try again on the next refresh
  } finally {
    if (db) db.close();
  }
}

module.exports = { ZomboidMap, playerPositions };
