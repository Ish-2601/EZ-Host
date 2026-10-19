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

module.exports = { searchModpacks, getProject, getModpackVersions };
