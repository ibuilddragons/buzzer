import { $, h, toast, newBoard, makeRound, normalizeBoard, downloadJSON, slug, readFileAsDataURL, guessKind, isDataUrl, uid, siteBase } from './common.js';
import { listBoards, getBoard, putBoard, deleteBoard, listBundledBoards, fetchBundledBoard } from './store.js';

let board = null;      // board being edited
let roundIdx = 0;
let saveTimer = null;
let saveState = 'saved';

const editor = $('#editor');

// ---------- Board list ----------
async function refreshList() {
  const boards = await listBoards();
  const list = $('#boardList');
  list.innerHTML = '';
  if (!boards.length) list.append(h('p', { class: 'muted small' }, 'No boards yet.'));
  for (const b of boards) {
    list.append(h('button', {
      class: 'board-item' + (board && b.id === board.id ? ' active' : ''),
      onclick: () => openBoard(b.id),
    }, b.title, h('span', { class: 'sub' }, `${b.rounds.length} round(s) · ${new Date(b.updatedAt).toLocaleDateString()}`)));
  }
}

async function refreshBundled() {
  const items = await listBundledBoards();
  $('#bundledWrap').hidden = !items.length;
  const list = $('#bundledList');
  list.innerHTML = '';
  for (const it of items) {
    list.append(h('button', {
      class: 'board-item',
      onclick: async () => {
        try {
          const b = normalizeBoard(await fetchBundledBoard(it.file));
          b.id = uid();
          b.title = b.title + ' (copy)';
          await putBoard(b);
          await openBoard(b.id);
          toast('Copied to My boards');
        } catch (e) { toast(e.message); }
      },
    }, it.title || it.file, h('span', { class: 'sub' }, 'Copy to my boards')));
  }
}

async function openBoard(id) {
  await flushSave();
  board = await getBoard(id);
  roundIdx = 0;
  history.replaceState(null, '', '?board=' + encodeURIComponent(id));
  render();
  refreshList();
}

// ---------- Saving ----------
function markDirty() {
  saveState = 'unsaved';
  updateSaveLabel();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!board || saveState !== 'unsaved') return;
  saveState = 'saving'; updateSaveLabel();
  try {
    await putBoard(board);
    saveState = 'saved';
    refreshList();
  } catch (e) {
    saveState = 'error';
    toast('Could not save: ' + e.message, 5000);
  }
  updateSaveLabel();
}
function updateSaveLabel() {
  const el = $('#saveLabel');
  if (!el) return;
  el.textContent = { saved: '✓ Saved', unsaved: 'Unsaved…', saving: 'Saving…', error: '⚠ Save failed' }[saveState];
  el.style.color = saveState === 'error' ? 'var(--bad)' : 'var(--muted)';
}
window.addEventListener('beforeunload', (e) => { if (saveState === 'unsaved' || saveState === 'saving') { flushSave(); e.preventDefault(); } });

