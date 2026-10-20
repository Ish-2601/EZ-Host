// Steam Workshop collections for Project Zomboid: find the host's own and
// favourited collections, read what is in a collection, and download items
// (anonymously, with SteamCMD) to learn their mod IDs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { USER_AGENT } = require('../../engine/http');

const APP_ID = 108600; // Project Zomboid (the game, which owns the Workshop)
const API = 'https://api.steampowered.com/ISteamRemoteStorage';

class PrivateProfileError extends Error {}

/** Steam accounts that have signed in on this PC, most recent first. */
function steamAccounts() {
  const files = ['C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf', 'C:\\Program Files\\Steam\\config\\loginusers.vdf'];
  const file = files.find((f) => fs.existsSync(f));
  if (!file) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/"(7656\d{13})"\s*\{([^}]*)\}/g)) {
    const field = (name) => (m[2].match(new RegExp(`"${name}"\\s*"([^"]*)"`, 'i')) || [])[1];
    out.push({
      steamId: m[1],
      name: field('PersonaName') || m[1],
      mostRecent: field('MostRecent') === '1',
      timestamp: Number(field('Timestamp')) || 0,
    });
  }
  return out.sort((a, b) => b.mostRecent - a.mostRecent || b.timestamp - a.timestamp);
}

async function postForm(endpoint, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  const res = await fetch(`${API}/${endpoint}/v1/`, { method: 'POST', body, headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Steam returned ${res.status}`);
  return (await res.json()).response;
}

/** Titles and pictures for Workshop items or collections. */
async function itemDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const fields = { itemcount: batch.length };
    batch.forEach((id, n) => (fields[`publishedfileids[${n}]`] = id));
    const res = await postForm('GetPublishedFileDetails', fields);
    for (const d of res.publishedfiledetails || []) {
      if (d.result !== 1) continue;
      out.set(d.publishedfileid, { id: d.publishedfileid, title: d.title, preview: d.preview_url || null, appId: d.consumer_app_id, description: d.description || '' });
    }
  }
  return out;
}

/** Children of collections: Map(collectionId -> [itemId]). Non-collections are left out. */
async function collectionChildren(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const fields = { collectioncount: batch.length };
    batch.forEach((id, n) => (fields[`publishedfileids[${n}]`] = id));
    const res = await postForm('GetCollectionDetails', fields);
    for (const c of res.collectiondetails || []) {
      if (c.result === 1 && c.children) out.set(c.publishedfileid, c.children);
    }
  }
  return out;
}

/** Every item in a collection, following collections inside it. */
async function collectionItems(collectionId) {
  const items = [];
  const seen = new Set();
  let queue = [String(collectionId)];
  while (queue.length) {
    const children = await collectionChildren(queue);
    if (!children.size && !items.length) throw new Error('That is not a public Workshop collection');
    queue = [];
    for (const list of children.values()) {
      for (const child of list) {
        if (seen.has(child.publishedfileid)) continue;
        seen.add(child.publishedfileid);
        if (child.filetype === 2) queue.push(child.publishedfileid);
        else items.push(child.publishedfileid);
      }
    }
  }
  return items;
}

/** Workshop IDs linked from a profile's Workshop pages ("collections" or "favorites"). */
async function profileWorkshopIds(steamId, which) {
  const ids = [];
  for (let page = 1; page <= 5; page++) {
    const query = which === 'favorites' ? `browsefilter=myfavorites&appid=${APP_ID}` : `section=collections&appid=${APP_ID}`;
    const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/myworkshopfiles/?${query}&p=${page}&numperpage=30`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EZ-Host' },
    });
    const html = await res.text();
    if (/profile_private_info|This profile is private/i.test(html)) throw new PrivateProfileError('private');
    const found = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))].filter((id) => !ids.includes(id));
    if (!found.length) break;
    ids.push(...found);
  }
  return ids;
}

/**
 * The host's Zomboid collections: ones they made and ones they favourited, for
 * every Steam account on this PC. Returns { collections, notes }.
 */
async function listCollections() {
  const accounts = steamAccounts();
  const notes = [];
  if (!accounts.length) notes.push('No Steam account was found on this PC.');
  const found = new Map();
  for (const account of accounts) {
    for (const which of ['collections', 'favorites']) {
      try {
        const ids = await profileWorkshopIds(account.steamId, which);
        for (const id of ids) if (!found.has(id)) found.set(id, { source: which === 'favorites' ? 'Favourite' : 'Made by you', account: account.name });
      } catch (err) {
        if (err instanceof PrivateProfileError) {
          notes.push(`${account.name}'s Steam profile is private, so its collections cannot be read. Make "Game details" public in Steam (Profile → Edit Profile → Privacy Settings), or paste a collection link instead.`);
          break;
        }
        notes.push(`Could not read ${account.name}'s Workshop pages (${err.message}).`);
      }
    }
  }
  const ids = [...found.keys()];
  const children = ids.length ? await collectionChildren(ids) : new Map();
  const details = children.size ? await itemDetails([...children.keys()]) : new Map();
  const collections = [...children.keys()]
    .map((id) => ({
      id,
      title: (details.get(id) || {}).title || `Collection ${id}`,
      preview: (details.get(id) || {}).preview || null,
      items: children.get(id).length,
      ...found.get(id),
    }))
    .filter((c) => !details.get(c.id) || details.get(c.id).appId === APP_ID);
  if (accounts.length && !collections.length && !notes.length) {
    notes.push(`No Project Zomboid collections were found for ${accounts.map((a) => a.name).join(' or ')}. Make or favourite one on the Steam Workshop, or paste a collection link.`);
  }
  return { accounts: accounts.map((a) => ({ name: a.name, steamId: a.steamId })), collections, notes };
}

/** A collection ID from a link like https://steamcommunity.com/sharedfiles/filedetails/?id=123. */
function parseCollectionLink(text) {
  const m = String(text || '').match(/(?:\?id=|^)(\d{6,12})/);
  if (!m) throw new Error('Paste a Steam Workshop collection link or its number');
  return m[1];
}

/** Download Workshop items anonymously with SteamCMD, in batches. `onProgress(done, total)`. */
function downloadItems(steamcmd, ids, { onProgress = () => {}, log = () => {} } = {}) {
  return (async () => {
    let done = 0;
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const args = ['+login', 'anonymous'];
      for (const id of batch) args.push('+workshop_download_item', String(APP_ID), String(id));
      args.push('+quit');
      await new Promise((resolve) => {
        const child = spawn(steamcmd, args, { cwd: path.dirname(steamcmd), windowsHide: true });
        child.stdout.on('data', (d) => {
          for (const line of d.toString().split(/\r?\n/)) {
            if (/Success\. Downloaded item/i.test(line)) onProgress(++done, ids.length);
            else if (/ERROR!.*download item/i.test(line)) log(line.trim());
          }
        });
        child.on('error', () => resolve());
        child.on('exit', () => resolve());
      });
    }
  })();
}

/** Where SteamCMD puts downloaded Zomboid Workshop items. */
function steamcmdWorkshopRoot(steamcmd) {
  return path.join(path.dirname(steamcmd), 'steamapps', 'workshop', 'content', String(APP_ID));
}

module.exports = {
  steamAccounts,
  listCollections,
  collectionItems,
  itemDetails,
  parseCollectionLink,
  downloadItems,
  steamcmdWorkshopRoot,
  PrivateProfileError,
};
