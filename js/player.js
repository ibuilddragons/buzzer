import { $, h, uid, normCode, formatScore, sfx, MediaStage, MediaCache, toast } from './common.js';
import { GameClient } from './client.js';

const params = new URLSearchParams(location.search);
const store = {
  get: (s, k) => { try { return s.getItem(k); } catch { return null; } },
  set: (s, k, v) => { try { s.setItem(k, v); } catch {} },
  del: (s, k) => { try { s.removeItem(k); } catch {} },
};

let client = null;
let state = null;
let myId = null;
let myName = '';
let penaltyUntil = 0;
let pendingBuzz = null;     // clue key + open timestamp we buzzed on
let deadlineAt = null;
let muted = store.get(localStorage, 'bb-muted') === '1';
const cache = new MediaCache();
const stage = new MediaStage(h('div', { class: 'media' }));

// ---------------- Join ----------------
const codeInput = $('#codeInput');
const nameInput = $('#nameInput');
codeInput.value = normCode(params.get('room') || '');
nameInput.value = store.get(localStorage, 'bb-name') || '';
codeInput.addEventListener('input', () => { codeInput.value = normCode(codeInput.value); updateDisplayLink(); });
function updateDisplayLink() { $('#displayLink').href = 'display.html' + (codeInput.value.length === 4 ? '?room=' + codeInput.value : ''); }
updateDisplayLink();
if (codeInput.value && !nameInput.value) nameInput.focus(); else if (!codeInput.value) codeInput.focus();

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normCode(codeInput.value);
  const name = nameInput.value.trim();
  if (code.length !== 4) { $('#joinStatus').textContent = 'Room codes are 4 letters.'; return; }
  if (!name) return;
  stage.unlock(); // user gesture: allow audio later on phones
  join(code, name);
});

function join(code, name) {
  myName = name;
  store.set(localStorage, 'bb-name', name);
  let cid = store.get(sessionStorage, 'bb-client-' + code);
  if (!cid) { cid = uid(); store.set(sessionStorage, 'bb-client-' + code, cid); }
  myId = cid;
  $('#joinStatus').textContent = 'Connecting…';
  client = new GameClient({ role: 'player', code, name, clientId: cid, onMessage, onStatus });
  client.start();
  history.replaceState(null, '', '?room=' + code);
}

function onStatus(st, detail) {
  const banner = $('#connBanner');
  if (st === 'connected') {
    banner.hidden = true;
    store.set(sessionStorage, 'bb-joined', client.code);
  } else if (st === 'reconnecting') {
    banner.hidden = false; banner.textContent = 'Connection lost — reconnecting…';
  } else if (st === 'not-found') {
    store.del(sessionStorage, 'bb-joined');
    showJoin(`Room ${client.code} wasn't found. Check the code with your host.`);
  } else if (st === 'kicked') {
    store.del(sessionStorage, 'bb-joined');
    showJoin('The host removed you from the game.');
  } else if (st === 'error') {
    $('#joinStatus').textContent = detail || 'Connection error';
    banner.hidden = false; banner.textContent = detail || 'Connection error — retrying…';
  }
}

function showJoin(msg) {
  client?.stop();
  client = null; state = null;
  stage.clear();
  $('#play').hidden = true;
  $('#join').hidden = false;
  $('#joinStatus').textContent = msg || '';
}

// ---------------- Messages ----------------
function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      myId = msg.clientId; myName = msg.name;
      $('#join').hidden = true;
      $('#play').hidden = false;
      break;
    case 'state': {
      const prevKey = state?.clue?.key;
      state = msg.s;
      if (state.clue?.remainingMs != null) deadlineAt = Date.now() + state.clue.remainingMs; else deadlineAt = null;
      if (state.clue?.key !== prevKey) pendingBuzz = null;
      if (state.clue?.stage !== 'open') pendingBuzz = null;
      if (state.clue?.winner?.clientId === myId && prevWinner !== myId && !muted) { sfx('buzz'); navigator.vibrate?.([60, 40, 60]); }
      prevWinner = state.clue?.winner?.clientId || null;
      render();
      break;
    }
    case 'media':
      cache.put(msg.ref, msg.data);
      render();
      break;
    case 'mediaCmd':
      if (msg.cmd === 'play') stage.play(); else stage.stop();
      break;
    case 'penalty':
      penaltyUntil = Date.now() + msg.ms;
      pendingBuzz = null;
      if (!muted) sfx('early');
      navigator.vibrate?.(150);
      render();
      setTimeout(render, msg.ms + 20);
      break;
  }
}
let prevWinner = null;