// ---------- Editor render ----------
function render() {
  editor.innerHTML = '';
  if (!board) { editor.append(h('div', { class: 'card muted' }, 'Create a new board or pick one from the list.')); return; }
  const round = board.rounds[roundIdx];
  const cols = round.categories.length;
  const rows = Math.max(0, ...round.categories.map((c) => c.clues.length));

  const sizeBytes = new Blob([JSON.stringify(board)]).size;

  editor.append(
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('input', { value: board.title, style: { fontSize: '1.3rem', fontWeight: 700, flex: '1', minWidth: '200px' }, 'aria-label': 'Board title',
          oninput: (e) => { board.title = e.target.value; markDirty(); } }),
        h('span', { class: 'save-state', id: 'saveLabel' }),
      ),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: 'host.html?board=' + encodeURIComponent(board.id), onclick: () => flushSave() }, '▶ Host with this board'),
        h('button', { onclick: () => downloadJSON(board, slug(board.title) + '.json') }, 'Export JSON'),
        h('button', { onclick: duplicateBoard }, 'Duplicate'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'bad', onclick: removeBoard }, 'Delete board'),
      ),
      h('p', { class: 'muted small', style: { margin: 0 } }, `Board size: ${(sizeBytes / 1048576).toFixed(1)} MB` + (sizeBytes > 15e6 ? ' — large! Players may wait for media to arrive; consider moving big files to the repo media/ folder.' : '')),
    ),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('div', { class: 'tabs' }, board.rounds.map((r, i) =>
          h('button', { class: i === roundIdx ? 'active sm' : 'sm', onclick: () => { roundIdx = i; render(); } }, r.name || `Round ${i + 1}`))),
        h('button', { class: 'sm', onclick: addRound }, '+ Round'),
      ),
      h('div', { class: 'row' },
        h('label', { style: { flex: '1', minWidth: '180px' } }, 'Round name',
          h('input', { value: round.name, oninput: (e) => { round.name = e.target.value; markDirty(); } })),
        h('div', { class: 'row', style: { alignSelf: 'end' } },
          h('span', { class: 'muted small' }, `${cols} categories`),
          h('button', { class: 'sm', onclick: () => resizeCols(-1), disabled: cols <= 1 }, '−'),
          h('button', { class: 'sm', onclick: () => resizeCols(1), disabled: cols >= 8 }, '+'),
          h('span', { class: 'muted small' }, `${rows} rows`),
          h('button', { class: 'sm', onclick: () => resizeRows(-1), disabled: rows <= 1 }, '−'),
          h('button', { class: 'sm', onclick: () => resizeRows(1), disabled: rows >= 8 }, '+'),
          h('button', { class: 'sm', onclick: setValues, title: 'Set all values in this round' }, 'Values…'),
          h('button', { class: 'sm bad', onclick: removeRound, disabled: board.rounds.length <= 1 }, 'Delete round'),
        ),
      ),
      h('div', { class: 'board ed-board', style: { '--cols': cols } },
        round.categories.map((cat) => h('div', { class: 'cat' },
          h('textarea', { value: cat.name, rows: 2, placeholder: 'Category', 'aria-label': 'Category name',
            oninput: (e) => { cat.name = e.target.value; markDirty(); } }))),
        Array.from({ length: rows }, (_, r) => round.categories.map((cat, c) => {
          const q = cat.clues[r];
          if (!q) return h('div', { class: 'cell used' });
          const icons = (q.dd ? '★DD ' : '') + q.media.map((m) => ({ image: '🖼', audio: '🔊', video: '🎬' }[m.kind] || '📎')).join('');
          return h('button', { class: 'cell' + (q.clue ? '' : ' empty'), onclick: () => editClue(c, r) },
            '$' + q.value,
            h('span', { class: 'snip' }, q.clue || '(empty)'),
            icons ? h('span', { class: 'icons' }, icons) : null);
        })),
      ),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Click a cell to edit its clue, answer, and media. Changes save automatically.'),
    ),
  );
  updateSaveLabel();
}

function resizeCols(d) {
  const round = board.rounds[roundIdx];
  if (d > 0) {
    const rows = Math.max(1, ...round.categories.map((c) => c.clues.length));
    const tmpl = round.categories[0]?.clues.map((q) => q.value) || [];
    round.categories.push({ name: `Category ${round.categories.length + 1}`, clues: Array.from({ length: rows }, (_, r) => ({ value: tmpl[r] ?? (r + 1) * 200, clue: '', answer: '', dd: false, media: [] })) });
  } else {
    const last = round.categories[round.categories.length - 1];
    if (last.clues.some((q) => q.clue || q.media.length) && !confirm(`Delete category "${last.name}" and its clues?`)) return;
    round.categories.pop();
  }
  markDirty(); render();
}
function resizeRows(d) {
  const round = board.rounds[roundIdx];
  if (d < 0 && round.categories.some((c) => { const q = c.clues[c.clues.length - 1]; return q && (q.clue || q.media.length); })
      && !confirm('Delete the bottom row of clues?')) return;
  for (const c of round.categories) {
    if (d > 0) {
      const prev = c.clues[c.clues.length - 1];
      const step = c.clues.length >= 2 ? c.clues[1].value - c.clues[0].value : (prev?.value || 200);
      c.clues.push({ value: (prev?.value || 0) + step, clue: '', answer: '', dd: false, media: [] });
    } else c.clues.pop();
  }
  markDirty(); render();
}
function setValues() {
  const round = board.rounds[roundIdx];
  const base = Number(prompt('Value of the first row (each row adds this much again):', round.categories[0]?.clues[0]?.value || 200));
  if (!base) return;
  for (const c of round.categories) c.clues.forEach((q, r) => (q.value = base * (r + 1)));
  markDirty(); render();
}
function addRound() {
  const prev = board.rounds[board.rounds.length - 1];
  const cols = prev?.categories.length || 6;
  const rows = prev?.categories[0]?.clues.length || 5;
  const base = (prev?.categories[0]?.clues[0]?.value || 200) * 2;
  board.rounds.push(makeRound(board.rounds.length === 1 ? 'Double Round' : `Round ${board.rounds.length + 1}`, cols, rows, base));
  roundIdx = board.rounds.length - 1;
  markDirty(); render();
}
function removeRound() {
  if (!confirm(`Delete round "${board.rounds[roundIdx].name}"?`)) return;
  board.rounds.splice(roundIdx, 1);
  roundIdx = Math.max(0, roundIdx - 1);
  markDirty(); render();
}
async function duplicateBoard() {
  await flushSave();
  const copy = structuredClone(board);
  copy.id = uid();
  copy.title = board.title + ' (copy)';
  await putBoard(copy);
  await openBoard(copy.id);
}
async function removeBoard() {
  if (!confirm(`Delete "${board.title}" from this browser? Export it first if you want a backup.`)) return;
  clearTimeout(saveTimer); saveState = 'saved';
  await deleteBoard(board.id);
  board = null;
  history.replaceState(null, '', location.pathname);
  render(); refreshList();
}

