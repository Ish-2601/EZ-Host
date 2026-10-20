// Runs one Minecraft server as a child process and exposes its console.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_HISTORY = 2000;
const STALL_MS = 3 * 60 * 1000;

// Startup stages, matched against log lines from vanilla, Fabric, Quilt,
// Forge and NeoForge. `at` is how far along startup is when the line appears.
const STAGES = [
  { re: /ModLauncher running|with Fabric Loader|with Quilt Loader|Starting minecraft server version|Environment: /i, at: 4, label: 'Starting Java' },
  { re: /Found mod file|Loading \d+ mods|Discovered \d+ mods|Scanning mods/i, at: 10, label: 'Finding mods' },
  { re: /mixin/i, at: 18, label: 'Loading mods' },
  { re: /CONSTRUCT|Constructing/i, at: 30, label: 'Loading mods' },
  { re: /COMMON_SETUP|common setup|Registries|registr/i, at: 45, label: 'Setting up mods' },
  { re: /Loaded \d+ recipes|Loaded \d+ advancements|Reloading ResourceManager|Loading properties/i, at: 60, label: 'Loading game data' },
  { re: /Starting Minecraft server on/i, at: 66, label: 'Opening the server port' },
  { re: /Preparing level/i, at: 72, label: 'Loading the world' },
  { re: /Preparing (start|spawn) region|Preparing spawn area/i, at: 76, label: 'Preparing the spawn area' },
];

// Lines that mean startup has failed for good. Forge sometimes keeps the
// process alive after these, so the app stops waiting and ends it.
const FATAL = [
  /Failed to start the minecraft server/i,
  /Crash report saved to/i,
  /This crash report has been saved to/i,
  /Incompatible mods found!/i,
  /FAILED TO BIND TO PORT/i,
  /java\.lang\.OutOfMemoryError/,
  /Loading errors encountered/i,
];

// Garbage-collector settings widely used for Minecraft servers ("Aikar's
// flags"): fewer lag spikes from memory clean-up. Heap pre-touching is left
// out so startup stays quick.
const G1_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
];

/**
 * Events:
 *   'line'   (text, stream)  one console line ('stdout' | 'stderr' | 'input' | 'system')
 *   'status' (status)        'stopped' | 'starting' | 'running' | 'stopping'
 *   'exit'   (code)
 *   'progress' ({ percent, stage, stalled, failure })  while starting
 */
class ServerProcess extends EventEmitter {
  constructor({ javaPath, serverDir, launch, memoryMb = 4096, extraJvmArgs = [], javaMajor = 17, lastStartMs = 0, modCount = 0 }) {
    super();
    this.javaMajor = javaMajor;
    this.lastStartMs = lastStartMs;
    this.modCount = modCount;
    this.failure = null;
    this.javaPath = javaPath;
    this.serverDir = serverDir;
    this.launch = launch;
    this.memoryMb = memoryMb;
    this.extraJvmArgs = extraJvmArgs;
    this.child = null;
    this.status = 'stopped';
    this.history = [];
    this.stopTimer = null;
    this.players = new Set();
  }

