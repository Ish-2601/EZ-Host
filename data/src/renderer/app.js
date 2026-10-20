// UI logic. Talks to the main process only through the `api` global from preload.js.
const $ = (id) => document.getElementById(id);

const state = {
  servers: [],
  selectedId: null,
  source: 'profiles', // which "where do mods come from" tab is open
  pending: null, // what the details step will create: { kind: 'modrinth'|'profile', ... }
  profiles: null,
  totalMemoryMb: 8192,
  install: {}, // serverId -> { step, label, done, total }
  startup: {}, // serverId -> startup phase and elapsed-time origin
  players: {}, // serverId -> [names]
  playit: { state: 'unlinked', linked: false },
  join: {}, // serverId -> joinInfo
  tunnels: {}, // serverId -> { state, address, message, resolveLink }
  pregen: {}, // serverId -> pregeneration status
  playerList: [],
  playerUuid: null, // selected player on the Players tab
  playerTimer: null,
  backups: [],
  backupSettings: null,
  tasks: [],
  fileDir: '.',
  fileEntries: [],
  fileEditorPath: null,
  auth: { username: 'Host', permissions: [], host: true },
  metricsTimer: null,
  commandButtons: [],
  packDiff: null,
  sftpCredentials: null,
  liveStatus: null,
  menuFor: null, // server id the right-click menu is open for
  game: 'minecraft', // which game's section the sidebar shows
  zbNew: null, // choices on the new Zomboid server page
  collections: null, // promise of the host's Workshop collections
  rules: null, // world rules of the open Zomboid server
  ruleEdits: {},
};

const MAX_CONSOLE_LINES = 2000;
const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla' };
const INSTALL_STEPS = ['Download mods', 'Install Java', 'Install mod loader', 'Ready'];

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(url, cls = '') {
  if (url) return el('img', { src: url, class: cls, alt: '' });
  return el('div', { class: `icon-fallback ${cls}` }, '⛏');
}

const loaderName = (loader, version) => `${LOADER_NAMES[loader] || loader} ${version || ''}`.trim();

function formatMb(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

let toastTimer = null;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 7000 : 3000);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    // IPC errors arrive as "Error invoking remote method 'x': Error: message".
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''), true);
    return undefined;
  }
}

function confirmDialog(message, { title = 'Are you sure?', confirmText = 'Continue', danger = true } = {}) {
  const modal = $('confirm-modal');
  const cancel = $('confirm-cancel');
  const confirm = $('confirm-accept');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  confirm.textContent = confirmText;
  confirm.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const finish = (accepted) => {
      modal.classList.add('hidden');
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKeyDown);
      cancel.onclick = null;
      confirm.onclick = null;
      resolve(accepted);
    };
    const onOverlay = (event) => { if (event.target === modal) finish(false); };
    const onKeyDown = (event) => { if (event.key === 'Escape') finish(false); };
    cancel.onclick = () => finish(false);
    confirm.onclick = () => finish(true);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKeyDown);
    cancel.focus();
  });
}

function copyButton(text) {
  return el('button', { class: 'btn', type: 'button', onclick: async () => {
    await attempt(() => api.copy(text));
    toast(`Copied ${text}`);
  } }, 'Copy');
}

function showView(name) {
  for (const v of ['empty', 'new', 'zbnew', 'details', 'server']) $(`view-${v}`).classList.toggle('hidden', v !== name);
  $('main').scrollTop = 0;
}

function current() {
  return state.servers.find((s) => s.id === state.selectedId);
}

/** RAM slider capped at 75% of this PC's memory, with a plain-language hint. */
function setupRamSlider(input, label, value, hint) {
  const max = Math.max(4096, Math.floor((state.totalMemoryMb * 0.75) / 512) * 512);
  input.max = String(max);
  input.value = String(Math.min(value, max));
  const update = () => {
    const mb = Number(input.value);
    label.textContent = formatMb(mb);
    if (hint) {
      hint.textContent =
        state.game === 'zomboid'
          ? mb < 4096 ? 'Fine for a few friends with few mods. Lots of mods need more.'
            : mb > state.totalMemoryMb * 0.6 ? `This PC has ${formatMb(state.totalMemoryMb)}. Leave some for Windows and Project Zomboid itself.`
            : `Good for most Zomboid servers. This PC has ${formatMb(state.totalMemoryMb)} in total.`
        : mb < 4096 ? 'Fine for small packs. Big modpacks may run out of memory.'
        : mb > state.totalMemoryMb * 0.6 ? `This PC has ${formatMb(state.totalMemoryMb)}. Leave some for Windows and Minecraft itself.`
        : `Good for most modpacks. This PC has ${formatMb(state.totalMemoryMb)} in total.`;
    }
  };
  input.oninput = update;
  update();
}

/**
 * Memory a Zomboid server needs: about 4 GB for the game, plus roughly 24 MB per
 * mod (maps and big mods weigh more, small ones less) and 128 MB per player slot.
 */
function recommendedZomboidRam(modCount = 0, players = 16) {
  const mb = 4096 + modCount * 24 + Math.min(players, 64) * 128;
  const cap = Math.max(4096, Math.floor((state.totalMemoryMb * 0.75) / 512) * 512);
  return Math.min(cap, Math.ceil(mb / 512) * 512);
}

/** "Suggested for N mods and M players: X GB [Use this]" under a memory slider. */
function showRamSuggestion(box, slider, label, modCount, players) {
  const mb = recommendedZomboidRam(modCount, players);
  const current = Number(slider.value);
  const button = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { slider.value = String(mb); slider.oninput(); showRamSuggestion(box, slider, label, modCount, players); } }, 'Use this');
  fill(box,
    el('span', {}, `Suggested for ${modCount} ${modCount === 1 ? 'mod' : 'mods'} and ${players} players: `, el('strong', {}, formatMb(mb))),
    current === mb ? el('span', { class: 'muted small' }, '✓ Using it') : button,
    current < mb - 1024 ? el('span', { class: 'muted small' }, 'Less than this may cause lag or crashes.') : null);
}

function recommendedRam(modCount = 100) {
  // The host's own default from App settings wins.
  if (state.app && state.app.defaultMemoryMb) return state.app.defaultMemoryMb;
  const want = modCount > 250 ? 8192 : modCount > 120 ? 6144 : 4096;
  return Math.min(want, Math.floor((state.totalMemoryMb * 0.5) / 512) * 512 || 4096);
}

// ---------- sidebar ----------

function statusWord(s) {
  if (s.status === 'installing') return 'Installing…';
  if (s.status === 'running') {
    const n = (state.players[s.id] || []).length;
    return n ? `Running · ${n} online` : 'Running';
  }
  if (s.status === 'starting') return 'Starting…';
  if (s.status === 'stopping') return 'Stopping…';
  if (s.installError) return 'Install failed';
  if (s.crashed) return 'Stopped unexpectedly';
  return 'Stopped';
}

const gameOf = (s) => s.game || 'minecraft';
const gameServers = () => state.servers.filter((s) => gameOf(s) === state.game);

const GAME_TEXT = {
  minecraft: {
    button: '+ New Minecraft server',
    title: 'Host a modded Minecraft server',
    text: 'Pick a modpack or one of your CurseForge profiles. EZ Host installs everything it needs, runs the server on this PC, and gives you an address your friends can join from anywhere.',
  },
  zomboid: {
    button: '+ New Zomboid server',
    title: 'Host a Project Zomboid server',
    text: 'Make a new dedicated server with its own world rules, map and Workshop mods (or a collection you made or favourited). Friends join from anywhere with the address it gives you.',
  },
};

/** Switch the sidebar to one game's section. `route` opens one of its servers (or its start page). */
function setGame(game, { route = true } = {}) {
  state.game = game;
  try { localStorage.setItem('game', game); } catch { /* storage blocked */ }
  document.querySelectorAll('.game-btn').forEach((b) => b.classList.toggle('active', b.dataset.game === game));
  $('new-server-btn').textContent = GAME_TEXT[game].button;
  $('empty-title').textContent = GAME_TEXT[game].title;
  $('empty-text').textContent = GAME_TEXT[game].text;
  renderServerList();
  if (!route) return;
  const s = current();
  if (s && gameOf(s) === game) return;
  const first = gameServers()[0];
  if (first) openServer(first.id);
  else {
    state.selectedId = null;
    document.documentElement.dataset.game = game;
    renderServerList();
    showView('empty');
  }
}

function renderServerList() {
  renderStrip();
  for (const g of ['minecraft', 'zomboid']) {
    const n = state.servers.filter((s) => gameOf(s) === g).length;
    $(`count-${g}`).textContent = n ? String(n) : '';
  }
  $('server-list').replaceChildren(
    ...gameServers().map((s) =>
      el('li', {
        class: `server-item${s.id === state.selectedId ? ' active' : ''}`,
        onclick: () => openServer(s.id),
        oncontextmenu: (e) => openMenu(e, s.id),
        title: 'Right-click for more options',
      },
        s.game === 'zomboid' ? el('div', { class: 'icon-fallback zb-head' }, '☣') : icon(s.source && (s.source.iconUrl || (s.source.type === 'vanilla' ? 'icon.svg' : null))),
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, s.name),
          el('div', { class: 'sub' }, statusWord(s))
        ),
        el('span', { class: `dot ${s.installError || s.crashed ? 'error' : s.status}` })
      )
    )
  );
}

/** HUD status strip: one square per server (click to open), totals, and a clock. */
function renderStrip() {
  const strip = $('hud-strip');
  if (!strip || document.documentElement.dataset.strip !== 'on') return;
  const running = state.servers.filter((s) => s.status === 'running');
  const players = running.reduce((n, s) => n + ((state.players[s.id] || []).length), 0);
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  fill(strip,
    el('strong', {}, 'EZH'),
    el('span', { class: 'sep' }, '|'),
    el('div', { class: 'cells' }, state.servers.map((s) => el('button', {
      class: `cell ${s.installError || s.crashed ? 'error' : s.status}${s.id === state.selectedId ? ' active' : ''}`,
      type: 'button',
      title: `${s.name} · ${statusWord(s)}`,
      onclick: () => openServer(s.id),
    }))),
    el('span', {}, `SRV ${pad(state.servers.length)}`),
    el('span', {}, 'ONLINE ', el('strong', { class: running.length ? 'live' : '' }, pad(running.length))),
    el('span', {}, 'PLAYERS ', el('strong', {}, pad(players))),
    el('span', {}, `LINK ${state.playit.linked ? (state.playit.state === 'running' ? 'UP' : 'READY') : 'OFF'}`),
    el('span', { class: 'spacer' }),
    el('span', {}, `${t.getFullYear()}.${pad(t.getMonth() + 1)}.${pad(t.getDate())}`),
    el('strong', {}, `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`));
}

function renderPlayitPill() {
  const p = state.playit;
  const text = !p.linked ? 'Online address: not set up'
    : p.state === 'running' ? 'Online addresses: on'
    : p.state === 'error' ? 'Online addresses: problem'
    : 'Online addresses: ready';
  $('playit-pill').replaceChildren(el('span', { class: `dot ${p.state === 'running' ? 'online' : p.state === 'error' ? 'error' : ''}` }), text);
}

async function refreshServers() {
  state.servers = (await attempt(() => api.listServers())) || [];
  renderServerList();
  const s = current();
  if (s) renderServer(s);
  else if (state.selectedId) {
    state.selectedId = null;
    setGame(state.game);
  }
}

// ---------- new server: step 1 ----------

function openNewServer() {
  state.selectedId = null;
  renderServerList();
  document.documentElement.dataset.game = state.game;
  if (state.game === 'zomboid') return openZomboidNew();
  showView('new');
  selectSource(state.source);
}

async function selectSource(source) {
  state.source = source;
  document.querySelectorAll('.source-tab').forEach((t) => t.classList.toggle('active', t.dataset.source === source));
  for (const s of ['profiles', 'modrinth', 'file', 'vanilla']) $(`source-${s}`).classList.toggle('hidden', s !== source);
  if (source === 'profiles') await loadProfiles();
  if (source === 'modrinth') {
    if (!$('search-results').children.length) search('');
    $('search-input').focus();
  }
}

async function loadProfiles(force = false) {
  if (!state.profiles || force) state.profiles = (await attempt(() => api.listProfiles())) || [];
  const usable = state.profiles.filter((p) => p.minecraft && p.modCount > 0);
  $('profiles-empty').classList.toggle('hidden', usable.length > 0);
  $('profile-results').replaceChildren(
    ...usable.map((p) =>
      el('button', { class: 'pack-card', type: 'button', onclick: () => chooseProfile(p) },
        el('div', { class: 'icon-fallback' }, '⛏'),
        el('div', {},
          el('div', { class: 'launcher' }, p.launcherName),
          el('div', { class: 'title' }, p.name),
          el('div', { class: 'tags' },
            el('span', { class: 'tag' }, `Minecraft ${p.minecraft}`),
            el('span', { class: 'tag' }, loaderName(p.loader, p.loaderVersion)),
            el('span', { class: 'tag' }, `${p.modCount} ${p.modCount === 1 ? 'mod' : 'mods'}`)
          )
        )
      )
    )
  );
}

let searchSeq = 0;
async function search(query) {
  const seq = ++searchSeq;
  $('search-status').textContent = 'Searching…';
  const result = await attempt(() => api.searchModpacks(query, { limit: 30 }));
  if (seq !== searchSeq || !result) return;
  $('search-status').textContent = result.hits.length
    ? query ? `${result.total} modpacks found` : 'Popular modpacks that run on servers'
    : 'No modpacks found. Try another name.';
  $('search-results').replaceChildren(
    ...result.hits.map((hit) =>
      el('button', { class: 'pack-card', type: 'button', onclick: () => chooseModrinthPack(hit) },
        icon(hit.iconUrl),
        el('div', {},
          el('div', { class: 'title' }, hit.title),
          el('div', { class: 'desc' }, hit.description),
          el('div', { class: 'tags' },
            hit.loaders.map((l) => el('span', { class: 'tag' }, LOADER_NAMES[l] || l)),
            hit.gameVersions.length ? el('span', { class: 'tag' }, hit.gameVersions[hit.gameVersions.length - 1]) : null,
            el('span', { class: 'tag' }, `${formatCount(hit.downloads)} downloads`)
          )
        )
      )
    )
  );
}

// ---------- new server: step 2 ----------

function openDetails({ title, description, iconUrl, name, ram }) {
  showView('details');
  delete $('server-name').dataset.touched;
  setTimeout(checkCreateForm, 0);
  const img = $('detail-icon');
  if (iconUrl) img.src = iconUrl;
  else img.src = 'icon.svg';
  $('detail-title').textContent = title;
  $('detail-desc').textContent = description || '';
  $('server-name').value = name;
  setupRamSlider($('server-ram'), $('ram-label'), ram, $('ram-hint'));
}

function chooseProfile(p) {
  state.pending = { kind: 'profile', profile: p };
  $('version-field').classList.add('hidden');
  $('mc-version-field').classList.add('hidden');
  openDetails({
    title: p.name,
    description: `${p.launcherName} profile · Minecraft ${p.minecraft} · ${loaderName(p.loader, p.loaderVersion)} · ${p.modCount} mods. The server will use the same mods, so this profile can join it.`,
    name: p.name,
    ram: recommendedRam(p.modCount),
  });
}

async function chooseModrinthPack(hit) {
  state.pending = { kind: 'modrinth', hit, versions: [] };
  $('version-field').classList.remove('hidden');
  $('mc-version-field').classList.add('hidden');
  openDetails({ title: hit.title, description: hit.description, iconUrl: hit.iconUrl, name: hit.title, ram: recommendedRam(150) });
  const select = $('pack-version');
  select.replaceChildren(el('option', {}, 'Loading versions…'));
  select.disabled = true;
  $('version-meta').textContent = '';
  const versions = await attempt(() => api.getModpackVersions(hit.id));
  if (!versions || state.pending.hit !== hit) return;
  state.pending.versions = versions;
  if (!versions.length) {
    select.replaceChildren(el('option', {}, 'No versions can be installed on a server'));
    return;
  }
  select.replaceChildren(
    ...versions.map((v) =>
      el('option', { value: v.id }, `${v.versionNumber} · Minecraft ${v.gameVersions.join(', ')} · ${v.loaders.map((l) => LOADER_NAMES[l] || l).join(', ')}`)
    )
  );
  select.disabled = false;
  select.onchange = updateVersionMeta;
  updateVersionMeta();
  checkCreateForm();
}

function updateVersionMeta() {
  const v = state.pending.versions.find((x) => x.id === $('pack-version').value);
  if (v) $('version-meta').textContent = `Released ${new Date(v.datePublished).toLocaleDateString()} · ${formatMb(Math.max(1, Math.round(v.file.size / 1048576)))} download`;
}

async function chooseVanilla() {
  state.pending = { kind: 'vanilla' };
  $('version-field').classList.add('hidden');
  $('mc-version-field').classList.remove('hidden');
  openDetails({
    title: 'Plain Minecraft',
    description: 'A normal Minecraft server with no mods.',
    name: 'Minecraft',
    ram: Math.min(3072, recommendedRam(0)),
  });
  const select = $('mc-version');
  select.replaceChildren(el('option', {}, 'Loading versions…'));
  select.disabled = true;
  const versions = await attempt(() => api.minecraftVersions());
  if (!versions || state.pending.kind !== 'vanilla') return;
  select.replaceChildren(...versions.map((v) => el('option', { value: v.id }, v.id)));
  select.disabled = false;
  const syncName = () => {
    const name = $('server-name');
    if (!name.value || /^Minecraft( [\d.]+)?$/.test(name.value)) name.value = `Minecraft ${select.value}`;
  };
  select.onchange = syncName;
  syncName();
  checkCreateForm();
}

// ---------- Project Zomboid: new server ----------

const zbCard = ({ title, sub, tags = [], image = null, glyph = '☣', label = 'Project Zomboid', selected = false, onclick }) =>
  el('button', { class: `pack-card${selected ? ' selected' : ''}`, type: 'button', onclick },
    image ? el('img', { src: image, alt: '' }) : el('div', { class: 'icon-fallback' }, glyph),
    el('div', {}, el('div', { class: 'launcher' }, label), el('div', { class: 'title' }, title), el('div', { class: 'desc' }, sub),
      el('div', { class: 'tags' }, tags.filter(Boolean).map((t) => el('span', { class: 'tag' }, t)))));

/** The host's Workshop collections, looked up once (it reads their Steam profile pages). */
function workshopCollections(force = false) {
  if (!state.collections || force) {
    state.collections = api.zomboidCollections().catch((err) => ({ collections: [], notes: [err.message], failed: true }));
  }
  return state.collections;
}

function zbRamSuggestion() {
  const z = state.zbNew;
  if (!z) return;
  const copied = z.copyFrom && z.configs.find((c) => c.name === z.copyFrom);
  const mods = (z.collection ? z.collection.items : 0) + (copied ? copied.mods : 0);
  const players = copied && copied.maxPlayers ? copied.maxPlayers : Number($('zbnew-max').value) || 16;
  showRamSuggestion($('zbnew-ram-suggest'), $('zbnew-ram'), $('zbnew-ram-label'), mods, players);
}

async function openZomboidNew() {
  showView('zbnew');
  state.zbNew = { copyFrom: null, collection: null, extra: [], configs: [], preset: 'Apocalypse', presets: [] };
  attempt(() => api.zomboidPresets()).then((p) => { if (state.zbNew) { state.zbNew.presets = p || []; renderZomboidNew(); } });
  $('zbnew-name').value = '';
  for (const id of ['zbnew-name', 'zbnew-max', 'zbnew-map', 'zbnew-link']) delete $(id).dataset.touched;
  $('zbnew-link').value = '';
  setupRamSlider($('zbnew-ram'), $('zbnew-ram-label'), recommendedZomboidRam(0, 16), $('zbnew-ram-hint'));
  const slide = $('zbnew-ram').oninput;
  $('zbnew-ram').oninput = () => { slide(); zbRamSuggestion(); };
  $('zbnew-max').oninput = zbRamSuggestion;
  renderZomboidNew();
  state.zbNew.configs = (await attempt(() => api.zomboidLocalConfigs())) || [];
  renderZomboidNew();
  fill($('zbnew-notes'), 'Looking for your Workshop collections on Steam…');
  const found = await workshopCollections();
  if (!state.zbNew) return;
  state.zbNew.found = found;
  renderZomboidNew();
}

function collectionCards(list, selectedId, onPick) {
  return list.map((c) => zbCard({
    title: c.title,
    sub: [c.source, c.account ? `on ${c.account}` : null].filter(Boolean).join(' '),
    tags: [`${c.items} items`],
    image: c.preview,
    label: 'Workshop collection',
    selected: selectedId === c.id,
    onclick: () => onPick(c),
  }));
}

