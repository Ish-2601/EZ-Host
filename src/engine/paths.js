// Path helpers. Everything the engine writes lives under one data root
// (Electron's userData folder in the app, a local folder in scripts).
const path = require('path');

/**
 * Resolve `relative` inside `root`, refusing anything that escapes it
 * (absolute paths, drive letters, "..", etc). Modpack archives are
 * untrusted input, so every path taken from them goes through here.
 */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('Empty path in modpack');
  }
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
    throw new Error(`Unsafe path in modpack: ${relative}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Unsafe path in modpack: ${relative}`);
  }
  return target;
}

function dataPaths(root) {
  return {
    root,
    servers: path.join(root, 'servers'),
    java: path.join(root, 'java'),
    cache: path.join(root, 'cache'),
  };
}

module.exports = { safeJoin, dataPaths };