// ---------- Clue dialog ----------
const dlg = $('#clueDlg');
const form = $('#clueForm');
let editing = null; // {c, r, media}

function editClue(c, r) {
  const round = board.rounds[roundIdx];
  const q = round.categories[c].clues[r];
  editing = { c, r, media: structuredClone(q.media) };
  $('#clueTitle').textContent = `${round.categories[c].name || 'Category'} · $${q.value}`;
  form.value.value = q.value;
  form.dd.checked = q.dd;
  form.clue.value = q.clue;
  form.answer.value = q.answer;
  $('#mediaUrl').value = '';
  renderMediaList();
  dlg.showModal();
  setTimeout(() => form.clue.focus(), 50);
}

function renderMediaList() {
  const list = $('#mediaList');
  list.innerHTML = '';
  if (!editing.media.length) list.append(h('p', { class: 'muted small', style: { margin: 0 } }, 'No media.'));
  editing.media.forEach((m, i) => {
    const src = isDataUrl(m.src) ? m.src : new URL(m.src, siteBase()).href;
    let pv;
    if (m.kind === 'image') pv = h('img', { src });
    else if (m.kind === 'video') pv = h('video', { src, muted: true, preload: 'metadata' });
    else pv = h('span', {}, '🔊');
    const sizeKB = isDataUrl(m.src) ? Math.round(m.src.length * 0.75 / 1024) : null;
    list.append(h('div', { class: 'media-item' },
      h('div', { class: 'pv' }, pv),
      h('div', { class: 'info' },
        h('select', { onchange: (e) => { m.kind = e.target.value; renderMediaList(); }, style: { width: 'auto', padding: '.2em .4em' } },
          ['image', 'audio', 'video'].map((k) => h('option', { value: k, selected: m.kind === k }, k))),
        ' ', isDataUrl(m.src) ? `uploaded file · ${sizeKB} KB` : m.src,
        m.kind !== 'image' ? h('div', {}, h(m.kind, { src, controls: true, preload: 'none', style: { maxHeight: '60px', width: '100%' } })) : null,
      ),
      h('button', { type: 'button', class: 'sm', title: 'Move up', disabled: i === 0, onclick: () => { editing.media.splice(i - 1, 0, editing.media.splice(i, 1)[0]); renderMediaList(); } }, '↑'),
      h('button', { type: 'button', class: 'sm bad', onclick: () => { editing.media.splice(i, 1); renderMediaList(); } }, 'Remove'),
    ));
  });
}

$('#addFileBtn').onclick = () => $('#mediaFile').click();
$('#mediaFile').onchange = async (e) => {
  for (const file of e.target.files) {
    if (file.size > 12 * 1048576 && !confirm(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB. Large files are slow to send to players. Add it anyway?`)) continue;
    const kind = guessKind(file.name, file.type) || 'image';
    editing.media.push({ kind, src: await readFileAsDataURL(file) });
  }
  e.target.value = '';
  renderMediaList();
};
$('#addUrlBtn').onclick = () => {
  const url = $('#mediaUrl').value.trim();
  if (!url) return;
  editing.media.push({ kind: guessKind(url) || 'image', src: url });
  $('#mediaUrl').value = '';
  renderMediaList();
};

// Save on submit (fires synchronously; the dialog's close event can be delayed in background tabs).
form.addEventListener('submit', (e) => {
  if (editing) { // every submit means save; Cancel/✕ are plain buttons
    const q = board.rounds[roundIdx].categories[editing.c].clues[editing.r];
    q.value = Number(form.value.value) || 0;
    q.dd = form.dd.checked;
    q.clue = form.clue.value.trim();
    q.answer = form.answer.value.trim();
    q.media = editing.media;
    markDirty(); render();
  }
  editing = null;
});

// ---------- New / import ----------
$('#newBtn').onclick = async () => {
  await flushSave();
  const b = newBoard('My Jeopardy board');
  await putBoard(b);
  await openBoard(b.id);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const b = normalizeBoard(JSON.parse(await file.text()));
    const existing = await getBoard(b.id);
    if (existing && !confirm(`"${existing.title}" already exists here. Replace it? (Cancel imports as a copy.)`)) b.id = uid();
    await putBoard(b);
    await openBoard(b.id);
    toast('Imported ' + b.title);
  } catch (err) { toast('Import failed: ' + err.message, 5000); }
};

// ---------- Init ----------
(async () => {
  await refreshList();
  refreshBundled();
  const id = new URLSearchParams(location.search).get('board');
  if (id && await getBoard(id)) openBoard(id);
})();
