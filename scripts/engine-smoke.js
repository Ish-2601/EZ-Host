// Drives the engine without the UI: search Modrinth, install a pack, and
// launch it far enough to prove Java + loader work.
//
//   node scripts/engine-smoke.js "<search query>" [--version <modrinth version id>]
//
// Data goes to .dev-data/ in the repo. The EULA is NOT accepted here, so a
// vanilla-based server stops at the EULA prompt; reaching that prompt means
// the loader and Java launched correctly.
const path = require('path');
const { ServerManager } = require('../src/engine/manager');
const modrinth = require('../src/engine/modrinth');

async function main() {
  const args = process.argv.slice(2);
  const query = args[0] || 'cobblemon';
  const versionFlag = args.indexOf('--version');
  const manager = new ServerManager(path.join(__dirname, '..', '.dev-data'));

  const { hits } = await modrinth.searchModpacks(query, { limit: 5 });
  console.log('Search results:');
  hits.forEach((h, i) => console.log(`  ${i + 1}. ${h.title} [${h.loaders.join(', ')}] (${h.id})`));
  if (!hits.length) throw new Error('No results');
  const project = hits[0];
  const versions = await modrinth.getModpackVersions(project.id);
  const version = versionFlag >= 0 ? versions.find((v) => v.id === args[versionFlag + 1]) : versions[0];
  console.log(`Installing ${project.title} ${version.versionNumber} (${version.gameVersions.join(', ')})`);

  manager.on('install', (_id, e) => {
    if (e.message) console.log(`[install] ${e.message}`);
  });
  const created = await manager.createFromModrinth({ projectId: project.id, versionId: version.id, memoryMb: 4096 });

  await new Promise((resolve) => {
    manager.on('status', (id, status) => {
      if (id === created.id && status === 'stopped') resolve();
    });
  });
  const config = manager.readConfig(created.id);
  if (!config.installed) throw new Error(`Install failed: ${config.installError}`);
  console.log('Installed:', JSON.stringify({ mc: config.minecraft, loader: config.loader, launch: config.launch }));

  // Launch without accepting the EULA: bypass the manager's EULA guard.
  const { ensureJava } = require('../src/engine/java');
  const { ServerProcess } = require('../src/engine/server-process');
  const { javaPath } = await ensureJava(config.javaMajor, manager.paths.java);
  const proc = new ServerProcess({ javaPath, serverDir: manager.serverDir(created.id), launch: config.launch });
  let sawEula = false;
  proc.on('line', (text) => {
    console.log(`[server] ${text}`);
    if (/eula/i.test(text) && !sawEula) {
      sawEula = true;
      // Some packs replace the EULA check with a console prompt that waits forever.
      setTimeout(() => proc.kill(), 3000);
    }
  });
  proc.start();
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  console.log(sawEula ? 'OK: server launched and reached the EULA check' : `Server exited (${code}) without reaching the EULA check`);
  process.exit(sawEula ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
