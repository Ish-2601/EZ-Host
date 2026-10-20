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
  if (state.selectedId !== id) {
    state.fileDir = '.';
    state.fileEditorPath = null;
    $('file-editor').classList.add('hidden');
  }
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
  if (s.startup) state.startup[s.id] = s.startup;
  else if (s.status !== 'starting') delete state.startup[s.id];
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
    const startup = state.startup[s.id];
    help = startup
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
      ? `${fixed.join(', ')} only work${fixed.length === 1 ? 's' : ''} in the game, not on a server, so Self-Host MC turned ${fixed.length === 1 ? 'it' : 'them'} off and is trying again. See the Mods tab.`
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
  $('srv-start').classList.toggle('hidden', live);
  $('srv-stop').classList.toggle('hidden', !live);
  $('srv-start').disabled = s.status === 'installing' || !s.installed;
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
  const info = state.startup[id] || { label: 'Starting Minecraft server', startedAt: Date.now() };
  const bar = $('startup-progress-bar');
  const label = $('startup-label');
  const elapsed = $('startup-elapsed');
  if (!bar || !label || !elapsed) return;
  label.textContent = info.label || 'Starting Minecraft server';
  const seconds = Math.max(0, Math.floor((Date.now() - (info.startedAt || Date.now())) / 1000));
  elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('startup-guidance').textContent = seconds >= 300
    ? 'This is taking a while. Check Console for errors or a stalled download; the elapsed time and current phase are shown above.'
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
  $('wl-help').textContent = wl.enabled
    ? 'Only the players below can join. Anyone else is turned away and shows up under "Trying to join".'
    : 'Anyone who has the server address can join. Turn the whitelist on to choose who gets in.';
  const remove = (name) => async () => {
    if (await attempt(async () => (await api.whitelistRemove(s.id, name), true))) loadWhitelist();
  };
  fill($('wl-list'),
    wl.players.length ? null : el('li', { class: 'muted' }, 'Nobody yet. Add your own username first.'),
    wl.players.map((p) => el('li', {},
      el('img', { src: headUrl(p.uuid || p.name, 24), alt: '' }),
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

function slotEl(item, key, player, extraClass = '') {
  if (!item) return el('div', { class: `slot ${extraClass}` });
  const label = itemLabel(item);
  const [namespace, itemId] = item.id.includes(':') ? item.id.split(':', 2) : ['minecraft', item.id];
  // Minecraft's vanilla item textures are served per game version. Modded
  // items (or items without a matching texture) use the neutral fallback.
  const minecraftVersion = current()?.minecraft || '1.21.4';
  const texture = namespace !== 'minecraft' || !/^[a-z0-9_./-]+$/i.test(itemId)
    ? null
    : /^26\./.test(minecraftVersion)
      ? `https://project-crafting.github.io/minecraft-auto-updated-textures-api/items/${itemId}.png`
      : `https://mcasset.cloud/${encodeURIComponent(minecraftVersion)}/assets/minecraft/textures/item/${itemId}.png`;
  const artwork = el('span', { class: 'item-fallback', 'aria-hidden': 'true' }, '◇');
  const image = texture ? el('img', {
    class: 'item-icon',
    src: texture,
    alt: label,
    title: label,
    loading: 'lazy',
    onload: () => artwork.remove(),
    onerror: (event) => event.currentTarget.remove(),
  }) : null;
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

async function showPlayer(uuid, { quiet = false } = {}) {
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

async function openPlayerMenu(event, player) {
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

async function loadWorld() {
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
  if (name === 'mods') loadMods();
  if (name === 'tools') loadPerformance();
  if (name === 'settings') loadServerIcon();
  if (name === 'world') loadWorld();
  else if (typeof WorldMap !== 'undefined') WorldMap.close();
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

function renderMods() {
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
    ['Java memory', m.memoryUsedMb == null ? '—' : `${formatMb(m.memoryUsedMb)} / ${formatMb(current()?.memoryMb || 0)}`],
    ['Host memory', `${formatMb(m.systemMemoryUsedMb)} / ${formatMb(m.systemMemoryMb)}`],
    ['Players', `${m.playerCount} / ${m.maxPlayers || '—'}`],
    ['Tick rate', m.tps == null ? 'Unavailable' : `${m.tps.toFixed(1)} TPS${m.msPerTick != null ? ` · ${m.msPerTick} ms per tick` : ''}`],
    ['Server files', `${formatBytes(m.diskBytes)}${m.diskScanLimited ? '+' : ''}`],
  ];
  $('metrics-grid').replaceChildren(...rows.map(([label, value], index) => {
    const card = el('div', { class: `metric${index === 5 && m.diskWarning ? ' warn' : ''}` }, el('span', { class: 'muted small' }, label), el('strong', {}, value));
    return card;
  }));
  $('metrics-updated').textContent = new Date().toLocaleTimeString();
  if (document.activeElement !== $('disk-warning-limit')) $('disk-warning-limit').value = m.diskWarningGb;
  $('metrics-note').textContent = m.diskWarning
    ? `Disk usage has passed the ${m.diskWarningGb} GB warning limit. Remove old backups or unused files.`
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

async function loadTools() {
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
  const node = el('div', { class: classifyLine(line) }, line.text);
  node.hidden = Boolean($('console-search') && $('console-search').value && !String(line.text).toLowerCase().includes($('console-search').value.toLowerCase()));
  c.append(node);
  while (c.childElementCount > MAX_CONSOLE_LINES) c.firstChild.remove();
  if (atBottom) c.scrollTop = c.scrollHeight;
}

async function loadSettings() {
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

async function init() {
  wire();
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
  if (state.servers.length) openServer(state.servers[0].id);
  else showView('empty');
}

init();
