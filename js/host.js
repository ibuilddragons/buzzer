import {
  $, h, toast, copyText, uid, makeRoomCode, peerIdFor, joinUrl, siteBase, openPeer, keepPeerAlive,
  formatScore, sfx, MediaStage, isDataUrl, normalizeBoard, renderQR, TEAM_COLORS, MAX_TEAMS,
} from './common.js';
import { listBoards, getBoard, kvGet, kvSet, kvDel, listBundledBoards, fetchBundledBoard } from './store.js';

const SESSION_KEY = 'hostSession';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Game state (persisted so a refresh doesn't lose the game). */
let S = null;
let peer = null;
const conns = new Map();     // clientId -> DataConnection (players)
const displays = new Set();  // display connections
const penalties = new Map(); // clientId -> timestamp until which buzzes are ignored
let buzzTimer = null;
let mediaStage = null;

// ======================================================================
// Setup screen
// ======================================================================
let picked = null;          // {source:'local'|'bundled'|'file', id|file|board}
let importedBoard = null;

async function initSetup() {
  const params = new URLSearchParams(location.search);
  const sel = $('#teamCount');
  for (let i = 1; i <= MAX_TEAMS; i++) sel.append(h('option', { value: i, selected: i === 3 }, i + (i === 1 ? ' team' : ' teams')));
  sel.onchange = renderTeamNameInputs;
  renderTeamNameInputs();

  const session = await kvGet(SESSION_KEY).catch(() => null);
  if (session && session.phase !== 'over') {
    $('#resumeCard').hidden = false;
    $('#resumeInfo').textContent = `Room ${session.code} · ${session.board.title} · ${session.teams.map((t) => `${t.name} ${formatScore(t.score)}`).join(', ')}`;
    $('#resumeBtn').onclick = () => resume(session);
    $('#discardBtn').onclick = async () => { if (confirm('Discard the saved game?')) { await kvDel(SESSION_KEY); $('#resumeCard').hidden = true; } };
  }

  await renderBoardPick(params.get('board'));

  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      importedBoard = normalizeBoard(JSON.parse(await f.text()));
      await renderBoardPick('file');
    } catch (err) { toast('Import failed: ' + err.message, 5000); }
  };
  $('#createBtn').onclick = createRoom;
}

function renderTeamNameInputs() {
  const n = Number($('#teamCount').value);
  const wrap = $('#teamNames');
  const old = [...wrap.querySelectorAll('input')].map((i) => i.value);
  wrap.innerHTML = '';
  for (let i = 0; i < n; i++) {
    wrap.append(h('input', { value: old[i] || `Team ${i + 1}`, 'aria-label': `Team ${i + 1} name`, style: { borderLeft: `6px solid ${TEAM_COLORS[i]}` } }));
  }
}

async function renderBoardPick(preselect) {
  const list = $('#boardPick');
  list.innerHTML = '';
  const options = [];
  if (importedBoard) options.push({ key: 'file', title: importedBoard.title, sub: 'Imported file', pick: { source: 'file' } });
  for (const b of await listBoards()) {
    options.push({ key: b.id, title: b.title, sub: `My board · ${b.rounds.length} round(s)`, pick: { source: 'local', id: b.id } });
  }
  for (const b of await listBundledBoards()) {
    options.push({ key: 'bundled:' + b.file, title: b.title || b.file, sub: 'From the repo', pick: { source: 'bundled', file: b.file } });
  }
  if (!options.length) {
    list.append(h('p', { class: 'muted' }, 'No boards yet. ', h('a', { href: 'editor.html' }, 'Make one in the editor'), ' or import a board file.'));
    picked = null;
    return;
  }
  const want = preselect && options.find((o) => o.key === preselect) ? preselect : options[0].key;
  for (const o of options) {
    const input = h('input', { type: 'radio', name: 'board', checked: o.key === want, onchange: () => (picked = o.pick) });
    if (o.key === want) picked = o.pick;
    list.append(h('label', { class: 'pick' }, input, h('div', {}, h('div', {}, o.title), h('div', { class: 'sub' }, o.sub))));
  }
}

async function loadPickedBoard() {
  if (!picked) throw new Error('Pick a board first');
  if (picked.source === 'file') return structuredClone(importedBoard);
  if (picked.source === 'local') return getBoard(picked.id);
  return normalizeBoard(await fetchBundledBoard(picked.file));
}

async function createRoom() {
  const btn = $('#createBtn');
  btn.disabled = true;
  $('#setupStatus').textContent = 'Connecting…';
  try {
    const board = await loadPickedBoard();
    if (!board?.rounds?.length) throw new Error('That board has no rounds');
    const names = [...$('#teamNames').querySelectorAll('input')].map((i) => i.value.trim());
    S = {
      code: makeRoomCode(),
      board,
      settings: {
        assignMode: $('#assignMode').value,
        penaltyMs: Math.max(0, Number($('#penaltyMs').value) || 0),
        buzzSeconds: Math.max(0, Number($('#buzzSeconds').value) || 0),
        autoOpen: $('#autoOpen').checked,
        playerAudio: $('#playerAudio').checked,
      },
      teams: names.map((n, i) => ({ id: uid(), name: n || `Team ${i + 1}`, color: TEAM_COLORS[i], score: 0 })),
      players: {},
      roundIndex: 0,
      used: {},
      control: null,
      phase: 'lobby',
      clue: null,
      log: [],
    };
    await startNetwork(false);
    enterGame();
  } catch (e) {
    console.error(e);
    $('#setupStatus').textContent = 'Could not create room: ' + (e.message || e.type || e);
    btn.disabled = false;
  }
}

