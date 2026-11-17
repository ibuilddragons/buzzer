// IndexedDB storage for boards (they can hold large media) and host session state.

const DB_NAME = 'buzzboard';
const DB_VERSION = 1;
let dbp;

function db() {
  dbp = dbp || new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage aborted (out of space?)'));
  });
}

export const listBoards = async () => {
  const all = (await tx('boards', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};
export const getBoard = (id) => tx('boards', 'readonly', (s) => s.get(id));
export const putBoard = (board) => tx('boards', 'readwrite', (s) => s.put({ ...board, updatedAt: Date.now() }));
export const deleteBoard = (id) => tx('boards', 'readwrite', (s) => s.delete(id));

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, val) => tx('kv', 'readwrite', (s) => s.put(val, key));
export const kvDel = (key) => tx('kv', 'readwrite', (s) => s.delete(key));

/** Boards committed to the repo, listed in boards/index.json. */
export async function listBundledBoards() {
  try {
    const res = await fetch('boards/index.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : list.boards || [];
  } catch { return []; }
}
export async function fetchBundledBoard(file) {
  const res = await fetch('boards/' + file, { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load boards/' + file);
  return res.json();
}
