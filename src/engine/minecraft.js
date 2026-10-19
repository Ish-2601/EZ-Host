// Mojang version metadata: which Java a Minecraft version needs, and
// where its vanilla server jar lives.
const { getJson } = require('./http');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

let manifestCache = null;

async function getVersionInfo(minecraftVersion) {
  if (!manifestCache) manifestCache = await getJson(MANIFEST);
  const entry = manifestCache.versions.find((v) => v.id === minecraftVersion);
  if (!entry) throw new Error(`Unknown Minecraft version ${minecraftVersion}`);
  return getJson(entry.url);
}

/** Guess for when the metadata has no javaVersion (very old versions). */
function fallbackJavaVersion(minecraftVersion) {
  const [major, minor = 0, patch = 0] = minecraftVersion.split('.').map(Number);
  // Year-based versions (26.1 and later) need Java 25.
  if (major >= 26) return 25;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

async function requiredJavaVersion(minecraftVersion) {
  try {
    const info = await getVersionInfo(minecraftVersion);
    if (info.javaVersion && info.javaVersion.majorVersion) return info.javaVersion.majorVersion;
  } catch {
    // Fall through to the guess.
  }
  return fallbackJavaVersion(minecraftVersion);
}

async function vanillaServerDownload(minecraftVersion) {
  const info = await getVersionInfo(minecraftVersion);
  const server = info.downloads && info.downloads.server;
  if (!server) throw new Error(`Minecraft ${minecraftVersion} has no official server download`);
  return { url: server.url, sha1: server.sha1, size: server.size };
}

/** Release versions (newest first) that have an official server download. */
async function listReleases() {
  if (!manifestCache) manifestCache = await getJson(MANIFEST);
  return manifestCache.versions.filter((v) => v.type === 'release').map((v) => ({ id: v.id, releaseTime: v.releaseTime }));
}

module.exports = { requiredJavaVersion, vanillaServerDownload, fallbackJavaVersion, listReleases };