async function resume(session) {
  S = session;
  S.log = S.log || [];
  if (S.clue && S.clue.stage === 'open') S.clue.stage = 'reading';
  $('#resumeBtn').disabled = true;
  $('#setupStatus').textContent = 'Reconnecting room ' + S.code + '…';
  try {
    await startNetwork(true);
    enterGame();
  } catch (e) {
    $('#setupStatus').textContent = 'Could not resume: ' + (e.message || e.type || e);
    $('#resumeBtn').disabled = false;
  }
}

// ======================================================================
// Networking
// ======================================================================
async function startNetwork(resuming) {
  for (let attempt = 0; ; attempt++) {
    try {
      peer = await openPeer(peerIdFor(S.code));
      break;
    } catch (e) {
      if (e.type === 'unavailable-id') {
        if (resuming && attempt < 25) {
          // The previous tab's registration takes a little while to expire.
          $('#setupStatus').textContent = `Waiting for room ${S.code} to free up (${attempt + 1})…`;
          await sleep(3000);
          continue;
        }
        if (!resuming && attempt < 5) { S.code = makeRoomCode(); continue; }
      }
      throw e;
    }
  }
  keepPeerAlive(peer);
  peer.on('connection', onConnection);
  peer.on('error', (e) => { console.warn('peer error', e.type, e); if (e.type === 'network' || e.type === 'server-error') toast('Network problem: ' + e.type); });
  const updateDot = () => { const d = $('#netDot'); if (d) d.classList.toggle('on', !peer.disconnected); };
  peer.on('disconnected', updateDot);
  peer.on('open', updateDot);
  setInterval(updateDot, 3000);
}

function onConnection(conn) {
  conn.sentMedia = new Set();
  conn.on('data', (msg) => { try { handleMessage(conn, msg); } catch (e) { console.error(e); } });
  const drop = () => {
    if (conn.role === 'display') displays.delete(conn);
    else if (conn.clientId && conns.get(conn.clientId) === conn) conns.delete(conn.clientId);
    changed('players');
  };
  conn.on('close', drop);
  conn.on('error', drop);
}

function send(conn, msg) { try { if (conn.open) conn.send(msg); } catch (e) { console.warn('send failed', e); } }
function allConns() { return [...conns.values(), ...displays]; }
function broadcast(msg) { allConns().forEach((c) => send(c, msg)); }

function handleMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') return onHello(conn, msg);
  if (!conn.clientId || conns.get(conn.clientId) !== conn) return;
  const p = S.players[conn.clientId];
  if (!p) return;
  if (msg.t === 'buzz') onBuzz(p, conn);
  else if (msg.t === 'team' && S.settings.assignMode === 'choose') {
    if (msg.teamId === null || S.teams.some((t) => t.id === msg.teamId)) { p.teamId = msg.teamId; changed('players'); }
  }
}

function onHello(conn, msg) {
  if (msg.role === 'display') {
    conn.role = 'display';
    displays.add(conn);
    send(conn, { t: 'welcome', role: 'display' });
    sendClueMedia(conn);
    send(conn, { t: 'state', s: publicState() });
    return;
  }
  let id = String(msg.clientId || uid()).slice(0, 64);
  let name = String(msg.name || '').trim().slice(0, 24) || 'Player';
  let p = S.players[id];
  if (!p) {
    // Same name as a disconnected player? Treat it as them rejoining from a new tab/device.
    const ghost = Object.values(S.players).find((q) => !conns.has(q.clientId) && q.name.toLowerCase() === name.toLowerCase());
    if (ghost) {
      delete S.players[ghost.clientId];
      ghost.clientId = id;
      p = S.players[id] = ghost;
    }
  }
  // Keep names unique among other players.
  const taken = (n) => Object.values(S.players).some((q) => q.clientId !== id && q.name.toLowerCase() === n.toLowerCase());
  if (taken(name)) { let i = 2; while (taken(`${name} ${i}`)) i++; name = `${name} ${i}`; }
  if (!p) {
    p = S.players[id] = { clientId: id, name, teamId: null, joinedAt: Date.now() };
    if (S.settings.assignMode === 'auto') p.teamId = smallestTeam()?.id || null;
  } else {
    p.name = name;
  }
  const old = conns.get(id);
  if (old && old !== conn) { old.clientId = null; try { old.close(); } catch {} }
  conn.role = 'player';
  conn.clientId = id;
  conns.set(id, conn);
  send(conn, { t: 'welcome', role: 'player', clientId: id, name });
  sendClueMedia(conn);
  changed('players');
}

