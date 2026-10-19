// World map on the World tab: terrain tiles, live player heads, and selecting
// chunks to keep them force-loaded. Uses helpers from app.js ($, api, state,
// attempt, toast, current).
const WorldMap = (() => {
  const m = {
    serverId: null,
    dim: 'minecraft:overworld',
    cx: 0, // block coordinate at the center of the view
    cz: 0,
    scale: 1, // screen pixels per block
    regions: [],
    tiles: new Map(), // "rx,rz" -> { img, loading }
    forced: [],
    players: [],
    heads: new Map(),
    selection: null, // { x1, z1, x2, z2 } in chunks
    drag: null,
    timers: [],
  };
  const canvas = () => $('map-canvas');

  // ---------- coordinates ----------

  function size() {
    const c = canvas();
    return { w: c.clientWidth, h: c.clientHeight };
  }
  function toScreen(bx, bz) {
    const { w, h } = size();
    return [(bx - m.cx) * m.scale + w / 2, (bz - m.cz) * m.scale + h / 2];
  }
  function toBlock(sx, sz) {
    const { w, h } = size();
    return [(sx - w / 2) / m.scale + m.cx, (sz - h / 2) / m.scale + m.cz];
  }

  // ---------- drawing ----------

  let frame = null;
  function draw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint();
    });
  }

  function paint() {
    const c = canvas();
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0d10';
    g.fillRect(0, 0, w, h);

    for (const { rx, rz } of m.regions) {
      const [x, z] = toScreen(rx * 512, rz * 512);
      const sizePx = 512 * m.scale;
      if (x > w || z > h || x + sizePx < 0 || z + sizePx < 0) continue;
      const tile = loadTile(rx, rz);
      if (tile && tile.img && tile.img.complete) g.drawImage(tile.img, x, z, sizePx, sizePx);
      else {
        g.fillStyle = '#1a1d23';
        g.fillRect(x, z, sizePx, sizePx);
      }
    }

    // Chunk grid when zoomed in far enough to be useful.
    if (m.scale >= 1.5) {
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1;
      const [bx0, bz0] = toBlock(0, 0);
      const [bx1, bz1] = toBlock(w, h);
      g.beginPath();
      for (let x = Math.floor(bx0 / 16) * 16; x <= bx1; x += 16) {
        const [sx] = toScreen(x, 0);
        g.moveTo(Math.round(sx) + 0.5, 0);
        g.lineTo(Math.round(sx) + 0.5, h);
      }
      for (let z = Math.floor(bz0 / 16) * 16; z <= bz1; z += 16) {
        const [, sz] = toScreen(0, z);
        g.moveTo(0, Math.round(sz) + 0.5);
        g.lineTo(w, Math.round(sz) + 0.5);
      }
      g.stroke();
    }

    const chunkRect = (cx, cz, fill, stroke) => {
      const [x, z] = toScreen(cx * 16, cz * 16);
      const s = 16 * m.scale;
      g.fillStyle = fill;
      g.fillRect(x, z, s, s);
      if (stroke && s >= 4) {
        g.strokeStyle = stroke;
        g.strokeRect(x + 0.5, z + 0.5, s - 1, s - 1);
      }
    };
    for (const [cx, cz] of m.forced) chunkRect(cx, cz, 'rgba(255,150,30,0.45)', 'rgba(255,170,60,0.9)');

    if (m.selection) {
      const { x1, z1, x2, z2 } = norm(m.selection);
      const [x, z] = toScreen(x1 * 16, z1 * 16);
      const [x2s, z2s] = toScreen((x2 + 1) * 16, (z2 + 1) * 16);
      g.fillStyle = 'rgba(88,166,255,0.25)';
      g.fillRect(x, z, x2s - x, z2s - z);
      g.strokeStyle = '#58a6ff';
      g.lineWidth = 2;
      g.strokeRect(x, z, x2s - x, z2s - z);
    }

    g.font = '12px Segoe UI, sans-serif';
    g.textAlign = 'center';
    for (const p of m.players) {
      if (p.dim !== m.dim) continue;
      const [x, z] = toScreen(p.x, p.z);
      const head = headImage(p);
      g.fillStyle = '#000';
      g.fillRect(x - 12, z - 12, 24, 24);
      if (head && head.complete && head.naturalWidth) g.drawImage(head, x - 11, z - 11, 22, 22);
      g.fillStyle = 'rgba(0,0,0,0.65)';
      const tw = g.measureText(p.name).width + 10;
      g.fillRect(x - tw / 2, z + 14, tw, 17);
      g.fillStyle = '#fff';
      g.fillText(p.name, x, z + 27);
    }
  }

  function headImage(p) {
    const key = p.uuid || p.name;
    if (!m.heads.has(key)) {
      const img = new Image();
      img.onload = draw;
      img.src = `https://mc-heads.net/avatar/${p.uuid || p.name}/32`;
      m.heads.set(key, img);
    }
    return m.heads.get(key);
  }

  function loadTile(rx, rz) {
    const key = `${rx},${rz}`;
    let tile = m.tiles.get(key);
    if (tile) return tile;
    tile = { loading: true, img: null };
    m.tiles.set(key, tile);
    const id = m.serverId;
    const dim = m.dim;
    api.mapTile(id, dim, rx, rz).then(
      (res) => {
        if (id !== m.serverId || dim !== m.dim) return;
        const img = new Image();
        img.onload = draw;
        img.src = res.png;
        tile.img = img;
        tile.loading = false;
      },
      () => {
        tile.loading = false;
      }
    );
    return tile;
  }

  // ---------- selection ----------

  function norm(sel) {
    return {
      x1: Math.min(sel.x1, sel.x2), z1: Math.min(sel.z1, sel.z2),
      x2: Math.max(sel.x1, sel.x2), z2: Math.max(sel.z1, sel.z2),
    };
  }

  function updateSelectionUi() {
    const s = current();
    const running = s && s.status === 'running';
    if (!m.selection) {
      $('map-selection').textContent = running ? '' : 'Start the server to keep chunks loaded.';
      $('map-keep').disabled = $('map-unkeep').disabled = true;
      return;
    }
    const { x1, z1, x2, z2 } = norm(m.selection);
    const count = (x2 - x1 + 1) * (z2 - z1 + 1);
    $('map-selection').textContent = `${count} chunk${count === 1 ? '' : 's'} selected (blocks ${x1 * 16}, ${z1 * 16} to ${x2 * 16 + 15}, ${z2 * 16 + 15})${running ? '' : ' · start the server to change them'}`;
    $('map-keep').disabled = $('map-unkeep').disabled = !running;
  }

  async function applySelection(add) {
    if (!m.selection) return;
    const out = await attempt(() => api.mapForceload(m.serverId, m.dim, norm(m.selection), add));
    if (out !== undefined) {
      toast(add ? 'Those chunks now stay loaded.' : 'Those chunks are no longer kept loaded.');
      m.selection = null;
      updateSelectionUi();
      await refreshForced();
    }
  }

  // ---------- data ----------

  async function refreshForced() {
    const list = await api.mapForceloaded(m.serverId, m.dim).catch(() => null);
    m.forced = list || [];
    draw();
  }

  async function refreshPlayers() {
    m.players = (await api.mapPlayers(m.serverId).catch(() => [])) || [];
    draw();
  }

  async function loadRegions(recenter) {
    m.tiles.clear();
    m.regions = (await attempt(() => api.mapRegions(m.serverId, m.dim))) || [];
    $('map-empty').classList.toggle('hidden', m.regions.length > 0);
    if (recenter) center();
    draw();
  }

  function center() {
    const here = m.players.find((p) => p.dim === m.dim);
    if (here) {
      m.cx = here.x;
      m.cz = here.z;
    } else if (m.regions.length) {
      // Middle of everything explored.
      const xs = m.regions.map((r) => r.rx);
      const zs = m.regions.map((r) => r.rz);
      m.cx = ((Math.min(...xs) + Math.max(...xs) + 1) / 2) * 512;
      m.cz = ((Math.min(...zs) + Math.max(...zs) + 1) / 2) * 512;
    } else {
      m.cx = m.cz = 0;
    }
    draw();
  }

  function zoom(factor, sx, sz) {
    const { w, h } = size();
    const ax = sx ?? w / 2;
    const az = sz ?? h / 2;
    const [bx, bz] = toBlock(ax, az);
    m.scale = Math.max(0.125, Math.min(8, m.scale * factor));
    // Keep the block under the cursor in place.
    m.cx = bx - (ax - w / 2) / m.scale;
    m.cz = bz - (az - h / 2) / m.scale;
    draw();
  }

  // ---------- lifecycle ----------

  async function open(serverId) {
    const changed = serverId !== m.serverId;
    m.serverId = serverId;
    if (changed) {
      m.selection = null;
      m.forced = [];
      m.players = [];
      m.scale = 1;
    }
    const dims = (await attempt(() => api.mapDimensions(serverId))) || [];
    if (!dims.length) dims.push({ id: 'minecraft:overworld', label: 'Overworld' });
    if (!dims.some((d) => d.id === m.dim)) m.dim = dims[0].id;
    fill($('map-dim'), dims.map((d) => el('option', { value: d.id }, d.label)));
    $('map-dim').value = m.dim;
    await refreshPlayers();
    await loadRegions(changed);
    refreshForced();
    updateSelectionUi();
    stopTimers();
    m.timers.push(setInterval(() => !document.hidden && refreshPlayers(), 3000));
    m.timers.push(setInterval(() => !document.hidden && refreshForced(), 10000));
  }

  function stopTimers() {
    m.timers.forEach(clearInterval);
    m.timers = [];
  }

  function wire() {
    const c = canvas();
    c.addEventListener('mousedown', (e) => {
      const selecting = $('map-select-mode').checked || e.shiftKey;
      const [bx, bz] = toBlock(e.offsetX, e.offsetY);
      if (selecting) {
        const cx = Math.floor(bx / 16);
        const cz = Math.floor(bz / 16);
        m.selection = { x1: cx, z1: cz, x2: cx, z2: cz };
        m.drag = { mode: 'select' };
      } else {
        m.drag = { mode: 'pan', sx: e.clientX, sz: e.clientY, cx: m.cx, cz: m.cz };
        c.style.cursor = 'grabbing';
      }
      draw();
    });
    window.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oz = e.clientY - rect.top;
      if (ox >= 0 && oz >= 0 && ox <= rect.width && oz <= rect.height) {
        const [bx, bz] = toBlock(ox, oz);
        $('map-hover').textContent = `Block ${Math.floor(bx)}, ${Math.floor(bz)} · Chunk ${Math.floor(bx / 16)}, ${Math.floor(bz / 16)}`;
      }
      if (!m.drag) return;
      if (m.drag.mode === 'pan') {
        m.cx = m.drag.cx - (e.clientX - m.drag.sx) / m.scale;
        m.cz = m.drag.cz - (e.clientY - m.drag.sz) / m.scale;
      } else {
        const [bx, bz] = toBlock(ox, oz);
        m.selection.x2 = Math.floor(bx / 16);
        m.selection.z2 = Math.floor(bz / 16);
        updateSelectionUi();
      }
      draw();
    });
    window.addEventListener('mouseup', () => {
      if (m.drag && m.drag.mode === 'select') updateSelectionUi();
      m.drag = null;
      c.style.cursor = '';
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX, e.offsetY);
    }, { passive: false });
    new ResizeObserver(draw).observe(c);

    $('map-zoom-in').onclick = () => zoom(1.5);
    $('map-zoom-out').onclick = () => zoom(1 / 1.5);
    $('map-center').onclick = center;
    $('map-refresh').onclick = () => loadRegions(false);
    $('map-dim').onchange = () => {
      m.dim = $('map-dim').value;
      m.selection = null;
      updateSelectionUi();
      loadRegions(true);
      refreshForced();
    };
    $('map-select-mode').onchange = () => c.classList.toggle('selecting', $('map-select-mode').checked);
    $('map-keep').onclick = () => applySelection(true);
    $('map-unkeep').onclick = () => applySelection(false);
  }

  wire();
  return { open, close: stopTimers, refreshUi: updateSelectionUi };
})();
