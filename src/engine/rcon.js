// Minimal Minecraft RCON client (Source RCON protocol), used to run commands
// and read their output without scraping the console.
// https://minecraft.wiki/w/RCON
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

class Rcon {
  constructor({ host = '127.0.0.1', port, password }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.queue = Promise.resolve();
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      socket.setNoDelay(true);
      const fail = (err) => {
        this.close();
        reject(err);
      };
      socket.once('error', fail);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error('RCON connection closed'));
        this.pending.clear();
        this.socket = null;
        this.ready = null;
      });
      socket.once('connect', async () => {
        this.socket = socket;
        socket.off('error', fail);
        socket.on('error', () => {});
        try {
          const id = await this.send(TYPE_AUTH, this.password);
          if (id === -1) throw new Error('RCON password was rejected');
          resolve();
        } catch (err) {
          fail(err);
        }
      });
    });
    return this.ready;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < length + 4) break;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.toString('utf8', 12, 4 + length - 2);
      this.buffer = this.buffer.subarray(4 + length);
      // A failed login answers with id -1 instead of the request id.
      const key = id === -1 ? [...this.pending.keys()][0] : id;
      const waiter = this.pending.get(key);
      if (!waiter) continue;
      this.pending.delete(key);
      waiter.resolve(id === -1 ? -1 : body);
    }
  }

  send(type, body) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('RCON is not connected'));
      const id = this.nextId++;
      const payload = Buffer.from(body, 'utf8');
      const packet = Buffer.alloc(14 + payload.length);
      packet.writeInt32LE(10 + payload.length, 0);
      packet.writeInt32LE(id, 4);
      packet.writeInt32LE(type, 8);
      payload.copy(packet, 12);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON command timed out'));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(type === TYPE_AUTH ? (v === -1 ? -1 : id) : v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(packet);
    });
  }

  /** Run a command and return its output text. Commands run one at a time. */
  command(cmd) {
    const run = async () => {
      await this.connect();
      return this.send(TYPE_COMMAND, cmd);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ready = null;
  }
}

module.exports = { Rcon };