function smallestTeam() {
  const counts = new Map(S.teams.map((t) => [t.id, 0]));
  Object.values(S.players).forEach((p) => { if (counts.has(p.teamId)) counts.set(p.teamId, counts.get(p.teamId) + 1); });
  return S.teams.slice().sort((a, b) => counts.get(a.id) - counts.get(b.id))[0];
}

// ---------- Public state ----------
const round = () => S.board.rounds[S.roundIndex];
const clueKey = (r, c, row) => `${r}:${c}:${row}`;
const clueData = (c = S.clue) => c && S.board.rounds[c.r].categories[c.c].clues[c.row];
const team = (id) => S.teams.find((t) => t.id === id);
const textVisible = () => S.clue && S.clue.stage !== 'wager';

function publicMedia() {
  if (!textVisible()) return [];
  const q = clueData();
  return q.media.map((m, i) => isDataUrl(m.src)
    ? { kind: m.kind, ref: clueKey(S.clue.r, S.clue.c, S.clue.row) + ':' + i }
    : { kind: m.kind, src: m.src });
}

function sendClueMedia(conn) {
  if (!textVisible()) return;
  const q = clueData();
  q.media.forEach((m, i) => {
    if (!isDataUrl(m.src)) return;
    const ref = clueKey(S.clue.r, S.clue.c, S.clue.row) + ':' + i;
    if (conn.sentMedia.has(ref)) return;
    conn.sentMedia.add(ref);
    send(conn, { t: 'media', ref, data: m.src });
  });
}

function publicState() {
  const rd = round();
  const c = S.clue;
  const q = clueData();
  const online = (id) => conns.has(id);
  return {
    code: S.code,
    title: S.board.title,
    phase: S.phase,
    roundIndex: S.roundIndex,
    roundCount: S.board.rounds.length,
    roundName: rd.name,
    categories: rd.categories.map((cat, ci) => ({
      name: cat.name,
      clues: cat.clues.map((cl, ri) => ({ value: cl.value, used: !!S.used[clueKey(S.roundIndex, ci, ri)] })),
    })),
    teams: S.teams.map((t) => ({
      id: t.id, name: t.name, color: t.color, score: t.score,
      members: Object.values(S.players).filter((p) => p.teamId === t.id).map((p) => ({ clientId: p.clientId, name: p.name, online: online(p.clientId) })),
    })),
    unassigned: Object.values(S.players).filter((p) => !team(p.teamId)).map((p) => ({ clientId: p.clientId, name: p.name, online: online(p.clientId) })),
    control: S.control,
    settings: { assignMode: S.settings.assignMode, playerAudio: S.settings.playerAudio },
    clue: c && {
      key: clueKey(c.r, c.c, c.row),
      category: S.board.rounds[c.r].categories[c.c].name,
      value: q.value,
      dd: !!c.dd,
      ddTeam: c.ddTeam || null,
      wager: c.wager ?? null,
      stage: c.stage,
      text: textVisible() ? q.clue : null,
      media: publicMedia(),
      winner: c.winner || null,
      lockedTeams: c.lockedTeams,
      remainingMs: c.stage === 'open' && c.deadline ? Math.max(0, c.deadline - Date.now()) : null,
      answer: c.stage === 'answer' ? q.answer : null,
      result: c.result || null,
    },
    final: S.phase === 'over' ? S.teams.slice().sort((a, b) => b.score - a.score).map((t) => t.id) : null,
  };
}

// ---------- Change propagation ----------
let pending = false;
let saveTimer = null;
function changed() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    if (S.clue) allConns().forEach(sendClueMedia);
    broadcast({ t: 'state', s: publicState() });
    renderGame();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 400);
  });
}
function saveSession() {
  const snap = { ...S, clue: S.clue ? { ...S.clue } : null };
  kvSet(SESSION_KEY, snap).catch((e) => console.warn('session save failed', e));
}

function addLog(text) {
  S.log.unshift({ at: Date.now(), text });
  S.log.length = Math.min(S.log.length, 40);
}

// ======================================================================
// Game actions
// ======================================================================
function startGame() { S.phase = 'board'; changed(); }

function pickClue(ci, ri) {
  if (S.clue) return;
  const key = clueKey(S.roundIndex, ci, ri);
  if (S.used[key]) return;
  const q = round().categories[ci].clues[ri];
  S.phase = 'clue';
  S.log = [];
  S.clue = { r: S.roundIndex, c: ci, row: ri, dd: q.dd, stage: q.dd ? 'wager' : 'reading', lockedTeams: [], winner: null, buzzes: [] };
  if (q.dd) {
    S.clue.ddTeam = (team(S.control) || S.teams[0])?.id || null;
    S.clue.wager = null;
  }
  addLog(`Opened ${round().categories[ci].name || 'clue'} for ${formatScore(q.value)}${q.dd ? ' (Daily Double)' : ''}`);
  if (!q.dd && S.settings.autoOpen) openBuzzers(true);
  changed();
}

