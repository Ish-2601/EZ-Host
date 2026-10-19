// UI logic. Talks to the main process only through window.api (see preload.js).
// `api` is the global exposed by preload.js.
const $ = (id) => document.getElementById(id);

const state = {
  servers: [],
  selectedId: null,
  pack: null, // { project, versions } while picking a version
  totalMemoryMb: 8192,
  installProgress: {}, // serverId -> { label, done, total }
};

const MAX_CONSOLE_LINES = 2000;

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(url, cls) {
  if (url) return el('img', { src: url, class: cls, alt: '' });
  return el('div', { class: `icon-fallback ${cls || ''}` }, '⛏');
}

function formatMb(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`;
}

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla' };

let toastTimer = null;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 7000 : 3500);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    // IPC errors arrive as "Error invoking remote method 'x': Error: message".
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

function showView(name) {
  for (const v of ['empty', 'new', 'pack', 'server']) $(`view-${v}`).classList.toggle('hidden', v !== name);
}

function setupRamSlider(input, label, value) {
  const max = Math.max(4096, Math.floor((state.totalMemoryMb * 0.75) / 512) * 512);
  input.max = String(max);
  input.value = String(Math.min(value, max));
  label.textContent = formatMb(Number(input.value));
  input.oninput = () => (label.textContent = formatMb(Number(input.value)));
}

// ---------- sidebar ----------

function renderServerList() {
  const list = $('server-list');
  list.replaceChildren(
    ...state.servers.map((s) =>
      el(
        'li',
        { class: `server-item${s.id === state.selectedId ? ' active' : ''}`, onclick: () => openServer(s.id) },
        icon(s.source && s.source.iconUrl),
        el('div', { class: 'grow' },
          el('div', { class: 'name' }, s.name),
          el('div', { class: 'sub' }, s.minecraft ? `${LOADER_NAMES[s.loader] || s.loader} ${s.minecraft}` : 'Setting up…')
        ),
        el('span', { class: `dot ${s.status}`, title: s.status })
      )
    )
  );
}

async function refreshServers() {
  state.servers = (await attempt(() => api.listServers())) || [];
  renderServerList();
  if (state.selectedId) {
    const current = state.servers.find((s) => s.id === state.selectedId);
    if (current) renderServer(current);
    else {
      state.selectedId = null;
      showView(state.servers.length ? 'new' : 'empty');
    }
  }
}

// ---------- new server: search ----------

let searchSeq = 0;
async function search(query) {
  const seq = ++searchSeq;
  $('search-status').textContent = 'Searching…';
  const result = await attempt(() => api.searchModpacks(query, { limit: 30 }));
  if (seq !== searchSeq || !result) return;
  $('search-status').textContent = result.hits.length
    ? query ? `${result.total} modpacks found` : 'Popular server-ready modpacks'
    : 'No modpacks found.';
  $('search-results').replaceChildren(
    ...result.hits.map((hit) =>
      el(
        'button',
        { class: 'pack-card', type: 'button', onclick: () => openPack(hit) },
        icon(hit.iconUrl),
        el('div', {},
          el('div', { class: 'title' }, hit.title),
          el('div', { class: 'desc' }, hit.description),
          el('div', { class: 'tags' },
            hit.loaders.map((l) => el('span', { class: 'tag' }, LOADER_NAMES[l] || l)),
            hit.gameVersions.length ? el('span', { class: 'tag' }, hit.gameVersions[hit.gameVersions.length - 1]) : null,
            el('span', { class: 'tag' }, `⬇ ${formatCount(hit.downloads)}`)
          )
        )
      )
    )
  );
}

function openNewServer() {
  state.selectedId = null;
  renderServerList();
  showView('new');
  $('search-input').focus();
  if (!$('search-results').children.length) search('');
}

// ---------- new server: choose version ----------

async function openPack(hit) {
  showView('pack');
  $('pack-icon').src = hit.iconUrl || '';
  $('pack-title').textContent = hit.title;
  $('pack-desc').textContent = hit.description;
  $('server-name').value = hit.title;
  setupRamSlider($('server-ram'), $('ram-label'), 6144);
  const select = $('pack-version');
  select.replaceChildren(el('option', {}, 'Loading versions…'));
  select.disabled = true;

  const versions = await attempt(() => api.getModpackVersions(hit.id));
  if (!versions) return;
  state.pack = { project: hit, versions };
  if (!versions.length) {
    select.replaceChildren(el('option', {}, 'No downloadable versions'));
    return;
  }
  select.replaceChildren(
    ...versions.map((v) =>
      el('option', { value: v.id }, `${v.versionNumber} · MC ${v.gameVersions.join(', ')} · ${v.loaders.map((l) => LOADER_NAMES[l] || l).join(', ')}`)
    )
  );
  select.disabled = false;
  select.onchange = updateVersionMeta;
  updateVersionMeta();
}

function updateVersionMeta() {
  const v = state.pack.versions.find((x) => x.id === $('pack-version').value);
  if (!v) return;
  $('version-meta').textContent = `${v.name} · released ${new Date(v.datePublished).toLocaleDateString()} · ${formatMb(Math.round(v.file.size / 1048576))} download`;
}

async function createServer(event) {
  event.preventDefault();
  if (!state.pack) return;
  const created = await attempt(() =>
    api.createFromModrinth({
      name: $('server-name').value.trim(),
      projectId: state.pack.project.id,
      versionId: $('pack-version').value,
      memoryMb: Number($('server-ram').value),
    })
  );
  if (created) {
    await refreshServers();
    openServer(created.id);
  }
}

async function importFile() {
  const created = await attempt(() => api.createFromFile({ memoryMb: 6144 }));
  if (created) {
    await refreshServers();
    openServer(created.id);
  }
}

// ---------- server view ----------

async function openServer(id) {
  state.selectedId = id;
  renderServerList();
  showView('server');
  switchTab('console');
  const server = state.servers.find((s) => s.id === id) || (await attempt(() => api.getServer(id)));
  if (!server) return;
  renderServer(server);
  const history = (await attempt(() => api.getConsole(id))) || [];
  const consoleEl = $('console');
  consoleEl.replaceChildren();
  history.forEach((line) => appendConsole(line));
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function renderServer(s) {
  $('srv-name').textContent = s.name;
  const srvIcon = $('srv-icon');
  if (s.source && s.source.iconUrl) srvIcon.src = s.source.iconUrl;
  else srvIcon.removeAttribute('src');

  const parts = [];
  if (s.packName) parts.push(`${s.packName} ${s.packVersion || ''}`.trim());
  else if (s.source && s.source.title) parts.push(s.source.title);
  if (s.minecraft) parts.push(`Minecraft ${s.minecraft}`);
  if (s.loader) parts.push(`${LOADER_NAMES[s.loader] || s.loader} ${s.loaderVersion || ''}`.trim());
  parts.push(`${formatMb(s.memoryMb)} RAM`);
  $('srv-meta').textContent = parts.join(' · ');

  const status = s.status;
  const pill = $('srv-status');
  pill.textContent = status;
  pill.className = `status-pill ${status}`;

  const busy = status === 'installing';
  const live = status === 'running' || status === 'starting';
  $('srv-start').disabled = busy || !s.installed || !s.eulaAccepted || status !== 'stopped';
  $('srv-stop').disabled = !live;
  $('command-input').disabled = !live;

  $('srv-install').classList.toggle('hidden', !busy);
  if (busy) renderProgress(s.id);

  const err = $('srv-error');
  err.classList.toggle('hidden', !s.installError || busy);
  err.textContent = s.installError ? `Install failed: ${s.installError}` : '';

  $('srv-eula').classList.toggle('hidden', !s.installed || s.eulaAccepted || busy);
}

function renderProgress(id) {
  const p = state.installProgress[id];
  const bar = $('srv-progress-bar');
  if (p && p.total) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
    const amount = p.label === 'Mods' ? `${p.done}/${p.total} files` : `${formatMb(Math.round(p.done / 1048576))} of ${formatMb(Math.round(p.total / 1048576))}`;
    $('srv-progress-label').textContent = `Installing · ${p.label}: ${amount}`;
  } else {
    bar.classList.add('indeterminate');
    bar.style.width = '';
    $('srv-progress-label').textContent = 'Installing…';
  }
}

function classifyLine(line) {
  if (line.stream === 'system' || line.stream === 'input') return line.stream;
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(line.text)) return 'error';
  if (/\bWARN(ING)?\b/.test(line.text)) return 'warn';
  return line.stream === 'stderr' ? 'stderr' : '';
}

function appendConsole(line) {
  const consoleEl = $('console');
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
  consoleEl.append(el('div', { class: classifyLine(line) }, line.text));
  while (consoleEl.childElementCount > MAX_CONSOLE_LINES) consoleEl.firstChild.remove();
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-console').classList.toggle('hidden', name !== 'console');
  $('tab-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'settings') loadSettings();
}

async function loadSettings() {
  const s = state.servers.find((x) => x.id === state.selectedId);
  if (!s) return;
  $('set-name').value = s.name;
  setupRamSlider($('set-ram'), $('set-ram-label'), s.memoryMb);
  const props = (await attempt(() => api.getProperties(s.id))) || {};
  const hasProps = Object.keys(props).length > 0;
  $('set-motd').value = props.motd || '';
  $('set-maxplayers').value = props['max-players'] || '';
  $('set-port').value = props['server-port'] || '';
  $('set-difficulty').value = props.difficulty || 'easy';
  for (const id of ['set-motd', 'set-maxplayers', 'set-port', 'set-difficulty']) $(id).disabled = !hasProps;
  $('settings-hint').classList.toggle('hidden', hasProps);
  $('settings-saved').textContent = '';
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
    refreshServers();
  }
}

// ---------- wiring ----------

function wire() {
  $('new-server-btn').onclick = openNewServer;
  document.querySelector('[data-action="new-server"]').onclick = openNewServer;
  $('import-file-btn').onclick = importFile;
  $('search-form').onsubmit = (e) => {
    e.preventDefault();
    search($('search-input').value.trim());
  };
  $('back-to-search').onclick = () => showView('new');
  $('create-form').onsubmit = createServer;

  $('srv-start').onclick = () => attempt(() => api.start(state.selectedId));
  $('srv-stop').onclick = () => attempt(() => api.stop(state.selectedId));
  $('eula-check').onchange = (e) => ($('eula-accept').disabled = !e.target.checked);
  $('eula-accept').onclick = async () => {
    await attempt(() => api.acceptEula(state.selectedId));
    $('eula-check').checked = false;
    $('eula-accept').disabled = true;
    refreshServers();
  };
  $('command-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('command-input');
    const command = input.value.trim().replace(/^\//, '');
    if (!command) return;
    input.value = '';
    await attempt(() => api.command(state.selectedId, command));
  };
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $('settings-form').onsubmit = saveSettings;
  $('open-folder').onclick = () => attempt(() => api.openFolder(state.selectedId));
  $('delete-server').onclick = async () => {
    const s = state.servers.find((x) => x.id === state.selectedId);
    if (!s || !confirm(`Delete "${s.name}"? Its world and all files will be removed from this PC.`)) return;
    const ok = await attempt(async () => {
      await api.deleteServer(s.id);
      return true;
    });
    if (ok) {
      state.selectedId = null;
      await refreshServers();
      showView(state.servers.length ? 'new' : 'empty');
      if (state.servers.length) openNewServer();
    }
  };

  api.onConsole((id, line) => {
    if (id === state.selectedId) appendConsole(line);
  });
  api.onInstall((id, event) => {
    if (event.progress) {
      state.installProgress[id] = event.progress;
      if (id === state.selectedId) renderProgress(id);
    }
    if (event.message && id === state.selectedId) appendConsole({ text: event.message, stream: 'system' });
  });
  api.onStatus((id, status) => {
    const s = state.servers.find((x) => x.id === id);
    if (s) s.status = status;
    renderServerList();
    if (s && id === state.selectedId) renderServer(s);
  });
  api.onServersChanged(() => refreshServers());
}

async function init() {
  wire();
  state.totalMemoryMb = (await attempt(() => api.totalMemoryMb())) || 8192;
  await refreshServers();
  if (state.servers.length) openServer(state.servers[0].id);
  else showView('empty');
}

init();
