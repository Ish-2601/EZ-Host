// Applies the saved look before the page draws, so it never flashes the wrong theme.
// The real settings live with the app's data; this is a fast local copy.
(() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('appearance') || '{}');
  } catch {
    // first run or storage unavailable
  }
  const root = document.documentElement;
  root.dataset.theme = saved.theme || 'hud';
  root.dataset.accent = saved.accent || 'orange';
  root.dataset.panels = saved.panels || 'brackets';
  root.dataset.bg = saved.background || 'globe';
  root.dataset.density = saved.density || 'comfortable';
  root.dataset.strip = saved.strip === false ? 'off' : 'on';
  root.dataset.motion = saved.motion === false ? 'off' : 'on';
})();
