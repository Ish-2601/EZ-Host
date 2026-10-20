// Starts a server and reports startup progress, failures, automatic mod
// fixes and restarts, until it is running or gives up.
//
//   node scripts/startup-smoke.js <data folder> "<server name>"
const path = require('path');
const { ServerManager } = require('../src/engine/manager');

const root = path.resolve(process.argv[2]);
const name = process.argv[3];
const manager = new ServerManager(path.join(root, 'data'));
const server = manager.list().find((s) => s.name === name);
if (!server) throw new Error(`No server called ${name}`);
const id = server.id;

let lastLabel = '';
manager.on('startup', (sid, s) => {
  if (sid !== id) return;
  const label = `${s.phase} ${s.label}${s.progress ? ` ${s.progress.done}%` : ''}`;
  if (label !== lastLabel) console.log(`[startup ${Math.round((Date.now() - s.startedAt) / 1000)}s] ${label}`);
  lastLabel = label;
});
manager.on('console', (sid, line) => {
  if (sid === id && line.stream === 'system' && !line.text.startsWith('> java')) console.log(`[app] ${line.text}`);
});
manager.on('status', (sid, status) => {
  if (sid !== id) return;
  console.log(`[status] ${status}`);
  if (status === 'running') {
    console.log('OK: running. Last failure:', JSON.stringify(manager.describe(id).lastFailure), 'issues:', JSON.stringify(manager.readConfig(id).modIssues || []));
    manager.stop(id).then(() => process.exit(0));
  }
});

manager.start(id).catch((err) => {
  console.error('start failed', err.message);
  process.exit(1);
});
setTimeout(async () => {
  console.log('Gave up after 15 minutes');
  await manager.stopAll();
  process.exit(1);
}, 15 * 60 * 1000);