  buildArgs() {
    const args = [`-Xms${Math.min(2048, this.memoryMb)}M`, `-Xmx${this.memoryMb}M`];
    if (this.memoryMb >= 2048) args.push(...G1_FLAGS);
    if (this.javaMajor >= 19) {
      // Class-data sharing: Java saves the classes it loaded on the first
      // start and maps them back in on later starts, which is quicker.
      args.push('-XX:+AutoCreateSharedArchive', '-XX:SharedArchiveFile=.selfhost/java-classes.jsa');
    }
    args.push(...this.extraJvmArgs);
    if (this.launch.type === 'argfile') {
      args.push(`@${this.launch.argFile}`);
    } else {
      args.push('-jar', this.launch.jar);
    }
    args.push('nogui');
    return args;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  pushLine(text, stream) {
    const entry = { text, stream, time: Date.now() };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.emit('line', text, stream);
  }

  start() {
    if (this.child) throw new Error('Server is already running');
    const args = this.buildArgs();
    this.pushLine(`> java ${args.join(' ')}`, 'system');
    this.crashed = false;
    this.failure = null;
    this.fatalAt = null;
    this.startedAt = Date.now();
    this.lastLineAt = Date.now();
    this.stagePercent = 1;
    this.stageLabel = 'Starting Java';
    this.modsFound = 0;
    this.stallWarned = false;
    this.setStatus('starting');
    this.progressTimer = setInterval(() => this.emitProgress(), 2000);

    const child = spawn(this.javaPath, args, { cwd: this.serverDir, windowsHide: true });
    this.child = child;
    let finalized = false;
    const finish = (code) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(this.stopTimer);
      clearTimeout(this.fatalTimer);
      clearInterval(this.progressTimer);
      this.child = null;
      if (this.players.size) {
        this.players.clear();
        this.emit('players', []);
      }
      // A stop the user asked for exits with 0; anything else is a crash.
      this.crashed = Boolean(this.fatalAt) || (this.status !== 'stopping' && code !== 0);
      if (this.crashed && this.status === 'starting' && !this.failure) {
        this.setFailure('crash', 'The server stopped while starting. The Console tab shows why.');
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
          this.trackStartup(line);
          // Vanilla, Fabric, Forge and NeoForge all print this once the world is loaded.
          if (this.status === 'starting' && /Done \([\d.,]+s\)!/.test(line)) {
            clearInterval(this.progressTimer);
            this.startupMs = Date.now() - this.startedAt;
            this.setStatus('running');
          }
          this.trackPlayers(line);
        }
      };
    };
    child.stdout.on('data', splitter('stdout'));
    child.stderr.on('data', splitter('stderr'));