function setWager(teamId, wager) {
  if (!S.clue || S.clue.stage !== 'wager') return;
  S.clue.ddTeam = teamId;
  S.clue.wager = Math.max(0, Math.round(Number(wager) || 0));
  S.clue.stage = 'ddclue';
  addLog(`${team(teamId)?.name} wagers ${formatScore(S.clue.wager)}`);
  changed();
}

function openBuzzers(silent) {
  const c = S.clue;
  if (!c || !['reading', 'timeout'].includes(c.stage) || c.dd) return;
  if (S.teams.every((t) => c.lockedTeams.includes(t.id))) { toast('Every team is locked out'); return; }
  c.stage = 'open';
  c.winner = null;
  c.openedAt = Date.now();
  c.deadline = S.settings.buzzSeconds ? c.openedAt + S.settings.buzzSeconds * 1000 : null;
  c.token = uid();
  clearTimeout(buzzTimer);
  if (c.deadline) {
    const token = c.token;
    buzzTimer = setTimeout(() => {
      if (S.clue && S.clue.token === token && S.clue.stage === 'open') {
        S.clue.stage = 'timeout';
        addLog('Time ran out');
        broadcast({ t: 'sfx', kind: 'timeout' });
        sfx('timeout');
        changed();
      }
    }, c.deadline - c.openedAt);
  }
  if (!silent) addLog('Buzzers open');
  broadcast({ t: 'sfx', kind: 'open' });
  changed();
}

function closeBuzzers() {
  if (S.clue?.stage !== 'open') return;
  clearTimeout(buzzTimer);
  S.clue.stage = 'timeout';
  addLog('Buzzers closed');
  changed();
}

function onBuzz(p, conn) {
  const c = S.clue;
  const now = Date.now();
  if (!c || c.dd || !team(p.teamId)) return;
  if (c.stage === 'reading') {
    if (S.settings.penaltyMs > 0) {
      penalties.set(p.clientId, now + S.settings.penaltyMs);
      send(conn, { t: 'penalty', ms: S.settings.penaltyMs });
      addLog(`${p.name} buzzed early`);
      changed();
    }
    return;
  }
  if (c.stage === 'open') {
    if (c.lockedTeams.includes(p.teamId)) return;
    if ((penalties.get(p.clientId) || 0) > now) { send(conn, { t: 'penalty', ms: penalties.get(p.clientId) - now }); return; }
    clearTimeout(buzzTimer);
    c.stage = 'buzzed';
    c.winner = { clientId: p.clientId, name: p.name, teamId: p.teamId, ms: now - c.openedAt };
    addLog(`🔔 ${p.name} (${team(p.teamId).name}) — ${now - c.openedAt} ms`);
    broadcast({ t: 'sfx', kind: 'buzz' });
    sfx('buzz');
    changed();
    return;
  }
  if (c.stage === 'buzzed' && c.winner && c.winner.clientId !== p.clientId && !c.lockedTeams.includes(p.teamId)) {
    addLog(`…${p.name} (${team(p.teamId).name}) +${now - c.openedAt - c.winner.ms} ms late`);
    changed();
  }
}

function judge(correct) {
  const c = S.clue;
  if (!c) return;
  const q = clueData();
  if (c.dd) {
    if (c.stage !== 'ddclue') return;
    const t = team(c.ddTeam);
    if (t) t.score += correct ? c.wager : -c.wager;
    if (correct && t) S.control = t.id;
    c.result = { teamId: c.ddTeam, correct, amount: c.wager };
    addLog(`${t?.name} ${correct ? 'correct' : 'wrong'} (${correct ? '+' : '−'}${formatScore(c.wager)})`);
    revealAnswer(true);
    broadcast({ t: 'sfx', kind: correct ? 'right' : 'wrong' });
    sfx(correct ? 'right' : 'wrong');
    return;
  }
  if (c.stage !== 'buzzed' || !c.winner) return;
  const t = team(c.winner.teamId);
  if (t) t.score += correct ? q.value : -q.value;
  addLog(`${c.winner.name} ${correct ? 'correct' : 'wrong'} (${correct ? '+' : '−'}${formatScore(q.value)})`);
  broadcast({ t: 'sfx', kind: correct ? 'right' : 'wrong' });
  sfx(correct ? 'right' : 'wrong');
  if (correct) {
    S.control = c.winner.teamId;
    c.result = { teamId: c.winner.teamId, correct: true, amount: q.value };
    revealAnswer(true);
  } else {
    c.lockedTeams.push(c.winner.teamId);
    c.winner = null;
    const remaining = S.teams.filter((tm) => !c.lockedTeams.includes(tm.id));
    if (!remaining.length) { c.stage = 'timeout'; addLog('All teams locked out'); changed(); }
    else { c.stage = 'reading'; openBuzzers(true); addLog('Buzzers re-opened for other teams'); }
  }
}

function revealAnswer(fromJudge) {
  const c = S.clue;
  if (!c) return;
  clearTimeout(buzzTimer);
  c.stage = 'answer';
  S.used[clueKey(c.r, c.c, c.row)] = true;
  if (!fromJudge) addLog('Answer revealed');
  changed();
}