// ---------------- Rendering ----------------
const myTeam = () => state?.teams.find((t) => t.members.some((m) => m.clientId === myId));
const teamById = (id) => state?.teams.find((t) => t.id === id);

function render() {
  if (!state) return;
  const t = myTeam();
  document.documentElement.style.setProperty('--team', t?.color || 'var(--line)');
  $('#pName').textContent = myName;
  $('#pTeam').textContent = t ? t.name : 'No team yet';
  $('#pScore').textContent = t ? formatScore(t.score) : '';
  $('#muteBtn').textContent = muted ? '🔇' : '🔊';
  stage.setMuted(muted || !state.settings.playerAudio);

  const main = $('#pmain');
  const parts = [];
  const choose = state.settings.assignMode === 'choose';

  if (state.phase === 'lobby' || !t) {
    parts.push(h('div', { class: 'card stack' },
      h('h2', { style: { margin: 0 } }, state.title),
      choose ? h('div', { class: 'muted' }, t ? 'You can switch teams until the game starts.' : 'Pick your team:') :
        h('div', { class: 'muted' }, t ? `You're on ${t.name}.` : 'The host will put you on a team.'),
      choose ? h('div', { class: 'team-pick' }, state.teams.map((tm) => h('button', {
        class: tm === t ? 'mine' : '', style: { '--team': tm.color },
        disabled: state.phase !== 'lobby' && !!t,
        onclick: () => client.send({ t: 'team', teamId: tm.id }),
      }, tm.name, h('span', { class: 'muted small' }, tm.members.map((m) => m.name).join(', ') || 'empty')))) : null,
      state.phase === 'lobby' ? h('div', { class: 'waiting', style: { padding: '.5rem 0' } }, 'Waiting for the host to start…') : null,
    ));
  }

  if (state.phase === 'over') {
    parts.push(h('div', { class: 'card stack', style: { textAlign: 'center' } }, h('h2', {}, '🏆 Final scores'),
      state.final.map((id, i) => { const tm = teamById(id); return h('div', { class: 'score', style: { '--team': tm.color } }, h('div', { class: 'name' }, `${i + 1}. ${tm.name}`), h('div', { class: 'pts' }, formatScore(tm.score))); })));
  } else if (state.phase === 'clue' && state.clue) {
    const c = state.clue;
    const card = h('div', { class: 'pclue' },
      h('div', { class: 'clue-meta' }, `${c.category} · ${formatScore(c.dd && c.wager != null ? c.wager : c.value)}`));
    if (c.stage === 'wager') {
      stage.clear();
      card.append(h('div', { class: 'dd-banner' }, 'DAILY DOUBLE'), h('div', {}, `${teamById(c.ddTeam)?.name || 'A team'} is making a wager…`));
    } else {
      card.append(h('div', { class: 'clue-text' }, c.text || ''));
      card.append(stage.el);
      stage.show(c.key, cache.resolve(c.media), { allowSound: state.settings.playerAudio });
      if (c.stage === 'open' && deadlineAt) card.append(h('div', { class: 'countdown', id: 'pCountdown' }));
      if (c.stage === 'answer') card.append(h('div', { class: 'answer-text' }, c.answer || ''));
      if (c.result && c.stage === 'answer') {
        const rt = teamById(c.result.teamId);
        card.append(h('div', { class: 'small' }, `${rt?.name} ${c.result.correct ? '✓' : '✗'} ${c.result.correct ? '+' : '−'}${formatScore(c.result.amount)}`));
      }
    }
    parts.push(card);
  } else if (state.phase === 'board') {
    stage.clear();
    parts.push(h('div', { class: 'waiting' }, `${state.roundName} — waiting for the next clue…`));
  }
  if (state.phase !== 'clue') stage.clear();

  if (state.phase !== 'lobby') {
    parts.push(h('div', { class: 'mini-scores' }, state.teams.map((tm) => h('div', {
      class: 'score' + (tm.id === state.control ? ' control' : '') + (state.clue?.winner?.teamId === tm.id ? ' buzzed' : '') + (state.clue?.lockedTeams?.includes(tm.id) ? ' locked' : ''),
      style: { '--team': tm.color },
    }, h('div', { class: 'name' }, tm.name), h('div', { class: 'pts' + (tm.score < 0 ? ' neg' : '') }, formatScore(tm.score))))));
  }
  main.replaceChildren(...parts);
  renderBuzzer();
}