function renderZomboidNew() {
  const z = state.zbNew;
  if (!z) return;
  $('zbnew-form').classList.toggle('copying', Boolean(z.copyFrom));
  fill($('zbnew-start'),
    zbCard({ title: 'A brand-new server', sub: 'Your own settings, map, mods and world rules, chosen here.', selected: !z.copyFrom, onclick: () => { z.copyFrom = null; renderZomboidNew(); } }),
    z.configs.map((c) => zbCard({
      title: `Copy "${c.name}"`,
      sub: 'A server you host from the game: same settings, mods and world rules.',
      tags: [`${c.mods} ${c.mods === 1 ? 'mod' : 'mods'}`, c.map, c.maxPlayers ? `${c.maxPlayers} players` : null],
      selected: z.copyFrom === c.name,
      onclick: () => {
        z.copyFrom = c.name;
        if (!$('zbnew-name').value.trim()) $('zbnew-name').value = c.name;
        renderZomboidNew();
      },
    })));
  fill($('zbnew-presets'),
    zbCard({ title: 'Game default', sub: 'Zomboid\'s standard server rules.', glyph: '⚙', label: 'World', selected: !z.preset, onclick: () => { z.preset = null; renderZomboidNew(); } }),
    z.presets.map((p) => zbCard({ title: p.name, sub: p.description || 'One of the game\'s own presets.', glyph: '☣', label: 'World', selected: z.preset === p.id, onclick: () => { z.preset = p.id; renderZomboidNew(); } })));
  const found = z.found ? z.found.collections : [];
  const list = [...z.extra, ...found.filter((c) => !z.extra.some((x) => x.id === c.id))];
  fill($('zbnew-collections'),
    zbCard({ title: z.copyFrom ? 'Keep its mods' : 'No mods', sub: z.copyFrom ? 'Only the mods the copied server already uses.' : 'Plain Project Zomboid. You can add mods later.', glyph: '∅', label: 'Mods', selected: !z.collection, onclick: () => { z.collection = null; renderZomboidNew(); } }),
    collectionCards(list, z.collection && z.collection.id, (c) => {
      z.collection = c;
      $('zbnew-ram').value = String(recommendedZomboidRam(c.items, Number($('zbnew-max').value) || 16));
      $('zbnew-ram').oninput();
      renderZomboidNew();
    }));
  if (z.found) fill($('zbnew-notes'), z.found.notes.map((n) => el('div', {}, n)));
  zbRamSuggestion();
  checkZomboidForm();
  $('zbnew-summary').textContent = [
    z.copyFrom ? `Copy of ${z.copyFrom}` : `New world${z.preset ? ` (${(z.presets.find((p) => p.id === z.preset) || {}).name || z.preset})` : ''}`,
    z.collection ? `+ ${z.collection.title} (${z.collection.items} mods)` : null,
  ].filter(Boolean).join(' ');
}

/** Read a pasted collection link and add it to a list of choices. */
async function previewCollectionLink(input, button) {
  const link = input.value.trim();
  if (!link) return null;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const c = await attempt(() => api.previewZomboidCollection(link));
    return c ? { ...c, source: 'From a link', preview: null } : null;
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.label;
  }
}

async function useZomboidNewLink() {
  const c = await previewCollectionLink($('zbnew-link'), $('zbnew-link-btn'));
  if (!c || !state.zbNew) return;
  state.zbNew.extra = [c, ...state.zbNew.extra.filter((x) => x.id !== c.id)];
  state.zbNew.collection = c;
  $('zbnew-link').value = '';
  renderZomboidNew();
}

/** Zomboid will not start without these, so a server cannot be made without them. */
function checkZomboidForm() {
  const z = state.zbNew;
  if (!z) return false;
  const name = $('zbnew-name');
  const max = $('zbnew-max');
  const map = $('zbnew-map');
  const players = Number(max.value);
  return requireFields('zbnew-required', 'zbnew-create', [
    [name.value.trim().length > 0, 'Give the server a name. Zomboid will not start without one.', name],
    [Boolean(z.copyFrom) || (Number.isInteger(players) && players >= 1 && players <= 100), 'Set max players to a number from 1 to 100.', max],
    [Boolean(z.copyFrom) || map.value.trim().length > 0, 'Choose a map (Muldraugh, KY is the normal one).', map],
    [!$('zbnew-link').value.trim(), 'Press "Use this link" for the collection link you pasted, or clear the box.', $('zbnew-link')],
    [Number($('zbnew-ram').value) >= 2048, 'Give the server at least 2 GB of memory.'],
  ]);
}

async function createZomboidServer(event) {
  event.preventDefault();
  const z = state.zbNew;
  for (const id of ['zbnew-name', 'zbnew-max', 'zbnew-map', 'zbnew-link']) $(id).dataset.touched = '1';
  if (!checkZomboidForm()) return;
  const name = $('zbnew-name').value.trim();
  const created = await attempt(() => api.createZomboid({
    name,
    memoryMb: Number($('zbnew-ram').value),
    copyFrom: z.copyFrom,
    collectionId: z.collection ? z.collection.id : null,
    preset: z.copyFrom ? null : z.preset,
    options: z.copyFrom ? null : {
      Open: !$('zbnew-whitelist').checked,
      PauseEmpty: $('zbnew-pause').checked,
      PlayerSafehouse: $('zbnew-safehouse').checked,
      SleepAllowed: $('zbnew-sleep').checked,
      GlobalChat: $('zbnew-chat').checked,
      DisplayUserName: $('zbnew-names').checked,
      HoursForLootRespawn: Number($('zbnew-loot').value),
      SaveWorldEveryMinutes: Number($('zbnew-save').value),
      ...($('zbnew-welcome').value.trim() ? { ServerWelcomeMessage: $('zbnew-welcome').value.trim() } : {}),
    },
    settings: z.copyFrom ? { PublicName: name } : {
      PublicName: name,
      MaxPlayers: Number($('zbnew-max').value),
      Password: $('zbnew-pass').value,
      Map: $('zbnew-map').value,
      PVP: $('zbnew-pvp').checked,
      Public: $('zbnew-public').checked,
    },
  }));
  if (created) {
    state.zbNew = null;
    await refreshServers();
    openServer(created.id);
  }
}

// ---------- Project Zomboid: collections on an existing server ----------

async function loadServerCollections(force = false) {
  const id = state.selectedId;
  fill($('zb-coll-notes'), 'Looking for your Workshop collections on Steam…');
  if (force) fill($('zb-collections'));
  const found = await workshopCollections(force);
  if (state.selectedId !== id) return;
  fill($('zb-collections'), collectionCards(found.collections, null, (c) => addCollection(c)));
  fill($('zb-coll-notes'), found.notes.map((n) => el('div', {}, n)));
}

async function addCollection(c) {
  const s = current();
  if (!s) return;
  if (s.status !== 'stopped') return toast('Stop the server before adding mods', true);
  const ok = await confirmDialog(`Download and turn on the ${c.items} items in "${c.title}"? Mods already on stay on.`, { title: 'Add collection', confirmText: 'Add mods', danger: false });
  if (!ok) return;
  toast(`Adding "${c.title}". Progress shows in the Console tab.`);
  const r = await attempt(() => api.installZomboidCollection(s.id, c.id));
  if (r) {
    toast(`Turned on ${r.added} mod(s) from "${c.title}".${r.unreadable ? ` ${r.unreadable} item(s) are maps or could not be read.` : ''}`);
    loadMods();
  }
}

async function addCollectionLink() {
  const c = await previewCollectionLink($('zb-coll-link'), $('zb-coll-link-btn'));
  if (!c) return;
  $('zb-coll-link').value = '';
  addCollection(c);
}

// ---------- Project Zomboid: world rules ----------

async function loadWorldRules() {
  const s = current();
  if (!s || s.game !== 'zomboid') return;
  state.ruleEdits = {};
  $('zb-rules-saved').textContent = '';
  const r = await attempt(() => api.zomboidSandbox(s.id));
  if (!r || state.selectedId !== s.id) return;
  state.rules = r;
  renderWorldRules();
  const presets = (await attempt(() => api.zomboidPresets())) || [];
  fill($('zb-rules-preset'), presets.map((p) => el('option', { value: p.id }, p.name)));
}

async function applyWorldPreset() {
  const s = current();
  const id = $('zb-rules-preset').value;
  if (!id) return;
  const name = $('zb-rules-preset').selectedOptions[0].textContent;
  if (!(await confirmDialog(`Set every world rule to the "${name}" preset? Rules from mods stay as they are.`, { title: 'Apply preset', confirmText: 'Apply', danger: false }))) return;
  const r = await attempt(() => api.applyZomboidPreset(s.id, id));
  if (r) {
    state.rules = r;
    state.ruleEdits = {};
    renderWorldRules();
    $('zb-rules-saved').textContent = `Applied "${name}". It applies on the next start.`;
  }
}

function ruleControl(f, edits = state.ruleEdits, status = $('zb-rules-saved')) {
  const key = f.path || f.key;
  const value = key in edits ? edits[key] : f.value;
  const set = (v) => {
    if (v === f.value) delete edits[key];
    else edits[key] = v;
    status.textContent = Object.keys(edits).length ? `${Object.keys(edits).length} unsaved change(s)` : '';
  };
  if (f.type === 'bool') {
    const box = el('input', { type: 'checkbox' });
    box.checked = value;
    box.onchange = () => set(box.checked);
    return el('label', { class: 'checkbox' }, box, f.label);
  }
  let input;
  if (f.type === 'choice') {
    input = el('select', {}, f.choices.map((c) => el('option', { value: String(c.value) }, c.label)));
    input.value = String(value);
    input.onchange = () => set(Number(input.value));
  } else if (f.type === 'number') {
    input = el('input', { type: 'number', step: f.decimal ? 'any' : '1', min: f.min, max: f.max });
    input.value = String(value);
    input.onchange = () => {
      let n = Number(input.value);
      if (!Number.isFinite(n)) n = f.value;
      if (f.min !== undefined) n = Math.max(f.min, n);
      if (f.max !== undefined) n = Math.min(f.max, n);
      input.value = String(n);
      set(n);
    };
  } else {
    input = el('input', { type: 'text' });
    input.value = value;
    input.onchange = () => set(input.value);
  }
  return [el('div', { class: 'rule-label' }, f.label), input];
}

function ruleEl(f, edits, status) {
  return el('div', { class: 'rule' }, ruleControl(f, edits, status),
    f.help ? el('div', { class: 'rule-help' }, f.help + (f.min !== undefined ? ` (${f.min} to ${f.max})` : '')) : null);
}

const GROUP_NAMES = { General: 'World', ZombieLore: 'Zombies', ZombieConfig: 'Zombie population', MultiplierConfig: 'XP multipliers', Map: 'Map', Basement: 'Basements' };

function renderWorldRules() {
  const r = state.rules;
  const s = current();
  const running = s && s.status !== 'stopped';
  $('zb-rules-save').disabled = running;
  if (!r || r.missing) {
    fill($('zb-rules'), el('p', { class: 'muted' }, 'This server has no world rules file yet. Start it once and they appear here.'));
    return;
  }
  const q = $('zb-rules-search').value.trim().toLowerCase();
  const byPath = new Map(r.fields.map((f) => [f.path, f]));
  if (q) {
    const hits = r.fields.filter((f) => `${f.label} ${f.help} ${f.path}`.toLowerCase().includes(q));
    fill($('zb-rules'), hits.length ? el('div', { class: 'rules-grid' }, hits.slice(0, 80).map((f) => ruleEl(f))) : el('p', { class: 'muted' }, 'No rules match.'));
    return;
  }
  const groups = new Map();
  for (const f of r.fields) {
    const g = f.mod ? f.group : f.group.split('.')[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  fill($('zb-rules'),
    running ? el('p', { class: 'notice' }, 'Stop the server to change world rules.') : null,
    el('details', { class: 'rules-group', open: '' }, el('summary', {}, 'Most changed'),
      el('div', { class: 'rules-grid' }, r.common.map((p) => byPath.get(p)).filter(Boolean).map((f) => ruleEl(f)))),
    [...groups].sort((a, b) => a[0].startsWith('Mod: ') - b[0].startsWith('Mod: ')).map(([g, fields]) => el('details', { class: 'rules-group' },
      el('summary', {}, `${GROUP_NAMES[g] || g} (${fields.length})`),
      el('div', { class: 'rules-grid' }, fields.map((f) => ruleEl(f))))));
}

// ---------- Project Zomboid: all server options ----------

async function loadServerOptions() {
  const s = current();
  if (!s || s.game !== 'zomboid') return;
  state.optionEdits = {};
  $('zb-options-saved').textContent = '';
  const r = await attempt(() => api.zomboidServerOptions(s.id));
  if (!r || state.selectedId !== s.id) return;
  state.options = r;
  renderServerOptions();
}

function renderServerOptions() {
  const r = state.options;
  const s = current();
  const running = s && s.status !== 'stopped';
  const status = $('zb-options-saved');
  $('zb-options-save').disabled = running;
  if (!r || r.missing) return fill($('zb-options'), el('p', { class: 'muted' }, 'Start the server once and its options appear here.'));
  const item = (f) => ruleEl(f, state.optionEdits, status);
  const q = $('zb-options-search').value.trim().toLowerCase();
  if (q) {
    const hits = r.fields.filter((f) => `${f.label} ${f.help} ${f.key}`.toLowerCase().includes(q));
    return fill($('zb-options'), hits.length ? el('div', { class: 'rules-grid' }, hits.slice(0, 80).map(item)) : el('p', { class: 'muted' }, 'No options match.'));
  }
  const groups = new Map();
  for (const f of r.fields) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  fill($('zb-options'),
    running ? el('p', { class: 'notice' }, 'Stop the server to change its options.') : null,
    [...groups].map(([g, fields]) => el('details', { class: 'rules-group' },
      el('summary', {}, `${g} (${fields.length})`),
      el('div', { class: 'rules-grid' }, fields.map(item)))));
}

async function saveServerOptions() {
  const s = current();
  if (!Object.keys(state.optionEdits || {}).length) {
    $('zb-options-saved').textContent = 'Nothing changed.';
    return;
  }
  const r = await attempt(() => api.saveZomboidServerOptions(s.id, state.optionEdits));
  if (r) {
    state.options = r;
    state.optionEdits = {};
    renderServerOptions();
    $('zb-options-saved').textContent = 'Saved. They apply on the next start.';
    loadZomboidSettings();
  }
}

async function saveWorldRules() {
  const s = current();
  if (!Object.keys(state.ruleEdits).length) {
    $('zb-rules-saved').textContent = 'Nothing changed.';
    return;
  }
  const r = await attempt(() => api.saveZomboidSandbox(s.id, state.ruleEdits));
  if (r) {
    state.rules = r;
    state.ruleEdits = {};
    renderWorldRules();
    $('zb-rules-saved').textContent = 'Saved. They apply on the next start.';
    refreshServers();
  }
}

/**
 * Show what still has to be filled in before a server can be made, and keep the
 * Create button off until it is. `checks` is [[ok, message, input?], ...].
 */
function requireFields(listId, buttonId, checks) {
  const missing = checks.filter(([ok]) => !ok);
  fill($(listId), missing.map(([, text]) => el('li', {}, text)));
  for (const [ok, , input] of checks) if (input) input.classList.toggle('missing', !ok && input.dataset.touched === '1');
  $(buttonId).disabled = missing.length > 0;
  return missing.length === 0;
}

function checkCreateForm() {
  const p = state.pending;
  if (!p) return false;
  const name = $('server-name');
  const vanilla = p.kind === 'vanilla';
  const pack = p.kind === 'modrinth';
  return requireFields('create-required', 'create-submit', [
    [name.value.trim().length > 0, 'Give the server a name.', name],
    [!vanilla || Boolean($('mc-version').value), 'Choose a Minecraft version.'],
    [!pack || Boolean($('pack-version').value), 'Choose a modpack version.'],
    [Number($('server-ram').value) >= 2048, 'Give the server at least 2 GB of memory.'],
  ]);
}

async function createServer(event) {
  event.preventDefault();
  const p = state.pending;
  if (!p) return;
  $('server-name').dataset.touched = '1';
  if (!checkCreateForm()) return;
  const common = { name: $('server-name').value.trim(), memoryMb: Number($('server-ram').value) };
  const created = await attempt(() =>
    p.kind === 'profile' ? api.createFromProfile({ ...common, profileId: p.profile.id })
    : p.kind === 'vanilla' ? api.createVanilla({ ...common, minecraft: $('mc-version').value })
    : api.createFromModrinth({ ...common, projectId: p.hit.id, versionId: $('pack-version').value })
  );
  if (created) {
    await refreshServers();
    openServer(created.id);
  }
}

async function importFile() {
  const created = await attempt(() => api.createFromFile({ memoryMb: recommendedRam(150) }));
  if (created) {
    await refreshServers();
    openServer(created.id);
  }
}

// ---------- server page ----------

async function openServer(id) {
  if (state.selectedId !== id) {
    state.fileDir = '.';
    state.fileEditorPath = null;
    $('file-editor').classList.add('hidden');
  }
  state.selectedId = id;
  const target = state.servers.find((x) => x.id === id);
  if (target && gameOf(target) !== state.game) setGame(gameOf(target), { route: false });
  renderServerList();
  showView('server');
  const s = current() || (await attempt(() => api.getServer(id)));
  if (!s) return;
  state.players[id] = (await attempt(() => api.getPlayers(id))) || [];
  state.tunnels[id] = (await attempt(() => api.getTunnel(id))) || {};
  renderServer(s);
  switchTab(s.status === 'installing' || s.installError || s.crashed ? 'console' : s.worldSetupPending ? 'settings' : 'friends');
  const history = (await attempt(() => api.getConsole(id))) || [];
  $('console').replaceChildren();
  history.forEach(appendConsole);
  $('console').scrollTop = $('console').scrollHeight;
  loadShare(id);
}

function renderServer(s) {
  document.documentElement.dataset.game = s.game || 'minecraft';
  document.querySelector('.tab[data-tab="world"]').textContent = s.game === 'zomboid' ? 'Map' : 'World';
  if (s.startup) state.startup[s.id] = s.startup;
  else if (s.status !== 'starting') delete state.startup[s.id];
  $('srv-name').textContent = s.name;
  $('srv-icon').src = (s.source && s.source.iconUrl) || 'icon.svg';
  const parts = [];
  if (s.game === 'zomboid') parts.push('Project Zomboid', s.packName && s.packName !== 'Project Zomboid' ? s.packName : null);
  else if (s.loader === 'vanilla') parts.push('No mods');
  else if (s.packName) parts.push(`${s.packName} ${s.packVersion || ''}`.trim());
  if (s.minecraft) parts.push(`Minecraft ${s.minecraft}`);
  if (s.loader && s.loader !== 'vanilla') parts.push(loaderName(s.loader, s.loaderVersion));
  parts.push(`${formatMb(s.memoryMb)} memory`);
  $('srv-meta').textContent = parts.filter(Boolean).join(' · ');
  renderStatus(s);
  $('share-card').classList.toggle('hidden', !s.installed);
  renderOnlineBox();
}

function renderStatus(s) {
  const card = $('status-card');
  const players = state.players[s.id] || [];
  let dot = s.status;
  let text = statusWord(s);
  let help = '';
  let problem = false;

  if (s.status === 'installing') {
    help = s.game === 'zomboid'
      ? 'Finishing Project Zomboid setup. The first install downloads the dedicated server and creates its world settings.'
      : 'Setting everything up. Big modpacks can take a few minutes.';
  } else if (s.installError) {
    problem = true;
    dot = 'error';
    help = s.installError;
  } else if (s.game === 'zomboid' && !s.installed) {
    help = hasPermission('settings')
      ? 'Project Zomboid setup did not finish. Continue setup to resume it; existing server files and world settings will be kept.'
      : 'Project Zomboid setup did not finish. Ask the host to continue setup before starting the server.';
  } else if (s.status === 'starting') {
    const startup = state.startup[s.id];
    help = s.game === 'zomboid'
      ? `${(startup && startup.label) || 'Starting the Project Zomboid server'}. With many mods this can take several minutes; Console shows the latest details.`
      : startup
        ? `${startup.label || 'Starting Minecraft server'}. Large Forge packs can take several minutes; Console shows the latest details.`
        : 'Loading mods and the world. Large modpacks can take several minutes.';
  } else if (s.status === 'running') {
    help = players.length ? 'Players online:' : 'Your server is up. Share the address below with your friends.';
  } else if (s.status === 'stopping') {
    help = 'Saving the world…';
  } else if (s.crashed) {
    problem = true;
    dot = 'error';
    const f = s.lastFailure;
    const fixed = f && f.mods ? f.mods.filter((m) => m.clientOnly).map((m) => m.name) : [];
    help = fixed.length
      ? `${fixed.join(', ')} only work${fixed.length === 1 ? 's' : ''} in the game, not on a server, so EZ Host turned ${fixed.length === 1 ? 'it' : 'them'} off and is trying again. See the Mods tab.`
      : f && f.summary ? f.summary : 'The server stopped by itself. The Console tab shows what went wrong.';
  } else if (!s.eulaAccepted) {
    help = 'Ready for its first start. You will be asked to accept the Minecraft EULA.';
  } else {
    help = 'Press Start when you are ready to play.';
  }

  card.classList.toggle('running', s.status === 'running');
  card.classList.toggle('problem', problem);
  $('status-dot').className = `dot big ${dot}`;
  $('status-text').textContent = text;
  $('status-help').textContent = help;

  const live = ['starting', 'running', 'stopping'].includes(s.status);
  const canResumeZomboidSetup = s.game === 'zomboid' && !s.installed && s.status !== 'installing' && !live;
  const startButton = $('srv-start');
  startButton.classList.toggle('hidden', live || s.status === 'installing');
  startButton.textContent = canResumeZomboidSetup
    ? (s.installError ? 'Retry setup' : 'Finish setup')
    : 'Start server';
  $('srv-stop').classList.toggle('hidden', !live);
  startButton.disabled = s.status === 'installing'
    || (canResumeZomboidSetup ? !hasPermission('settings') : !s.installed);
  startButton.title = canResumeZomboidSetup && !hasPermission('settings')
    ? 'Ask the host to finish Project Zomboid setup'
    : '';
  $('srv-stop').disabled = s.status === 'stopping';
  $('command-input').disabled = !live;

  $('install-progress').classList.toggle('hidden', s.status !== 'installing');
  if (s.status === 'installing') renderInstall(s.id);
  $('startup-progress').classList.toggle('hidden', s.status !== 'starting');
  if (s.status === 'starting') renderStartup(s.id);

  const box = $('players');
  box.classList.toggle('hidden', s.status !== 'running' || !players.length);
  box.replaceChildren(...players.map((p) => el('span', { class: 'player' }, p)));
}

function renderStartup(id) {
  const zb = current() && current().game === 'zomboid';
  const info = state.startup[id] || { label: zb ? 'Starting the Project Zomboid server' : 'Starting Minecraft server', startedAt: Date.now() };
  const bar = $('startup-progress-bar');
  const label = $('startup-label');
  const elapsed = $('startup-elapsed');
  if (!bar || !label || !elapsed) return;
  label.textContent = info.label || (zb ? 'Starting the Project Zomboid server' : 'Starting Minecraft server');
  const seconds = Math.max(0, Math.floor((Date.now() - (info.startedAt || Date.now())) / 1000));
  elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('startup-guidance').textContent = seconds >= 300
    ? 'This is taking a while. Check Console for errors or a stalled download; the elapsed time and current phase are shown above.'
    : zb ? 'With many Workshop mods this can take several minutes. Check Console for details.'
    : 'Large Forge packs can take several minutes. Check Console for detailed startup output.';
  const progress = info.progress;
  const determinate = progress && Number(progress.total) > 0;
  bar.classList.toggle('indeterminate', !determinate);
  if (determinate) {
    const percent = Math.max(0, Math.min(100, (Number(progress.done) / Number(progress.total)) * 100));
    bar.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    elapsed.textContent += ` · ${Math.round(percent)}%`;
  } else {
    bar.style.removeProperty('width');
    bar.removeAttribute('aria-valuenow');
  }
}

/** Map install messages to the four friendly steps. */
function noteInstallMessage(id, message) {
  const info = state.install[id] || (state.install[id] = { step: 0 });
  if (/Java/.test(message)) info.step = Math.max(info.step, 1);
  if (/(Fabric|Quilt|Forge|NeoForge) .*(installer|launcher)|Installing (Forge|NeoForge|Quilt)|Minecraft .* server\.\.\./.test(message)) info.step = Math.max(info.step, 2);
  if (/Install complete/.test(message)) info.step = 3;
}

function renderInstall(id) {
  const info = state.install[id] || { step: 0 };
  $('install-steps').replaceChildren(
    ...INSTALL_STEPS.map((label, i) => el('li', { class: i < info.step ? 'done' : i === info.step ? 'active' : '' }, label))
  );
  const bar = $('progress-bar');
  if (info.total) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.round((info.done / info.total) * 100)}%`;
    $('progress-label').textContent = info.label === 'Mods'
      ? `${info.done} of ${info.total} files`
      : `${formatMb(Math.round(info.done / 1048576))} of ${formatMb(Math.round(info.total / 1048576))}`;
  } else {
    bar.classList.add('indeterminate');
    bar.style.width = '';
    $('progress-label').textContent = '';
  }
}

// ---------- share with friends ----------

async function loadShare(id) {
  const info = await attempt(() => api.joinInfo(id));
  if (!info || id !== state.selectedId) return;
  state.join[id] = info;
  const rows = [['On this PC', info.local], ...info.lan.map((l) => ['Same Wi-Fi / home network', l.address])];
  $('lan-addresses').replaceChildren(
    ...rows.map(([who, address]) => el('div', { class: 'address' }, el('span', { class: 'who' }, who), el('code', {}, address), copyButton(address)))
  );
  renderOnlineBox();
}

/** "How friends join" for Zomboid: the IP and port to type, and three steps. */
function renderZomboidJoin() {
  const s = current();
  if (!s || s.game !== 'zomboid') return;
  const t = state.tunnels[s.id] || {};
  const info = state.join[s.id];
  const address = t.address || (info && ((info.lan[0] && info.lan[0].address) || info.local)) || '';
  const cut = address.lastIndexOf(':');
  const ip = cut > 0 ? address.slice(0, cut) : address;
  const port = cut > 0 ? address.slice(cut + 1) : String(s.port || 16261);
  const box = (label, value) => el('div', { class: 'zb-join-box' }, el('span', { class: 'muted small' }, label),
    el('div', { class: 'row' }, el('code', {}, value || '—'), value ? copyButton(value) : null));
  fill($('zb-join'),
    t.address ? null : el('p', { class: 'muted small' }, 'Set up the online address above so friends outside your home can join. Until then this is your home-network address.'),
    el('div', { class: 'zb-join-boxes' }, box('IP', ip), box('Port', port)),
    el('ol', { class: 'zb-join-steps' },
      el('li', {}, 'Open Project Zomboid and click ', el('strong', {}, 'Join'), '.'),
      el('li', {}, 'Click ', el('strong', {}, 'Add server'), ', paste the IP and Port above, and save.'),
      el('li', {}, 'Pick the server and click ', el('strong', {}, 'Join'), '. Mods download by themselves.')),
    el('p', { class: 'muted small' }, 'Whitelist on? They sign in with the username and password you made for them on the Players tab.'));
}

function renderOnlineBox() {
  const s = current();
  if (!s) return;
  renderZomboidJoin();
  const p = state.playit;
  const t = state.tunnels[s.id] || {};
  const running = ['starting', 'running'].includes(s.status);
  let content;

  if (p.state === 'linking') {
    content = el('div', { class: 'notice' },
      el('strong', {}, 'Finish in your browser'),
      el('p', {}, 'Sign in or make a free playit.gg account, then approve EZ Host. This page updates by itself.'),
      p.claimUrl ? el('a', { href: p.claimUrl, target: '_blank', rel: 'noreferrer' }, 'Open the approval page again') : null
    );
  } else if (!p.linked) {
    content = el('div', { class: 'notice' },
      el('strong', {}, 'Let friends join from anywhere'),
      el('p', {}, 'EZ Host uses playit.gg, a free service, to give each server its own online address. No router settings needed. You link it once, in your browser.'),
      p.message ? el('p', { class: 'small' }, p.message) : null,
      el('button', { class: 'btn btn-primary', onclick: () => attempt(() => api.playitLink()) }, 'Connect playit.gg')
    );
  } else if (t.state === 'error') {
    content = el('div', { class: 'notice error' },
      el('strong', {}, 'The online address is not working'),
      el('p', {}, t.message || 'Something went wrong with playit.gg.'),
      running ? el('button', { class: 'btn', onclick: () => attempt(() => api.playitRetry(s.id)) }, 'Try again') : null
    );
  } else if (t.address) {
    const status = t.state === 'online' && running ? 'Friends can join with this address now.'
      : t.state === 'starting' ? 'Connecting…'
      : 'This is the server\'s address. It works while the server is running.';
    content = el('div', { class: 'online-box' },
      el('div', { class: 'address-big' }, el('code', {}, t.address), copyButton(t.address)),
      el('p', { class: 'muted small' }, status),
      t.message ? el('p', { class: 'small' }, t.message) : null,
      t.resolveLink ? el('a', { href: t.resolveLink, target: '_blank', rel: 'noreferrer' }, 'Fix this on playit.gg') : null,
      el('details', { class: 'lan' },
        el('summary', {}, 'Change this address'),
        el('div', { class: 'card', style: null },
          el('p', { class: 'small' }, 'Each server has its own address. The free playit.gg plan picks the name for you, but you can swap it for a new random one. Friends will need the new address.'),
          el('p', { class: 'small muted' }, 'Choosing your own name (like myserver.joinmc.link) needs playit.gg Premium or a domain you own. You set that up on the playit.gg website.'),
          el('div', { class: 'address-actions' },
            el('button', { class: 'btn', type: 'button', onclick: () => newAddress(s) }, 'Get a new random address'),
            el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => attempt(() => api.openExternal('https://playit.gg/account/tunnels')) }, 'Open playit.gg')
          )
        )
      )
    );
  } else if (t.state === 'starting') {
    content = el('p', { class: 'muted' }, 'Getting this server\'s online address…');
  } else {
    content = el('p', { class: 'muted' }, 'Start the server to get its online address. Each server gets its own.');
  }
  $('online-box').replaceChildren(content);

  $('playit-settings-text').textContent = p.linked
    ? 'This PC is linked to playit.gg. Disconnecting removes the link from this PC only.'
    : 'Not connected.';
  $('playit-unlink').disabled = !p.linked;
}

async function newAddress(s) {
  if (!(await confirmDialog(`Get a new online address for "${s.name}"? The old address stops working and friends will need the new one.`, {
    title: 'Get a new online address?', confirmText: 'Get new address', danger: false,
  }))) return;
  await attempt(() => api.newAddress(s.id));
  state.tunnels[s.id] = (await attempt(() => api.getTunnel(s.id))) || {};
  renderOnlineBox();
}

// ---------- players ----------

const headUrl = (uuid, size = 64) => `https://mc-heads.net/avatar/${uuid}/${size}`;

/** A player head with a crown for OPs and a red dot for banned players. */
function headEl(idOrName, size, { op = false, banned = false } = {}) {
  // Zomboid players have no Minecraft skin; show a plain badge instead.
  if (String(idOrName).startsWith('zomboid:')) {
    const wrap = el('span', { class: 'head-wrap', title: op ? 'Admin' : banned ? 'Banned' : null }, el('span', { class: 'icon-fallback zb-head' }, '☣'));
    wrap.firstChild.style.width = wrap.firstChild.style.height = `${size}px`;
    if (op) wrap.append(crownSvg());
    if (banned) wrap.append(el('span', { class: 'ban' }));
    return wrap;
  }
  const wrap = el('span', { class: 'head-wrap', title: op ? 'Operator (OP)' : banned ? 'Banned' : null });
  wrap.append(el('img', { src: headUrl(idOrName, size), alt: '', width: size, height: size }));
  if (op) wrap.append(crownSvg());
  if (banned) wrap.append(el('span', { class: 'ban' }));
  return wrap;
}

function crownSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('class', 'crown');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M2 14 0 3l6 4 6-7 6 7 6-4-2 11Z');
  path.setAttribute('fill', '#f5c518');
  path.setAttribute('stroke', '#7a5a00');
  path.setAttribute('stroke-width', '1.2');
  svg.append(path);
  return svg;
}

// ---------- whitelist ----------

async function loadWhitelist() {
  const id = state.selectedId;
  const wl = await attempt(() => api.whitelistStatus(id));
  if (wl && id === state.selectedId) renderWhitelist(wl);
}

function renderWhitelist(wl) {
  const s = current();
  if (!s) return;
  $('wl-enabled').checked = wl.enabled;
  $('wl-switch-label').textContent = wl.enabled ? 'Whitelist on' : 'Whitelist off';
  $('wl-name').placeholder = wl.needsPassword ? 'Zomboid username' : 'Minecraft username';
  if (wl.needsPassword) {
    $('wl-help').textContent = wl.enabled
      ? 'Only players with an account on this server can join. Add a username and the app makes a password for them to use. The server must be running to add or remove players.'
      : 'Anyone who has the server address can join and make their own account. Turn the whitelist on to choose who gets in.';
  } else $('wl-help').textContent = wl.enabled
    ? 'Only the players below can join. Anyone else is turned away and shows up under "Trying to join".'
    : 'Anyone who has the server address can join. Turn the whitelist on to choose who gets in.';
  const remove = (name) => async () => {
    if (await attempt(async () => (await api.whitelistRemove(s.id, name), true))) loadWhitelist();
  };
  fill($('wl-list'),
    wl.players.length ? null : el('li', { class: 'muted' }, 'Nobody yet. Add your own username first.'),
    wl.players.map((p) => el('li', {},
      wl.needsPassword ? headEl(`zomboid:${p.name}`, 24) : el('img', { src: headUrl(p.uuid || p.name, 24), alt: '' }),
      p.name,
      el('button', { type: 'button', title: `Remove ${p.name}`, onclick: remove(p.name) }, '×')
    ))
  );
  const refused = wl.refused;
  $('wl-refused').classList.toggle('hidden', !wl.enabled || !refused.length);
  fill($('wl-refused'),
    el('strong', {}, 'Trying to join'),
    el('div', { class: 'join-requests' },
      refused.map((name) => el('div', { class: 'join-request' },
        el('img', { src: headUrl(name, 32), alt: '' }),
        el('span', { class: 'who' }, name),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => addToWhitelist(name) }, 'Approve'),
        el('button', { class: 'btn', type: 'button', onclick: async () => {
          await attempt(() => api.whitelistDeny(s.id, name));
          loadWhitelist();
        } }, 'Deny')
      ))
    )
  );
}