function backToBoard() {
  if (!S.clue) return;
  S.used[clueKey(S.clue.r, S.clue.c, S.clue.row)] = true;
  clearTimeout(buzzTimer);
  S.clue = null;
  S.phase = 'board';
  broadcast({ t: 'mediaCmd', cmd: 'stop' });
  mediaStage?.clear();
  changed();
}

function cancelClue() {
  // Close without marking it used (picked by mistake).
  clearTimeout(buzzTimer);
  S.clue = null;
  S.phase = 'board';
  broadcast({ t: 'mediaCmd', cmd: 'stop' });
  mediaStage?.clear();
  changed();
}

function setRound(i) {
  if (i < 0 || i >= S.board.rounds.length) return;
  if (S.clue) cancelClue();
  S.roundIndex = i;
  if (S.phase === 'over') S.phase = 'board';
  changed();
}

function endGame() {
  if (!confirm('End the game and show final scores?')) return;
  if (S.clue) cancelClue();
  S.phase = 'over';
  changed();
}

// ---------- Team management ----------
function renameTeam(t) {
  const n = prompt('Team name:', t.name);
  if (n && n.trim()) { t.name = n.trim().slice(0, 24); changed(); }
}
function editScore(t) {
  const v = prompt(`Set score for ${t.name} (or +200 / -400 to adjust):`, t.score);
  if (v == null) return;
  const s = v.trim();
  if (/^[+-]/.test(s)) t.score += Number(s) || 0;
  else if (s !== '' && !isNaN(Number(s))) t.score = Number(s);
  changed();
}
function addTeam() {
  if (S.teams.length >= MAX_TEAMS) { toast(`Maximum ${MAX_TEAMS} teams`); return; }
  const color = TEAM_COLORS.find((c) => !S.teams.some((t) => t.color === c)) || TEAM_COLORS[0];
  S.teams.push({ id: uid(), name: `Team ${S.teams.length + 1}`, color, score: 0 });
  changed();
}
function removeTeam(t) {
  if (!confirm(`Remove ${t.name}? Its players become unassigned.`)) return;
  S.teams = S.teams.filter((x) => x !== t);
  Object.values(S.players).forEach((p) => { if (p.teamId === t.id) p.teamId = null; });
  if (S.control === t.id) S.control = null;
  changed();
}
function movePlayer(clientId, teamId) {
  const p = S.players[clientId];
  if (!p) return;
  p.teamId = teamId;
  changed();
}
function kick(clientId) {
  const p = S.players[clientId];
  if (!p || !confirm(`Remove ${p.name} from the game?`)) return;
  const conn = conns.get(clientId);
  if (conn) { send(conn, { t: 'kicked' }); setTimeout(() => { try { conn.close(); } catch {} }, 300); conns.delete(clientId); }
  delete S.players[clientId];
  changed();
}

// ======================================================================
// Host UI
// ======================================================================
function enterGame() {
  $('#setup').hidden = true;
  $('#game').hidden = false;
  history.replaceState(null, '', location.pathname);
  $('#gCode').textContent = S.code;
  $('#gTitle').textContent = S.board.title;
  $('#copyLink').onclick = () => copyText(joinUrl(S.code));
  $('#openDisplay').onclick = () => window.open(`${siteBase()}display.html?room=${S.code}`, 'buzzboard-display', 'width=1280,height=760');
  $('#prevRound').onclick = () => setRound(S.roundIndex - 1);
  $('#nextRound').onclick = () => setRound(S.roundIndex + 1);
  $('#endGame').onclick = endGame;
  $('#addTeam').onclick = addTeam;
  renderLiveSettings();
  document.addEventListener('keydown', onKey);
  setInterval(tickCountdown, 200);
  window.addEventListener('beforeunload', (e) => { if (S.phase !== 'over') { saveSession(); e.preventDefault(); } });
  changed();
}

let mainSig = '';
function renderGame() {
  if ($('#game').hidden) return;
  $('#roundLabel').textContent = `${round().name} (${S.roundIndex + 1}/${S.board.rounds.length})`;
  $('#prevRound').disabled = S.roundIndex === 0;
  $('#nextRound').disabled = S.roundIndex >= S.board.rounds.length - 1;
  renderTeams();
  renderLog();
  // Only rebuild the main area when it actually changes (keeps inputs/media stable).
  const sig = JSON.stringify([S.phase, S.roundIndex, S.used, S.clue && { ...S.clue, buzzes: 0, token: 0 }, S.teams.map((t) => [t.id, t.name, t.score]), S.control,
    S.phase === 'lobby' ? Object.values(S.players).length + ':' + conns.size : 0]);
  if (sig !== mainSig) { mainSig = sig; renderMain(); }
}

