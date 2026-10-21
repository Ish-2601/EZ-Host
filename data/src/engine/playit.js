// playit.gg tunnel: gives a server a public address so friends on other
// internet connections can join, with no port forwarding.
//
// Flow (mirrors the official agent, github.com/playit-cloud/playit-agent):
//   1. link():   make a claim code, the user approves it at playit.gg/claim/<code>,
//                then exchange it for this PC's agent secret.
//   2. startAgent(): run the official playit agent with that secret.
//   3. ensureTunnel(): create (once per server) a Minecraft Java tunnel to
//                localhost:<port> and return its public address.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { download, USER_AGENT } = require('./http');

const API = 'https://api.playit.gg';
// Pinned release of the official agent. Its Windows build is signed by playit's publisher.
const AGENT_VERSION = 'v1.0.10';
const AGENT_URL = `https://github.com/playit-cloud/playit-agent/releases/download/${AGENT_VERSION}/playit-windows-x86_64-signed.exe`;
const AGENT_PUBLISHER = 'Developed Methods LLC';
const TUNNEL_NAME = 'EZ Host';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlayitError extends Error {}

async function api(pathname, body, secret) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (secret) headers.Authorization = `Agent-Key ${secret}`;
  const res = await fetch(`${API}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  if (res.status === 429) throw new PlayitError('playit.gg is rate limiting requests, try again in a minute');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlayitError(`Unexpected reply from playit.gg (${res.status})`);
  }
  if (json.status === 'success') return json.data;
  const detail = typeof json.data === 'string' ? json.data : JSON.stringify(json.data);
  const err = new PlayitError(`playit.gg ${json.status}: ${detail}`);
  err.status = json.status;
  err.data = json.data;
  throw err;
}

/** Confirm a downloaded agent is signed by playit's publisher (Windows only). */
function verifySignature(exe) {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, out) => {
      if (err) return reject(err);
      const [status, subject = ''] = out.trim().split('|');
      if (status === 'Valid' && subject.includes(`CN=${AGENT_PUBLISHER}`)) resolve();
      else reject(new PlayitError(`The playit agent download failed its signature check (${status})`));
    })
  );
}

/**
 * Events: 'status' ({ state, message, address?, claimUrl? }), 'log' (line)
 * States: 'unlinked' | 'linking' | 'running' | 'error' | 'stopped' (the agent;
 * per-server tunnel state lives in ServerManager)
 */
class Playit extends EventEmitter {
  constructor(dataRoot) {
    super();
    this.dir = path.join(dataRoot, 'playit');
    this.secretFile = path.join(this.dir, 'secret.txt');
    this.agentExe = path.join(this.dir, AGENT_VERSION, 'playit.exe');
    this.child = null;
    this.linking = null;
    this.state = { state: this.isLinked() ? 'stopped' : 'unlinked', message: '' };
  }

  setState(state) {
    this.state = state;
    this.emit('status', state);
  }

  isLinked() {
    return fs.existsSync(this.secretFile);
  }

  readSecret() {
    return this.isLinked() ? fs.readFileSync(this.secretFile, 'utf8').trim() : null;
  }

  /**
   * Link this PC to a playit.gg account. Calls `openUrl(url)` so the user can
   * approve it in their browser, then waits (up to 15 minutes) for approval.
   */
  link(openUrl) {
    if (this.linking) return this.linking;
    const code = crypto.randomBytes(5).toString('hex');
    const claimUrl = `https://playit.gg/claim/${code}`;
    this.linking = (async () => {
      this.setState({ state: 'linking', message: 'Approve EZ Host in your browser to finish linking playit.gg.', claimUrl });
      openUrl(claimUrl);
      const deadline = Date.now() + 15 * 60 * 1000;
      for (;;) {
        if (Date.now() > deadline) throw new PlayitError('Linking timed out. Press "Connect playit.gg" to try again.');
        let setup;
        try {
          setup = await api('/claim/setup', { code, agent_type: 'self-managed', version: 'EZ Host 0.2.1' });
        } catch (err) {
          if (err.status === 'fail') throw new PlayitError(`Linking failed: ${err.data}`);
          await sleep(3000);
          continue;
        }
        if (setup === 'UserAccepted') break;
        if (setup === 'UserRejected') throw new PlayitError('Linking was declined on playit.gg.');
        await sleep(2000);
      }
      let secret;
      for (;;) {
        try {
          secret = (await api('/claim/exchange', { code })).secret_key;
          break;
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await sleep(2000);
        }
      }
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.secretFile, secret + '\n', { mode: 0o600 });
      this.setState({ state: 'stopped', message: 'playit.gg is linked.' });
    })()
      .catch((err) => {
        this.setState({ state: 'unlinked', message: err.message });
        throw err;
      })
      .finally(() => {
        this.linking = null;
      });
    return this.linking;
  }

  async unlink() {
    await this.stop();
    await fsp.rm(this.secretFile, { force: true });
    this.setState({ state: 'unlinked', message: '' });
  }

  async ensureAgent(log = () => {}) {
    if (process.platform !== 'win32') throw new PlayitError('The built-in playit.gg tunnel only supports Windows for now');
    if (fs.existsSync(this.agentExe)) return this.agentExe;
    log(`Downloading the playit.gg agent ${AGENT_VERSION}...`);
    const tmp = `${this.agentExe}.download`;
    await download(AGENT_URL, tmp);
    try {
      await verifySignature(tmp);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fsp.rename(tmp, this.agentExe);
    return this.agentExe;
  }

  async runData() {
    return api('/v1/agents/rundata', {}, this.readSecret());
  }

  /**
   * Find or create the Minecraft Java tunnel for one server and point it at
   * localhost:<port>. `tunnelId` is the tunnel saved for that server, if any.
   * `claimed` lists tunnel ids other servers already use, so they are not taken over.
   * Returns { tunnelId, address, notices }.
   */
  async ensureTunnel({ tunnelId, port, name, claimed = [], kind = 'minecraft-java' }) {
    // kind: 'minecraft-java' (one TCP port) or 'udp-2' (two UDP ports, e.g. Project Zomboid).
    const udp = kind === 'udp-2';
    const secret = this.readSecret();
    const data = await this.runData();
    const portOf = (t) => {
      const f = t.agent_config && t.agent_config.fields.find((x) => x.name === 'local_port');
      return f ? Number(f.value) : null;
    };
    const isMc = (t) => (udp ? t.port_type === 'udp' && !t.tunnel_type : t.tunnel_type === 'minecraft-java');
    let tunnel = tunnelId && data.tunnels.find((t) => t.id === tunnelId);
    if (!tunnel) {
      // Adopt an unclaimed tunnel already pointing at this port (made before
      // tunnels were saved per server, or by hand on playit.gg).
      tunnel = data.tunnels.find((t) => isMc(t) && !claimed.includes(t.id) && portOf(t) === port);
    }
    if (tunnel && portOf(tunnel) !== port) {
      await api(
        '/tunnels/update',
        { tunnel_id: tunnel.id, local_ip: '127.0.0.1', local_port: port, agent_id: data.agent_id, enabled: true },
        secret
      );
    }
    if (!tunnel) {
      // playit's /v1/tunnels/create rejects agent-key requests ("failed to parse body"),
      // so use the older endpoint, which accepts them.
      const created = await api(
        '/tunnels/create',
        {
          name: `${TUNNEL_NAME}: ${name}`.slice(0, 60).replace(/[^ -~]/g, ''),
          tunnel_type: udp ? null : 'minecraft-java',
          // Custom (non-Minecraft) tunnels must say what they are for.
          ...(udp ? { tunnel_description: `${name} (game server)`.slice(0, 60).replace(/[^ -~]/g, '') } : {}),
          port_type: udp ? 'udp' : 'tcp',
          port_count: udp ? 2 : 1,
          origin: { type: 'agent', data: { agent_id: data.agent_id, local_ip: '127.0.0.1', local_port: port } },
          enabled: true,
          alloc: null,
          firewall_id: null,
          proxy_protocol: null,
        },
        secret
      ).catch((err) => {
        if (err.data === 'RequiresVerifiedAccount') {
          const e = new PlayitError('playit.gg needs you to verify your email address before it can give this game an online address. Check your inbox for the playit.gg email, click the link, then press Try again.');
          e.resolveLink = 'https://playit.gg/account';
          throw e;
        }
        throw err;
      });
      tunnel = { id: created.id };
    }
    const id = tunnel.id;
    // A new tunnel can take a little while to get its address.
    for (let i = 0; i < 30; i++) {
      const now = await this.runData();
      const t = now.tunnels.find((x) => x.id === id);
      if (t && t.display_address) return { tunnelId: id, address: t.display_address, notices: now.notices || [] };
      const pending = now.pending.find((x) => x.id === id);
      if (pending && pending.status_msg) this.emit('log', `playit.gg: ${pending.status_msg}`);
      await sleep(2000);
    }
    throw new PlayitError('playit.gg did not give the tunnel an address in time. Try again in a minute.');
  }

  /** Delete a tunnel, e.g. to get a new random address. */
  async deleteTunnel(tunnelId) {
    try {
      await api('/tunnels/delete', { tunnel_id: tunnelId }, this.readSecret());
    } catch (err) {
      if (!(err.status === 'fail' && err.data === 'TunnelNotFound')) throw err;
    }
  }

  /** Start the playit agent if it is not running. It serves every tunnel of this PC. */
  async startAgent(log = (line) => this.emit('log', line)) {
    if (!this.isLinked()) throw new PlayitError('Connect playit.gg first');
    const exe = await this.ensureAgent(log);
    if (this.child) return;
    await fsp.mkdir(this.dir, { recursive: true });
    const child = spawn(exe, ['--secret-path', this.secretFile, '--socket-path', '\\\\.\\pipe\\self-host-mc-playit'], {
      windowsHide: true,
      cwd: this.dir,
    });
    this.child = child;
    const forward = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.emit('log', l));
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.setState({ state: 'error', message: `The playit.gg agent stopped (code ${code}).` });
    });
    this.setState({ state: 'running', message: '' });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    }
    if (this.isLinked()) this.setState({ state: 'stopped', message: '' });
  }
}

module.exports = { Playit, PlayitError };
