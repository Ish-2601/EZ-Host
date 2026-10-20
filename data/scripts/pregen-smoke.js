// End-to-end check of RCON and world pregeneration on a throwaway server.
//
//   node scripts/pregen-smoke.js <data folder>
//
// Creates (or reuses) a small Fabric server from Modrinth in <data folder>,
// starts it, adds Chunky, restarts, and pregenerates a small radius.
// It accepts the Minecraft EULA for that test server only.
const path = require('path');
const { ServerManager } = require('../src/engine/manager');
const modrinth = require('../src/engine/modrinth');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '.dev-data-ui'));
const manager = new ServerManager(path.join(root, 'data'));
manager.on('install', (_id, e) => e.message && console.log(`[install] ${e.message}`));
manager.on('pregen', (_id, p) => console.log(`[pregen] ${p.state} ${p.percent ?? ''}% eta=${p.eta ?? ''}`));

const waitStatus = (id, want) =>
  new Promise((resolve) => {
    const onStatus = (sid, status) => {
      if (sid === id && status === want) {
        manager.off('status', onStatus);
        resolve();
      }
    };
    manager.on('status', onStatus);
  });

async function main() {
  let server = manager.list().find((s) => s.name === 'Pregen test');
  if (!server) {
    const { hits } = await modrinth.searchModpacks('Essentially Optimized (Server)', { limit: 1 });
    const versions = await modrinth.getModpackVersions(hits[0].id);
    server = await manager.createFromModrinth({ name: 'Pregen test', projectId: hits[0].id, versionId: versions[0].id, memoryMb: 3072 });
    await waitStatus(server.id, 'stopped');
  }
  const id = server.id;
  if (!manager.readConfig(id).installed) throw new Error(manager.readConfig(id).installError);
  await manager.acceptEula(id);

  if (!manager.chunkyInstalled(id)) {
    console.log('Adding Chunky...');
    await manager.installChunky(id);
  }
  await manager.start(id);
  await waitStatus(id, 'running');
  console.log('Server running. RCON list ->', JSON.stringify(await manager.rcon(id, 'list')));
  console.log('RCON chunky ->', JSON.stringify((await manager.rcon(id, 'chunky')).slice(0, 120)));

  await manager.startPregen(id, 128);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pregeneration did not finish in 5 minutes')), 5 * 60 * 1000);
    manager.on('pregen', (_id, p) => {
      if (p.state === 'done') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  console.log('OK: pregeneration finished');
  await manager.stop(id);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  await manager.stopAll().catch(() => {});
  process.exit(1);
});
