const http = require('http');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Minecraft server status</title><style>body{margin:0;background:#14161a;color:#e7ebf2;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{box-sizing:border-box;width:min(640px,calc(100% - 40px));padding:28px;background:#20242b;border:1px solid #3a404b;border-radius:16px}h1{margin-top:0}.online{color:#68d391}.offline{color:#ff7b72}.address{padding:12px;background:#14161a;border-radius:8px;font:600 20px ui-monospace,monospace;word-break:break-all}li{margin:6px 0}.muted{color:#9ba5b4;font-size:13px}</style></head><body><main class="card"><h1 id="name">Minecraft server</h1><p id="status" class="muted">Checking server…</p><h2>Join address</h2><div id="address" class="address">—</div><p id="version"></p><h2>Players online</h2><p id="players">—</p><p id="updated" class="muted"></p></main><script>async function refresh(){try{const r=await fetch('/status.json',{cache:'no-store'});const s=await r.json();document.title=s.name+' — Minecraft status';document.querySelector('#name').textContent=s.name;const status=document.querySelector('#status');status.textContent=s.online?'Online':'Offline';status.className=s.online?'online':'offline';document.querySelector('#address').textContent=s.address||'Ask the host for an address';document.querySelector('#version').textContent='Minecraft '+(s.version||'unknown')+(s.software==='paper'?' · Paper':'')+(s.loader&&s.loader!=='vanilla'?' · '+s.loader+' '+(s.loaderVersion||''):'');document.querySelector('#players').textContent=s.players.length?s.players.join(', '):'No players online';document.querySelector('#updated').textContent='Updated '+new Date(s.updatedAt).toLocaleTimeString()}catch{document.querySelector('#status').textContent='Status unavailable'}}refresh();setInterval(refresh,10000);</script></body></html>`;

function createStatusServer({ port = 27892, lanAccess = false, getStatus }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(PAGE);
    }
    if (req.url === '/status.json') {
      try {
        const body = JSON.stringify(await getStatus());
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(body);
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end('{"error":"status unavailable"}');
      }
    }
    res.writeHead(404); res.end();
  });
  const host = lanAccess ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ server, host, port, close: () => new Promise((done) => { server.close(() => done()); if (server.closeAllConnections) server.closeAllConnections(); }) });
    });
  });
}

module.exports = { createStatusServer };
