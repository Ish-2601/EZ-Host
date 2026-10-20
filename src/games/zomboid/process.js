// Runs one Project Zomboid dedicated server and exposes its console. Same
// events and methods as the Minecraft ServerProcess, so the app treats both alike.
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_HISTORY = 2000;

// Startup stages from the Zomboid server log.
const STAGES = [
  { re: /versionNumber=|version=\d/i, at: 5, label: 'Starting Java' },
  { re: /Workshop|workshop item|DownloadItem/i, at: 15, label: 'Downloading Workshop mods' },
  { re: /Loading mod|loading .*\.lua|LuaManager/i, at: 35, label: 'Loading mods' },
  { re: /Loading world|IsoWorld|Loading map/i, at: 60, label: 'Loading the world' },
  { re: /SERVER STARTED|Zomboid Server is VAC Secure|znet: Online/i, at: 95, label: 'Opening to players' },
];

const FATAL = [/Exception in thread "main"/, /OutOfMemoryError/, /Could not create the Java Virtual Machine/, /address already in use|Port.*in use|failed to bind/i];

class ZomboidProcess extends EventEmitter {
  constructor({ installDir, cacheDir, serverName, memoryMb = 6144, adminPassword, lastStartMs = 0 }) {
    super();
    this.installDir = installDir;
    this.cacheDir = cacheDir;
    this.serverName = serverName;
    this.memoryMb = memoryMb;
    this.adminPassword = adminPassword;
    this.lastStartMs = lastStartMs;
    this.child = null;
    this.status = 'stopped';
    this.history = [];
    this.players = new Set();
    this.failure = null;
  }

  buildArgs() {
    return [
      '-Djava.awt.headless=true',
      '-Dzomboid.steam=1',
      '-Dzomboid.znetlog=1',
      '-XX:+UseZGC',
      '-XX:-CreateCoredumpOnCrash',
      '-XX:-OmitStackTraceInFastThrow',
      `-Xms${Math.min(2048, this.memoryMb)}m`,
      `-Xmx${this.memoryMb}m`,
      `-Ddeployment.user.cachedir=${this.cacheDir}`,
      '-Djava.library.path=natives/',
      '-cp',
      'java/;java/projectzomboid.jar',
      'zombie.network.GameServer',
      '-statistic',
      '0',
      `-cachedir=${this.cacheDir}`,
      '-servername',
      this.serverName,
      '-adminusername',
      'admin',
      '-adminpassword',
      this.adminPassword,
    ];
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  pushLine(text, stream) {
    this.history.push({ text, stream, time: Date.now() });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.emit('line', text, stream);
  }

  progressState() {
    const elapsed = Date.now() - this.startedAt;
    const byTime = this.lastStartMs ? Math.min(95, (elapsed / this.lastStartMs) * 100) : 0;
    return {
      percent: Math.round(Math.min(99, Math.max(this.stagePercent, Math.min(byTime, this.stagePercent + 25)))),
      stage: this.stageLabel,
      stalled: Date.now() - this.lastLineAt > 5 * 60 * 1000,
      failure: this.failure,
    };
  }

  emitProgress() {
    if (this.status === 'starting') this.emit('progress', this.progressState());
  }

  track(line) {
    this.lastLineAt = Date.now();
    if (this.status === 'starting') {
      for (const s of STAGES) {
        if (s.at > this.stagePercent && s.re.test(line)) {
          this.stagePercent = s.at;
          this.stageLabel = s.label;
        }
      }
      if (/SERVER STARTED/.test(line)) {
        clearInterval(this.progressTimer);
        this.startupMs = Date.now() - this.startedAt;
        this.setStatus('running');
      }
      if (!this.failure && FATAL.some((re) => re.test(line))) {
        this.failure = {
          kind: /in use|bind/i.test(line) ? 'port' : /OutOfMemory/.test(line) ? 'memory' : 'crash',
          summary: /in use|bind/i.test(line)
            ? "Another program is already using this server's port."
            : /OutOfMemory/.test(line)
              ? 'The server ran out of memory. Give it more in Settings.'
              : 'The server crashed while starting. The Console tab shows why.',
          mods: [],
        };
      }
    }
    // Join/leave lines differ between builds; /players over RCON is the source of truth.
    const joined = line.match(/ConnectionManager: \[fully-connected\].*username="([^"]+)"/) || line.match(/^\S*\s*(?:LOG\s*:\s*)?\S*\s*> (\S+) fully connected/);
    if (joined) {
      this.players.add(joined[1]);
      this.emit('players', [...this.players]);
    }
    const left = line.match(/ConnectionManager: \[disconnect\].*username="([^"]+)"/);
    if (left) {
      this.players.delete(left[1]);
      this.emit('players', [...this.players]);
    }
  }

  setPlayers(names) {
    const next = new Set(names);
    const same = next.size === this.players.size && [...next].every((n) => this.players.has(n));
    if (same) return;
    this.players = next;
    this.emit('players', [...this.players]);
  }

  start() {
    if (this.child) throw new Error('Server is already running');
    const java = path.join(this.installDir, 'jre64', 'bin', 'java.exe');
    const args = this.buildArgs();
    this.pushLine(`> java ${args.map((a) => (a === this.adminPassword ? '********' : a)).join(' ')}`, 'system');
    this.crashed = false;
    this.failure = null;
    this.startedAt = Date.now();
    this.lastLineAt = Date.now();
    this.stagePercent = 1;
    this.stageLabel = 'Starting Java';
    this.setStatus('starting');
    this.progressTimer = setInterval(() => this.emitProgress(), 2000);

    const child = spawn(java, args, { cwd: this.installDir, windowsHide: true });
    this.child = child;
    let finalized = false;
    const finish = (code) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(this.stopTimer);
      clearInterval(this.progressTimer);
      this.child = null;
      if (this.players.size) {
        this.players.clear();
        this.emit('players', []);
      }
      this.crashed = this.status !== 'stopping' && code !== 0;
      if (this.crashed && this.status === 'starting' && !this.failure) {
        this.failure = { kind: 'crash', summary: 'The server stopped while starting. The Console tab shows why.', mods: [] };
      }
      this.pushLine(`Server process exited with code ${code}`, 'system');
      this.setStatus('stopped');
      this.emit('exit', code);
    };
    const splitter = (stream) => {
      let buffer = '';
      return (data) => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          this.pushLine(line, stream);
          this.track(line);
        }
      };
    };
    child.stdout.on('data', splitter('stdout'));
    child.stderr.on('data', splitter('stderr'));
    child.on('error', (err) => {
      this.pushLine(`Could not start Java: ${err.message}`, 'system');
      if (child.pid == null) finish(null);
    });
    child.on('exit', finish);
  }

  send(command) {
    if (!this.child) throw new Error('Server is not running');
    this.pushLine(`> ${command}`, 'input');
    this.child.stdin.write(command + '\n');
  }

  /** "quit" saves the world and exits; kill it if it takes too long. */
  stop(timeoutMs = 90000) {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.once('exit', () => resolve());
      if (this.status === 'stopping') return;
      const wasStarting = this.status === 'starting';
      this.setStatus('stopping');
      try {
        this.child.stdin.write('quit\n');
      } catch {
        // stdin closed; the kill timer handles it
      }
      this.stopTimer = setTimeout(() => {
        if (this.child) {
          this.pushLine('Server did not stop in time, killing it', 'system');
          this.child.kill();
        }
      }, wasStarting ? 20000 : timeoutMs);
    });
  }

  kill() {
    if (this.child) this.child.kill();
  }
}

module.exports = { ZomboidProcess };
