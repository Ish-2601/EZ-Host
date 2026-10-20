// Installs the server side of each mod loader and works out how to launch it.
// The result is a "launch" description saved with the server:
//   { type: 'jar', jar: 'fabric-server-launch.jar' }        -> java -jar <jar> nogui
//   { type: 'argfile', argFile: 'libraries/.../win_args.txt' } -> java @<argFile> nogui
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { getJson, download } = require('./http');
const { vanillaServerDownload } = require('./minecraft');

function runJava(javaPath, args, cwd, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    const forward = (data) =>
      data
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => log(line));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}`))
    );
  });
}

async function installVanilla({ serverDir, minecraft, log }) {
  log(`Downloading Minecraft ${minecraft} server...`);
  const { url, sha1 } = await vanillaServerDownload(minecraft);
  await download(url, path.join(serverDir, 'server.jar'), { hashes: { sha1 } });
  return { type: 'jar', jar: 'server.jar' };
}

async function installFabric({ serverDir, minecraft, loaderVersion, log }) {
  const installers = await getJson('https://meta.fabricmc.net/v2/versions/installer');
  const installer = installers.find((i) => i.stable) || installers[0];
  log(`Downloading Fabric ${loaderVersion} server launcher...`);
  const url =
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraft)}` +
    `/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`;
  await download(url, path.join(serverDir, 'fabric-server-launch.jar'));
  // The launcher fetches the vanilla server jar and libraries itself on first start.
  return { type: 'jar', jar: 'fabric-server-launch.jar' };
}

async function installQuilt({ serverDir, minecraft, loaderVersion, javaPath, log }) {
  const installers = await getJson('https://meta.quiltmc.org/v3/versions/installer');
  if (!installers.length) throw new Error('Could not find the Quilt installer');
  const installerJar = path.join(serverDir, 'quilt-installer.jar');
  log(`Downloading Quilt installer ${installers[0].version}...`);
  await download(installers[0].url, installerJar);
  log(`Installing Quilt ${loaderVersion}...`);
  await runJava(
    javaPath,
    ['-jar', installerJar, 'install', 'server', minecraft, loaderVersion, '--download-server', `--install-dir=${serverDir}`],
    serverDir,
    log
  );
  await fsp.rm(installerJar, { force: true });
  return { type: 'jar', jar: 'quilt-server-launch.jar' };
}

function forgeInstallerUrl(loader, minecraft, version) {
  if (loader === 'neoforge') {
    // NeoForge's first release (for 1.20.1) still used Forge's naming.
    if (minecraft === '1.20.1') {
      const v = `1.20.1-${version}`;
      return `https://maven.neoforged.net/releases/net/neoforged/forge/${v}/forge-${v}-installer.jar`;
    }
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  }
  const v = `${minecraft}-${version}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`;
}

/** Recursively look for the platform args file Forge/NeoForge 1.17+ generate. */
function findArgFile(serverDir) {
  const name = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const roots = [
    'libraries/net/minecraftforge/forge',
    'libraries/net/neoforged/neoforge',
    'libraries/net/neoforged/forge',
  ];
  for (const root of roots) {
    const dir = path.join(serverDir, root);
    if (!fs.existsSync(dir)) continue;
    for (const version of fs.readdirSync(dir)) {
      const candidate = path.join(dir, version, name);
      if (fs.existsSync(candidate)) return path.relative(serverDir, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

/** Older Forge (1.16 and earlier) produces a runnable forge-<version>.jar. */
function findForgeJar(serverDir) {
  const jars = fs
    .readdirSync(serverDir)
    .filter((f) => /^(forge|neoforge)-.*\.jar$/i.test(f) && !/installer/i.test(f));
  return jars.find((f) => !/universal/i.test(f)) || jars[0] || null;
}

async function installForgeLike({ serverDir, minecraft, loader, loaderVersion, javaPath, log }) {
  const label = loader === 'neoforge' ? 'NeoForge' : 'Forge';
  const installerJar = path.join(serverDir, `${loader}-installer.jar`);
  log(`Downloading ${label} ${loaderVersion} installer...`);
  await download(forgeInstallerUrl(loader, minecraft, loaderVersion), installerJar);
  log(`Installing ${label} (this downloads Minecraft and libraries, it can take a few minutes)...`);
  await runJava(javaPath, ['-jar', installerJar, '--installServer'], serverDir, log);
  await fsp.rm(installerJar, { force: true });
  await fsp.rm(`${installerJar}.log`, { force: true });

  const argFile = findArgFile(serverDir);
  if (argFile) return { type: 'argfile', argFile };
  const jar = findForgeJar(serverDir);
  if (jar) return { type: 'jar', jar };
  throw new Error(`${label} installed, but no way to launch it was found`);
}

/**
 * Install `loader` into `serverDir`. Needs a java binary for loaders whose
 * installers are Java programs (Forge, NeoForge, Quilt).
 */
async function installLoader({ serverDir, minecraft, loader, loaderVersion, javaPath, log = () => {} }) {
  const ctx = { serverDir, minecraft, loader, loaderVersion, javaPath, log };
  switch (loader) {
    case 'vanilla':
      return installVanilla(ctx);
    case 'fabric':
      return installFabric(ctx);
    case 'quilt':
      return installQuilt(ctx);
    case 'forge':
    case 'neoforge':
      return installForgeLike(ctx);
    default:
      throw new Error(`Unsupported mod loader: ${loader}`);
  }
}

module.exports = { installLoader, forgeInstallerUrl };