function renderMain() {
  const main = $('#main');
  if (S.phase === 'lobby') return renderLobby(main);
  if (S.phase === 'over') return renderFinal(main);
  if (S.phase === 'clue' && S.clue) return renderClue(main);
  mediaStage?.clear();
  const rd = round();
  const rows = Math.max(...rd.categories.map((c) => c.clues.length));
  const allUsed = rd.categories.every((cat, ci) => cat.clues.every((_, ri) => S.used[clueKey(S.roundIndex, ci, ri)]));
  main.replaceChildren(
    h('div', { class: 'stack' },
      allUsed ? h('div', { class: 'card row' }, h('b', {}, 'Round complete!'), h('span', { class: 'spacer' }),
        S.roundIndex < S.board.rounds.length - 1
          ? h('button', { class: 'primary', onclick: () => setRound(S.roundIndex + 1) }, `Start ${S.board.rounds[S.roundIndex + 1].name} ▶`)
          : h('button', { class: 'primary', onclick: endGame }, 'Show final scores')) : null,
      h('div', { class: 'board', style: { '--cols': rd.categories.length } },
        rd.categories.map((c) => h('div', { class: 'cat' }, c.name)),
        Array.from({ length: rows }, (_, ri) => rd.categories.map((cat, ci) => {
          const q = cat.clues[ri];
          if (!q) return h('div', { class: 'cell used' });
          const used = !!S.used[clueKey(S.roundIndex, ci, ri)];
          return h('button', { class: 'cell' + (used ? ' used' : ''), disabled: used, title: q.clue, onclick: () => pickClue(ci, ri) },
            '$' + q.value, q.dd && !used ? h('span', { class: 'dd-mark' }, 'DD') : null);
        })),
      ),
      h('p', { class: 'muted small' }, 'Pick a clue. Only you see the "DD" marks. Used clues can be re-opened from the board after a mistake by switching rounds — or just adjust scores manually.'),
    ),
  );
}

function renderLobby(main) {
  const url = joinUrl(S.code);
  const qr = h('div', { class: 'qr' });
  const total = Object.keys(S.players).length;
  main.replaceChildren(h('div', { class: 'card stack', style: { textAlign: 'center' } },
    h('h2', {}, 'Waiting for players'),
    h('p', {}, 'Players open ', h('a', { href: url, target: '_blank' }, url), ' (or scan the code) and enter room code'),
    h('div', { class: 'code-badge', style: { fontSize: '3rem', display: 'inline-block' } }, S.code),
    h('div', {}, qr),
    h('p', { class: 'muted' }, `${total} player(s) joined. Arrange teams on the right, then start.`),
    h('div', {}, h('button', { class: 'primary', style: { fontSize: '1.2rem' }, onclick: startGame }, 'Start game ▶')),
    h('p', { class: 'muted small' }, 'Tip: click "Open display screen" and screen-share that window — it shows the board and clues without the answers.'),
  ));
  renderQR(qr, url, 180);
}

function renderFinal(main) {
  const sorted = S.teams.slice().sort((a, b) => b.score - a.score);
  main.replaceChildren(h('div', { class: 'card stack', style: { textAlign: 'center' } },
    h('h2', {}, '🏆 Final scores'),
    h('div', { class: 'final-list' }, sorted.map((t, i) => h('div', { class: 'final-row', style: { '--team': t.color } },
      h('b', {}, `${i + 1}.`), t.name, h('span', { class: 'pts' }, formatScore(t.score))))),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { onclick: () => { S.phase = 'board'; changed(); } }, 'Back to board'),
      h('button', { class: 'primary', onclick: async () => { await kvDel(SESSION_KEY); location.href = 'host.html'; } }, 'New game')),
  ));
}

