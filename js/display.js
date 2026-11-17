import { $, h, normCode, formatScore, sfx, MediaStage, MediaCache, joinUrl, renderQR, unlockAudio } from './common.js';
import { GameClient } from './client.js';

const params = new URLSearchParams(location.search);
let client = null;
let state = null;
let deadlineAt = null;
const cache = new MediaCache();
const stage = new MediaStage(h('div', { class: 'media' }));

const codeIn = $('#codeIn');
codeIn.value = normCode(params.get('room') || '');
codeIn.addEventListener('input', () => (codeIn.value = normCode(codeIn.value)));
$('#startBtn').onclick = start;
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

function start() {
  const code = normCode(codeIn.value);
  if (code.length !== 4) { $('#startStatus').textContent = 'Enter the 4-letter room code.'; return; }
  stage.unlock();
  unlockAudio();
  $('#startStatus').textContent = 'Connecting…';
  client = new GameClient({ role: 'display', code, onMessage, onStatus });
  client.start();
  history.replaceState(null, '', '?room=' + code);
}

function onStatus(st, detail) {
  $('#dDot').classList.toggle('on', st === 'connected');
  if (st === 'connected') $('#start').hidden = true;
  else if (st === 'not-found') { $('#start').hidden = false; $('#startStatus').textContent = `Room ${client.code} not found.`; }
  else if (st === 'error') $('#startStatus').textContent = detail;
}

function onMessage(msg) {
  if (msg.t === 'state') {
    state = msg.s;
    deadlineAt = state.clue?.remainingMs != null ? Date.now() + state.clue.remainingMs : null;
    render();
  } else if (msg.t === 'media') { cache.put(msg.ref, msg.data); render(); }
  else if (msg.t === 'mediaCmd') { if (msg.cmd === 'play') stage.play(); else stage.stop(); }
  else if (msg.t === 'sfx') sfx(msg.kind);
}

const teamById = (id) => state.teams.find((t) => t.id === id);
let lastJoinCode = null;

function render() {
  const s = state;
  $('#dTitle').textContent = s.title;
  $('#dRound').textContent = s.phase === 'lobby' ? '' : `${s.roundName}`;
  if (lastJoinCode !== s.code) {
    lastJoinCode = s.code;
    $('#dJoin').replaceChildren(h('div', {}, 'Join at ', h('b', {}, joinUrl(s.code).replace(/^https?:\/\//, '').replace(/\?.*$/, ''))), h('div', {}, 'Room ', h('b', { class: 'code-badge', style: { fontSize: '1.1rem' } }, s.code)));
  }
  const main = $('#dMain');

  if (s.phase === 'lobby') {
    stage.clear();
    const qr = h('div', { class: 'qr' });
    main.replaceChildren(h('div', { class: 'lobby' },
      h('div', {},
        h('div', { class: 'muted', style: { fontSize: '1.3rem' } }, 'Join on your phone with room code'),
        h('div', { class: 'big' }, s.code),
        h('div', { class: 'muted' }, joinUrl(s.code))),
      qr,
      h('div', { class: 'lobby-teams' }, s.teams.map((t) => h('div', { class: 'score', style: { '--team': t.color } },
        h('div', { class: 'name' }, t.name),
        h('div', { class: 'members' }, t.members.map((m) => m.name).join(', ') || '—')))),
      s.unassigned.length ? h('div', { class: 'muted' }, 'Not on a team yet: ' + s.unassigned.map((m) => m.name).join(', ')) : null,
    ));
    renderQR(qr, joinUrl(s.code), 200);
    $('#dScores').replaceChildren();
    return;
  }

  if (s.phase === 'over') {
    stage.clear();
    main.replaceChildren(h('div', { class: 'lobby' },
      h('div', { class: 'big', style: { fontSize: 'clamp(2rem,7vw,5rem)' } }, 'FINAL SCORES'),
      h('div', { class: 'lobby-teams' }, s.final.map((id, i) => { const t = teamById(id); return h('div', { class: 'score', style: { '--team': t.color, minWidth: '220px', transform: i === 0 ? 'scale(1.12)' : '' } },
        h('div', { class: 'name' }, `${i === 0 ? '🏆 ' : ''}${t.name}`), h('div', { class: 'pts' + (t.score < 0 ? ' neg' : '') }, formatScore(t.score))); })),
    ));
  } else if (s.phase === 'clue' && s.clue) {
    const c = s.clue;
    const view = h('div', { class: 'clue-view' },
      h('div', { class: 'clue-meta', style: { fontSize: 'clamp(1rem,2vw,1.6rem)' } }, `${c.category} · ${formatScore(c.dd && c.wager != null ? c.wager : c.value)}`));
    if (c.stage === 'wager') {
      stage.clear();
      view.append(h('div', { class: 'dd-banner' }, 'DAILY DOUBLE'), h('div', { style: { fontSize: '1.5rem' } }, `${teamById(c.ddTeam)?.name || ''} is making a wager`));
    } else {
      view.append(h('div', { class: 'clue-text' }, c.text || ''), stage.el);
      stage.show(c.key, cache.resolve(c.media));
      if (c.stage === 'open') view.append(h('div', { class: 'countdown', id: 'dCountdown' }, 'Buzzers open'));
      if (c.stage === 'buzzed' && c.winner) {
        const t = teamById(c.winner.teamId);
        view.append(h('div', { class: 'buzz-banner', style: { background: t?.color } }, `${c.winner.name} · ${t?.name}`));
      }
      if (c.dd && c.stage === 'ddclue') view.append(h('div', { class: 'buzz-banner', style: { background: teamById(c.ddTeam)?.color } }, `${teamById(c.ddTeam)?.name} · wager ${formatScore(c.wager)}`));
      if (c.stage === 'timeout') view.append(h('div', { class: 'muted', style: { fontSize: '1.4rem' } }, "Time's up"));
      if (c.stage === 'answer') view.append(h('div', { class: 'answer-text' }, c.answer || ''));
    }
    main.replaceChildren(view);
  } else {
    stage.clear();
    const rows = Math.max(...s.categories.map((c) => c.clues.length));
    main.replaceChildren(h('div', { class: 'board', style: { '--cols': s.categories.length } },
      s.categories.map((c) => h('div', { class: 'cat' }, c.name)),
      Array.from({ length: rows }, (_, ri) => s.categories.map((cat) => {
        const q = cat.clues[ri];
        return h('div', { class: 'cell' + (!q || q.used ? ' used' : '') }, q ? '$' + q.value : '');
      }))));
  }

  $('#dScores').replaceChildren(...s.teams.map((t) => h('div', {
    class: 'score' + (t.id === s.control ? ' control' : '') + (s.clue?.winner?.teamId === t.id ? ' buzzed' : '') + (s.clue?.lockedTeams?.includes(t.id) ? ' locked' : ''),
    style: { '--team': t.color },
  }, h('div', { class: 'name' }, t.name), h('div', { class: 'pts' + (t.score < 0 ? ' neg' : '') }, formatScore(t.score)),
  h('div', { class: 'members' }, t.members.map((m) => m.name).join(', ')))));
}

setInterval(() => {
  const el = $('#dCountdown');
  if (el && deadlineAt) el.textContent = `Buzzers open · ${Math.max(0, (deadlineAt - Date.now()) / 1000).toFixed(1)}s`;
}, 100);

if (codeIn.value) codeIn.focus();