async function addToWhitelist(name) {
  const id = state.selectedId;
  if ((current() && current().game === 'zomboid')) {
    const result = await attempt(() => api.whitelistAdd(id, name));
    if (!result) return false;
    const box = el('div', { class: 'secret-box' },
      el('span', {}, `Send ${result.name} this password:`), el('code', {}, result.password), copyButton(result.password));
    let secret = document.getElementById('wl-secret');
    if (!secret) {
      secret = el('div', { id: 'wl-secret', class: 'wl-refused' });
      $('wl-form').after(secret);
    }
    fill(secret, el('strong', {}, `${result.name} can now join`), box,
      el('p', { class: 'muted small' }, 'They log in with this username and password. It is shown once, so copy it now.'));
    loadWhitelist();
    return true;
  }
  if (await attempt(async () => (await api.whitelistAdd(id, name), true))) {
    toast(`${name} can now join`);
    loadWhitelist();
    return true;
  }
  return false;
}

async function loadPlayers() {
  const id = state.selectedId;
  loadWhitelist();
  const list = (await attempt(() => api.listPlayers(id))) || [];
  if (id !== state.selectedId) return;
  state.playerList = list;
  if (!list.some((p) => p.uuid === state.playerUuid)) state.playerUuid = list.length ? list[0].uuid : null;
  fill($('player-list'), list.length ? null : el('li', { class: 'muted' }, 'Nobody has joined yet.'),
    ...list.map((p) =>
      el('li', {
        class: p.uuid === state.playerUuid ? 'active' : '',
        onclick: () => showPlayer(p.uuid),
        oncontextmenu: (e) => openPlayerMenu(e, p),
      },
        headEl(p.uuid, 28, p),
        el('span', { class: 'pname' }, p.name || p.uuid.slice(0, 8)),
        p.banned ? el('span', { class: 'tag' }, 'Banned') : null,
        el('span', { class: `dot ${p.online ? 'online' : ''}`, title: p.online ? 'Online' : 'Offline' })
      )
    )
  );
  if (state.playerUuid) showPlayer(state.playerUuid);
  else fill($('player-detail'), el('p', { class: 'muted' }, 'Players show up here after they join the server once.'));
}

function iconRow(kind, value, max) {
  const count = Math.ceil(max / 2);
  const row = el('div', { class: 'icons' });
  for (let i = 0; i < count; i++) {
    const fillLevel = value >= i * 2 + 2 ? 1 : value >= i * 2 + 1 ? 0.5 : 0;
    row.append(icon2(kind, fillLevel, `${kind}${i}`));
  }
  row.append(el('span', { class: 'label' }, `${Math.round(value * 10) / 10} / ${max}`));
  return row;
}

/** A heart or drumstick drawn as SVG, full, half or empty. */
function icon2(kind, level, uid) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  const color = kind === 'heart' ? '#e5534b' : '#c98b4a';
  const gid = `g-${uid}-${Math.random().toString(36).slice(2, 7)}`;
  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', gid);
  for (const [offset, c] of [[0, color], [level, color], [level, '#3a3f49'], [1, '#3a3f49']]) {
    const stop = document.createElementNS(NS, 'stop');
    stop.setAttribute('offset', String(offset));
    stop.setAttribute('stop-color', c);
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', kind === 'heart'
    ? 'M10 17.5 2.6 10.2A4.6 4.6 0 0 1 10 4.6a4.6 4.6 0 0 1 7.4 5.6Z'
    : 'M12.6 2.4a5 5 0 0 1 5 5c0 3.2-3.4 5.6-6.2 5.6l-3.2 3.2a1.8 1.8 0 1 1-2.5-.3 1.8 1.8 0 1 1-.3-2.5L8.6 10.2c0-2.8 1-7.8 4-7.8Z');
  path.setAttribute('fill', `url(#${gid})`);
  path.setAttribute('stroke', '#111');
  path.setAttribute('stroke-width', '1');
  svg.append(path);
  return svg;
}

function itemLabel(item) {
  if (item.name) return item.name;
  const [ns, id] = item.id.includes(':') ? item.id.split(':') : ['minecraft', item.id];
  const words = id.split(/[_/]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return ns === 'minecraft' ? words : `${words}`;
}

// ---------- item pictures (drawn from the game's own model files) ----------

const ItemArt = {
  specs: new Map(), // "version|id" -> Promise<spec|null>
  images: new Map(), // data URL -> Promise<HTMLImageElement>

  spec(version, id) {
    const server = state.selectedId;
    const key = `${server}|${version}|${id}`;
    if (!this.specs.has(key)) {
      const p = api.itemArt(version, id, server).catch(() => null);
      this.specs.set(key, p);
      // A missing client jar (offline) is not remembered, so the next view tries again.
      p.then((s) => { if (!s) setTimeout(() => this.specs.delete(key), 30000); });
    }
    return this.specs.get(key);
  },

  image(url) {
    if (!this.images.has(url)) {
      this.images.set(url, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }));
    }
    return this.images.get(url);
  },

  /** Draw an item into a canvas the way the in-game inventory does. Resolves false if there is no picture. */
  async draw(canvas, version, id, { glint = false } = {}) {
    const spec = await this.spec(version, id);
    if (!spec) return false;
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    if (spec.type === 'flat') {
      const leather = /(^|:)leather_(helmet|chestplate|leggings|boots)$/.test(id);
      for (const [i, url] of spec.layers.entries()) {
        const img = await this.image(url);
        if (!img) continue;
        if (leather && i === 0) {
          // Undyed leather armour is brown in game; the texture itself is grey.
          const off = document.createElement('canvas');
          off.width = off.height = size;
          const o = off.getContext('2d');
          o.imageSmoothingEnabled = false;
          o.drawImage(img, 0, 0, img.naturalWidth, img.naturalWidth, 0, 0, size, size);
          o.globalCompositeOperation = 'multiply';
          o.fillStyle = '#a06540';
          o.fillRect(0, 0, size, size);
          o.globalCompositeOperation = 'destination-in';
          o.drawImage(img, 0, 0, img.naturalWidth, img.naturalWidth, 0, 0, size, size);
          ctx.drawImage(off, 0, 0);
        } else ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalWidth, 0, 0, size, size);
      }
    } else {
      await this.drawBoxes(ctx, spec, size);
    }
    if (glint) {
      // The enchantment shimmer: a purple wash over the item's own pixels only.
      ctx.globalCompositeOperation = 'source-atop';
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, 'rgba(140, 80, 255, 0.55)');
      g.addColorStop(0.5, 'rgba(210, 150, 255, 0.35)');
      g.addColorStop(1, 'rgba(120, 60, 230, 0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
    }
    return true;
  },

  /**
   * Blocks: draw each box of the model from the inventory angle (looking down at
   * 30 degrees with the block turned 135 degrees), showing the top, north and west faces.
   */
  async drawBoxes(ctx, spec, size) {
    const imgs = {};
    for (const [name, url] of Object.entries(spec.textures)) imgs[name] = await this.image(url);
    const k = (size - 6) / 22.63; // one model unit in pixels: a full block fills the icon
    const c = Math.SQRT1_2;
    const project = (x, y, z) => {
      x -= 8; y -= 8; z -= 8;
      return [size / 2 + (-c * x + c * z) * k, size / 2 + (-0.866 * y + 0.5 * (-c * x - c * z)) * k + 1];
    };
    const depth = (b) => -c * (b.from[0] + b.to[0]) / 2 - c * (b.from[2] + b.to[2]) / 2;
    const tinted = (img, name, color) => {
      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = Math.min(img.naturalHeight, img.naturalWidth);
      const o = off.getContext('2d');
      o.drawImage(img, 0, 0);
      o.globalCompositeOperation = 'multiply';
      o.fillStyle = color;
      o.fillRect(0, 0, off.width, off.height);
      o.globalCompositeOperation = 'destination-in';
      o.drawImage(img, 0, 0);
      return off;
    };
    const tintFor = (name) => (/leaves|vine|azalea|mangrove/.test(name) ? '#6aa84f' : /grass|fern|sugar_cane|lily/.test(name) ? '#8fbf57' : /water/.test(name) ? '#3f76e4' : '#ffffff');
    const shade = { up: 0, north: 0.2, west: 0.4 };

    for (const b of [...spec.boxes].sort((a, z) => depth(a) - depth(z) || a.from[1] - z.from[1])) {
      const [x1, y1, z1] = b.from;
      const [x2, y2, z2] = b.to;
      // Each face: texture origin corner and the corners the texture's right and bottom edges run to.
      const faceGeometry = {
        up: { o: [x1, y2, z1], u: [x2, y2, z1], v: [x1, y2, z2], defaultUv: [x1, z1, x2, z2] },
        north: { o: [x2, y2, z1], u: [x1, y2, z1], v: [x2, y1, z1], defaultUv: [16 - x2, 16 - y2, 16 - x1, 16 - y1] },
        west: { o: [x1, y2, z1], u: [x1, y2, z2], v: [x1, y1, z1], defaultUv: [z1, 16 - y2, z2, 16 - y1] },
      };
      for (const side of ['west', 'north', 'up']) {
        const face = b.faces[side];
        if (!face) continue;
        const img = imgs[face.texture];
        if (!img) continue;
        const g = faceGeometry[side];
        const uv = face.uv || g.defaultUv;
        const frame = Math.min(img.naturalWidth, img.naturalHeight); // animated textures are tall strips
        const sx = (uv[0] / 16) * frame;
        const sy = (uv[1] / 16) * frame;
        const sw = ((uv[2] - uv[0]) / 16) * frame;
        const sh = ((uv[3] - uv[1]) / 16) * frame;
        if (!sw || !sh) continue;
        const O = project(...g.o);
        const U = project(...g.u);
        const V = project(...g.v);
        ctx.save();
        // Map the unit square onto the face (origin, right edge, bottom edge), then draw the texture part into it.
        ctx.setTransform(U[0] - O[0], U[1] - O[1], V[0] - O[0], V[1] - O[1], O[0], O[1]);
        ctx.imageSmoothingEnabled = false;
        const source = face.tint ? tinted(img, face.texture, tintFor(face.texture)) : img;
        ctx.drawImage(source, Math.min(sx, sx + sw), Math.min(sy, sy + sh), Math.abs(sw), Math.abs(sh), 0, 0, 1, 1);
        ctx.restore();
        if (shade[side]) {
          ctx.save();
          ctx.beginPath();
          const corners = [g.o, g.u, [g.u[0] + g.v[0] - g.o[0], g.u[1] + g.v[1] - g.o[1], g.u[2] + g.v[2] - g.o[2]], g.v].map((p) => project(...p));
          ctx.moveTo(...corners[0]);
          for (const p of corners.slice(1)) ctx.lineTo(...p);
          ctx.closePath();
          ctx.fillStyle = `rgba(0, 0, 0, ${shade[side]})`;
          ctx.fill();
          ctx.restore();
        }
      }
    }
  },
};

