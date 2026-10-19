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
  players: {}, // serverId -> [names]
  playit: { state: 'unlinked', linked: false },
  join: {}, // serverId -> joinInfo
  tunnels: {}, // serverId -> { state, address, message, resolveLink }
  pregen: {}, // serverId -> pregeneration status
  menuFor: null, // server id the right-click menu is open for
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

function copyButton(text) {
  return el('button', { class: 'btn', type: 'button', onclick: async () => {
    await attempt(() => api.copy(text));
    toast(`Copied ${text}`);
  } }, 'Copy');
}

function showView(name) {
  for (const v of ['empty', 'new', 'details', 'server']) $(`view-${v}`).classList.toggle('hidden', v !== name);
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
        mb < 4096 ? 'Fine for small packs. Big modpacks may run out of memory.'
        : mb > state.totalMemoryMb * 0.6 ? `This PC has ${formatMb(state.totalMemoryMb)}. Leave some for Windows and Minecraft itself.`
        : `Good for most modpacks. This PC has ${formatMb(state.totalMemoryMb)} in total.`;
    }
  };
  input.oninput = update;
  update();
}

function recommendedRam(modCount = 100) {
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

function renderServerList() {
  $('server-list').replaceChildren(
    ...state.servers.map((s) =>
      el('li', {
        class: `server-item${s.id === state.selectedId ? ' active' : ''}`,
        onclick: () => openServer(s.id),
        oncontextmenu: (e) => openMenu(e, s.id),
        title: 'Right-click for more options',
      },
        icon(s.source && (s.source.iconUrl || (s.source.type === 'vanilla' ? 'icon.svg' : null))),
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, s.name),
          el('div', { class: 'sub' }, statusWord(s))
        ),
        el('span', { class: `dot ${s.installError || s.crashed ? 'error' : s.status}` })
      )
    )
  );
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
    showView(state.servers.length ? 'new' : 'empty');
  }
}

// ---------- new server: step 1 ----------

function openNewServer() {
  state.selectedId = null;
  renderServerList();
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
}

async function createServer(event) {
  event.preventDefault();
  const p = state.pending;
  if (!p) return;
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
  state.selectedId = id;
  renderServerList();
  showView('server');
  const s = current() || (await attempt(() => api.getServer(id)));
  if (!s) return;
  state.players[id] = (await attempt(() => api.getPlayers(id))) || [];
  state.tunnels[id] = (await attempt(() => api.getTunnel(id))) || {};
  renderServer(s);
  switchTab(s.status === 'installing' || s.installError || s.crashed ? 'console' : 'friends');
  const history = (await attempt(() => api.getConsole(id))) || [];
  $('console').replaceChildren();
  history.forEach(appendConsole);
  $('console').scrollTop = $('console').scrollHeight;
  loadShare(id);
}