function renderClue(main) {
  const c = S.clue;
  const q = clueData();
  const cat = S.board.rounds[c.r].categories[c.c];
  // One persistent media element, moved into each re-render so playback isn't interrupted.
  if (!mediaStage) mediaStage = new MediaStage(h('div', { class: 'media' }));
  const mediaEl = mediaStage.el;
  const controls = h('div', { class: 'controls' });
  const status = h('div', { class: 'stack', style: { textAlign: 'center' } });

  if (c.stage === 'wager') {
    const sel = h('select', { style: { width: 'auto' } }, S.teams.map((t) => h('option', { value: t.id, selected: t.id === c.ddTeam }, t.name)));
    const maxFor = () => Math.max(team(sel.value)?.score || 0, Math.max(...round().categories.flatMap((x) => x.clues.map((y) => y.value))));
    const wager = h('input', { type: 'number', min: 0, step: 100, style: { width: '9em' }, placeholder: 'Wager' });
    const hint = h('span', { class: 'muted small' });
    const upd = () => (hint.textContent = `max ${formatScore(maxFor())}`);
    sel.onchange = upd; upd();
    status.append(h('div', { class: 'dd-banner' }, 'DAILY DOUBLE'));
    controls.append(
      h('div', { class: 'row', style: { justifyContent: 'center' } }, 'Team', sel, 'wagers', wager, hint),
      h('button', { class: 'primary', onclick: () => {
        const w = Number(wager.value);
        if (!(w >= 0) || wager.value === '') { toast('Enter a wager'); return; }
        if (w > maxFor() && !confirm(`That's more than the usual max (${formatScore(maxFor())}). Use it anyway?`)) return;
        setWager(sel.value, w);
      } }, 'Show clue'),
      h('button', { class: 'ghost', onclick: cancelClue }, 'Cancel'),
    );
    setTimeout(() => wager.focus(), 30);
  } else {
    if (c.dd) status.append(h('div', { class: 'muted' }, `Daily Double · ${team(c.ddTeam)?.name} wagered ${formatScore(c.wager)}`));
    if (c.stage === 'reading') {
      status.append(h('div', { class: 'muted' }, c.lockedTeams.length ? 'Buzzers closed.' : 'Read the clue, then open the buzzers.'));
      controls.append(
        h('button', { class: 'primary', onclick: () => openBuzzers() }, 'Open buzzers', h('kbd', {}, 'Space')),
        h('button', { onclick: () => revealAnswer() }, 'Reveal answer', h('kbd', {}, 'A')),
        h('button', { class: 'ghost', onclick: cancelClue, title: 'Close without using up this clue' }, 'Cancel clue'),
      );
    } else if (c.stage === 'open') {
      status.append(h('div', { class: 'countdown', id: 'countdown' }, 'Buzzers open'));
      controls.append(
        h('button', { onclick: closeBuzzers }, 'Close buzzers'),
        h('button', { onclick: () => revealAnswer() }, 'Reveal answer', h('kbd', {}, 'A')),
      );
    } else if (c.stage === 'buzzed') {
      const t = team(c.winner.teamId);
      status.append(h('div', { class: 'buzz-banner', style: { background: t?.color } }, `${c.winner.name} · ${t?.name}`),
        h('div', { class: 'muted small' }, `${c.winner.ms} ms after buzzers opened`));
      controls.append(
        h('button', { class: 'good', onclick: () => judge(true) }, `✓ Correct +${formatScore(q.value)}`, h('kbd', {}, 'C')),
        h('button', { class: 'bad', onclick: () => judge(false) }, `✗ Wrong −${formatScore(q.value)}`, h('kbd', {}, 'X')),
      );
    } else if (c.stage === 'ddclue') {
      const t = team(c.ddTeam);
      status.append(h('div', { class: 'buzz-banner', style: { background: t?.color } }, `${t?.name} answers`));
      controls.append(
        h('button', { class: 'good', onclick: () => judge(true) }, `✓ Correct +${formatScore(c.wager)}`, h('kbd', {}, 'C')),
        h('button', { class: 'bad', onclick: () => judge(false) }, `✗ Wrong −${formatScore(c.wager)}`, h('kbd', {}, 'X')),
      );
    } else if (c.stage === 'timeout') {
      status.append(h('div', { class: 'muted' }, c.lockedTeams.length >= S.teams.length ? 'Every team is locked out.' : 'No one buzzed in time.'));
      controls.append(
        h('button', { class: 'primary', onclick: () => revealAnswer() }, 'Reveal answer', h('kbd', {}, 'A')),
        c.lockedTeams.length < S.teams.length ? h('button', { onclick: () => openBuzzers() }, 'Re-open buzzers', h('kbd', {}, 'Space')) : null,
      );
    } else if (c.stage === 'answer') {
      if (c.result) {
        const t = team(c.result.teamId);
        status.append(h('div', { class: 'muted' }, `${t?.name} ${c.result.correct ? 'got it' : 'missed'} (${c.result.correct ? '+' : '−'}${formatScore(c.result.amount)})`));
      }
      controls.append(h('button', { class: 'primary', onclick: backToBoard }, 'Back to board', h('kbd', {}, 'Enter')));
    }
    if (c.lockedTeams.length && c.stage !== 'answer') status.append(h('div', { class: 'muted small' }, 'Locked out: ' + c.lockedTeams.map((id) => team(id)?.name).join(', ')));
  }

  const hasMedia = q.media.length && c.stage !== 'wager';
  main.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'clue-view', style: { minHeight: '40vh' } },
      h('div', { class: 'clue-meta' }, `${cat.name} · ${formatScore(c.dd && c.wager != null ? c.wager : q.value)}`),
      c.stage === 'wager' ? null : h('div', { class: 'clue-text' }, q.clue || '(no clue text)'),
      mediaEl,
      c.stage === 'answer' ? h('div', { class: 'answer-text' }, q.answer || '(no answer set)') : null,
    ),
    c.stage !== 'answer' ? h('div', { class: 'host-answer' }, 'Answer (only you see this): ', h('b', {}, q.answer || '(none)')) : null,
    status,
    controls,
    hasMedia ? h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'sm', onclick: () => { broadcast({ t: 'mediaCmd', cmd: 'play' }); mediaStage?.play(); } }, '▶ Replay media for everyone'),
      h('button', { class: 'sm', onclick: () => { broadcast({ t: 'mediaCmd', cmd: 'stop' }); mediaStage?.stop(); } }, '■ Stop media'),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!mediaStage?.muted, onchange: (e) => mediaStage?.setMuted(e.target.checked) }), 'Mute on this screen'),
    ) : null,
  ));

  const items = c.stage === 'wager' ? [] : q.media.map((m) => ({ kind: m.kind, src: isDataUrl(m.src) ? m.src : new URL(m.src, siteBase()).href }));
  mediaStage.show(clueKey(c.r, c.c, c.row), items);
  tickCountdown();
}

