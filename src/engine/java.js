// Installs Eclipse Temurin Java runtimes on demand, one per major version,
// so the user never has to install or pick Java themselves.
// API docs: https://api.adoptium.net/q/swagger-ui/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');
const { getJson, download } = require('./http');

// Adoptium does not ship every major version (16 was short-lived).
// Each Minecraft version runs fine on the next LTS up from what it asks for.
const AVAILABLE = [8, 11, 17, 21, 25];

function pickRuntime(required) {
  return AVAILABLE.find((v) => v >= required) || AVAILABLE[AVAILABLE.length - 1];
}

function platform() {
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
  return { os, arch };
}

function javaExeName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

/** Find bin/java inside an extracted runtime folder (one level of nesting). */
function findJavaBinary(dir) {
  const direct = path.join(dir, 'bin', javaExeName());
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(dir)) return null;
  for (const child of fs.readdirSync(dir)) {
    const candidates = [
      path.join(dir, child, 'bin', javaExeName()),
      path.join(dir, child, 'Contents', 'Home', 'bin', javaExeName()),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (found) return found;
  }
  return null;
}

/**
 * Return the path to a java binary of at least `requiredMajor`,
 * downloading a Temurin JRE into `javaRoot` the first time.
 */
async function ensureJava(requiredMajor, javaRoot, { log = () => {}, onProgress } = {}) {
  const major = pickRuntime(requiredMajor);
  const dir = path.join(javaRoot, `temurin-${major}`);
  const existing = findJavaBinary(dir);
  if (existing) return { javaPath: existing, major };

  const { os, arch } = platform();
  const params = new URLSearchParams({ architecture: arch, image_type: 'jre', os, vendor: 'eclipse' });
  const assets = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${params}`);
  const asset = assets.find((a) => a.binary && a.binary.package);
  if (!asset) throw new Error(`No Java ${major} runtime available for ${os}/${arch}`);
  const pkg = asset.binary.package;

  log(`Downloading Java ${major} (${asset.release_name})...`);
  const archive = path.join(javaRoot, pkg.name);
  await download(pkg.link, archive, { hashes: { sha256: pkg.checksum }, onProgress });

  log(`Unpacking Java ${major}...`);
  const staging = `${dir}.staging`;
  await fsp.rm(staging, { recursive: true, force: true });
  if (pkg.name.endsWith('.zip')) {
    new AdmZip(archive).extractAllTo(staging, true);
  } else {
    // tar.gz on macOS/Linux; Windows 10+ also ships tar.
    await fsp.mkdir(staging, { recursive: true });
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) =>
      execFile('tar', ['-xzf', archive, '-C', staging], (err) => (err ? reject(err) : resolve()))
    );
  }
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(staging, dir);
  await fsp.rm(archive, { force: true });

  const javaPath = findJavaBinary(dir);
  if (!javaPath) throw new Error(`Java ${major} unpacked but no java binary was found`);
  log(`Java ${major} ready`);
  return { javaPath, major };
}

module.exports = { ensureJava, pickRuntime };