function renderServer(s) {
  $('srv-name').textContent = s.name;
  $('srv-icon').src = (s.source && s.source.iconUrl) || 'icon.svg';
  const parts = [];
  if (s.loader === 'vanilla') parts.push('No mods');
  else if (s.packName) parts.push(`${s.packName} ${s.packVersion || ''}`.trim());
  if (s.minecraft) parts.push(`Minecraft ${s.minecraft}`);
  if (s.loader && s.loader !== 'vanilla') parts.push(loaderName(s.loader, s.loaderVersion));
  parts.push(`${formatMb(s.memoryMb)} memory`);
  $('srv-meta').textContent = parts.join(' · ');
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
    help = 'Setting everything up. Big modpacks can take a few minutes.';
  } else if (s.installError) {
    problem = true;
    dot = 'error';
    help = s.installError;
  } else if (s.status === 'starting') {
    help = 'Loading mods and the world. Modded servers can take a minute or two.';
  } else if (s.status === 'running') {
    help = players.length ? 'Players online:' : 'Your server is up. Share the address below with your friends.';
  } else if (s.status === 'stopping') {
    help = 'Saving the world…';
  } else if (s.crashed) {
    problem = true;
    dot = 'error';
    help = 'The server stopped by itself. The Console tab shows what went wrong.';
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
  $('srv-start').classList.toggle('hidden', live);
  $('srv-stop').classList.toggle('hidden', !live);
  $('srv-start').disabled = s.status === 'installing' || !s.installed;
  $('srv-stop').disabled = s.status === 'stopping';
  $('command-input').disabled = !live;

  $('install-progress').classList.toggle('hidden', s.status !== 'installing');
  if (s.status === 'installing') renderInstall(s.id);

  const box = $('players');
  box.classList.toggle('hidden', s.status !== 'running' || !players.length);
  box.replaceChildren(...players.map((p) => el('span', { class: 'player' }, p)));
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

function renderOnlineBox() {
  const s = current();
  if (!s) return;
  const p = state.playit;
  const t = state.tunnels[s.id] || {};
  const running = ['starting', 'running'].includes(s.status);
  let content;

  if (p.state === 'linking') {
    content = el('div', { class: 'notice' },
      el('strong', {}, 'Finish in your browser'),
      el('p', {}, 'Sign in or make a free playit.gg account, then approve Self-Host MC. This page updates by itself.'),
      p.claimUrl ? el('a', { href: p.claimUrl, target: '_blank', rel: 'noreferrer' }, 'Open the approval page again') : null
    );
  } else if (!p.linked) {
    content = el('div', { class: 'notice' },
      el('strong', {}, 'Let friends join from anywhere'),
      el('p', {}, 'Self-Host MC uses playit.gg, a free service, to give each server its own online address. No router settings needed. You link it once, in your browser.'),
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
  if (!confirm(`Get a new online address for "${s.name}"? The old address stops working and friends will need the new one.`)) return;
  await attempt(() => api.newAddress(s.id));
  state.tunnels[s.id] = (await attempt(() => api.getTunnel(s.id))) || {};
  renderOnlineBox();
}

// ---------- world: pregeneration ----------

const RADII = [
  [500, 'Small (500 blocks around spawn)'],
  [1000, 'Medium (1,000 blocks)'],
  [2000, 'Large (2,000 blocks)'],
  [3000, 'Very large (3,000 blocks)'],
  [5000, 'Huge (5,000 blocks)'],
];

async function loadWorld() {
  const id = state.selectedId;
  state.pregen[id] = (await attempt(() => api.pregenStatus(id))) || {};
  renderPregen();
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
  if (!confirm(`Delete "${s.name}"?\n\nIts world, mods and settings will be permanently removed from this PC. This can't be undone.`)) return;
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
  for (const tab of ['friends', 'world', 'console', 'settings']) $(`tab-${tab}`).classList.toggle('hidden', name !== tab);
  if (name === 'world') loadWorld();
  if (name === 'settings') loadSettings();
  if (name === 'friends') loadFriends();
  if (name === 'console') $('console').scrollTop = $('console').scrollHeight;
}

async function loadFriends() {
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
  if (!state.profiles.length) select.replaceChildren(el('option', {}, 'No CurseForge or Prism profiles found'));
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
  c.append(el('div', { class: classifyLine(line) }, line.text));
  while (c.childElementCount > MAX_CONSOLE_LINES) c.firstChild.remove();
  if (atBottom) c.scrollTop = c.scrollHeight;
}

async function loadSettings() {
  const s = current();
  if (!s) return;
  $('set-name').value = s.name;
  setupRamSlider($('set-ram'), $('set-ram-label'), s.memoryMb);
  const props = (await attempt(() => api.getProperties(s.id))) || {};
  const has = Object.keys(props).length > 0;
  $('set-motd').value = props.motd || '';
  $('set-maxplayers').value = props['max-players'] || '';
  $('set-port').value = props['server-port'] || '';
  $('set-difficulty').value = props.difficulty || 'easy';
  for (const id of ['set-motd', 'set-maxplayers', 'set-port', 'set-difficulty']) $(id).disabled = !has;
  $('settings-hint').classList.toggle('hidden', has);
  $('settings-saved').textContent = '';
  renderOnlineBox();
}

async function saveSettings(event) {
  event.preventDefault();
  const id = state.selectedId;
  const ok = await attempt(async () => {
    await api.update(id, { name: $('set-name').value, memoryMb: Number($('set-ram').value) });
    if (!$('set-motd').disabled) {
      const port = Number($('set-port').value);
      const maxPlayers = Number($('set-maxplayers').value);
      const patch = { motd: $('set-motd').value.replace(/[\r\n]/g, ' '), difficulty: $('set-difficulty').value };
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch['server-port'] = port;
      if (Number.isInteger(maxPlayers) && maxPlayers > 0) patch['max-players'] = maxPlayers;
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
  if (!s.eulaAccepted) {
    $('eula-check').checked = false;
    $('eula-accept').disabled = true;
    $('eula-modal').classList.remove('hidden');
    $('eula-check').focus();
    return;
  }
  await attempt(() => api.start(s.id));
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
      $('eula-modal').classList.add('hidden');
      $('rename-modal').classList.add('hidden');
      closeMenu();
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
  $('check-btn').onclick = checkProfile;
  $('export-cf').onclick = () => exportPack('cf');
  $('export-mrpack').onclick = () => exportPack('mrpack');
  $('settings-form').onsubmit = saveSettings;
  $('open-folder').onclick = () => attempt(() => api.openFolder(state.selectedId));
  $('playit-unlink').onclick = async () => {
    if (confirm('Disconnect playit.gg from this PC? Friends will not be able to join from other networks until you connect it again.')) {
      await attempt(() => api.playitUnlink());
    }
  };
  $('delete-server').onclick = () => {
    const s = current();
    if (s) deleteServer(s);
  };
  $('vanilla-continue').onclick = chooseVanilla;
  document.querySelectorAll('#ctx-menu button').forEach((b) => (b.onclick = () => runMenu(b.dataset.cmd)));
  document.addEventListener('click', (e) => {
    if (!$('ctx-menu').contains(e.target)) closeMenu();
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
    if (status === 'stopped') await refreshServers();
    renderServerList();
    if (s && id === state.selectedId) {
      renderServer(s);
      if (!$('tab-world').classList.contains('hidden')) loadWorld();
    }
  });
  api.onPlayers((id, players) => {
    state.players[id] = players;
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
  api.onServersChanged(() => refreshServers());
}

async function init() {
  wire();
  state.totalMemoryMb = (await attempt(() => api.totalMemoryMb())) || 8192;
  state.playit = (await attempt(() => api.playitStatus())) || state.playit;
  renderPlayitPill();
  await refreshServers();
  if (state.servers.length) openServer(state.servers[0].id);
  else showView('empty');
}

init();
