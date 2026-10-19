// Modrinth API client: search modpacks and list their versions.
// Docs: https://docs.modrinth.com/api/
const { getJson } = require('./http');

const API = 'https://api.modrinth.com/v2';

/**
 * Search modpacks that can run on a server (server_side required or optional).
 */
async function searchModpacks(query = '', { limit = 20, offset = 0 } = {}) {
  const facets = JSON.stringify([
    ['project_type:modpack'],
    ['server_side:required', 'server_side:optional'],
  ]);
  const params = new URLSearchParams({
    query,
    facets,
    limit: String(limit),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
  });
  const data = await getJson(`${API}/search?${params}`);
  return {
    total: data.total_hits,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      iconUrl: h.icon_url || null,
      downloads: h.downloads,
      gameVersions: h.versions || [],
      loaders: (h.categories || []).filter((c) =>
        ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)
      ),
    })),
  };
}

async function getProject(idOrSlug) {
  const p = await getJson(`${API}/project/${encodeURIComponent(idOrSlug)}`);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    iconUrl: p.icon_url || null,
  };
}

/** List a modpack's versions, newest first, each with its .mrpack file. */
async function getModpackVersions(projectId) {
  const versions = await getJson(`${API}/project/${encodeURIComponent(projectId)}/version`);
  return versions
    .map((v) => {
      const file =
        v.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ||
        v.files.find((f) => f.filename.endsWith('.mrpack'));
      if (!file) return null;
      return {
        id: v.id,
        name: v.name,
        versionNumber: v.version_number,
        gameVersions: v.game_versions,
        loaders: v.loaders,
        datePublished: v.date_published,
        file: {
          url: file.url,
          filename: file.filename,
          size: file.size,
          hashes: file.hashes,
        },
      };
    })
    .filter(Boolean);
}

/**
 * Many packs list client-only mods without marking them, and those crash a
 * dedicated server. Look each file up by hash and return the set of sha1
 * hashes whose Modrinth project says it does not run on servers.
 */
async function findClientOnlyFiles(sha1Hashes) {
  const clientOnly = new Set();
  if (!sha1Hashes.length) return clientOnly;
  const { request } = require('./http');
  const res = await request(`${API}/version_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: sha1Hashes, algorithm: 'sha1' }),
  });
  const versionsByHash = await res.json();
  const projectIds = [...new Set(Object.values(versionsByHash).map((v) => v.project_id))];
  const serverSide = new Map();
  // Keep URLs short: fetch projects in batches.
  for (let i = 0; i < projectIds.length; i += 100) {
    const ids = JSON.stringify(projectIds.slice(i, i + 100));
    const projects = await getJson(`${API}/projects?ids=${encodeURIComponent(ids)}`);
    for (const p of projects) serverSide.set(p.id, p.server_side);
  }
  for (const [hash, version] of Object.entries(versionsByHash)) {
    if (serverSide.get(version.project_id) === 'unsupported') clientOnly.add(hash.toLowerCase());
  }
  return clientOnly;
}

/** Newest version of a mod that works with this loader and Minecraft version, or null. */
async function getCompatibleVersion(idOrSlug, loader, minecraft) {
  const params = new URLSearchParams({ loaders: JSON.stringify([loader]), game_versions: JSON.stringify([minecraft]) });
  const versions = await getJson(`${API}/project/${encodeURIComponent(idOrSlug)}/version?${params}`);
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  if (!v) return null;
  const file = v.files.find((f) => f.primary) || v.files[0];
  return {
    projectId: v.project_id,
    versionNumber: v.version_number,
    file: { url: file.url, filename: file.filename, hashes: file.hashes },
    requiredProjects: (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id),
  };
}

/** Modrinth project ids of the given jar hashes (sha1), for jars Modrinth knows. */
async function projectIdsForHashes(sha1Hashes) {
  if (!sha1Hashes.length) return new Set();
  const { request } = require('./http');
  const res = await request(`${API}/version_files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: sha1Hashes, algorithm: 'sha1' }),
  });
  return new Set(Object.values(await res.json()).map((v) => v.project_id));
}

module.exports = { searchModpacks, getProject, getModpackVersions, findClientOnlyFiles, getCompatibleVersion, projectIdsForHashes };