function slotEl(item, key, player, extraClass = '') {
  if (!item) return el('div', { class: `slot ${extraClass}` });
  const label = itemLabel(item);
  const [namespace, itemId] = item.id.includes(':') ? item.id.split(':', 2) : ['minecraft', item.id];
  // Minecraft's vanilla item textures are served per game version. Modded
  // items (or items without a matching texture) use the neutral fallback.
  const minecraftVersion = current()?.minecraft;
  const artwork = el('span', { class: 'item-fallback', 'aria-hidden': 'true' }, '◇');
  let image = null;
  if (minecraftVersion && /^[a-z0-9_.-]+$/i.test(namespace) && /^[a-z0-9_./-]+$/i.test(itemId)) {
    // Drawn from the game's own model files, so blocks look like blocks and tools like tools.
    image = el('canvas', { class: 'item-icon', 'aria-label': label });
    ItemArt.draw(image, minecraftVersion, item.id, { glint: item.enchanted }).then((ok) => {
      if (ok) artwork.remove();
      else image.remove();
    });
  }
  return el('div', {
    class: `slot filled ${item.enchanted ? 'enchanted' : ''} ${extraClass}`,
    'aria-label': `${label} × ${item.count}`,
    title: `${label} × ${item.count}\n${item.id}${item.enchanted ? '\nEnchanted' : ''}\nClick to remove`,
    onclick: () => removeItem(player, key, item),
  }, artwork, image, item.count > 1 ? el('span', { class: 'count' }, item.count) : null);
}

async function removeItem(player, key, item) {
  if (!(await confirmDialog(`Remove ${itemLabel(item)} × ${item.count} from ${player.name || 'this player'}?`, {
    title: 'Remove this item?', confirmText: 'Remove item',
  }))) return;
  await playerDo(player, 'remove', { slot: key });
}

async function playerDo(player, action, args) {
  const out = await attempt(() => api.playerAction(state.selectedId, player.uuid, action, args));
  if (out !== undefined) {
    toast(out && out.trim() ? out.trim().split('\n')[0].slice(0, 120) : 'Done');
    await showPlayer(player.uuid, { quiet: true });
    if (action === 'op' || action === 'deop') loadPlayers();
  }
}

/** Spawnable vehicles for the open server, loaded once per server. */
async function zomboidVehicles() {
  const id = state.selectedId;
  state.vehicleLists = state.vehicleLists || {};
  if (!state.vehicleLists[id]) state.vehicleLists[id] = api.zomboidVehicles(id).catch(() => []);
  return state.vehicleLists[id];
}

const PERK_NAMES = { Lightfoot: 'Lightfooted', Sneak: 'Sneaking', Axe: 'Axe', Blunt: 'Long Blunt', SmallBlunt: 'Short Blunt', LongBlade: 'Long Blade', SmallBlade: 'Short Blade', Woodwork: 'Carpentry', Doctor: 'First Aid', Electricity: 'Electrical', MetalWelding: 'Welding', PlantScavenging: 'Foraging', FlintKnapping: 'Knapping', Husbandry: 'Animal Care', Blacksmith: 'Blacksmithing' };

/** Zomboid items for the open server, loaded once per server. */
async function zomboidItems() {
  const id = state.selectedId;
  state.itemLists = state.itemLists || {};
  if (!state.itemLists[id]) state.itemLists[id] = api.zomboidItems(id).catch(() => []);
  return state.itemLists[id];
}

/**
 * Rank items for what was typed: the typed letters appearing together anywhere
 * in the name or id first (earlier and at word starts rank higher), then names
 * that contain the letters in order with gaps.
 */
function matchItems(items, query, limit = 40) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const id = item.id.toLowerCase();
    let score = -1;
    let at = name.indexOf(q);
    if (at >= 0) score = 1000 - at * 2 - name.length / 10 + (at === 0 || name[at - 1] === ' ' ? 200 : 0) + (name === q ? 500 : 0);
    else if ((at = id.indexOf(q)) >= 0) score = 600 - at;
    else {
      let i = 0;
      for (const ch of name) if (ch === q[i]) i++;
      if (i === q.length) score = 100 - name.length / 10;
    }
    if (score >= 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.item);
}

/** A text box with a dropdown of matching items. The box ends up holding the item id. */
function itemPicker(input, source = zomboidItems) {
  const list = el('ul', { class: 'suggest-list hidden' });
  const wrap = el('div', { class: 'suggest' }, input, list);
  let shown = [];
  let active = -1;
  const highlight = (text, q) => {
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    if (!q || at < 0) return [text];
    return [text.slice(0, at), el('mark', {}, text.slice(at, at + q.length)), text.slice(at + q.length)];
  };
  const close = () => { list.classList.add('hidden'); active = -1; $('main').removeEventListener('scroll', close); };
  const choose = (item) => { input.value = item.id; close(); };
  const render = () => {
    fill(list, shown.map((item, i) => el('li', {
      class: i === active ? 'active' : '',
      onmousedown: (e) => { e.preventDefault(); choose(item); },
    }, el('span', { class: 's-name' }, highlight(item.name, input.value.trim())), item.mod ? el('span', { class: 's-mod' }, item.mod) : null, el('span', { class: 's-id' }, item.id))));
    list.classList.toggle('hidden', !shown.length);
    if (shown.length) $('main').addEventListener('scroll', close, { passive: true });
    // Fixed position so card edges (clipped in the Neon theme) never cut the list off.
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 220;
    Object.assign(list.style, { left: `${r.left}px`, width: `${Math.max(r.width, 320)}px`, top: below ? `${r.bottom + 4}px` : '', bottom: below ? '' : `${window.innerHeight - r.top + 4}px` });
  };
  input.autocomplete = 'off';
  input.addEventListener('input', async () => {
    const q = input.value;
    const items = await source();
    if (input.value !== q) return;
    shown = matchItems(items, q);
    active = shown.length ? 0 : -1;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  return wrap;
}

function showZomboidPlayer(uuid) {
  state.playerUuid = uuid;
  document.querySelectorAll('#player-list li').forEach((li, i) => li.classList.toggle('active', state.playerList[i] && state.playerList[i].uuid === uuid));
  const p = state.playerList.find((x) => x.uuid === uuid);
  if (!p) return;
  const s = current();
  const online = p.online && s && s.status === 'running';
  const itemInput = el('input', { type: 'text', class: 'item', placeholder: 'Type an item, e.g. axe or bandage' });
  const countInput = el('input', { type: 'number', class: 'count', min: 1, max: 500, value: 1 });
  const give = el('button', { class: 'btn', type: 'button' }, 'Give');
  give.disabled = !online;
  zomboidItems();
  zomboidVehicles();
  // Skills
  const perk = el('select', {});
  attempt(() => api.zomboidPerks()).then((perks) => fill(perk, (perks || []).map((k) => el('option', { value: k }, PERK_NAMES[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2')))));
  const xp = el('input', { type: 'number', min: 1, max: 100000, value: 150 });
  const addXp = el('button', { class: 'btn', type: 'button', disabled: !online, onclick: () => playerDo(p, 'xp', { perk: perk.value, amount: Number(xp.value) }) }, 'Add XP');
  // Vehicle
  const vehicleInput = el('input', { type: 'text', placeholder: 'Type a vehicle, e.g. pickup or ambulance' });
  const spawn = el('button', { class: 'btn', type: 'button', disabled: !online, onclick: () => playerDo(p, 'vehicle', { vehicle: vehicleInput.value }) }, 'Spawn');
  const where = el('div', { class: 'muted small' }, 'Looking up where they are…');
  attempt(() => api.zomboidPositions(s.id)).then((list) => {
    const pos = (list || []).find((x) => x.username.toLowerCase() === p.name.toLowerCase());
    fill(where, pos
      ? [`${pos.character ? `Plays ${pos.character}. ` : ''}${pos.dead ? 'Their character is dead. ' : ''}Last saved at ${pos.x}, ${pos.y}${pos.z ? `, floor ${pos.z}` : ''}. `,
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); switchTab('world'); setTimeout(() => ZbMap.center(pos.x, pos.y, 1), 300); } }, 'Show on map')]
      : 'No saved position yet. It appears after they have played.');
  });
  give.onclick = () => playerDo(p, 'give', { item: itemInput.value, count: Number(countInput.value) });
  fill($('player-detail'),
    el('div', { class: 'player-head', oncontextmenu: (e) => openPlayerMenu(e, p) },
      el('div', { class: 'icon-fallback pack-icon-md' }, '☣'),
      el('div', {},
        el('h2', {}, p.name),
        el('div', { class: 'meta' }, online ? 'Online now' : p.lastPlayed ? `Offline · last seen ${new Date(p.lastPlayed).toLocaleString()}` : 'Has not joined yet'),
        el('div', { class: 'meta' }, `Role: ${p.role || (p.op ? 'admin' : 'player')}${p.banned ? ' · banned' : ''}`))),
    where,
    el('div', { class: 'zb-player-grid' },
      el('div', { class: 'card' }, el('h4', {}, 'Give an item'), el('div', { class: 'row' }, itemPicker(itemInput), countInput, give)),
      el('div', { class: 'card' }, el('h4', {}, 'Skills'), el('div', { class: 'row' }, perk, xp, addXp), el('div', { class: 'muted small' }, 'About 75 XP is one level at the start; higher levels need much more.')),
      el('div', { class: 'card' }, el('h4', {}, 'Spawn a vehicle next to them'), el('div', { class: 'row' }, itemPicker(vehicleInput, zomboidVehicles), spawn)),
      el('div', { class: 'card' }, el('h4', {}, 'Powers'), el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', disabled: !online, onclick: () => playerDo(p, 'godmode', { on: true }) }, 'God mode'),
        el('button', { class: 'btn', type: 'button', disabled: !online, onclick: () => playerDo(p, 'invisible', { on: true }) }, 'Invisible'),
        el('button', { class: 'btn', type: 'button', disabled: !online, onclick: () => playerDo(p, 'noclip', { on: true }) }, 'Walk through walls'),
        el('button', { class: 'btn btn-ghost', type: 'button', disabled: !online, onclick: async () => { for (const a of ['godmode', 'invisible', 'noclip']) await playerDo(p, a, { on: false }); } }, 'Turn all off')))),
    online ? null : el('p', { class: 'muted small' }, 'These need the player online.'),
    el('p', { class: 'muted small' }, 'Right-click the player for admin, teleport, kick and ban. Zomboid does not let other programs read a player\'s health or inventory, so those are not shown.'));
}

async function showPlayer(uuid, { quiet = false } = {}) {
  if ((current() && current().game === 'zomboid')) return showZomboidPlayer(uuid);
  state.playerUuid = uuid;
  document.querySelectorAll('#player-list li').forEach((li, i) => li.classList.toggle('active', state.playerList[i] && state.playerList[i].uuid === uuid));
  const id = state.selectedId;
  const box = $('player-detail');
  const known = state.playerList.find((p) => p.uuid === uuid);
  if (known && !known.online && !known.hasData) {
    fill(box, el('div', { class: 'player-head' }, el('img', { src: headUrl(uuid, 72), alt: '' }), el('div', {}, el('h2', {}, known.name || uuid), el('div', { class: 'meta' }, 'Has not played on this server yet, so there is nothing to show.'))));
    return;
  }
  if (!quiet) fill(box, el('p', { class: 'muted' }, 'Loading…'));
  const d = quiet ? await api.playerDetails(id, uuid).catch(() => null) : await attempt(() => api.playerDetails(id, uuid));
  if (!d || id !== state.selectedId || uuid !== state.playerUuid) {
    if (!d && !quiet) fill(box, el('p', { class: 'muted' }, 'No saved data for this player yet.'));
    return;
  }
  const s = current();
  const online = d.online && s && s.status === 'running';

  const actions = el('div', { class: 'player-actions' });
  const button = (label, action, args, opts = {}) => {
    const b = el('button', { class: `btn ${opts.cls || ''}`, type: 'button' }, label);
    b.onclick = async () => {
      if (opts.confirm && !(await confirmDialog(opts.confirm, {
        title: opts.confirmTitle || 'Confirm player change', confirmText: opts.confirmText || 'Continue', danger: opts.danger !== false,
      }))) return;
      b.disabled = true;
      await playerDo(d, action, typeof args === 'function' ? args() : args);
      b.disabled = false;
    };
    if (opts.disabled) b.disabled = true;
    return b;
  };
  const mode = el('select', {}, ['survival', 'creative', 'adventure', 'spectator'].map((m) => el('option', { value: m }, m[0].toUpperCase() + m.slice(1))));
  mode.value = d.gameMode;
  const xp = el('input', { type: 'number', min: 0, max: 10000, value: d.xpLevel, class: 'count' });
  fill(actions,
    button('Heal', 'heal'),
    button('Feed', 'feed'),
    mode, button('Set game mode', 'gamemode', () => ({ mode: mode.value })),
    el('span', { class: 'muted small' }, 'XP level'), xp, button('Set', 'xp', () => ({ level: Number(xp.value) })),
    d.op ? button('Remove OP', 'deop') : button('Make OP', 'op'),
    online ? button('Kick', 'kick', {}, { cls: 'btn-danger', confirm: `Kick ${d.name}?` }) : null,
    button('Clear inventory', 'clear', {}, { cls: 'btn-danger', confirmTitle: 'Clear inventory?', confirmText: 'Clear inventory', confirm: `Delete everything in ${d.name || 'this player'}'s inventory? This can't be undone.` })
  );
  const give = el('div', { class: 'player-actions' });
  const itemInput = el('input', { type: 'text', class: 'item', placeholder: 'Item id, e.g. minecraft:diamond' });
  const countInput = el('input', { type: 'number', class: 'count', min: 1, max: 6400, value: 1 });
  fill(give, itemInput, countInput, button('Give', 'give', () => ({ item: itemInput.value, count: Number(countInput.value) }), { disabled: !online }),
    online ? null : el('span', { class: 'muted small' }, 'Giving items needs the player online.'));

  const slots = d.slots || {};
  const armor = el('div', { class: 'inv-row' }, ['head', 'chest', 'legs', 'feet'].map((k) => slotEl(slots[`armor:${k}`], `armor:${k}`, d)), slotEl(slots.offhand, 'offhand', d));
  const main = el('div', { class: 'inv-grid' });
  for (let i = 9; i < 36; i++) main.append(slotEl(slots[`inv:${i}`], `inv:${i}`, d));
  const hotbar = el('div', { class: 'inv-grid' });
  for (let i = 0; i < 9; i++) hotbar.append(slotEl(slots[`inv:${i}`], `inv:${i}`, d, i === d.selectedSlot ? 'selected' : ''));
  const ender = el('div', { class: 'inv-grid' });
  for (let i = 0; i < 27; i++) ender.append(slotEl(d.ender[i], `ender:${i}`, d));

  const where = d.pos ? `${d.dimension.replace('minecraft:', '').replace('_', ' ')} at ${d.pos.map(Math.round).join(', ')}` : '';
  fill(box,
    el('div', { class: 'player-head', oncontextmenu: (e) => openPlayerMenu(e, d) },
      headEl(d.uuid, 72, d),
      el('div', {},
        el('h2', {}, d.name || d.uuid),
        el('div', { class: 'meta' }, online ? 'Online now · live data' : `Offline · from the save file${d.lastPlayed ? `, last saved ${new Date(d.lastPlayed).toLocaleString()}` : ''}`),
        el('div', { class: 'meta' }, `${d.gameMode[0].toUpperCase() + d.gameMode.slice(1)} · XP level ${d.xpLevel}${where ? ` · ${where}` : ''}`)
      )
    ),
    el('div', { class: 'bars' }, iconRow('heart', d.health, d.maxHealth), iconRow('food', d.food, 20)),
    actions,
    give,
    el('div', { class: 'inv-section' },
      el('h4', {}, 'Armor and offhand'), armor,
      el('h4', {}, 'Inventory'), main,
      el('h4', {}, 'Hotbar'), hotbar,
      el('h4', {}, 'Ender chest'), ender,
      el('p', { class: 'muted small' }, 'Click an item to remove it.')
    )
  );
}

// ---------- player right-click menu ----------

function openZomboidPlayerMenu(event, player) {
  event.preventDefault();
  closeMenu();
  const s = current();
  const online = s && s.status === 'running' && player.online;
  const running = s && s.status === 'running';
  const others = state.playerList.filter((x) => x.online && x.name !== player.name);
  const items = [];
  const label = (t) => items.push(el('div', { class: 'menu-label' }, t));
  const item = (text, action, args = {}, opts = {}) => {
    const b = el('button', { role: 'menuitem', class: opts.danger ? 'danger' : '' }, text);
    if (opts.disabled) b.disabled = true;
    b.onclick = async () => {
      closePlayerMenu();
      if (opts.confirm && !confirm(opts.confirm)) return;
      if (opts.run) return opts.run();
      await playerDo(player, action, args);
      loadPlayers();
    };
    items.push(b);
  };
  label(`${player.name} · ${online ? 'online' : 'offline'}`);
  item(player.op ? 'Remove admin' : 'Make admin', player.op ? 'deop' : 'op', {}, { disabled: !running, confirm: player.op ? null : `Make ${player.name} an admin? Admins can use every command.` });
  item('Make moderator', 'role', { level: 'moderator' }, { disabled: !running });
  if (player.whitelisted) item('Remove from whitelist', null, {}, { disabled: !running, danger: true, run: async () => { await attempt(() => api.whitelistRemove(s.id, player.name)); loadPlayers(); } });
  label('Teleport');
  for (const other of others.slice(0, 6)) item(`Send to ${other.name}`, 'tp-to', { target: other.name }, { disabled: !online });
  for (const other of others.slice(0, 6)) item(`Bring ${other.name} here`, 'tp-from', { target: other.name }, { disabled: !online });
  if (!others.length) items.push(el('div', { class: 'menu-label' }, 'Nobody else online'));
  label('Powers');
  item('God mode on', 'godmode', { on: true }, { disabled: !online });
  item('God mode off', 'godmode', { on: false }, { disabled: !online });
  item('Invisible to zombies', 'invisible', { on: true }, { disabled: !online });
  item('Visible to zombies', 'invisible', { on: false }, { disabled: !online });
  item('Walk through walls on', 'noclip', { on: true }, { disabled: !online });
  item('Walk through walls off', 'noclip', { on: false }, { disabled: !online });
  label('Events');
  item('Send a horde of 10 at them', 'horde', { count: 10 }, { disabled: !online, confirm: `Spawn 10 zombies around ${player.name}?` });
  item('Lightning strike near them', 'lightning', {}, { disabled: !online });
  label('Moderation');
  item('Kick', 'kick', {}, { disabled: !online, danger: true, confirm: `Kick ${player.name}?` });
  if (player.banned) item('Unban', 'pardon', {}, { disabled: !running });
  else item('Ban', 'ban', {}, { disabled: !running, danger: true, confirm: `Ban ${player.name}?` });
  const menu = $('player-menu');
  fill(menu, items);
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

async function openPlayerMenu(event, player) {
  if ((current() && current().game === 'zomboid')) return openZomboidPlayerMenu(event, player);
  event.preventDefault();
  closeMenu();
  const s = current();
  if (!s) return;
  if (state.host === undefined) state.host = ((await attempt(() => api.hostName())) || {}).name || null;
  const running = s.status === 'running';
  const online = running && player.online;
  const host = state.host;
  const hostOnline = online && host && host.toLowerCase() !== String(player.name).toLowerCase() &&
    state.playerList.some((p) => p.online && p.name && p.name.toLowerCase() === host.toLowerCase());
  const others = state.playerList.filter((p) => p.online && p.uuid !== player.uuid && p.name);
  const name = player.name || 'this player';

  const items = [];
  const label = (text) => items.push(el('div', { class: 'menu-label' }, text));
  const item = (text, action, args = {}, opts = {}) => {
    const b = el('button', { role: 'menuitem', class: opts.danger ? 'danger' : '' }, text);
    if (opts.disabled) b.disabled = true;
    b.onclick = async () => {
      closePlayerMenu();
      if (opts.confirm && !(await confirmDialog(opts.confirm, {
        title: opts.confirmTitle || 'Confirm player change', confirmText: opts.confirmText || 'Continue', danger: opts.danger !== false,
      }))) return;
      if (opts.run) return opts.run();
      await playerDo(player, action, args);
      loadPlayers();
    };
    items.push(b);
  };

  label(name + (online ? ' · online' : ' · offline'));
  item(player.op ? 'Remove OP' : 'Give OP', player.op ? 'deop' : 'op', {}, {
    confirmTitle: 'Give operator powers?', confirmText: 'Make OP',
    confirm: player.op ? null : `Give ${name} operator powers? OPs can use every command, including /stop and /ban.`,
  });
  if (player.whitelisted) item('Remove from whitelist', null, {}, { run: async () => { await attempt(() => api.whitelistRemove(s.id, player.name)); loadPlayers(); } });
  else item('Add to whitelist', null, {}, { disabled: !player.name, run: async () => { await addToWhitelist(player.name); loadPlayers(); } });

  label('Teleport');
  item(host ? `Bring ${name} to me` : 'Bring to me', 'tp-to', { target: host }, { disabled: !hostOnline });
  item(host ? `Send me to ${name}` : 'Send me to them', 'tp-from', { target: host }, { disabled: !hostOnline });
  for (const other of others.slice(0, 6)) {
    if (host && other.name.toLowerCase() === host.toLowerCase()) continue;
    item(`Send to ${other.name}`, 'tp-to', { target: other.name }, { disabled: !online });
  }

  label('Game mode');
  for (const mode of ['survival', 'creative', 'adventure', 'spectator']) {
    item(mode[0].toUpperCase() + mode.slice(1), 'gamemode', { mode }, {});
  }

  label('Health');
  item('Heal', 'heal');
  item('Feed', 'feed');

  label('Moderation');
  item('Kick', 'kick', {}, { disabled: !online, danger: true, confirm: `Kick ${name} from the server?` });
  if (player.banned) item('Unban', 'pardon');
  else item('Ban', 'ban', {}, { danger: true, confirm: `Ban ${name}? They won't be able to join until you unban them.` });
  item('Kill', 'kill', {}, { disabled: !online, danger: true, confirm: `Kill ${name}? They will drop their items.` });
  item('Clear inventory', 'clear', {}, { danger: true, confirm: `Delete everything in ${name}'s inventory? This can't be undone.` });

  const menu = $('player-menu');
  fill(menu, items);
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
}

function closePlayerMenu() {
  $('player-menu').classList.add('hidden');
}

// ---------- world: pregeneration ----------

const RADII = [
  [500, 'Small (500 blocks around spawn)'],
  [1000, 'Medium (1,000 blocks)'],
  [2000, 'Large (2,000 blocks)'],
  [3000, 'Very large (3,000 blocks)'],
  [5000, 'Huge (5,000 blocks)'],
];

// ---------- Project Zomboid: map ----------

/** Pan/zoom map drawn from the server's own map tiles, with players on top. */
const ZbMap = {
  info: null,
  tiles: new Map(), // "level/x/y" -> Image | null (empty) | 'loading'
  players: [],
  scale: 0.05, // screen pixels per world square
  cx: 10800, // world point in the middle of the view (Muldraugh)
  cy: 9600,
  timer: null,
  wired: false,

  async open() {
    if (!this.info) this.info = await attempt(() => api.zomboidMapInfo());
    if (!this.info) {
      fill($('zbmap-players'), el('li', { class: 'muted' }, 'The map files were not found in the server install.'));
      return;
    }
    this.wire();
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, 10000);
    requestAnimationFrame(() => this.draw());
  },

  close() {
    clearInterval(this.timer);
    this.timer = null;
  },

  async refresh() {
    const id = state.selectedId;
    // Left the server or the Map tab: stop refreshing.
    if (!id || !current() || current().game !== 'zomboid' || $('tab-world').classList.contains('hidden') || $('view-server').classList.contains('hidden')) return this.close();
    const list = await attempt(() => api.zomboidPositions(id));
    if (!list || id !== state.selectedId) return;
    this.players = list;
    this.renderList();
    this.draw();
  },

  center(x, y, scale) {
    this.cx = x;
    this.cy = y;
    if (scale) this.scale = scale;
    this.draw();
  },

  fit() {
    const wrap = $('zbmap-wrap');
    const i = this.info;
    this.cx = (i.minX + i.maxX) / 2;
    this.cy = (i.minY + i.maxY) / 2;
    this.scale = Math.min(wrap.clientWidth / (i.maxX - i.minX), wrap.clientHeight / (i.maxY - i.minY));
    this.draw();
  },

  renderList() {
    const s = current();
    fill($('zbmap-players'),
      this.players.length ? null : el('li', { class: 'muted' }, 'Nobody has played on this server yet.'),
      this.players.map((p) => el('li', {},
        el('span', { class: `dot ${p.dead ? 'error' : p.online ? 'online' : ''}` }),
        el('div', { class: 'grow' },
          el('div', {}, el('strong', {}, p.username), p.character ? ` · ${p.character}` : ''),
          el('div', { class: 'sub' }, `${p.dead ? 'Dead · ' : p.online ? 'Online · ' : ''}${p.x}, ${p.y}${p.z ? ` · floor ${p.z}` : ''}`)),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.center(p.x, p.y, Math.max(this.scale, 1)) }, 'Show'),
        el('a', { class: 'btn btn-ghost', href: `https://pzmap.org/en/B42/?goto=${p.x},${p.y}`, target: '_blank', rel: 'noreferrer', title: 'Open the detailed online map at this spot' }, 'Web map'))));
    if (s && s.status !== 'running' && this.players.length) $('zbmap-players').prepend(el('li', { class: 'muted small note' }, 'The server is stopped; these are the last saved spots.'));
  },

  tile(level, tx, ty) {
    const key = `${level}/${tx}/${ty}`;
    if (this.tiles.has(key)) return this.tiles.get(key);
    this.tiles.set(key, 'loading');
    api.zomboidMapTile(level, tx, ty).then((url) => {
      if (!url) return this.tiles.set(key, null);
      const img = new Image();
      img.onload = () => { this.tiles.set(key, img); this.draw(); };
      img.src = url;
    }).catch(() => this.tiles.set(key, null));
    return 'loading';
  },

  draw() {
    const canvas = $('zbmap');
    const wrap = $('zbmap-wrap');
    if (!this.info || !wrap.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2d3a24';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = this.scale < 1;
    const i = this.info;
    // Pick the level whose tiles are drawn at about their own size.
    const level = Math.max(0, Math.min(i.maxLevel, Math.round(Math.log2(1 / (this.scale)))));
    const span = i.tileSquares * 2 ** level; // world squares per tile
    const toX = (wx) => (wx - this.cx) * this.scale + w / 2;
    const toY = (wy) => (wy - this.cy) * this.scale + h / 2;
    const x0 = Math.max(0, Math.floor((this.cx - w / 2 / this.scale) / span));
    const y0 = Math.max(0, Math.floor((this.cy - h / 2 / this.scale) / span));
    const x1 = Math.min(Math.ceil(i.maxX / span) - 1, Math.floor((this.cx + w / 2 / this.scale) / span));
    const y1 = Math.min(Math.ceil(i.maxY / span) - 1, Math.floor((this.cy + h / 2 / this.scale) / span));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const img = this.tile(level, tx, ty);
        const sx = toX(tx * span);
        const sy = toY(ty * span);
        const size = span * this.scale;
        if (img && img !== 'loading') ctx.drawImage(img, sx, sy, size + 0.5, size + 0.5);
        else if (img === 'loading') {
          // Show a coarser tile while this one loads.
          const up = level + 1 <= i.maxLevel ? this.tiles.get(`${level + 1}/${tx >> 1}/${ty >> 1}`) : null;
          if (up && up !== 'loading') ctx.drawImage(up, (tx & 1) * 128, (ty & 1) * 128, 128, 128, sx, sy, size + 0.5, size + 0.5);
        }
      }
    }
    const names = $('zbmap-names').checked;
    ctx.font = '600 12px system-ui, sans-serif';
    for (const p of this.players) {
      const px = toX(p.x);
      const py = toY(p.y);
      if (px < -50 || py < -50 || px > w + 50 || py > h + 50) continue;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = p.dead ? '#e5534b' : p.online ? '#3fb950' : '#9aa4b2';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      if (names) {
        const label = p.dead ? `${p.username} (dead)` : p.username;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,.65)';
        ctx.fillRect(px + 9, py - 9, tw + 8, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, px + 13, py + 4);
      }
    }
  },

  wire() {
    if (this.wired) return;
    this.wired = true;
    const wrap = $('zbmap-wrap');
    let drag = null;
    wrap.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
      wrap.classList.add('dragging');
    });
    window.addEventListener('mouseup', () => {
      drag = null;
      wrap.classList.remove('dragging');
    });
    wrap.addEventListener('mousemove', (e) => {
      const r = wrap.getBoundingClientRect();
      const wx = Math.round(this.cx + (e.clientX - r.left - r.width / 2) / this.scale);
      const wy = Math.round(this.cy + (e.clientY - r.top - r.height / 2) / this.scale);
      $('zbmap-coords').textContent = `${wx}, ${wy}`;
      if (!drag) return;
      this.cx = drag.cx - (e.clientX - drag.x) / this.scale;
      this.cy = drag.cy - (e.clientY - drag.y) / this.scale;
      this.draw();
    });
    wrap.addEventListener('mouseleave', () => { $('zbmap-coords').textContent = ''; });
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      const before = { x: this.cx + mx / this.scale, y: this.cy + my / this.scale };
      this.scale = Math.max(0.02, Math.min(4, this.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
      this.cx = before.x - mx / this.scale;
      this.cy = before.y - my / this.scale;
      this.draw();
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.timer) this.draw(); });
    $('zbmap-names').onchange = () => this.draw();
    $('zbmap-refresh').onclick = () => this.refresh();
    $('zbmap-fit').onclick = () => this.fit();
  },
};