function buzzerState() {
  const now = Date.now();
  const t = myTeam();
  const c = state?.clue;
  if (!state) return ['armed', 'WAIT', 'Connecting…', true];
  if (!t) return ['armed', 'NO TEAM', state.settings.assignMode === 'choose' ? 'Pick a team above' : 'Waiting for the host to assign you', true];
  if (now < penaltyUntil) return ['penalty', 'TOO EARLY', 'Wait for the buzzers to open', true];
  if (state.phase !== 'clue' || !c) return ['armed', 'WAIT', state.phase === 'lobby' ? 'The game will start soon' : 'Waiting for a clue', true];
  if (c.dd) return ['other', 'DAILY DOUBLE', `${teamById(c.ddTeam)?.name || 'One team'} plays this clue`, true];
  if (c.stage === 'answer') return ['armed', '—', '', true];
  if (c.lockedTeams.includes(t.id)) return ['locked', 'LOCKED OUT', 'Your team already tried this one', true];
  if (c.stage === 'reading') return ['armed', 'WAIT…', 'Buzzing before the buzzers open locks you out briefly', false];
  if (c.stage === 'open') {
    if (pendingBuzz === c.key) return ['open', '…', 'Sending', true];
    return ['open', 'BUZZ!', 'Tap or press Space', false];
  }
  if (c.stage === 'buzzed' && c.winner) {
    if (c.winner.clientId === myId) return ['won', "YOU'RE IN!", 'Say your answer', true];
    if (c.winner.teamId === t.id) return ['won', c.winner.name.toUpperCase(), 'Your teammate buzzed in', true];
    return ['other', c.winner.name.toUpperCase(), `${teamById(c.winner.teamId)?.name} buzzed first`, true];
  }
  if (c.stage === 'timeout') return ['other', "TIME'S UP", '', true];
  return ['armed', 'WAIT', '', true];
}

function renderBuzzer() {
  const [cls, label, sub, disabled] = buzzerState();
  const b = $('#buzz');
  b.className = 's-' + cls;
  b.disabled = disabled;
  b.replaceChildren(label, sub ? h('span', { class: 'sub' }, sub) : '');
}

function pressBuzz() {
  if (!state || $('#buzz').disabled) return;
  const c = state.clue;
  if (!c) return;
  if (!client.send({ t: 'buzz' })) { toast('Not connected'); return; }
  navigator.vibrate?.(25);
  if (c.stage === 'open') { pendingBuzz = c.key; renderBuzzer(); }
}

$('#buzz').addEventListener('pointerdown', (e) => { e.preventDefault(); pressBuzz(); });
document.addEventListener('keydown', (e) => {
  if ($('#play').hidden || e.repeat || e.target.closest?.('input, textarea, select')) return;
  if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); pressBuzz(); }
});
$('#muteBtn').onclick = () => {
  muted = !muted;
  store.set(localStorage, 'bb-muted', muted ? '1' : '0');
  stage.unlock();
  render();
};

setInterval(() => {
  const el = $('#pCountdown');
  if (el && deadlineAt) el.textContent = Math.max(0, (deadlineAt - Date.now()) / 1000).toFixed(1) + 's';
  if (penaltyUntil && Date.now() > penaltyUntil) { penaltyUntil = 0; renderBuzzer(); }
}, 100);

// Auto-rejoin after a page reload.
const rejoin = store.get(sessionStorage, 'bb-joined');
if (rejoin && rejoin === normCode(params.get('room') || rejoin) && nameInput.value) {
  join(rejoin, nameInput.value);
}
