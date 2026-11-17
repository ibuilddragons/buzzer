// Connection from a player or display to the host, with automatic reconnects.
import { openPeer, keepPeerAlive, peerIdFor, normCode } from './common.js';

export class GameClient {
  /**
   * @param {object} o
   * @param {'player'|'display'} o.role
   * @param {string} o.code room code
   * @param {string} [o.name] player name
   * @param {string} [o.clientId] stable id for this player
   * @param {(msg:object)=>void} o.onMessage
   * @param {(status:string, detail?:string)=>void} o.onStatus  'connecting'|'connected'|'reconnecting'|'not-found'|'error'|'kicked'
   */
  constructor(o) {
    Object.assign(this, o);
    this.code = normCode(o.code);
    this.conn = null;
    this.everConnected = false;
    this.stopped = false;
    this.retryTimer = null;
  }

  async start() {
    this.onStatus('connecting');
    try {
      this.peer = await openPeer();
    } catch (e) {
      this.onStatus('error', 'Could not reach the connection server: ' + (e.message || e.type));
      this.retryTimer = setTimeout(() => this.start(), 4000);
      return;
    }
    keepPeerAlive(this.peer);
    this.peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') {
        if (!this.everConnected) { this.onStatus('not-found'); this.stop(); }
        else this.scheduleReconnect(3000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.scheduleReconnect(3000);
      }
    });
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    if (this.conn) { try { this.conn.close(); } catch {} }
    const conn = this.peer.connect(peerIdFor(this.code), { reliable: true });
    this.conn = conn;
    const openTimeout = setTimeout(() => { if (!conn.open && this.conn === conn) this.scheduleReconnect(500); }, 10000);
    conn.on('open', () => {
      clearTimeout(openTimeout);
      this.everConnected = true;
      this.onStatus('connected');
      this.send({ t: 'hello', role: this.role, clientId: this.clientId, name: this.name });
    });
    conn.on('data', (msg) => {
      if (msg?.t === 'kicked') { this.stop(); this.onStatus('kicked'); return; }
      try { this.onMessage(msg); } catch (e) { console.error(e); }
    });
    const lost = () => { clearTimeout(openTimeout); if (this.conn === conn && !this.stopped) this.scheduleReconnect(1500); };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  scheduleReconnect(ms) {
    if (this.stopped) return;
    this.onStatus('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.peer.destroyed) { this.start(); return; }
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} }
      this.connect();
    }, ms);
  }

  send(msg) {
    if (this.conn?.open) { try { this.conn.send(msg); return true; } catch {} }
    return false;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
  }
}
