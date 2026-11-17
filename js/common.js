// Shared helpers for host, player, display and editor pages.

export const PEER_PREFIX = 'buzzboard-v1-';
export const MAX_TEAMS = 6;
export const TEAM_COLORS = ['#ef5350', '#42a5f5', '#66bb6a', '#ffa726', '#ab47bc', '#26c6da'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny DOM builder: h('div', {class:'x', onclick: fn}, 'text', childNode) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(4));
  for (const b of buf) s += A[b % A.length];
  return s;
}

export const normCode = (c) => (c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
export const peerIdFor = (code) => PEER_PREFIX + normCode(code);

export function siteBase() {
  // Directory URL of the current page (works on GitHub Pages sub-paths).
  return location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
}
export const joinUrl = (code) => `${siteBase()}index.html?room=${normCode(code)}`;

export function formatScore(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString();
}

export function toast(msg, ms = 2600) {
  let wrap = $('#toasts');
  if (!wrap) { wrap = h('div', { id: 'toasts' }); document.body.append(wrap); }
  const t = h('div', { class: 'toast' }, msg);
  wrap.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => prompt('Copy this:', text));
}

/** Create a PeerJS peer and resolve once it is registered with the broker. */
export function openPeer(id) {
  return new Promise((resolve, reject) => {
    if (typeof Peer === 'undefined') { reject(new Error('PeerJS failed to load (are you offline?)')); return; }
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const onErr = (err) => { cleanup(); try { peer.destroy(); } catch {} reject(err); };
    const onOpen = () => { cleanup(); resolve(peer); };
    const cleanup = () => { peer.off('open', onOpen); peer.off('error', onErr); };
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

/** Keep a peer registered with the signalling broker if it drops. */
export function keepPeerAlive(peer) {
  peer.on('disconnected', () => {
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch {} }, 1500);
  });
}

// ---- Sound effects (synthesised, no files needed) ----
let actx;
function ctx() {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
export function unlockAudio() { try { ctx(); } catch {} }
export function sfx(kind) {
  try {
    const c = ctx();
    const now = c.currentTime;
    const tone = (freq, start, dur, type = 'square', vol = 0.08) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, now + start);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.connect(g).connect(c.destination);
      o.start(now + start); o.stop(now + start + dur + 0.02);
    };
    if (kind === 'buzz') { tone(880, 0, 0.12); tone(1320, 0.1, 0.18); }
    else if (kind === 'right') { tone(660, 0, 0.12, 'triangle', 0.15); tone(990, 0.12, 0.25, 'triangle', 0.15); }
    else if (kind === 'wrong') { tone(220, 0, 0.35, 'sawtooth', 0.07); }
    else if (kind === 'timeout') { tone(400, 0, 0.15, 'sine', 0.15); tone(300, 0.18, 0.3, 'sine', 0.15); }
    else if (kind === 'early') { tone(160, 0, 0.12, 'square', 0.05); }
    else if (kind === 'open') { tone(1200, 0, 0.06, 'sine', 0.06); }
  } catch {}
}

// ---- Media ----
export const isDataUrl = (s) => typeof s === 'string' && s.startsWith('data:');

export function guessKind(src, mime = '') {
  const s = (mime || src || '').toLowerCase();
  if (s.startsWith('data:image') || s.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/.test(s)) return 'image';
  if (s.startsWith('data:audio') || s.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|$)/.test(s)) return 'audio';
  if (s.startsWith('data:video') || s.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)(\?|$)/.test(s)) return 'video';
  return null;
}

/**
 * Media player bound to a container. Renders images/videos, plays audio through
 * a single reused <audio> element (so mobile autoplay unlocking sticks).
 */
