// Runs one Minecraft server as a child process and exposes its console.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_HISTORY = 2000;

/**
 * Events:
 *   'line'   (text, stream)  one console line ('stdout' | 'stderr' | 'input' | 'system')
 *   'status' (status)        'stopped' | 'starting' | 'running' | 'stopping'
 *   'exit'   (code)
 */
class ServerProcess extends EventEmitter {
  constructor({ javaPath, serverDir, launch, memoryMb = 4096, extraJvmArgs = [] }) {
    super();
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
    const args = [`-Xms${Math.min(1024, this.memoryMb)}M`, `-Xmx${this.memoryMb}M`, ...this.extraJvmArgs];
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
    this.setStatus('starting');

    const child = spawn(this.javaPath, args, { cwd: this.serverDir, windowsHide: true });
    this.child = child;

    const splitter = (stream) => {
      let buffer = '';
      return (data) => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          this.pushLine(line, stream);
          // Vanilla, Fabric, Forge and NeoForge all print this once the world is loaded.
          if (this.status === 'starting' && /Done \([\d.,]+s\)!/.test(line)) this.setStatus('running');
          this.trackPlayers(line);
        }
      };
    };
    child.stdout.on('data', splitter('stdout'));
    child.stderr.on('data', splitter('stderr'));

    child.on('error', (err) => {
      this.pushLine(`Could not start Java: ${err.message}`, 'system');
    });
    child.on('exit', (code) => {
      clearTimeout(this.stopTimer);
      this.child = null;
      if (this.players.size) {
        this.players.clear();
        this.emit('players', []);
      }
      // A stop the user asked for exits with 0; anything else is a crash.
      this.crashed = this.status !== 'stopping' && code !== 0;
      this.pushLine(`Server process exited with code ${code}`, 'system');
      this.setStatus('stopped');
      this.emit('exit', code);
    });
  }

  trackPlayers(line) {
    const joined = line.match(/\]: (\w{3,16}) joined the game/);
    const left = line.match(/\]: (\w{3,16}) left the game/);
    if (joined) this.players.add(joined[1]);
    else if (left) this.players.delete(left[1]);
    else return;
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

module.exports = { ServerProcess };