async function loadWorld() {
  if (current() && current().game === 'zomboid') return ZbMap.open();
  const id = state.selectedId;
  if (typeof WorldMap !== 'undefined') WorldMap.open(id);
  state.pregen[id] = (await attempt(() => api.pregenStatus(id))) || {};
  renderPregen();
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function loadBackupsTasks() {
  const id = state.selectedId;
  const [backups, settings, tasks] = await Promise.all([
    api.listBackups(id).catch(() => []), api.backupSettings(id).catch(() => null), api.listTasks(id).catch(() => []),
  ]);
  if (id !== state.selectedId) return;
  state.backups = backups || [];
  state.backupSettings = settings;
  state.tasks = tasks || [];
  renderBackups();
}

function renderBackups() {
  const s = current();
  if (!s) return;
  $('backup-now').disabled = s.status !== 'stopped';
  const settings = state.backupSettings || {};
  $('backup-retention').value = settings.retention || 5;
  $('backup-include').value = (settings.include || []).join('\n');
  $('backup-exclude').value = (settings.exclude || []).join('\n');
  const list = $('backup-list');
  if (!state.backups.length) fill(list, el('p', { class: 'muted small' }, 'No restore points yet.'));
  else fill(list, state.backups.map((backup) => {
    const restore = el('button', { class: 'btn', type: 'button', disabled: s.status !== 'stopped' }, 'Restore');
    restore.onclick = async () => {
      if (!(await confirmDialog(`Restore "${backup.reason}" from ${new Date(backup.createdAt).toLocaleString()}? A backup of the current files will be saved first.`, {
        title: 'Restore this backup?', confirmText: 'Restore backup',
      }))) return;
      restore.disabled = true;
      if (await attempt(() => api.restoreBackup(s.id, backup.id))) toast('Backup restored.');
      await loadBackupsTasks();
      restore.disabled = false;
    };
    return el('div', { class: 'backup-row' },
      el('div', { class: 'grow' },
        el('strong', {}, backup.reason || 'Restore point'),
        el('div', { class: 'muted small' }, `${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.size)}`)
      ), restore
    );
  }));
  const chain = $('task-chain');
  const selected = chain.value;
  fill(chain, el('option', { value: '' }, 'No follow-up'), state.tasks.map((task) => el('option', { value: task.id }, task.name)));
  chain.value = state.tasks.some((task) => task.id === selected) ? selected : '';
  const taskList = $('task-list');
  if (!state.tasks.length) fill(taskList, el('p', { class: 'muted small' }, 'No scheduled tasks yet.'));
  else fill(taskList, state.tasks.map((task) => {
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = task.enabled;
    enabled.onchange = async () => {
      await attempt(() => api.saveTasks(s.id, state.tasks.map((t) => t.id === task.id ? { ...t, enabled: enabled.checked } : t)));
      await loadBackupsTasks();
    };
    const chainSelect = el('select', {}, [el('option', { value: '' }, 'No follow-up'), ...state.tasks.filter((t) => t.id !== task.id).map((t) => el('option', { value: t.id }, t.name))]);
    chainSelect.value = task.chainTaskId || '';
    chainSelect.onchange = async () => {
      await attempt(() => api.saveTasks(s.id, state.tasks.map((t) => t.id === task.id ? { ...t, chainTaskId: chainSelect.value || null } : t)));
      await loadBackupsTasks();
    };
    const run = el('button', { class: 'btn', type: 'button' }, 'Run now');
    run.onclick = async () => {
      run.disabled = true;
      await attempt(() => api.runTask(s.id, task.id));
      await loadBackupsTasks();
      run.disabled = false;
    };
    const remove = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Remove');
    remove.onclick = async () => {
      await attempt(() => api.saveTasks(s.id, state.tasks.filter((t) => t.id !== task.id).map((t) => t.chainTaskId === task.id ? { ...t, chainTaskId: null } : t)));
      await loadBackupsTasks();
    };
    const type = { backup: 'Backup', restart: `Restart${task.warningMinutes ? ` (warn ${task.warningMinutes}m)` : ''}`, start: 'Start', stop: 'Stop', command: `Command: ${task.command}` }[task.type];
    return el('div', { class: 'task-row' }, enabled,
      el('div', { class: 'grow' }, el('strong', {}, task.name), el('div', { class: 'muted small' }, `${type} · ${task.frequency} at ${task.time}${task.frequency === 'weekly' ? ` · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][task.dayOfWeek]}` : ''}${task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toLocaleString()}` : ''}`)),
      chainSelect, run, remove
    );
  }));
}

function updateTaskFields() {
  const type = $('task-type').value;
  const weekly = $('task-frequency').value === 'weekly';
  $('task-day-wrap').classList.toggle('hidden', !weekly);
  $('task-warning-wrap').classList.toggle('hidden', type !== 'restart');
  $('task-command-wrap').classList.toggle('hidden', type !== 'command');
}

async function loadFiles() {
  const id = state.selectedId;
  const dir = state.fileDir;
  const entries = await attempt(() => api.listServerFiles(id, dir));
  if (!entries || id !== state.selectedId || dir !== state.fileDir) return;
  state.fileEntries = entries;
  $('file-breadcrumb').textContent = dir === '.' ? 'Server root' : `Server root / ${dir.split('/').join(' / ')}`;
  const list = $('file-list');
  if (!entries.length) fill(list, el('p', { class: 'muted small' }, 'This folder is empty.'));
  else fill(list, entries.map((entry) => {
    const name = el('button', { type: 'button', class: `file-name${entry.directory ? ' folder' : ''}` }, `${entry.directory ? '📁' : '📄'}  ${entry.name}`);
    name.onclick = () => entry.directory ? (state.fileDir = entry.path, loadFiles()) : editServerFile(entry.path);
    const actions = [];
    if (entry.directory) {
      const archive = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Create ZIP');
      archive.onclick = async () => { await attempt(() => api.archiveServerFolder(id, entry.path)); };
      actions.push(archive);
    } else {
      actions.push(el('span', { class: 'muted small file-size' }, formatBytes(entry.size)));
      const download = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Download');
      download.onclick = () => attempt(() => api.downloadServerFile(id, entry.path));
      actions.push(download);
      if (/\.zip$/i.test(entry.name)) {
        const extract = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Extract');
        extract.onclick = async () => {
          if (await attempt(() => api.extractServerArchive(id, entry.path))) { toast('Archive extracted.'); loadFiles(); }
        };
        actions.push(extract);
      }
    }
    const rename = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Rename');
    rename.onclick = async () => {
      const nextName = await fileNameDialog('Rename item', entry.name);
      if (nextName && await attempt(() => api.renameServerFile(id, entry.path, nextName))) loadFiles();
    };
    const remove = el('button', { class: 'btn btn-ghost danger-text', type: 'button' }, 'Delete');
    remove.onclick = async () => {
      if (await confirmDialog(`Delete ${entry.name}${entry.directory ? ' and everything inside it' : ''}? This cannot be undone.`, { title: 'Delete this item?', confirmText: 'Delete' })) {
        if (await attempt(() => api.deleteServerFile(id, entry.path))) loadFiles();
      }
    };
    actions.push(rename, remove);
    return el('div', { class: 'file-row' }, name, el('div', { class: 'row wrap end file-actions' }, actions));
  }));
}

function fileNameDialog(title, initial = '') {
  const modal = $('file-name-modal');
  const input = $('file-name-input');
  $('file-name-title').textContent = title;
  input.value = initial;
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.classList.add('hidden');
      $('file-name-form').onsubmit = null;
      $('file-name-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(null); };
    $('file-name-form').onsubmit = (event) => { event.preventDefault(); finish(input.value.trim() || null); };
    $('file-name-cancel').onclick = () => finish(null);
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

async function editServerFile(file) {
  const content = await attempt(() => api.readServerFile(state.selectedId, file));
  if (content === undefined) return;
  state.fileEditorPath = file;
  $('file-editor-title').textContent = file;
  $('file-editor-content').value = content;
  $('file-editor-status').textContent = '';
  $('file-editor').classList.remove('hidden');
  $('file-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** replaceChildren that skips null/false entries. */
function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function renderPregen() {
  const s = current();
  if (!s) return;
  const p = state.pregen[s.id] || {};
  const running = s.status === 'running';
  const box = $('pregen-box');
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    await attempt(fn);
    btn.disabled = false;
    loadWorld();
  };

  if (!s.installed) return fill(box, el('p', { class: 'muted' }, 'Available once the server has finished installing.'));
  if (!p.supported) {
    return fill(box, el('p', { class: 'muted' }, 'Pregenerating needs a mod loader, so it is not available on Plain Minecraft servers.'));
  }
  if (!p.installed) {
    const btn = el('button', { class: 'btn btn-primary' }, 'Add the pregeneration tool');
    btn.onclick = busy(btn, () => api.installChunky(s.id));
    return fill(box, 
      el('p', {}, 'This uses Chunky, a free server-side mod. Players do not need it.'),
      el('div', {}, btn)
    );
  }
  if (p.needsRestart && running) {
    return fill(box, el('div', { class: 'notice' }, el('strong', {}, 'Restart the server to finish adding the tool'), el('p', {}, 'Stop the server and start it again, then come back here.')));
  }

  const percent = Math.max(0, Math.min(100, p.percent || 0));
  const progress = el('div', {},
    el('div', { class: 'progress' }, el('div', { class: 'progress-bar', style: null, 'data-w': percent })),
    el('div', { class: 'pregen-stats' },
      el('span', {}, `${percent.toFixed(1)}% done`),
      p.chunks ? el('span', {}, `${p.chunks.toLocaleString()} chunks`) : null,
      p.eta ? el('span', {}, `About ${p.eta} left`) : null,
      p.rate ? el('span', {}, `${Math.round(p.rate)} chunks/second`) : null
    )
  );

  if (p.state === 'running' || p.state === 'paused') {
    const pause = el('button', { class: 'btn' }, p.state === 'running' ? 'Pause' : 'Continue');
    pause.onclick = busy(pause, () => (p.state === 'running' ? api.pregenPause(s.id) : api.pregenContinue(s.id)));
    const cancel = el('button', { class: 'btn btn-danger' }, 'Cancel');
    cancel.onclick = busy(cancel, () => api.pregenCancel(s.id));
    pause.disabled = cancel.disabled = !running;
    fill(box, 
      el('strong', {}, p.state === 'running' ? `Pregenerating ${p.radius ? `${p.radius.toLocaleString()} blocks around spawn` : ''}…` : 'Paused'),
      progress,
      el('div', { class: 'row' }, pause, cancel),
      running ? null : el('p', { class: 'muted small' }, 'Start the server to continue.')
    );
  } else {
    const select = el('select', { id: 'pregen-radius' }, RADII.map(([r, label]) => el('option', { value: r }, label)));
    select.value = String(p.radius || 1000);
    const start = el('button', { class: 'btn btn-primary' }, 'Start pregenerating');
    start.disabled = !running;
    start.onclick = busy(start, () => api.pregenStart(s.id, Number(select.value)));
    fill(box, 
      p.state === 'done' ? el('div', { class: 'ok' }, `✓ Finished: ${(p.chunks || 0).toLocaleString()} chunks are ready.`) : null,
      el('div', { class: 'row' }, select, start),
      el('p', { class: 'muted small' }, running
        ? 'It keeps running while you play, but it is fastest when the server is empty. Bigger areas take longer: large can take an hour on modded servers.'
        : 'Start the server first.')
    );
  }
  // Inline styles are blocked by the page's security policy, so size the bar here.
  box.querySelectorAll('.progress-bar[data-w]').forEach((b) => (b.style.width = `${b.dataset.w}%`));
}

// ---------- right-click menu and rename ----------

function openMenu(event, id) {
  event.preventDefault();
  state.menuFor = id;
  const menu = $('ctx-menu');
  menu.classList.remove('hidden');
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`;
  menu.querySelector('button').focus();
}

function closeMenu() {
  $('ctx-menu').classList.add('hidden');
}

async function runMenu(cmd) {
  const id = state.menuFor;
  closeMenu();
  const s = state.servers.find((x) => x.id === id);
  if (!s) return;
  if (cmd === 'open') openServer(id);
  if (cmd === 'settings') {
    await openServer(id);
    switchTab('settings');
  }
  if (cmd === 'folder') attempt(() => api.openFolder(id));
  if (cmd === 'rename') {
    state.renaming = id;
    $('rename-input').value = s.name;
    $('rename-modal').classList.remove('hidden');
    $('rename-input').select();
  }
  if (cmd === 'delete') deleteServer(s);
}

async function deleteServer(s) {
  if (['starting', 'running', 'stopping'].includes(s.status)) {
    toast('Stop the server before deleting it.', true);
    return;
  }
  if (!(await confirmDialog("Its world, mods, and settings will be permanently removed from this PC. This can't be undone.", {
    title: `Delete "${s.name}"?`, confirmText: 'Delete server',
  }))) return;
  if (await attempt(async () => (await api.deleteServer(s.id), true))) {
    if (state.selectedId === s.id) state.selectedId = null;
    await refreshServers();
    if (!state.selectedId) {
      if (state.servers.length) openServer(state.servers[0].id);
      else showView('empty');
    }
    toast(`Deleted ${s.name}`);
  }
}

// ---------- tabs ----------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const tab of ['friends', 'players', 'mods', 'world', 'console', 'backups', 'files', 'tools', 'settings']) $(`tab-${tab}`).classList.toggle('hidden', name !== tab);
  if (name === 'mods') {
    loadMods();
    if (current() && current().game === 'zomboid') loadServerCollections();
  }
  if (name === 'tools') loadPerformance();
  if (name === 'settings') loadServerIcon();
  if (name === 'world') loadWorld();
  else {
    if (typeof WorldMap !== 'undefined') WorldMap.close();
    ZbMap.close();
  }
  clearInterval(state.playerTimer);
  if (name === 'players') {
    loadPlayers();
    // Keep online players' hearts and inventory fresh while the tab is open.
    state.playerTimer = setInterval(() => {
      const p = state.playerList.find((x) => x.uuid === state.playerUuid);
      if (p && p.online && !document.hidden) showPlayer(p.uuid, { quiet: true });
    }, 5000);
  }
  if (name === 'settings') loadSettings();
  if (name === 'backups') loadBackupsTasks();
  if (name === 'files') loadFiles();
  if (name === 'friends') loadFriends();
  if (name === 'console') $('console').scrollTop = $('console').scrollHeight;
  clearInterval(state.metricsTimer);
  if (name === 'tools') {
    loadTools();
    state.metricsTimer = setInterval(() => { if (!document.hidden) updateMetrics(); }, 10000);
  }
}

// ---------- mods tab ----------

async function loadMods() {
  const id = state.selectedId;
  fill($('mods-list'), el('li', { class: 'muted' }, 'Reading the mods folder…'));
  const data = await attempt(() => api.modsOverview(id));
  if (!data || id !== state.selectedId) return;
  state.mods = data;
  renderMods();
}

function modRow(m, running) {
  const toggle = el('label', { class: 'switch', title: running ? 'Stop the server to change mods' : m.enabled ? 'Turn off' : 'Turn on' },
    el('input', { type: 'checkbox' }), el('span', { class: 'switch-track' }));
  const box = toggle.querySelector('input');
  box.checked = m.enabled;
  box.disabled = running;
  box.onchange = async () => {
    if (!box.checked && m.neededBy.length && !confirm(`${m.neededBy.slice(0, 5).join(', ')}${m.neededBy.length > 5 ? ' and others' : ''} need${m.neededBy.length === 1 ? 's' : ''} ${m.name}. Turning it off will probably stop the server from starting. Turn it off anyway?`)) {
      box.checked = true;
      return;
    }
    const ok = await attempt(async () => (await api.setModEnabled(state.selectedId, m.fileName, box.checked), true));
    if (!ok) box.checked = !box.checked;
    loadMods();
  };
  const badges = [];
  if (m.issue && m.issue.autoDisabled && !m.enabled) badges.push(el('span', { class: 'badge warn' }, 'Turned off automatically'));
  else if (m.issue && m.issue.kind === 'failed') badges.push(el('span', { class: 'badge bad' }, 'Failed to load'));
  if (m.clientOnly) badges.push(el('span', { class: 'badge warn' }, 'Client-only'));
  if (m.neededBy.length) badges.push(el('span', { class: 'badge', title: `Needed by ${m.neededBy.join(', ')}` }, `Needed by ${m.neededBy.length}`));
  return el('li', { class: `mod-row${m.enabled ? '' : ' off'}` },
    toggle,
    el('div', { class: 'mod-main' },
      el('div', {}, el('span', { class: 'mod-name' }, m.name), badges),
      el('div', { class: 'mod-meta', title: m.description || '' }, [m.version, m.fileName].filter(Boolean).join(' · ')),
      m.issue ? el('div', { class: 'mod-reason' }, m.issue.reason)
        : m.clientOnly && m.enabled ? el('div', { class: 'mod-reason' }, 'Modrinth lists this as a mod that only works in the game. It may crash the server or do nothing.') : null
    )
  );
}

function renderZomboidMods() {
  const data = state.mods;
  const running = data.running;
  $('mods-running-note').classList.toggle('hidden', !running);
  $('mods-count').textContent = `${data.enabledCount} on · ${data.workshopCount} Workshop items in the download list`;
  const toggle = (mod) => {
    const sw = el('label', { class: 'switch' }, el('input', { type: 'checkbox' }), el('span', { class: 'switch-track' }));
    const box = sw.querySelector('input');
    box.checked = mod.enabled;
    box.disabled = running;
    box.onchange = async () => {
      const r = await attempt(() => api.setModEnabled(state.selectedId, mod.id, box.checked));
      if (r && r.added && r.added.length) toast(`Also turned on what it needs: ${r.added.join(', ')}`);
      loadMods();
    };
    return sw;
  };
  const modRowZ = (mod) => el('li', { class: `mod-row${mod.enabled ? '' : ' off'}` }, toggle(mod),
    el('div', { class: 'mod-main' },
      el('div', {}, el('span', { class: 'mod-name' }, mod.name), mod.problems.length ? el('span', { class: 'badge warn' }, 'Problem') : null),
      el('div', { class: 'mod-meta' }, mod.id),
      mod.problems.map((t) => el('div', { class: 'mod-reason' }, t))));
  const problemMods = data.items.flatMap((i) => i.mods).filter((m) => m.problems.length);
  $('mods-problems').classList.toggle('hidden', !problemMods.length && !data.unknown.length);
  fill($('mods-problem-list'),
    problemMods.map(modRowZ),
    data.unknown.length ? el('li', { class: 'muted small' }, `${data.unknown.length} mod(s) are on but not in your own Steam Workshop downloads (${data.unknown.slice(0, 6).join(', ')}${data.unknown.length > 6 ? '…' : ''}). The server can still download them; the app just cannot check their requirements.`) : null);
  const q = $('mods-search').value.trim().toLowerCase();
  const filter = $('mods-filter').value;
  const items = data.items
    .map((i) => ({ ...i, mods: i.mods.filter((m) => (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)) && (filter === 'all' || filter === 'client' || (filter === 'on' && m.enabled) || (filter === 'off' && !m.enabled))) }))
    .filter((i) => i.mods.length)
    .sort((a, b) => b.mods.some((m) => m.enabled) - a.mods.some((m) => m.enabled) || a.title.localeCompare(b.title));
  fill($('mods-list'),
    data.items.length ? null : el('li', { class: 'muted' }, 'No Project Zomboid Workshop mods found in your Steam downloads. Subscribe to mods in the Steam Workshop and they appear here.'),
    items.slice(0, 300).map((i) => el('li', { class: 'zb-item' },
      el('div', { class: 'zb-item-title' }, i.title, el('span', { class: 'badge' }, `Workshop ${i.workshopId}`)),
      el('ul', { class: 'mod-list' }, i.mods.map(modRowZ)))));
}

function renderMods() {
  if (state.mods && state.mods.game === 'zomboid') return renderZomboidMods();
  const data = state.mods;
  if (!data) return;
  const running = data.running;
  $('mods-running-note').classList.toggle('hidden', !running);
  const problems = data.mods.filter((m) => m.issue || (m.clientOnly && m.enabled));
  $('mods-problems').classList.toggle('hidden', !problems.length);
  fill($('mods-problem-list'), problems.map((m) => modRow(m, running)));
  const on = data.mods.filter((m) => m.enabled).length;
  $('mods-count').textContent = `${on} on, ${data.mods.length - on} off`;
  const q = $('mods-search').value.trim().toLowerCase();
  const filter = $('mods-filter').value;
  const shown = data.mods.filter((m) =>
    (!q || m.name.toLowerCase().includes(q) || m.fileName.toLowerCase().includes(q)) &&
    (filter === 'all' || (filter === 'on' && m.enabled) || (filter === 'off' && !m.enabled) || (filter === 'client' && m.clientOnly)));
  fill($('mods-list'),
    data.mods.length ? null : el('li', { class: 'muted' }, data.loader === 'vanilla' ? 'Plain Minecraft servers have no mods.' : 'No mods yet.'),
    data.mods.length && !shown.length ? el('li', { class: 'muted' }, 'No mods match.') : null,
    shown.slice(0, 600).map((m) => modRow(m, running)));
}

// ---------- performance card ----------

async function loadPerformance() {
  const id = state.selectedId;
  const body = $('perf-body');
  fill(body, el('p', { class: 'muted small' }, 'Checking…'));
  const a = await attempt(() => api.perfAdvice(id));
  if (!a || id !== state.selectedId) return;
  const s = current();
  const running = s && ['starting', 'running', 'stopping'].includes(s.status);
  const sections = [];

  // Memory
  const memRow = el('div', { class: 'row wrap' },
    el('span', {}, `Memory: ${formatMb(a.memoryMb)}`),
    el('span', { class: 'muted small' }, `Suggested for ${a.modCount} mods on this PC (${formatMb(a.systemMemoryMb)}): ${formatMb(a.recommendedMemoryMb)}`));
  if (Math.abs(a.memoryMb - a.recommendedMemoryMb) >= 1024) {
    const b = el('button', { class: 'btn', type: 'button' }, `Use ${formatMb(a.recommendedMemoryMb)}`);
    b.onclick = async () => {
      if (await attempt(() => api.setMemory(id, a.recommendedMemoryMb))) {
        toast(`Memory set to ${formatMb(a.recommendedMemoryMb)}. It applies on the next start.`);
        await refreshServers();
        loadPerformance();
      }
    };
    memRow.append(b);
  }
  sections.push(el('div', { class: 'perf-section' }, el('h4', {}, 'Memory'), memRow));

  // Settings
  const differs = a.settings.filter((x) => String(x.current) !== String(x.recommended));
  const table = el('table', { class: 'perf-table' }, el('tbody', {},
    a.settings.map((x) => el('tr', {},
      el('td', {}, x.label),
      el('td', { class: String(x.current) !== String(x.recommended) ? 'changed' : '' }, x.current == null ? 'default' : x.current, ' → ', x.recommended),
      el('td', { class: 'why' }, x.why)))));
  const apply = el('button', { class: 'btn btn-primary', type: 'button' }, differs.length ? 'Apply recommended settings' : 'All set');
  apply.disabled = !differs.length;
  apply.onclick = async () => {
    if (await attempt(() => api.perfApplySettings(id))) {
      toast(running ? 'Saved. Restart the server to use the new settings.' : 'Saved. They apply on the next start.');
      loadPerformance();
    }
  };
  sections.push(el('div', { class: 'perf-section' }, el('h4', {}, 'Server settings'), table, el('div', { class: 'row' }, apply)));

  // Performance mods
  if (a.perfMods.length) {
    const missing = a.perfMods.filter((m) => !m.installed);
    const list = el('div', { class: 'perf-mods' }, a.perfMods.map((m) => el('label', { class: 'checkbox' },
      el('input', { type: 'checkbox', value: m.slug, disabled: m.installed || null, checked: !m.installed || null }),
      el('span', {}, el('strong', {}, m.name), m.installed ? el('span', { class: 'badge' }, 'Installed') : null, el('span', { class: 'muted small' }, ` ${m.what}`)))));
    const add = el('button', { class: 'btn btn-primary', type: 'button' }, 'Add selected');
    add.disabled = !missing.length || running;
    add.onclick = async () => {
      const slugs = [...list.querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);
      if (!slugs.length) return;
      add.disabled = true;
      add.textContent = 'Adding…';
      if (await attempt(async () => (await api.perfInstallMods(id, slugs), true))) toast('Added. They load on the next start. Players do not need them.');
      loadPerformance();
    };
    sections.push(el('div', { class: 'perf-section' },
      el('h4', {}, 'Performance mods'),
      el('p', { class: 'muted small' }, 'Server-side mods that speed things up without changing gameplay. Players do not need to install them.'),
      list,
      el('div', { class: 'row' }, add, running ? el('span', { class: 'muted small' }, 'Stop the server to add mods.') : null)));
  }

  sections.push(el('div', { class: 'perf-section' },
    el('h4', {}, 'Less lag while exploring'),
    el('p', { class: 'muted small' }, 'Generating new land is the biggest cause of lag on modded servers. Pregenerate the area around spawn on the World tab while nobody is playing.')));
  fill(body, sections);
}

// ---------- server icon ----------

async function loadServerIcon() {
  const icon = await attempt(() => api.serverIcon(state.selectedId));
  $('server-icon-preview').src = icon || 'icon.svg';
  $('server-icon-remove').disabled = !icon;
}

function hasPermission(permission) {
  return state.auth.host || (state.auth.permissions || []).includes(permission);
}

async function updateMetrics() {
  if (!state.selectedId || !hasPermission('server')) return;
  const m = await attempt(() => api.serverMetrics(state.selectedId));
  if (!m || !document.getElementById('metrics-grid')) return;
  const rows = [
    ['CPU', m.cpuPercent == null ? '—' : `${m.cpuPercent.toFixed(1)}%`],
    [current()?.game === 'zomboid' ? 'Server memory' : 'Java memory', m.memoryUsedMb == null ? '—' : `${formatMb(m.memoryUsedMb)} / ${formatMb(current()?.memoryMb || 0)}`],
    ['Host memory', `${formatMb(m.systemMemoryUsedMb)} / ${formatMb(m.systemMemoryMb)}`],
    ['Players', `${m.playerCount} / ${m.maxPlayers || '—'}`],
    ['Tick rate', m.tps == null ? 'Unavailable' : `${m.tps.toFixed(1)} TPS${m.msPerTick != null ? ` · ${m.msPerTick} ms per tick` : ''}`],
    ['Server files', `${formatBytes(m.diskBytes)}${m.diskScanLimited ? '+' : ''}`],
  ].filter(([label]) => !(current()?.game === 'zomboid' && label === 'Tick rate'));
  $('metrics-grid').replaceChildren(...rows.map(([label, value], index) => {
    const card = el('div', { class: `metric${index === 5 && m.diskWarning ? ' warn' : ''}` }, el('span', { class: 'muted small' }, label), el('strong', {}, value));
    return card;
  }));
  $('metrics-updated').textContent = new Date().toLocaleTimeString();
  if (document.activeElement !== $('disk-warning-limit')) $('disk-warning-limit').value = m.diskWarningGb;
  $('metrics-note').textContent = m.diskWarning
    ? `Disk usage has passed the ${m.diskWarningGb} GB warning limit. Remove old backups or unused files.`
    : current()?.game === 'zomboid' ? ''
    : m.tps == null ? 'The tick rate shows once the server is running (Minecraft 1.20.3+, Forge, NeoForge or Paper).'
    : m.msPerTick != null && m.msPerTick > 50 ? `The server is lagging: each tick takes ${m.msPerTick} ms (it should be under 50). Try the suggestions in "Make it run smoothly".`
    : '';
}

function renderQuickCommands() {
  const root = $('quick-command-list');
  root.replaceChildren(...state.commandButtons.map((item) => {
    const row = el('div', { class: 'tool-row' }, el('div', { class: 'tool-info' }, el('strong', {}, item.label), el('span', { class: 'muted small' }, `/${item.command}`)));
    const run = el('button', { class: 'btn btn-primary', type: 'button' }, 'Run');
    run.onclick = async () => { await attempt(() => api.command(state.selectedId, item.command)); toast(`Ran ${item.label}`); };
    const remove = el('button', { class: 'btn btn-ghost', type: 'button', title: 'Remove command' }, 'Remove');
    remove.onclick = async () => { state.commandButtons = state.commandButtons.filter((x) => x.id !== item.id); if (await attempt(() => api.setCommandButtons(state.selectedId, state.commandButtons))) renderQuickCommands(); };
    row.append(run, remove);
    return row;
  }));
  if (!state.commandButtons.length) root.append(el('p', { class: 'muted small' }, 'No saved command buttons yet.'));
}

async function loadActivity() {
  if (!hasPermission('server')) return;
  const entries = await attempt(() => api.activity(state.selectedId)) || [];
  $('activity-list').replaceChildren(...entries.map((entry) => el('div', { class: 'activity-row' },
    el('div', { class: 'activity-info' }, el('strong', {}, entry.action), el('span', { class: 'muted small' }, `${entry.actor} · ${new Date(entry.at).toLocaleString()}`)))));
  if (!entries.length) $('activity-list').append(el('p', { class: 'muted small' }, 'Changes will appear here.'));
}

async function loadCohostUi() {
  state.auth = (await attempt(() => api.cohostStatus())) || state.auth;
  $('auth-current').textContent = state.auth.host ? 'Signed in as host' : `Signed in as ${state.auth.username}`;
  $('cohost-owner-tools').classList.toggle('hidden', !state.auth.host);
  $('cohost-logout').classList.toggle('hidden', state.auth.host);
  $('cohost-login-form').classList.toggle('hidden', !state.auth.host);
  for (const id of ['status-lan', 'live-status-start', 'live-status-stop', 'live-status-open', 'live-status-copy']) $(id).classList.toggle('hidden', !hasPermission('settings'));
  $('disk-warning-limit').parentElement.classList.toggle('hidden', !hasPermission('settings'));
  $('disk-warning-save').classList.toggle('hidden', !hasPermission('settings'));
  const tabPermissions = { friends: 'server', players: 'players', world: 'server', console: 'console', backups: 'backups', files: 'files', settings: 'settings' };
  for (const button of document.querySelectorAll('.tab')) {
    const permission = tabPermissions[button.dataset.tab];
    button.classList.toggle('hidden', Boolean(permission && !hasPermission(permission)));
  }
  for (const [id, permission] of [['metrics-card', 'server'], ['software-card', 'settings'], ['pack-update-card', 'settings'], ['plugin-card', 'tools'], ['bedrock-card', 'tools'], ['tool-share-card', 'server'], ['notification-card', 'settings'], ['command-card', 'tools'], ['activity-card', 'server'], ['sftp-card', 'settings']]) {
    $(id).classList.toggle('hidden', !hasPermission(permission));
  }
  if (state.auth.host) {
    const accounts = await attempt(() => api.listCohosts()) || [];
    $('cohost-list').replaceChildren(...accounts.map((account) => {
      const row = el('div', { class: 'tool-row' }, el('div', { class: 'tool-info' }, el('strong', {}, account.username), el('span', { class: 'muted small' }, `${account.permissions.join(', ')}${account.twoFactor ? ' · authenticator required' : ''}`)));
      const remove = el('button', { class: 'btn btn-ghost danger-text', type: 'button' }, 'Remove');
      remove.onclick = async () => { if (await confirmDialog(`Remove co-host account ${account.username}?`, { title: 'Remove co-host', confirmText: 'Remove' })) { await attempt(() => api.removeCohost(account.username)); loadCohostUi(); } };
      row.append(remove);
      return row;
    }));
    if (!accounts.length) $('cohost-list').append(el('p', { class: 'muted small' }, 'No co-host accounts yet.'));
  } else {
    $('cohost-list').replaceChildren();
    $('cohost-login-form').classList.add('hidden');
  }
}

function renderZomboidActions() {
  const s = current();
  if (!s || s.game !== 'zomboid') return;
  const running = s.status === 'running';
  const act = (label, action, opts = {}) => el('button', {
    class: `btn${opts.ghost ? ' btn-ghost' : ''}`,
    type: 'button',
    disabled: !running,
    onclick: async () => {
      if (opts.confirm && !(await confirmDialog(opts.confirm, { title: label, confirmText: label, danger: false }))) return;
      const r = await attempt(() => api.zomboidServerAction(s.id, action));
      if (r !== undefined && r !== null) toast(opts.done || `${label}: done`);
    },
  }, label);
  fill($('zb-action-buttons'),
    act('Save the world now', 'save', { done: 'World saved' }),
    act('Start rain', 'rain-start'),
    act('Stop rain', 'rain-stop'),
    act('Helicopter event', 'helicopter', { confirm: 'Start the helicopter event? It flies around and draws zombies to players.' }),
    act('Gunshot sound', 'gunshot', { confirm: 'Play a loud gunshot somewhere on the map? It draws zombies.' }),
    act('Check for mod updates', 'check-mods', { ghost: true, done: 'Asked the server to check. If a mod updated, it says so in Console.' }));
  $('zb-msg').disabled = !running;
}

async function loadTools() {
  renderZomboidActions();
  const zb = current() && current().game === 'zomboid';
  $('quick-command-text').placeholder = zb ? 'save' : 'save-all';
  const server = current();
  if (!server) return;
  await loadCohostUi();
  if (hasPermission('settings')) {
    const versions = await attempt(() => api.minecraftVersions()) || [];
    $('software-version').replaceChildren(...versions.map((version) => el('option', { value: version.id }, version.id)));
    const chosen = versions.some((version) => version.id === server.minecraft) ? server.minecraft : versions[0]?.id;
    if (chosen) $('software-version').value = chosen;
    $('software-type').value = server.software || server.loader || 'vanilla';
  }
  if (hasPermission('server')) {
    await Promise.all([updateMetrics(), loadActivity()]);
  }
  if (hasPermission('tools')) {
    state.commandButtons = await attempt(() => api.commandButtons(server.id)) || [];
    renderQuickCommands();
  }
  if (hasPermission('settings')) {
    const notifications = await attempt(() => api.notificationSettings()) || {};
    $('notify-start').checked = notifications.start !== false;
    $('notify-stop').checked = notifications.stop !== false;
    $('notify-crash').checked = notifications.crash !== false;
    $('notify-attention').checked = notifications.attention !== false;
    const sftp = await attempt(() => api.sftpStatus(server.id));
    if (sftp?.active) renderSftp(sftp);
    else renderSftp(null);
    const liveStatus = await attempt(() => api.statusPageState(server.id));
    state.liveStatus = liveStatus && liveStatus.active ? liveStatus : null;
    renderLiveStatus();
  }
  if (document.getElementById('pack-update-check')) $('pack-update-check').disabled = !hasPermission('settings') || !server.source || server.source.type !== 'modrinth';
}

function renderSftp(info) {
  const active = Boolean(info && info.active);
  $('sftp-start').classList.toggle('hidden', active);
  $('sftp-stop').classList.toggle('hidden', !active);
  $('sftp-copy').classList.toggle('hidden', !state.sftpCredentials);
  if (!active) {
    state.sftpCredentials = null;
    $('sftp-copy').classList.add('hidden');
    $('sftp-details').textContent = 'SFTP is stopped.';
    return;
  }
  const credentials = state.sftpCredentials;
  if (info.otherServer) {
    $('sftp-details').replaceChildren(el('p', { class: 'danger-text' }, `SFTP is currently sharing “${info.serverName}”. Stop it before starting access for this server.`));
    return;
  }
  const addresses = credentials?.addresses || [info.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0'];
  $('sftp-details').replaceChildren(
    el('p', {}, `Connected clients use username “minecraft” on port ${info.port}. Address${addresses.length === 1 ? '' : 'es'}: ${addresses.map((address) => `${address}:${info.port}`).join(', ')}`),
    el('p', {}, `Host key fingerprint: ${info.fingerprint}`),
    credentials ? el('p', {}, `Temporary password: ${credentials.password}`) : el('p', { class: 'muted' }, 'The password is shown only when SFTP starts. Stop and start to generate a new password.'),
  );
}

function renderLiveStatus() {
  const info = state.liveStatus;
  const active = Boolean(info && info.active);
  $('live-status-start').classList.toggle('hidden', active);
  $('live-status-stop').classList.toggle('hidden', !active);
  $('live-status-open').classList.toggle('hidden', !active || info.otherServer);
  $('live-status-copy').classList.toggle('hidden', !active || info.otherServer);
  $('status-lan').disabled = active;
  if (!active) { $('live-status-details').textContent = 'Live page is stopped.'; return; }
  if (info.otherServer) { $('live-status-details').textContent = `Live page is currently serving ${info.serverName}. Stop it first to switch servers.`; return; }
  const addresses = info.addresses.map((address) => `http://${address}:${info.port}/`);
  $('live-status-details').textContent = `Live page: ${addresses.join(' · ')}${info.lanAccess ? ' · LAN enabled' : ' · this PC only'}`;
}

async function searchPlugins() {
  const result = await attempt(() => api.searchPlugins($('plugin-search').value.trim(), { gameVersion: current()?.minecraft }));
  const root = $('plugin-results');
  root.replaceChildren();
  if (!result || !result.hits.length) { root.append(el('p', { class: 'muted small' }, 'No compatible plugins found.')); return; }
  for (const plugin of result.hits) {
    const row = el('div', { class: 'tool-row' });
    const info = el('div', { class: 'tool-info' }, el('strong', {}, plugin.title), el('span', { class: 'muted small' }, `${plugin.author} · ${formatCount(plugin.downloads)} downloads · ${plugin.description || ''}`));
    const install = el('button', { class: 'btn btn-primary', type: 'button' }, 'Install');
    install.onclick = async () => {
      const installed = await attempt(() => api.installPlugin(state.selectedId, plugin.id));
      if (installed) toast(`${installed.filename} installed${installed.needsRestart ? '; restart the server to load it' : ''}.`);
    };
    row.append(info, install); root.append(row);
  }
}

async function loadFriends() {
  if ((current() && current().game === 'zomboid')) return;
  const id = state.selectedId;
  const s = current();
  if (!s) return;
  $('check-result').classList.add('hidden');
  $('export-status').textContent = '';
  const needsList = $('join-needs');
  if (!s.installed) {
    needsList.replaceChildren(el('li', {}, 'Available once the server has finished installing.'));
  } else {
    const needs = await attempt(() => api.clientNeeds(id));
    if (needs && id === state.selectedId && needs.loader === 'vanilla') {
      needsList.replaceChildren(
        el('li', {}, 'Minecraft ', el('strong', {}, needs.minecraft), ' (Java Edition)'),
        el('li', {}, 'No mods. The normal Minecraft launcher works: pick version ', el('strong', {}, needs.minecraft), ' in Installations.')
      );
    } else if (needs && id === state.selectedId) {
      needsList.replaceChildren(
        el('li', {}, 'Minecraft ', el('strong', {}, needs.minecraft)),
        el('li', {}, el('strong', {}, loaderName(needs.loader, needs.loaderVersion)), ' (the mod loader, exact version)'),
        el('li', {}, el('strong', {}, `${needs.modCount} mods`), ` from ${s.packName ? `${s.packName} ${s.packVersion || ''}`.trim() : s.name}`)
      );
    }
  }
  const vanilla = s.source && s.source.type === 'vanilla';
  $('export-card').classList.toggle('hidden', vanilla);
  $('check-card').classList.toggle('hidden', vanilla);
  $('export-mrpack').classList.toggle('hidden', !s.source || s.source.type === 'profile');
  $('export-cf').disabled = !s.installed;
  $('export-mrpack').disabled = !s.installed;

  const mp = s.source && s.source.modpack;
  $('join-modpack-hint').classList.toggle('hidden', !mp);
  if (mp) $('join-modpack-hint').textContent = `Friends who use CurseForge can also install "${mp.name}"${mp.version ? ` (${mp.version})` : ''} straight from CurseForge.`;

  if (!state.profiles) state.profiles = (await attempt(() => api.listProfiles())) || [];
  const select = $('check-profile');
  select.replaceChildren(
    ...state.profiles.map((p) => el('option', { value: p.id }, `${p.name} (${p.launcherName}, Minecraft ${p.minecraft || '?'}, ${p.modCount} mods)`))
  );
  if (!state.profiles.length) select.replaceChildren(el('option', {}, 'No CurseForge, Modrinth App or Prism profiles found'));
  $('check-btn').disabled = !state.profiles.length || !s.installed;
}

async function checkProfile() {
  $('check-btn').disabled = true;
  const result = await attempt(() => api.checkProfile(state.selectedId, $('check-profile').value));
  $('check-btn').disabled = false;
  if (!result) return;
  const line = (ok, text) => el('div', { class: ok ? 'ok' : 'bad' }, `${ok ? '✓' : '✗'} ${text}`);
  const items = [
    line(result.minecraft.ok, `Minecraft: server needs ${result.minecraft.need}, profile has ${result.minecraft.have}`),
    line(result.loader.versionOk, `Mod loader: server needs ${result.loader.need}, profile has ${result.loader.have}`),
    line(result.missing.length === 0, result.missing.length ? `${result.missing.length} mod(s) missing from the profile` : 'All the server\'s mods are in the profile'),
  ];
  if (result.missing.length) items.push(el('details', {}, el('summary', {}, 'Show missing mods'), el('ul', {}, result.missing.map((m) => el('li', {}, m)))));
  if (result.extra.length) items.push(el('details', {}, el('summary', {}, `${result.extra.length} extra mod(s) in the profile (usually fine)`), el('ul', {}, result.extra.map((m) => el('li', {}, m)))));
  items.push(el('strong', {}, result.ready ? 'This profile can join the server.' : 'This profile can\'t join yet. Save the pack for CurseForge and import it as a new profile.'));
  $('check-result').replaceChildren(...items);
  $('check-result').classList.remove('hidden');
}

async function exportPack(kind) {
  const id = state.selectedId;
  $('export-status').textContent = kind === 'cf' ? 'Building the pack…' : '';
  const file = await attempt(() => (kind === 'cf' ? api.exportClientPack(id) : api.exportMrpack(id)));
  $('export-status').textContent = file ? `Saved to ${file}` : '';
}

function classifyLine(line) {
  if (line.stream === 'system' || line.stream === 'input') return line.stream;
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(line.text)) return 'error';
  if (/\bWARN(ING)?\b/.test(line.text)) return 'warn';
  return line.stream === 'stderr' ? 'stderr' : '';
}

function appendConsole(line) {
  const c = $('console');
  const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  const node = el('div', { class: classifyLine(line) }, line.text);
  node.hidden = Boolean($('console-search') && $('console-search').value && !String(line.text).toLowerCase().includes($('console-search').value.toLowerCase()));
  c.append(node);
  while (c.childElementCount > MAX_CONSOLE_LINES) c.firstChild.remove();
  if (atBottom) c.scrollTop = c.scrollHeight;
}

async function loadZomboidSettings() {
  const s = current();
  const v = await attempt(() => api.zomboidSettings(s.id));
  if (!v) return;
  $('zb-name').value = v.PublicName;
  $('zb-desc').value = v.PublicDescription;
  $('zb-max').value = v.MaxPlayers;
  $('zb-pass').value = v.Password;
  $('zb-pvp').checked = v.PVP === 'true';
  $('zb-map').value = v.Map || 'Muldraugh, KY';
  $('zb-pause').checked = v.PauseEmpty === 'true';
  $('zb-public').checked = v.Public === 'true';
  $('zb-modrestart').checked = s.modUpdateRestart !== false;
  setupRamSlider($('zb-ram'), $('zb-ram-label'), s.memoryMb, $('zb-ram-hint'));
  const suggest = () => showRamSuggestion($('zb-ram-suggest'), $('zb-ram'), $('zb-ram-label'), v.modCount || 0, Number($('zb-max').value) || 16);
  const slide = $('zb-ram').oninput;
  $('zb-ram').oninput = () => { slide(); suggest(); };
  $('zb-max').oninput = suggest;
  suggest();
  $('zb-saved').textContent = '';
}

async function saveZomboidSettings(event) {
  event.preventDefault();
  const s = current();
  const ok = await attempt(async () => {
    await api.saveZomboidSettings(s.id, {
      PublicName: $('zb-name').value,
      PublicDescription: $('zb-desc').value,
      MaxPlayers: Number($('zb-max').value),
      Password: $('zb-pass').value,
      PVP: $('zb-pvp').checked,
      PauseEmpty: $('zb-pause').checked,
      Public: $('zb-public').checked,
      Map: $('zb-map').value,
    });
    await api.setMemory(s.id, Number($('zb-ram').value));
    await api.update(s.id, { modUpdateRestart: $('zb-modrestart').checked });
    if ($('zb-name').value.trim()) await api.update(s.id, { name: $('zb-name').value.trim() });
    return true;
  });
  if (ok) {
    $('zb-saved').textContent = 'Saved. Changes apply on the next start.';
    refreshServers();
  }
}

async function loadSettings() {
  if ((current() && current().game === 'zomboid')) {
    loadWorldRules();
    loadServerOptions();
    return loadZomboidSettings();
  }
  const s = current();
  if (!s) return;
  $('set-name').value = s.name;
  setupRamSlider($('set-ram'), $('set-ram-label'), s.memoryMb);
  $('set-auto-restart').checked = s.autoRestart !== false;
  const props = (await attempt(() => api.getProperties(s.id))) || {};
  const has = Object.keys(props).length > 0;
  $('set-motd').value = props.motd || '';
  $('set-maxplayers').value = props['max-players'] || '';
  $('set-port').value = props['server-port'] || '';
  $('set-difficulty').value = props.difficulty || 'easy';
  $('set-spawn-protection').value = props['spawn-protection'] || '16';
  $('set-gamemode').value = props.gamemode || 'survival';
  $('set-pvp').checked = props.pvp !== 'false';
  $('set-command-blocks').checked = props['enable-command-block'] === 'true';
  $('set-force-gamemode').checked = props['force-gamemode'] === 'true';
  for (const id of ['set-motd', 'set-maxplayers', 'set-port', 'set-difficulty', 'set-spawn-protection', 'set-gamemode', 'set-pvp', 'set-command-blocks', 'set-force-gamemode']) $(id).disabled = !has;
  $('settings-hint').classList.toggle('hidden', has);
  $('settings-saved').textContent = '';
  renderOnlineBox();
}

async function saveSettings(event) {
  event.preventDefault();
  const id = state.selectedId;
  const ok = await attempt(async () => {
    await api.update(id, { name: $('set-name').value, memoryMb: Number($('set-ram').value), autoRestart: $('set-auto-restart').checked });
    if (!$('set-motd').disabled) {
      const port = Number($('set-port').value);
      const maxPlayers = Number($('set-maxplayers').value);
      const spawnProtection = Number($('set-spawn-protection').value);
      const patch = {
        motd: $('set-motd').value.replace(/[\r\n]/g, ' '), difficulty: $('set-difficulty').value,
        gamemode: $('set-gamemode').value, pvp: String($('set-pvp').checked),
        'enable-command-block': String($('set-command-blocks').checked),
        'force-gamemode': String($('set-force-gamemode').checked),
      };
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch['server-port'] = port;
      if (Number.isInteger(maxPlayers) && maxPlayers > 0) patch['max-players'] = maxPlayers;
      if (Number.isInteger(spawnProtection) && spawnProtection >= 0 && spawnProtection <= 1000) patch['spawn-protection'] = spawnProtection;
      await api.setProperties(id, patch);
    }
    return true;
  });
  if (ok) {
    $('settings-saved').textContent = 'Saved';
    await refreshServers();
    loadShare(id);
  }
}

// ---------- start / EULA ----------

async function startServer() {
  const s = current();
  if (!s) return;
  if (s.game === 'zomboid') {
    if (!s.installed) {
      await finishZomboidSetup();
      return;
    }
    // Checking for game updates can take a while before the status changes; show it at once.
    const button = $('srv-start');
    button.disabled = true;
    button.textContent = 'Starting…';
    const ok = await attempt(() => api.start(s.id));
    if (!ok) renderStatus(current() || s);
    return;
  }
  // Ask once for the host's username so they are put on each server's whitelist.
  const host = await attempt(() => api.hostName());
  if (host && !host.saved) {
    $('host-input').value = host.name || '';
    $('host-modal').classList.remove('hidden');
    $('host-input').select();
    return;
  }
  if (!s.eulaAccepted) {
    $('eula-check').checked = false;
    $('eula-accept').disabled = true;
    $('eula-modal').classList.remove('hidden');
    $('eula-check').focus();
    return;
  }
  await attempt(() => api.start(s.id));
}

async function finishZomboidSetup() {
  const s = current();
  if (!s || s.game !== 'zomboid' || s.installed) return;
  const button = $('srv-start');
  button.disabled = true;
  button.textContent = 'Resuming setup…';
  const started = await attempt(() => api.retryZomboidSetup(s.id));
  if (started) {
    await refreshServers();
    toast('Setup resumed. Progress is shown in the Console tab.');
  } else {
    renderStatus(current() || s);
  }
}

// ---------- wiring ----------

function wire() {
  $('new-server-btn').onclick = openNewServer;
  document.querySelector('[data-action="new-server"]').onclick = openNewServer;
  document.querySelectorAll('.source-tab').forEach((t) => (t.onclick = () => selectSource(t.dataset.source)));
  $('import-file-btn').onclick = importFile;
  $('search-form').onsubmit = (e) => {
    e.preventDefault();
    search($('search-input').value.trim());
  };
  $('back-to-source').onclick = () => showView('new');
  $('create-form').onsubmit = createServer;

  $('srv-start').onclick = startServer;
  $('srv-stop').onclick = () => attempt(() => api.stop(state.selectedId));
  $('eula-check').onchange = (e) => ($('eula-accept').disabled = !e.target.checked);
  $('eula-cancel').onclick = () => $('eula-modal').classList.add('hidden');
  $('eula-accept').onclick = async () => {
    $('eula-modal').classList.add('hidden');
    const id = state.selectedId;
    if (await attempt(() => api.acceptEula(id))) await attempt(() => api.start(id));
    refreshServers();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('tour').classList.contains('hidden')) endTour();
      $('app-settings-modal').classList.add('hidden');
      $('eula-modal').classList.add('hidden');
      $('rename-modal').classList.add('hidden');
      $('host-modal').classList.add('hidden');
      closeMenu();
      closePlayerMenu();
    }
  });

  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $('command-form').onsubmit = async (e) => {
    e.preventDefault();
    const command = $('command-input').value.trim().replace(/^\//, '');
    if (!command) return;
    $('command-input').value = '';
    await attempt(() => api.command(state.selectedId, command));
  };
  $('copy-log').onclick = async () => {
    await attempt(() => api.copy($('console').innerText));
    toast('Console log copied');
  };
  $('console-search').oninput = () => {
    const query = $('console-search').value.toLowerCase();
    for (const line of $('console').children) line.hidden = Boolean(query && !line.textContent.toLowerCase().includes(query));
  };
  $('copy-filtered-log').onclick = async () => {
    const text = [...$('console').children].filter((line) => !line.hidden).map((line) => line.innerText).join('\n');
    await attempt(() => api.copy(text));
    toast('Visible console lines copied');
  };
  $('backup-now').onclick = async () => {
    const button = $('backup-now');
    button.disabled = true;
    if (await attempt(() => api.createBackup(state.selectedId, 'Manual restore point'))) toast('Restore point saved.');
    await loadBackupsTasks();
    button.disabled = false;
  };
  $('backup-settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const saved = await attempt(() => api.setBackupSettings(state.selectedId, {
      retention: Number($('backup-retention').value),
      include: $('backup-include').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      exclude: $('backup-exclude').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    }));
    if (saved) $('backup-settings-status').textContent = 'Saved';
    await loadBackupsTasks();
  };
  $('task-type').onchange = updateTaskFields;
  $('task-frequency').onchange = updateTaskFields;
  $('task-form').onsubmit = async (e) => {
    e.preventDefault();
    const next = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: $('task-name').value.trim(), type: $('task-type').value,
      time: $('task-time').value, frequency: $('task-frequency').value,
      dayOfWeek: Number($('task-day').value), warningMinutes: Number($('task-warning').value),
      command: $('task-command').value.trim(), chainTaskId: $('task-chain').value || null, enabled: true,
    };
    const saved = await attempt(() => api.saveTasks(state.selectedId, [...state.tasks, next]));
    if (saved) {
      $('task-name').value = '';
      $('task-command').value = '';
      toast('Scheduled task added.');
      await loadBackupsTasks();
    }
  };
  $('file-up').onclick = () => {
    if (state.fileDir !== '.') state.fileDir = state.fileDir.split('/').slice(0, -1).join('/') || '.';
    loadFiles();
  };
  $('file-refresh').onclick = loadFiles;
  $('file-upload').onclick = async () => {
    if (await attempt(() => api.uploadServerFiles(state.selectedId, state.fileDir))) { toast('Files uploaded.'); loadFiles(); }
  };
  $('file-new-folder').onclick = async () => {
    const name = await fileNameDialog('Create folder');
    if (name && await attempt(() => api.createServerFolder(state.selectedId, state.fileDir, name))) loadFiles();
  };
  $('file-editor-close').onclick = () => { $('file-editor').classList.add('hidden'); state.fileEditorPath = null; };
  $('file-editor-save').onclick = async () => {
    if (!state.fileEditorPath) return;
    const saved = await attempt(() => api.writeServerFile(state.selectedId, state.fileEditorPath, $('file-editor-content').value));
    if (saved !== undefined) $('file-editor-status').textContent = 'Saved';
  };
  $('check-btn').onclick = checkProfile;
  $('export-cf').onclick = () => exportPack('cf');
  $('export-mrpack').onclick = () => exportPack('mrpack');
  $('settings-form').onsubmit = saveSettings;
  $('software-form').onsubmit = async (e) => {
    e.preventDefault();
    const software = $('software-type').value;
    const minecraft = $('software-version').value;
    if (!minecraft) return;
    const confirmed = await confirmDialog(`Switch ${current()?.name} to ${software} on Minecraft ${minecraft}? A restore point will be saved first. The server must be stopped, and existing mods may be moved aside if they do not match.`, { title: 'Switch server software?', confirmText: 'Save restore point and switch', danger: false });
    if (!confirmed) return;
    $('software-status').textContent = 'Saving restore point and preparing server files…';
    $('software-form').querySelector('button[type="submit"]').disabled = true;
    const result = await attempt(() => api.changeSoftware(state.selectedId, software, minecraft));
    $('software-form').querySelector('button[type="submit"]').disabled = false;
    $('software-status').textContent = result ? `Ready to start on ${software} ${minecraft}.` : '';
    if (result) { toast('Server software switched.'); await refreshServers(); await loadTools(); }
  };
  $('plugin-search-form').onsubmit = (e) => { e.preventDefault(); searchPlugins(); };
  $('pack-update-check').onclick = async () => {
    $('pack-update-check').disabled = true;
    const diff = await attempt(() => api.comparePackUpdate(state.selectedId));
    $('pack-update-check').disabled = false;
    if (!diff) return;
    state.packDiff = diff;
    const root = $('pack-update-diff');
    root.replaceChildren();
    if (diff.upToDate) { root.append(el('p', {}, 'This server already has the latest available modpack version.')); $('pack-update-apply').classList.add('hidden'); return; }
    root.append(el('p', {}, `Version ${diff.current || 'current'} → ${diff.latest}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`));
    const files = [...diff.added.map((file) => `+ ${file}`), ...diff.removed.map((file) => `− ${file}`), ...diff.changed.map((file) => `~ ${file}`)].slice(0, 40);
    if (files.length) root.append(el('pre', { class: 'muted small' }, files.join('\n')));
    if (diff.added.length + diff.removed.length + diff.changed.length > files.length) root.append(el('p', { class: 'muted small' }, `${diff.added.length + diff.removed.length + diff.changed.length - files.length} more changes`));
    $('pack-update-apply').classList.remove('hidden');
  };
  $('pack-update-apply').onclick = async () => {
    const diff = state.packDiff;
    if (!diff || diff.upToDate) return;
    const confirmed = await confirmDialog(`Update the server modpack from ${diff.current} to ${diff.latest}? A restore point will be created before pack files are replaced. Stop the server first if it is running.`, { title: 'Update modpack?', confirmText: 'Back up and update', danger: false });
    if (!confirmed) return;
    $('pack-update-apply').disabled = true;
    const result = await attempt(() => api.updatePack(state.selectedId, diff.versionId));
    $('pack-update-apply').disabled = false;
    if (result) { toast(`Updated to modpack ${result.version}; restore point ${result.backup.id} saved.`); state.packDiff = null; await refreshServers(); await loadTools(); }
  };
  $('disk-warning-save').onclick = async () => {
    const saved = await attempt(() => api.setDiskWarning(state.selectedId, Number($('disk-warning-limit').value)));
    if (saved) { toast(`Disk warning set to ${saved} GB.`); updateMetrics(); }
  };
  $('bedrock-install').onclick = async () => {
    const confirmed = await confirmDialog('Install Geyser and Floodgate on this Paper server? The server must be stopped. A restore point will be saved first.', { title: 'Set up Bedrock cross-play?', confirmText: 'Back up and install', danger: false });
    if (!confirmed) return;
    $('bedrock-install').disabled = true;
    const result = await attempt(() => api.installBedrockBridge(state.selectedId));
    $('bedrock-install').disabled = false;
    if (result) $('bedrock-status').textContent = `Installed ${result.geyser.filename} and ${result.floodgate.filename}. Start the server, then set up UDP port 19132 using the Geyser guide.`;
  };
  $('share-status-page').onclick = async () => {
    const file = await attempt(() => api.exportStatusPage(state.selectedId));
    if (file) toast('Status page exported. Share the HTML file or upload it to a website.');
  };
  $('live-status-start').onclick = async () => {
    $('live-status-start').disabled = true;
    const info = await attempt(() => api.startStatusPage(state.selectedId, { lanAccess: $('status-lan').checked }));
    $('live-status-start').disabled = false;
    if (info) { state.liveStatus = info; renderLiveStatus(); toast('Live status page is running.'); }
  };
  $('live-status-stop').onclick = async () => {
    if (!await confirmDialog('Stop the live status page? Friends will no longer be able to open it.', { title: 'Stop status page?', confirmText: 'Stop status page', danger: true })) return;
    if (await attempt(() => api.stopStatusPage(state.selectedId))) { state.liveStatus = null; renderLiveStatus(); toast('Live status page stopped.'); }
  };
  $('live-status-open').onclick = () => attempt(() => api.openStatusPage(state.selectedId));
  $('live-status-copy').onclick = async () => {
    if (!state.liveStatus) return;
    const url = state.liveStatus.addresses.map((address) => `http://${address}:${state.liveStatus.port}/`).join('\n');
    if (await attempt(() => api.copy(url))) toast('Live page address copied.');
  };
  $('copy-join-info').onclick = async () => {
    const server = current();
    const info = await attempt(() => api.joinInfo(state.selectedId));
    if (!server || !info) return;
    const publicAddress = state.tunnels[state.selectedId]?.address;
    const addresses = [...new Set([publicAddress, ...(info.lan || []).map((entry) => entry.address), info.local].filter(Boolean))];
    const instructions = [`${server.name} — Minecraft Java Edition`, `Version: ${server.minecraft || 'see host'}`, `Join address${addresses.length > 1 ? 'es' : ''}: ${addresses.join(', ')}`, ...(server.loader && server.loader !== 'vanilla' ? [`Mods: ${server.loader} ${server.loaderVersion || ''}; install the same modpack as the host.`] : [])].join('\n');
    if (await attempt(() => api.copy(instructions)) !== undefined) toast('Join instructions copied.');
  };
  $('notify-save').onclick = async () => {
    const saved = await attempt(() => api.setNotificationSettings({ start: $('notify-start').checked, stop: $('notify-stop').checked, crash: $('notify-crash').checked, attention: $('notify-attention').checked }));
    if (saved) toast('Notification settings saved.');
  };
  $('quick-command-form').onsubmit = async (e) => {
    e.preventDefault();
    const label = $('quick-command-name').value.trim();
    const command = $('quick-command-text').value.trim().replace(/^\//, '');
    if (!label || !command) return;
    const updated = await attempt(() => api.setCommandButtons(state.selectedId, [...state.commandButtons, { id: `cmd-${Date.now()}`, label, command }]));
    if (updated) { state.commandButtons = updated; renderQuickCommands(); $('quick-command-name').value = ''; $('quick-command-text').value = ''; }
  };
  $('sftp-start').onclick = async () => {
    const port = Number($('sftp-port').value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { toast('Choose a port from 1024 to 65535.', true); return; }
    $('sftp-start').disabled = true;
    const info = await attempt(() => api.sftpStart(state.selectedId, { port, lanAccess: $('sftp-lan').checked }));
    $('sftp-start').disabled = false;
    if (info) { state.sftpCredentials = info; renderSftp(info); toast('SFTP is running. Save the generated password before closing this screen.'); }
  };
  $('sftp-stop').onclick = async () => {
    if (!await confirmDialog('Disconnect all SFTP clients and stop access to the server folder?', { title: 'Stop SFTP?', confirmText: 'Stop SFTP', danger: true })) return;
    const stopped = await attempt(() => api.sftpStop(state.selectedId));
    if (stopped) { state.sftpCredentials = null; renderSftp(null); toast('SFTP stopped.'); }
  };
  $('sftp-copy').onclick = async () => {
    const info = state.sftpCredentials;
    if (!info) return;
    const lines = [`SFTP host: ${info.addresses.join(', ')}`, `Port: ${info.port}`, `Username: ${info.username}`, `Password: ${info.password}`, `Host key fingerprint: ${info.fingerprint}`, 'Remote folder: /'];
    if (await attempt(() => api.copy(lines.join('\n')))) toast('SFTP connection details copied.');
  };
  $('cohost-create-form').onsubmit = async (e) => {
    e.preventDefault();
    const permissions = [...document.querySelectorAll('.cohost-permission:checked')].map((input) => input.value);
    const result = await attempt(() => api.createCohost({ username: $('cohost-new-name').value.trim(), password: $('cohost-new-password').value, permissions, twoFactor: $('cohost-two-factor').checked }));
    if (!result) return;
    $('cohost-new-password').value = '';
    const secret = $('cohost-secret');
    secret.classList.remove('hidden');
    secret.replaceChildren(el('strong', {}, `Account ${result.username} created.`), el('p', {}, result.twoFactorSecret ? `Save this authenticator secret now: ${result.twoFactorSecret}. It will only be shown once. Add it to an authenticator app before the co-host signs in.` : 'Give the co-host their username and temporary password securely.'));
    await loadCohostUi();
  };
  $('cohost-login-form').onsubmit = async (e) => {
    e.preventDefault();
    const result = await attempt(() => api.loginCohost({ username: $('cohost-login-name').value.trim(), password: $('cohost-login-password').value, code: $('cohost-login-code').value }));
    if (result) { $('cohost-login-password').value = ''; $('cohost-login-code').value = ''; await loadCohostUi(); toast(`Signed in as ${result.username}.`); }
  };
  $('cohost-logout').onclick = async () => { await attempt(() => api.logoutCohost()); await loadCohostUi(); toast('Signed out of the co-host account.'); };
  $('open-folder').onclick = () => attempt(() => api.openFolder(state.selectedId));
  $('playit-unlink').onclick = async () => {
    if (await confirmDialog('Friends will not be able to join from other networks until you connect it again.', {
      title: 'Disconnect playit.gg?', confirmText: 'Disconnect',
    })) {
      await attempt(() => api.playitUnlink());
    }
  };
  $('delete-server').onclick = () => {
    const s = current();
    if (s) deleteServer(s);
  };
  $('vanilla-continue').onclick = chooseVanilla;
  $('host-cancel').onclick = () => $('host-modal').classList.add('hidden');
  $('host-form').onsubmit = async (e) => {
    e.preventDefault();
    if (await attempt(async () => (await api.setHostName($('host-input').value.trim()), true))) {
      state.host = $('host-input').value.trim();
      $('host-modal').classList.add('hidden');
      startServer();
    }
  };
  $('wl-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('wl-name').value.trim();
    if (name && (await addToWhitelist(name))) $('wl-name').value = '';
  };
  $('wl-enabled').onchange = async (e) => {
    const on = e.target.checked;
    if (!on && !(await confirmDialog('Anyone who has the server address will be able to join.', {
      title: 'Turn off the whitelist?', confirmText: 'Turn off whitelist',
    }))) {
      e.target.checked = true;
      return;
    }
    await attempt(() => api.whitelistEnable(state.selectedId, on));
    loadWhitelist();
  };
  api.onWhitelist((id, wl) => {
    if (id === state.selectedId) renderWhitelist(wl);
    if (wl.justRefused) toast(`${wl.justRefused} tried to join but is not on the list. Allow them on the Players tab.`);
  });
  document.querySelectorAll('#ctx-menu button').forEach((b) => (b.onclick = () => runMenu(b.dataset.cmd)));
  document.addEventListener('click', (e) => {
    if (!$('ctx-menu').contains(e.target)) closeMenu();
    if (!$('player-menu').contains(e.target)) closePlayerMenu();
  });
  $('rename-cancel').onclick = () => $('rename-modal').classList.add('hidden');
  $('rename-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('rename-input').value.trim();
    if (!name) return;
    $('rename-modal').classList.add('hidden');
    if (await attempt(() => api.update(state.renaming, { name }))) await refreshServers();
  };

  api.onConsole((id, line) => {
    if (id === state.selectedId) appendConsole(line);
  });
  api.onAuthChanged((auth) => { state.auth = auth; if (!$('tab-tools').classList.contains('hidden')) loadTools(); });
  api.onInstall((id, event) => {
    const info = state.install[id] || (state.install[id] = { step: 0 });
    if (event.progress) Object.assign(info, event.progress);
    if (event.message) {
      noteInstallMessage(id, event.message);
      info.total = 0; // a new step started; its byte/file count arrives with the next progress event
      if (id === state.selectedId) appendConsole({ text: event.message, stream: 'system' });
    }
    if (id === state.selectedId) renderInstall(id);
  });
  api.onStatus(async (id, status) => {
    const s = state.servers.find((x) => x.id === id);
    if (s) s.status = status;
    if (status === 'starting' && !state.startup[id]) state.startup[id] = { label: 'Preparing server startup', startedAt: Date.now() };
    if (status === 'running' || status === 'stopped') delete state.startup[id];
    if (status === 'stopped') await refreshServers();
    renderServerList();
    if (s && id === state.selectedId) {
      renderServer(s);
      if (!$('tab-world').classList.contains('hidden')) loadWorld();
    }
  });
  $('zb-settings-form').onsubmit = saveZomboidSettings;
  document.querySelectorAll('.game-btn').forEach((b) => (b.onclick = () => setGame(b.dataset.game)));
  $('zbnew-form').onsubmit = createZomboidServer;
  $('zbnew-form').addEventListener('input', (e) => { if (e.target.id) e.target.dataset.touched = '1'; checkZomboidForm(); });
  $('zbnew-form').addEventListener('click', () => setTimeout(checkZomboidForm, 0));
  $('create-form').addEventListener('input', (e) => { if (e.target.id) e.target.dataset.touched = '1'; checkCreateForm(); });
  $('create-form').addEventListener('change', checkCreateForm);
  for (const id of ['zbnew-link-btn', 'zb-coll-link-btn']) $(id).dataset.label = $(id).textContent;
  $('zbnew-link-btn').onclick = useZomboidNewLink;
  $('zbnew-link').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); useZomboidNewLink(); } };
  $('zb-coll-link-btn').onclick = addCollectionLink;
  $('zb-coll-refresh').onclick = () => loadServerCollections(true);
  $('zb-rules-search').oninput = renderWorldRules;
  $('zb-rules-save').onclick = saveWorldRules;
  $('zb-rules-reset').onclick = loadWorldRules;
  $('zb-rules-preset-apply').onclick = applyWorldPreset;
  $('zb-options-search').oninput = renderServerOptions;
  $('zb-msg-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('zb-msg').value.trim();
    if (!text) return;
    if (await attempt(() => api.zomboidServerAction(state.selectedId, 'message', { text }))) {
      $('zb-msg').value = '';
      toast('Message sent');
    }
  };
  $('zb-options-save').onclick = saveServerOptions;
  $('zb-options-reset').onclick = loadServerOptions;
  $('mods-search').oninput = renderMods;
  $('mods-filter').onchange = renderMods;
  $('perf-refresh').onclick = loadPerformance;
  $('server-icon-choose').onclick = async () => {
    const icon = await attempt(() => api.chooseServerIcon(state.selectedId));
    if (icon) {
      toast('Icon saved. Players see it after the next restart.');
      loadServerIcon();
    }
  };
  $('server-icon-remove').onclick = async () => {
    await attempt(() => api.removeServerIcon(state.selectedId));
    loadServerIcon();
  };
  api.onMods((id) => {
    if (id === state.selectedId && !$('tab-mods').classList.contains('hidden')) loadMods();
  });
  api.onStartup((id, startup) => {
    if (startup.phase === 'ready' || startup.phase === 'failed' || startup.phase === 'stopping') delete state.startup[id];
    else state.startup[id] = startup;
    const s = state.servers.find((server) => server.id === id);
    if (s && id === state.selectedId) renderStatus(s);
  });
  api.onPlayers((id, players) => {
    state.players[id] = players;
    if (id === state.selectedId && !$('tab-players').classList.contains('hidden')) loadPlayers();
    renderServerList();
    const s = current();
    if (s && s.id === id) renderStatus(s);
  });
  api.onPlayit((p) => {
    state.playit = { ...p, linked: !['unlinked', 'linking'].includes(p.state) };
    renderPlayitPill();
    renderOnlineBox();
  });
  api.onPregen((id, p) => {
    state.pregen[id] = p;
    if (id === state.selectedId && !$('tab-world').classList.contains('hidden')) renderPregen();
  });
  api.onTunnel((id, t) => {
    state.tunnels[id] = t;
    if (id === state.selectedId) renderOnlineBox();
  });
  api.onExport((id, p) => {
    if (id === state.selectedId) $('export-status').textContent = `Building the pack… ${p.done} of ${p.total} files`;
  });
  api.onBackup((id) => { if (id === state.selectedId) loadBackupsTasks(); });
  api.onTask((id) => { if (id === state.selectedId) loadBackupsTasks(); });
  api.onServersChanged(() => refreshServers());
}