export class MediaStage {
  constructor(container) {
    this.el = container;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.muted = false;
    this.key = null;
    this.videos = [];
  }
  /** Call from a user gesture so later playback is allowed on phones. */
  unlock() {
    unlockAudio();
    const a = this.audio;
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    a.play().catch(() => {});
  }
  setMuted(m) {
    this.muted = m;
    this.audio.muted = m;
    this.videos.forEach((v) => (v.muted = m));
  }
  /** items: [{kind, src}] with src resolved (may be null while loading). */
  show(key, items, { autoplay = true, allowSound = true } = {}) {
    const sig = key + '|' + items.map((m) => m.kind + ':' + (m.src ? m.src.length + m.src.slice(-24) : 'x')).join(',');
    if (sig === this.sig) return;
    const sameClue = key === this.key;
    this.sig = sig;
    this.key = key;
    this.el.innerHTML = '';
    this.videos = [];
    const audioItem = items.find((m) => m.kind === 'audio');
    if (!sameClue || !audioItem) this.stop();
    for (const m of items) {
      if (!m.src) { this.el.append(h('div', { class: 'media-loading' }, 'Loading ' + m.kind + '…')); continue; }
      if (m.kind === 'image') this.el.append(h('img', { src: m.src, alt: '' }));
      else if (m.kind === 'video') {
        const v = h('video', { src: m.src, playsInline: true, controls: false, preload: 'auto' });
        v.muted = this.muted || !allowSound;
        this.videos.push(v);
        this.el.append(v);
        if (autoplay) v.play().catch(() => {});
      } else if (m.kind === 'audio') {
        this.el.append(h('div', { class: 'media-audio' }, '♪ Audio clue'));
        if (allowSound && (!sameClue || this.audio.dataset.src !== m.src)) {
          this.audio.dataset.src = m.src;
          this.audio.src = m.src;
          this.audio.muted = this.muted;
          if (autoplay) this.audio.play().catch(() => {});
        }
      }
    }
    this.el.hidden = items.length === 0;
  }
  play() {
    if (this.audio.src && this.audio.dataset.src) { this.audio.currentTime = 0; this.audio.play().catch(() => {}); }
    this.videos.forEach((v) => { v.currentTime = 0; v.play().catch(() => {}); });
  }
  stop() {
    try { this.audio.pause(); } catch {}
    this.videos.forEach((v) => v.pause());
  }
  clear() {
    this.stop();
    this.audio.removeAttribute('src');
    delete this.audio.dataset.src;
    this.el.innerHTML = '';
    this.el.hidden = true;
    this.sig = null;
    this.key = null;
    this.videos = [];
  }
}

/** Client-side cache of media sent by the host as data (key -> data URL). */
export class MediaCache {
  constructor() { this.map = new Map(); }
  put(ref, data) { this.map.set(ref, data); }
  resolve(items = []) {
    return items.map((m) => ({ kind: m.kind, src: m.src ? new URL(m.src, siteBase()).href : this.map.get(m.ref) || null }));
  }
}

/** Render a QR code for a URL if the qrcode library loaded. */
export function renderQR(el, text, size = 160) {
  el.innerHTML = '';
  if (typeof QRCode === 'undefined') return;
  try { new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M }); } catch {}
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const slug = (s) => (s || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';

/** Validate/normalise a board object loaded from JSON. */
export function normalizeBoard(b) {
  if (!b || !Array.isArray(b.rounds)) throw new Error('Not a board file (missing "rounds")');
  return {
    id: b.id || uid(),
    title: String(b.title || 'Untitled board'),
    updatedAt: b.updatedAt || Date.now(),
    rounds: b.rounds.map((r, ri) => ({
      name: String(r.name || `Round ${ri + 1}`),
      categories: (r.categories || []).map((c) => ({
        name: String(c.name || ''),
        clues: (c.clues || []).map((q) => ({
          value: Number(q.value) || 0,
          clue: String(q.clue || ''),
          answer: String(q.answer || ''),
          dd: !!q.dd,
          media: (q.media || []).filter((m) => m && m.src).map((m) => ({ kind: m.kind || guessKind(m.src) || 'image', src: String(m.src) })),
        })),
      })),
    })),
  };
}

export function newBoard(title = 'New board') {
  return {
    id: uid(),
    title,
    updatedAt: Date.now(),
    rounds: [makeRound('Round 1', 6, 5, 200)],
  };
}
export function makeRound(name, cols, rows, base) {
  return {
    name,
    categories: Array.from({ length: cols }, (_, i) => ({
      name: `Category ${i + 1}`,
      clues: Array.from({ length: rows }, (_, r) => ({ value: base * (r + 1), clue: '', answer: '', dd: false, media: [] })),
    })),
  };
}
