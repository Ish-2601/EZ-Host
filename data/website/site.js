// Points the Download button straight at the newest installer on GitHub.
// If GitHub can't be reached, the button still goes to the Releases page.
(() => {
  const button = document.getElementById('download');
  const note = document.getElementById('download-note');
  if (!button || !window.fetch) return;
  fetch('https://api.github.com/repos/Ish-2601/EZ-Host/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((release) => {
      const installer = (release.assets || []).find((a) => /^EZ-Host-Setup-.*\.exe$/i.test(a.name));
      if (!installer) return;
      button.href = installer.browser_download_url;
      const mb = Math.round(installer.size / 1048576);
      note.textContent = `${(release.tag_name || '').replace(/^v/, 'Version ')} · ${mb} MB · Free installer`;
    })
    .catch(() => { /* keep the Releases page link */ });
})();
