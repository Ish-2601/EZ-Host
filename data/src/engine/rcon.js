// Minimal Minecraft RCON client (Source RCON protocol), used to run commands
// and read their output without scraping the console.
// https://minecraft.wiki/w/RCON
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

function packet(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

class Rcon {
  // multiPacket: Minecraft answers an unknown packet type, which marks the end of
  // long replies. Other games (Project Zomboid) ignore it, so they use one packet per reply.
  constructor({ host = '127.0.0.1', port, password, multiPacket = true }) {
    this.multiPacket = multiPacket;
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
      if (waiter.parts) {
        // Long command output arrives in several packets; it is complete once
        // the reply to the marker packet sent right after the command arrives.
        waiter.parts.push(body);
        continue;
      }
      if (waiter.endOf) {
        this.pending.delete(key);
        const main = this.pending.get(waiter.endOf);
        this.pending.delete(waiter.endOf);
        if (main) main.resolve(main.parts.join(''));
        waiter.resolve('');
        continue;
      }
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

  /** Send a command, then a marker packet, and gather every reply packet in between. */
  sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('RCON is not connected'));
      const id = this.nextId++;
      const markerId = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.pending.delete(markerId);
        reject(new Error('RCON command timed out'));
      }, 15000);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { parts: [], resolve: done(resolve), reject: done(reject) });
      this.pending.set(markerId, { endOf: id, resolve: () => {}, reject: () => {} });
      this.socket.write(packet(id, TYPE_COMMAND, cmd));
      // An unknown packet type makes the server answer right after the command.
      this.socket.write(packet(markerId, 200, ''));
    });
  }

  /** Run a command and return its output text. Commands run one at a time. */
  command(cmd) {
    const run = async () => {
      await this.connect();
      return this.multiPacket ? this.sendCommand(cmd) : this.send(TYPE_COMMAND, cmd);
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