    child.on('error', (err) => {
      this.pushLine(`Could not start Java: ${err.message}`, 'system');
      // A failed spawn does not always produce an `exit` event. Clear the
      // starting state so the UI and the next start attempt do not hang.
      if (child.pid == null) finish(null);
    });
    child.on('exit', finish);
  }

  // ---------- startup progress and failures ----------

  progressState() {
    const elapsed = Date.now() - this.startedAt;
    // Blend the stage from the log with how long the last start took, so the
    // bar keeps moving through long quiet stretches.
    const byTime = this.lastStartMs ? Math.min(95, (elapsed / this.lastStartMs) * 100) : 0;
    const byMods = this.modCount && this.modsFound ? Math.min(28, 10 + (this.modsFound / this.modCount) * 18) : 0;
    const percent = Math.max(this.stagePercent, byMods, Math.min(byTime, this.stagePercent + 25));
    return {
      percent: Math.round(Math.min(99, percent)),
      stage: this.stageLabel,
      stalled: Date.now() - this.lastLineAt > STALL_MS,
      failure: this.failure,
    };
  }

  emitProgress() {
    if (this.status !== 'starting') return;
    const state = this.progressState();
    if (state.stalled && !this.stallWarned) {
      this.stallWarned = true;
      this.pushLine('The server has not printed anything for 3 minutes. It may be stuck; you can stop it and check the log above.', 'system');
    }
    this.emit('progress', state);
  }

  trackStartup(line) {
    this.lastLineAt = Date.now();
    this.stallWarned = false;
    if (this.status !== 'starting') return;
    if (/Found mod file/.test(line)) this.modsFound++;
    for (const stage of STAGES) {
      if (stage.at > this.stagePercent && stage.re.test(line)) {
        this.stagePercent = stage.at;
        this.stageLabel = stage.label;
      }
    }
    const spawn = line.match(/Preparing spawn area: (\d+)%/);
    if (spawn) {
      this.stagePercent = Math.max(this.stagePercent, 76 + Number(spawn[1]) * 0.22);
      this.stageLabel = 'Preparing the spawn area';
    }
    this.trackFailure(line);
  }

  /** Work out why startup failed, and stop waiting on a server that will never finish. */
  trackFailure(line) {
    // Forge/NeoForge: "\tCIT Resewn (citresewn) has failed to load correctly"
    // (crash reports repeat it as "Failure message: CIT Resewn (citresewn) ...").
    const mod = line.match(/^\s*(?:Failure message:\s*)?(.+?) \(([a-z0-9_.-]+)\) has failed to load correctly/i);
    if (mod && !(this.failure && this.failure.mods.some((m) => m.modId === mod[2]))) {
      this.setFailure('mods', 'Some mods failed to load.');
      if (this.failure.kind === 'crash') Object.assign(this.failure, { kind: 'mods', summary: 'Some mods failed to load.' });
      this.failure.mods.push({ name: mod[1].trim(), modId: mod[2], clientOnly: false });
    }
    // The error right after names the missing class; client classes mean a client-only mod.
    if (this.failure && this.failure.mods.length && /net[/.]minecraft[/.]client[/.]|com[/.]mojang[/.]blaze3d|invalid dist DEDICATED_SERVER/.test(line)) {
      this.failure.mods[this.failure.mods.length - 1].clientOnly = true;
    }
    if (/FAILED TO BIND TO PORT/i.test(line)) this.setFailure('port', "Another program is already using this server's port.");
    else if (/OutOfMemoryError/.test(line)) this.setFailure('memory', 'The server ran out of memory. Give it more in Settings.');
    else if (/Incompatible mods found!/i.test(line)) this.setFailure('mods', 'Some mods are incompatible or are missing a mod they need. The Console tab shows which.');
    if (!this.fatalAt && FATAL.some((re) => re.test(line))) {
      this.fatalAt = Date.now();
      if (!this.failure) this.setFailure('crash', 'The server crashed while starting. The Console tab shows why.');
      // Give it a moment to finish writing its crash report, then end it.
      this.fatalTimer = setTimeout(() => {
        if (this.child && this.status === 'starting') {
          this.pushLine('The server failed to start and did not exit by itself, so EZ Host stopped it.', 'system');
          this.child.kill();
        }
      }, 15000);
      this.emitProgress();
    }
  }

  setFailure(kind, summary) {
    if (!this.failure) this.failure = { kind, summary, mods: [] };
  }

  trackPlayers(line) {
    // "[..]: Steve joined the game", or on 26.3+ "[..]: System chat: Steve joined the game".
    const joined = line.match(/\]: (?:System chat: )?(\w{3,16}) joined the game/);
    const left = line.match(/\]: (?:System chat: )?(\w{3,16}) left the game/);
    if (joined) this.players.add(joined[1]);
    else if (left) this.players.delete(left[1]);
    else return;
    this.emit('players', [...this.players]);
  }

  /** Replace the online list (from /list), e.g. when join messages were missed. */
  setPlayers(names) {
    const next = new Set(names);
    const same = next.size === this.players.size && [...next].every((n) => this.players.has(n));
    if (same) return;
    this.players = next;
    this.emit('players', [...this.players]);
  }

  /** Send a console command, e.g. "say hi" or "op Steve". */
  send(command) {
    if (!this.child) throw new Error('Server is not running');
    this.pushLine(`> ${command}`, 'input');
    this.child.stdin.write(command + '\n');
  }

  /**
   * Ask the server to save and stop. If it has not exited after
   * `timeoutMs`, kill it so the app never hangs on a stuck server.
   */
  stop(timeoutMs = 60000) {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.once('exit', () => resolve());
      if (this.status === 'stopping') return;
      this.setStatus('stopping');
      try {
        this.child.stdin.write('stop\n');
      } catch {
        // stdin already closed; fall through to the kill timer.
      }
      this.stopTimer = setTimeout(() => {
        if (this.child) {
          this.pushLine('Server did not stop in time, killing it', 'system');
          this.child.kill();
        }
      }, timeoutMs);
    });
  }

  kill() {
    if (this.child) this.child.kill();
  }
}

module.exports = { ServerProcess, G1_FLAGS };