// ---------- app settings and appearance ----------

const LOOK_KEYS = ['theme', 'accent', 'panels', 'background', 'density', 'strip', 'motion'];

function applyAppearance(app) {
  const root = document.documentElement;
  root.dataset.theme = app.theme;
  root.dataset.accent = app.accent;
  root.dataset.panels = app.panels || 'brackets';
  root.dataset.bg = app.background || 'globe';
  root.dataset.density = app.density || 'comfortable';
  root.dataset.strip = app.strip === false ? 'off' : 'on';
  root.dataset.motion = app.motion ? 'on' : 'off';
  renderStrip();
  try {
    localStorage.setItem('appearance', JSON.stringify(Object.fromEntries(LOOK_KEYS.map((k) => [k, app[k]]))));
  } catch {
    // the saved settings still apply on the next start
  }
}

function openAppSettings() {
  const app = state.app;
  $('as-theme').value = app.theme;
  document.querySelectorAll('input[name="as-accent"]').forEach((r) => (r.checked = r.value === app.accent));
  $('as-motion').checked = app.motion;
  $('as-panels').value = app.panels || 'brackets';
  $('as-background').value = app.background || 'globe';
  $('as-density').value = app.density || 'comfortable';
  $('as-strip').checked = app.strip !== false;
  $('as-whitelist').checked = app.defaultWhitelist;
  $('as-startup').checked = app.startWithWindows;
  const max = Math.max(4096, Math.floor((state.totalMemoryMb * 0.75) / 1024) * 1024);
  const options = [el('option', { value: '0' }, 'Suggest based on the modpack')];
  for (let mb = 2048; mb <= max; mb += 1024) options.push(el('option', { value: String(mb) }, formatMb(mb)));
  fill($('as-memory'), options);
  $('as-memory').value = String(app.defaultMemoryMb || 0);
  state.appBefore = { ...app };
  $('app-settings-modal').classList.remove('hidden');
  $('as-theme').focus();
}

