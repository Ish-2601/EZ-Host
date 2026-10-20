const path = require('path');
const { getJson, download } = require('./http');

const API = 'https://fill.papermc.io/v3/projects/paper';

async function versions() {
  const project = await getJson(API);
  const values = project.versions || {};
  return [...new Set(Object.values(values).flat())].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

async function stableBuild(minecraft) {
  const builds = await getJson(`${API}/versions/${encodeURIComponent(minecraft)}/builds`);
  const build = builds.find((item) => item.channel === 'STABLE' && item.downloads && item.downloads['server:default']);
  if (!build) throw new Error(`No stable Paper build is available for Minecraft ${minecraft}`);
  return build;
}

async function install(serverDir, minecraft) {
  const build = await stableBuild(minecraft);
  const file = build.downloads['server:default'];
  const jar = path.join(serverDir, file.name || 'paper.jar');
  await download(file.url, jar, { hashes: { sha256: file.checksums && file.checksums.sha256 } });
  return { type: 'jar', jar: path.basename(jar), build: build.id };
}

module.exports = { versions, stableBuild, install };
