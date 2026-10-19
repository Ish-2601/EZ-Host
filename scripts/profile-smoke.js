// Builds a server from a CurseForge/Prism profile on this PC and launches it
// up to the EULA check (the EULA is not accepted).
//
//   node scripts/profile-smoke.js "<profile name>"
const path = require('path');
const { ServerManager } = require('../src/engine/manager');
const { ensureJava } = require('../src/engine/java');
const { ServerProcess } = require('../src/engine/server-process');

async function main() {
  const name = process.argv[2];
  const manager = new ServerManager(path.join(__dirname, '..', '.dev-data'));
  const profiles = manager.listProfiles();
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    console.log('Profiles:', profiles.map((p) => p.name).join(', '));
    throw new Error(`No profile named "${name}"`);
  }
  manager.on('install', (_id, e) => e.message && console.log(`[install] ${e.message}`));
  const created = await manager.createFromProfile({ profileId: profile.id });
  await new Promise((resolve) =>
    manager.on('status', (id, status) => id === created.id && status === 'stopped' && resolve())
  );
  const config = manager.readConfig(created.id);
  if (!config.installed) throw new Error(`Install failed: ${config.installError}`);

  const { javaPath } = await ensureJava(config.javaMajor, manager.paths.java);
  const proc = new ServerProcess({ javaPath, serverDir: manager.serverDir(created.id), launch: config.launch });
  let sawEula = false;
  proc.on('line', (text) => {
    if (/ERROR|Exception|Caused by|eula/i.test(text)) console.log(`[server] ${text.slice(0, 300)}`);
    if (/eula/i.test(text) && !sawEula) {
      sawEula = true;
      setTimeout(() => proc.kill(), 3000);
    }
  });
  proc.start();
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  console.log(sawEula ? 'OK: reached the EULA check' : `FAILED: server exited (${code}) before the EULA check`);
  process.exit(sawEula ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