function previewAppearance() {
  const accent = (document.querySelector('input[name="as-accent"]:checked') || {}).value || state.app.accent;
  applyAppearance({ theme: $('as-theme').value, accent, ...lookFromForm() });
}

function lookFromForm() {
  return {
    panels: $('as-panels').value,
    background: $('as-background').value,
    density: $('as-density').value,
    strip: $('as-strip').checked,
    motion: $('as-motion').checked,
  };
}

async function saveAppSettings(event) {
  event.preventDefault();
  const accent = (document.querySelector('input[name="as-accent"]:checked') || {}).value || state.app.accent;
  const next = await attempt(() => api.setAppSettings({
    theme: $('as-theme').value,
    accent,
    ...lookFromForm(),
    defaultMemoryMb: Number($('as-memory').value) || null,
    defaultWhitelist: $('as-whitelist').checked,
    startWithWindows: $('as-startup').checked,
  }));
  if (!next) return;
  state.app = next;
  applyAppearance(next);
  $('app-settings-modal').classList.add('hidden');
  toast('Settings saved');
}

function cancelAppSettings() {
  if (state.appBefore) applyAppearance(state.appBefore);
  $('app-settings-modal').classList.add('hidden');
}

// ---------- tutorial ----------

const TOUR = [
  { title: 'Welcome to EZ Host', text: 'This quick tour shows where everything is. It takes about a minute, and you can skip it any time.' },
  { target: '.game-switch', title: 'Pick a game', text: 'Minecraft and Project Zomboid each have their own section with their own servers. Switch between them here.' },
  { target: '#new-server-btn', title: 'Make a server', text: 'Start here. For Minecraft, pick a profile you already play, a Modrinth modpack or plain Minecraft. For Zomboid, pick a world preset and your Workshop mods. Everything installs by itself.' },
  { target: '#server-list', title: 'Your servers', text: 'Every server you make shows up here. Click one to open it. Right-click for quick actions: rename, settings, open its folder, or delete it.' },
  { target: '#status-card', title: 'Start and stop', text: 'The big button starts or stops the server. The bar shows how far startup has got, and this card tells you in plain words if anything goes wrong.', needsServer: true },
  { target: '#share-card', title: 'Let friends join', text: 'Connect playit.gg once and each server gets its own online address. Copy it and send it to your friends; they paste it into Multiplayer, Add Server.', needsServer: true },
  { target: '.tabs', title: 'Everything else', text: 'Players: who can join, OP, inventories. Mods: turn mods on or off and see problems. World: the map and pregenerating. Tools: performance tips and live health. Settings: this server\'s options and icon.', needsServer: true },
  { target: '#app-settings-btn', title: 'Make it yours', text: 'Change the theme, accent colour, panels, background, spacing and the status strip, set defaults for new servers, or watch this tutorial again.' },
  { title: "You're ready", text: 'Make a server, press Start, and share the address. Have fun!' },
];