function tickCountdown() {
  const el = $('#countdown');
  if (!el || !S?.clue || S.clue.stage !== 'open') return;
  el.textContent = S.clue.deadline ? `Buzzers open · ${Math.max(0, (S.clue.deadline - Date.now()) / 1000).toFixed(1)}s` : 'Buzzers open';
}

function renderTeams() {
  const wrap = $('#teams');
  const c = S.clue;
  const chip = (p) => h('span', {
    class: 'chip' + (conns.has(p.clientId) ? '' : ' off'), draggable: true, title: conns.has(p.clientId) ? 'Online' : 'Offline',
    ondragstart: (e) => e.dataTransfer.setData('text/plain', p.clientId),
  }, p.name,
  h('select', { class: 'mv', style: { width: 'auto', padding: '0 .2em', fontSize: '.85em', background: 'transparent', border: 0 }, title: 'Move to team',
    onchange: (e) => movePlayer(p.clientId, e.target.value || null) },
  h('option', { value: '', selected: !team(p.teamId) }, '—'),
  S.teams.map((t) => h('option', { value: t.id, selected: t.id === p.teamId }, '→ ' + t.name))),
  h('span', { class: 'x', title: 'Remove player', onclick: () => kick(p.clientId) }, '✕'));
  const dropZone = (el, teamId) => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); movePlayer(e.dataTransfer.getData('text/plain'), teamId); });
    return el;
  };
  const players = Object.values(S.players);
  wrap.replaceChildren(...S.teams.map((t) => {
    const locked = c?.lockedTeams?.includes(t.id);
    const buzzed = c?.winner?.teamId === t.id;
    return dropZone(h('div', { class: 'team-box', style: { '--team': t.color, opacity: locked ? 0.55 : 1, boxShadow: buzzed ? `0 0 0 2px ${t.color}` : '' } },
      h('div', { class: 'team-head' },
        h('button', { class: 'ghost icon sm', title: 'Give this team control of the board', style: { color: S.control === t.id ? 'var(--gold)' : 'var(--muted)', border: 0 }, onclick: () => { S.control = t.id; changed(); } }, '★'),
        h('span', { class: 'nm', title: 'Rename', onclick: () => renameTeam(t) }, t.name),
        h('span', { class: 'pts' + (t.score < 0 ? ' neg' : ''), title: 'Edit score', onclick: () => editScore(t) }, formatScore(t.score)),
        h('button', { class: 'ghost icon sm', title: 'Remove team', style: { border: 0 }, onclick: () => removeTeam(t) }, '🗑'),
      ),
      h('div', { class: 'chips' }, players.filter((p) => p.teamId === t.id).map(chip)),
    ), t.id);
  }));
  const un = players.filter((p) => !team(p.teamId));
  $('#unassignedWrap').replaceChildren(un.length ? dropZone(h('div', { class: 'team-box', style: { '--team': '#888' } },
    h('div', { class: 'team-head' }, h('span', { class: 'nm' }, `Not on a team (${un.length})`)),
    h('div', { class: 'chips' }, un.map(chip))), null) : '');
}

function renderLog() {
  const el = $('#log');
  if (!S.log.length) { el.innerHTML = '<span class="muted small">Buzzes for the current clue appear here.</span>'; return; }
  el.replaceChildren(...S.log.map((l) => h('div', {}, l.text)));
}

function renderLiveSettings() {
  const st = S.settings;
  $('#liveSettings').replaceChildren(
    h('label', {}, 'Team assignment', h('select', { onchange: (e) => { st.assignMode = e.target.value; changed(); } },
      [['choose', 'Players pick their team'], ['auto', 'Auto-balance new players'], ['host', 'Host assigns players']].map(([v, l]) => h('option', { value: v, selected: st.assignMode === v }, l)))),
    h('label', {}, 'Early-buzz lockout (ms)', h('input', { type: 'number', min: 0, step: 50, value: st.penaltyMs, onchange: (e) => { st.penaltyMs = Math.max(0, Number(e.target.value) || 0); changed(); } })),
    h('label', {}, 'Seconds to buzz (0 = no limit)', h('input', { type: 'number', min: 0, value: st.buzzSeconds, onchange: (e) => { st.buzzSeconds = Math.max(0, Number(e.target.value) || 0); changed(); } })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.autoOpen, onchange: (e) => { st.autoOpen = e.target.checked; changed(); } }), 'Auto-open buzzers when a clue appears'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.playerAudio, onchange: (e) => { st.playerAudio = e.target.checked; changed(); } }), 'Clue sound on players\' devices'),
  );
}

function onKey(e) {
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const c = S.clue;
  if (!c) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && ['reading', 'timeout'].includes(c.stage)) { e.preventDefault(); openBuzzers(); }
  else if (k === 'c') judge(true);
  else if (k === 'x') judge(false);
  else if (k === 'a' && !['answer', 'wager'].includes(c.stage)) revealAnswer();
  else if ((k === 'enter' || k === 'escape') && c.stage === 'answer') { e.preventDefault(); backToBoard(); }
}

initSetup().catch((e) => { console.error(e); $('#setupStatus').textContent = 'Error: ' + e.message; });
