// IndexedDB: saved sessions and their narration clips (MP3 blobs).
import { app } from './app.js?v=3.0-152b544c';

const NAME = 'sauna-conductor';
const VERSION = 2;
const OPEN_TIMEOUT_MS = 5000;
export const BLOCKED_MSG = 'Sauna Conductor is also open in another Chrome tab (perhaps an older version), and that tab is holding on to the saved sessions. Close the other Sauna Conductor tabs, then reload this one.';

let dbp = null;
let conn = null;
let disabled = false;

function open() {
  if (disabled) return Promise.reject(new Error('This tab is paused because Sauna Conductor is open in another tab.'));
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let settled = false;
    const r = indexedDB.open(NAME, VERSION);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; dbp = null;
      app.emit('storage-blocked');
      rej(new Error(BLOCKED_MSG));
    }, OPEN_TIMEOUT_MS);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('clips2')) db.createObjectStore('clips2');
    };
    r.onsuccess = () => {
      const db = r.result;
      // If a newer version opens in another tab, step aside so it can upgrade.
      db.onversionchange = () => { db.close(); conn = null; dbp = null; };
      conn = db;
      clearTimeout(timer);
      if (settled) { dbp = Promise.resolve(db); app.emit('storage-ok'); return; }
      settled = true; res(db);
    };
    r.onerror = () => { clearTimeout(timer); if (settled) return; settled = true; dbp = null; rej(r.error || new Error('Could not open the saved sessions.')); };
    r.onblocked = () => app.emit('storage-blocked');
  });
  return dbp;
}

// Close the connection and refuse further use (when another tab takes over).
export function shutdown() {
  disabled = true;
  try { if (conn) conn.close(); } catch { /* ignore */ }
  conn = null; dbp = null;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(storeName, mode);
    const st = t.objectStore(storeName);
    const out = fn(st);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Saving failed (is the disk full?)'));
  });
}

// Every change is announced ('local-change') so cloud sync can upload it; sync itself writes with { quiet: true }.
const changed = (o, sid, deleted = false) => (r) => { if (!(o && o.quiet)) app.emit('local-change', { sid, deleted }); return r; };

export const sessions = {
  all: () => tx('sessions', 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))),
  get: (id) => tx('sessions', 'readonly', (s) => s.get(id)),
  put: (sess, o) => tx('sessions', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(sess)))).then(changed(o, sess.id)),
  del: (id, o) => tx('sessions', 'readwrite', (s) => s.delete(id)).then(changed(o, id, true)),
};

const key = (sid, cue) => `${sid}:${cue}`;

export const clips = {
  // rec = { blob, key, chars, at, source: 'generated'|'uploaded' }
  get: (sid, cue) => tx('clips2', 'readonly', (s) => s.get(key(sid, cue))),
  put: (sid, cue, rec, o) => tx('clips2', 'readwrite', (s) => s.put(rec, key(sid, cue))).then(changed(o, sid)),
  del: (sid, cue, o) => tx('clips2', 'readwrite', (s) => s.delete(key(sid, cue))).then(changed(o, sid)),
  async forSession(sid) {
    const db = await open();
    return new Promise((res, rej) => {
      const out = {};
      const t = db.transaction('clips2', 'readonly');
      const range = IDBKeyRange.bound(sid + ':', sid + ':￿');
      const req = t.objectStore('clips2').openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out[String(c.key).slice(sid.length + 1)] = c.value; c.continue(); }
      };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  },
  async delSession(sid) {
    return tx('clips2', 'readwrite', (s) => s.delete(IDBKeyRange.bound(sid + ':', sid + ':￿')));
  },   // always followed by sessions.del, which announces the change
};