function startTour() {
  state.tourStep = 0;
  $('tour').classList.remove('hidden');
  showTourStep();
}

function visibleTarget(step) {
  if (!step.target) return null;
  const node = document.querySelector(step.target);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && node.offsetParent !== null ? node : null;
}

function showTourStep() {
  // Skip server-only steps when no server is open yet.
  while (TOUR[state.tourStep] && TOUR[state.tourStep].needsServer && !visibleTarget(TOUR[state.tourStep])) state.tourStep++;
  const step = TOUR[state.tourStep];
  if (!step) return endTour();
  const steps = TOUR.filter((t) => !t.needsServer || visibleTarget(t));
  $('tour-count').textContent = `STEP ${steps.indexOf(step) + 1} OF ${steps.length}`;
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  $('tour-back').disabled = state.tourStep === 0;
  $('tour-next').textContent = state.tourStep === TOUR.length - 1 ? 'Finish' : 'Next';
  const target = visibleTarget(step);
  const spot = $('tour-spot');
  const box = $('tour-box');
  $('tour').classList.toggle('no-spot', !target);
  spot.classList.toggle('hidden', !target);
  if (target) {
    target.scrollIntoView({ block: 'nearest' });
    const r = target.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Put the box beside the highlight, keeping it on screen.
    const bw = box.offsetWidth || 380;
    const bh = box.offsetHeight || 200;
    let left = r.right + 18;
    let top = r.top;
    if (left + bw > window.innerWidth - 12) left = Math.max(12, r.left - bw - 18);
    if (left < 12 || (r.left - bw - 18 < 12 && r.right + 18 + bw > window.innerWidth)) {
      left = Math.min(window.innerWidth - bw - 12, Math.max(12, r.left));
      top = r.bottom + 14 + bh > window.innerHeight ? r.top - bh - 14 : r.bottom + 14;
    }
    Object.assign(box.style, { left: `${left}px`, top: `${Math.max(12, Math.min(top, window.innerHeight - bh - 12))}px`, transform: '' });
  } else {
    Object.assign(box.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
  }
  $('tour-next').focus();
}

async function endTour() {
  $('tour').classList.add('hidden');
  if (state.app && !state.app.tutorialDone) {
    const next = await attempt(() => api.setAppSettings({ tutorialDone: true }));
    if (next) state.app = next;
  }
}

async function init() {
  wire();
  $('app-settings-btn').onclick = openAppSettings;
  $('app-settings-form').onsubmit = saveAppSettings;
  $('as-cancel').onclick = cancelAppSettings;
  $('as-theme').onchange = previewAppearance;
  $('as-motion').onchange = previewAppearance;
  for (const id of ['as-panels', 'as-background', 'as-density', 'as-strip']) $(id).onchange = previewAppearance;
  setInterval(renderStrip, 1000);
  document.querySelectorAll('input[name="as-accent"]').forEach((r) => (r.onchange = previewAppearance));
  $('as-tour').onclick = () => {
    cancelAppSettings();
    startTour();
  };
  $('tour-skip').onclick = endTour;
  $('tour-next').onclick = () => {
    if (state.tourStep >= TOUR.length - 1) return endTour();
    state.tourStep++;
    showTourStep();
  };
  $('tour-back').onclick = () => {
    // Step back over server-only steps that are not on screen.
    do state.tourStep--; while (state.tourStep > 0 && TOUR[state.tourStep].needsServer && !visibleTarget(TOUR[state.tourStep]));
    showTourStep();
  };
  window.addEventListener('resize', () => {
    if (!$('tour').classList.contains('hidden')) showTourStep();
  });
  state.app = (await attempt(() => api.appSettings())) || { theme: 'hud', accent: 'orange', motion: true, tutorialDone: true };
  applyAppearance(state.app);
  setInterval(() => {
    const s = current();
    if (s && s.status === 'starting') renderStartup(s.id);
  }, 1000);
  const auth = await attempt(() => api.cohostStatus());
  if (auth) { state.auth = auth; await loadCohostUi(); }
  state.totalMemoryMb = (await attempt(() => api.totalMemoryMb())) || 8192;
  state.playit = (await attempt(() => api.playitStatus())) || state.playit;
  renderPlayitPill();
  await refreshServers();
  let saved = null;
  try { saved = localStorage.getItem('game'); } catch { /* storage blocked */ }
  const game = saved === 'zomboid' || saved === 'minecraft' ? saved : state.servers.length ? gameOf(state.servers[0]) : 'minecraft';
  setGame(game);
  // First run: a short tour, which can be skipped.
  if (!state.app.tutorialDone) setTimeout(startTour, 600);
}

init();
