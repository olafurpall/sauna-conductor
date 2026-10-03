// Cloud sync (Supabase): sign-in, a workspace shared with others, and syncing of
// sessions, recorded narration, run history, the ElevenLabs key and your Spotify login.
// The browser's own storage stays the working copy, so everything keeps working offline.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { app } from './app.js';
import { store, log, toast, sleep } from './util.js';
import * as db from './db.js';
import { eleven } from './eleven.js';

const Q = { quiet: true };            // local writes made by sync must not trigger another upload
const BUCKET = 'clips';

export const cloud = {
  configured: !!(SUPABASE_URL && SUPABASE_KEY),
  sb: null,
  user: null,
  ws: null,                           // current workspace row
  workspaces: [],
  members: [],
  invites: [],
  status: 'off',                      // off | starting | signed-out | syncing | synced | offline | error
  detail: '',
  lastSync: 0,
  isRunning: () => false,             // set by main.js: is a session running in this tab?
  get signedIn() { return !!this.user; },
  get email() { return this.user ? this.user.email || '' : ''; },
  get name() {
    const m = (this.user && this.user.user_metadata) || {};
    return m.full_name || m.name || this.email;
  },
};

function setStatus(status, detail = '') {
  cloud.status = status;
  cloud.detail = detail;
  app.emit('cloud');
}

const errText = (e) => (e && (e.message || e.error_description || e.msg)) || String(e);
const isOffline = (e) => !navigator.onLine || /fetch|network|load failed/i.test(errText(e));
function fail(e, where) {
  log('cloud-error', where, errText(e));
  if (isOffline(e)) setStatus('offline', 'Offline. Changes are kept here and sync when the connection is back.');
  else setStatus('error', errText(e));
}
function check(res) {
  if (res && res.error) throw res.error;
  return res ? res.data : null;
}

// ---------------------------------------------------------------- start-up and sign-in
async function loadLib() {
  if (window.__scSupabase) return window.__scSupabase;            // tests inject a fake
  if (window.supabase && window.supabase.createClient) return window.supabase;
  const u = new URL('./vendor/supabase.js', import.meta.url);
  u.search = new URL(import.meta.url).search;                     // same cache-busting version as this file
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = u.href; s.onload = res;
    s.onerror = () => rej(new Error('Could not load the sign-in library. Check the internet connection.'));
    document.head.append(s);
  });
  return window.supabase;
}

const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
const returnUrl = () => appUrl() + '?sb=1';

export async function initCloud() {
  if (!cloud.configured || location.protocol === 'file:') { setStatus('off'); return; }
  setStatus('starting');
  let lib;
  try { lib = await loadLib(); } catch (e) { fail(e, 'load'); return; }
  cloud.sb = lib.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'sc.sb-auth' },
  });

  // Back from Google or from the emailed link?
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (q.get('sb') === '1') {
    history.replaceState(null, '', appUrl());
    const err = q.get('error_description') || q.get('error') || hq.get('error_description') || hq.get('error');
    if (err) toast('Sign-in did not work: ' + err.replace(/\+/g, ' '), 9000);
    else if (q.get('code')) {
      const { error } = await cloud.sb.auth.exchangeCodeForSession(q.get('code'));
      if (error) toast('Sign-in did not work: ' + errText(error) + '. Open the link in the same browser you asked for it in.', 10000);
    }
  }

  let session = null;
  try { session = check(await cloud.sb.auth.getSession()).session; } catch (e) { log('cloud-session', errText(e)); }
  cloud.sb.auth.onAuthStateChange((evt, s) => {
    // Supabase asks not to call it again from inside this callback, so defer.
    setTimeout(() => {
      const uid = s && s.user ? s.user.id : null;
      if (evt === 'SIGNED_OUT' || !uid) { if (cloud.user) signedOut(); return; }
      if (!cloud.user || cloud.user.id !== uid) setUser(s.user);
      else cloud.user = s.user;
    }, 0);
  });
  if (session && session.user) setUser(session.user);
  else setStatus('signed-out');

  window.addEventListener('focus', () => { if (cloud.ws && Date.now() - cloud.lastSync > 30000) syncAll(); });
  window.addEventListener('online', () => { if (cloud.ws) syncAll(); });
  setInterval(() => { if (cloud.ws && document.visibilityState === 'visible' && !cloud.isRunning()) syncAll(); }, 120000);
}

export async function signInWithGoogle() {
  const { error } = await cloud.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl() } });
  if (error) throw error;
}

export async function signInWithEmail(email) {
  const { error } = await cloud.sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: returnUrl(), shouldCreateUser: true } });
  if (error) throw error;
}

export async function signOut() {
  await syncing;
  try { await cloud.sb.auth.signOut(); } catch (e) { log('cloud-signout', errText(e)); }
  signedOut();
}

function signedOut() {
  cloud.user = null; cloud.ws = null; cloud.workspaces = []; cloud.members = []; cloud.invites = [];
  setStatus('signed-out');
}

async function setUser(user) {
  cloud.user = user;
  setStatus('syncing', 'Signing in…');
  try {
    const known = store.get('wsKnown', []);
    cloud.workspaces = check(await cloud.sb.rpc('bootstrap')) || [];
    const fresh = cloud.workspaces.filter((w) => !known.includes(w.id) && w.created_by !== user.id);
    store.set('wsKnown', cloud.workspaces.map((w) => w.id));
    const want = fresh.length ? fresh[fresh.length - 1].id : store.get('ws', null);
    const ws = cloud.workspaces.find((w) => w.id === want) || cloud.workspaces[0] || null;
    if (fresh.length && known.length) toast(`You've joined a shared workspace. Its sessions are now here.`, 6000);
    await useWorkspace(ws);
  } catch (e) { fail(e, 'bootstrap'); }
}

async function useWorkspace(ws) {
  const prev = store.get('ws', null);
  cloud.ws = ws;
  if (!ws) { setStatus('error', 'No workspace.'); return; }
  store.set('ws', ws.id);
  if (prev && prev !== ws.id) await forgetWorkspace(prev);
  await syncAll();
}

export async function switchWorkspace(id) {
  const ws = cloud.workspaces.find((w) => w.id === id);
  if (ws && (!cloud.ws || ws.id !== cloud.ws.id)) await useWorkspace(ws);
}

// Sessions from another workspace are safe in the cloud; drop the local copies when switching.
async function forgetWorkspace(wsId) {
  const synced = store.get('synced', {});
  for (const [sid, w] of Object.entries(synced)) {
    if (w !== wsId) continue;
    await db.clips.delSession(sid, Q); await db.sessions.del(sid, Q);
    delete synced[sid];
  }
  store.set('synced', synced);
  app.emit('cloud-data');
}

// ---------------------------------------------------------------- workspace: people and shared settings
async function loadWorkspace() {
  const ws = cloud.ws.id;
  const [w, m, i] = await Promise.all([
    cloud.sb.from('workspaces').select('*').eq('id', ws),
    cloud.sb.from('members').select('user_id,email,name,role,joined_at').eq('workspace_id', ws),
    cloud.sb.from('invites').select('email,created_at').eq('workspace_id', ws),
  ]);
  const row = (check(w) || [])[0];
  if (!row) { const e = new Error('You are no longer in this workspace.'); e.gone = true; throw e; }
  cloud.ws = row;
  cloud.members = (check(m) || []).sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));
  cloud.invites = check(i) || [];
}

export async function invite(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That does not look like an email address.');
  if (cloud.members.some((m) => m.email === e)) throw new Error('They are already in this workspace.');
  check(await cloud.sb.from('invites').upsert({ workspace_id: cloud.ws.id, email: e, invited_by: cloud.user.id }));
  await loadWorkspace(); app.emit('cloud');
}

export async function cancelInvite(email) {
  check(await cloud.sb.from('invites').delete().eq('workspace_id', cloud.ws.id).eq('email', email));
  await loadWorkspace(); app.emit('cloud');
}

export async function removeMember(userId) {
  check(await cloud.sb.rpc('remove_member', { ws: cloud.ws.id, member: userId }));
  if (userId === cloud.user.id) { await setUser(cloud.user); return; }
  await loadWorkspace(); app.emit('cloud');
}

export async function renameWorkspace(name) {
  check(await cloud.sb.from('workspaces').update({ name, updated_at: new Date().toISOString() }).eq('id', cloud.ws.id));
  await loadWorkspace(); app.emit('cloud');
}

// The ElevenLabs key is shared with the workspace, so everyone records with the same account.
async function syncElevenKey() {
  const st = cloud.ws.settings || {};
  const localKey = eleven.key, localAt = store.get('elkeyAt', 0);
  if (st.elKey && st.elKey !== localKey && ((st.elKeyAt || 0) >= localAt || !localKey)) {
    store.set('elkey', st.elKey); store.set('elkeyAt', st.elKeyAt || Date.now());
    eleven._models = null; eleven._voices = null;
    app.emit('cloud-eleven');
  } else if (localKey && localKey !== st.elKey && localAt > (st.elKeyAt || 0)) {
    await saveSharedSettings({ elKey: localKey, elKeyAt: localAt });
  }
}

export async function pushElevenKey() {
  if (!cloud.ws) return;
  const at = Date.now();
  store.set('elkeyAt', at);
  try { await saveSharedSettings({ elKey: eleven.key, elKeyAt: at }); } catch (e) { fail(e, 'elkey'); }
}

async function saveSharedSettings(patch) {
  const rows = check(await cloud.sb.from('workspaces').select('settings').eq('id', cloud.ws.id)) || [];
  const settings = Object.assign({}, (rows[0] && rows[0].settings) || {}, patch);
  check(await cloud.sb.from('workspaces').update({ settings, updated_at: new Date().toISOString() }).eq('id', cloud.ws.id));
  cloud.ws.settings = settings;
}

// ---------------------------------------------------------------- your Spotify login (only yours)
async function userSettings() {
  const rows = check(await cloud.sb.from('user_settings').select('data').eq('user_id', cloud.user.id)) || [];
  return (rows[0] && rows[0].data) || {};
}
async function saveUserSettings(patch) {
  const data = Object.assign(await userSettings(), patch);
  check(await cloud.sb.from('user_settings').upsert({ user_id: cloud.user.id, data, updated_at: new Date().toISOString() }));
}

async function syncSpotify() {
  const sp = (await userSettings()).spotify || null;
  const tok = store.get('tok', null);
  const localAt = store.get('tokAt', 0);
  if (sp && sp.r && (!tok || !tok.r || (sp.at || 0) > localAt)) {
    if (!tok || tok.r !== sp.r) { store.set('tokAt', sp.at || Date.now()); app.emit('cloud-spotify', sp); }
  } else if (tok && tok.r && (!sp || sp.r !== tok.r) && localAt >= ((sp && sp.at) || 0)) {
    await saveUserSettings({ spotify: { r: tok.r, s: tok.s || '', at: localAt || Date.now() } });
  }
}

let spTimer = null;
app.on('spotify-tokens', (t) => {
  if (!cloud.user) return;
  clearTimeout(spTimer);
  spTimer = setTimeout(() => {
    const val = t && t.r ? { r: t.r, s: t.s || '', at: store.get('tokAt', Date.now()) } : null;
    saveUserSettings({ spotify: val }).catch((e) => fail(e, 'spotify'));
  }, 500);
});

// When Spotify refuses this browser's login because another computer already renewed it.
app.spotifyRecover = async (failedRefresh) => {
  if (!cloud.user) return null;
  try {
    const sp = (await userSettings()).spotify;
    return sp && sp.r && sp.r !== failedRefresh ? sp : null;
  } catch { return null; }
};

// ---------------------------------------------------------------- sessions and recordings
let syncing = null;
let again = false;
export function syncAll() {
  if (!cloud.sb || !cloud.ws) return Promise.resolve();
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    do { again = false; await fullSync(); } while (again);
  })().finally(() => { syncing = null; });
  return syncing;
}

async function fullSync() {
  const ws = cloud.ws.id;
  setStatus('syncing', 'Syncing…');
  try {
    await loadWorkspace();
    await syncElevenKey();
    await syncSpotify();

    // Sessions deleted here while offline.
    const tomb = store.get('tomb', {});
    for (const sid of Object.keys(tomb)) await deleteSession(sid);

    const rows = check(await cloud.sb.from('sessions').select('id,data,updated_at,deleted').eq('workspace_id', ws)) || [];
    const clipRows = check(await cloud.sb.from('clips').select('session_id,cue,key,source,chars,at,path,size,type').eq('workspace_id', ws)) || [];
    const local = await db.sessions.all();
    const byId = new Map(local.map((s) => [s.id, s]));
    const synced = store.get('synced', {});
    let changed = false;
    const live = [];

    for (const r of rows) {
      const l = byId.get(r.id);
      if (r.deleted) {
        if (l && (l.updatedAt || 0) <= r.updated_at) { await db.clips.delSession(r.id, Q); await db.sessions.del(r.id, Q); changed = true; }
        else if (l) { await putSession(l); live.push(r.id); }
        delete synced[r.id];
        continue;
      }
      if (!l || (l.updatedAt || 0) < r.updated_at) { await db.sessions.put(r.data, Q); changed = true; }
      else if ((l.updatedAt || 0) > r.updated_at) await putSession(l);
      synced[r.id] = ws;
      live.push(r.id);
    }
    for (const l of local) {
      if (rows.some((r) => r.id === l.id)) continue;
      if (synced[l.id] && synced[l.id] !== ws) continue;          // belongs to another workspace
      await putSession(l); synced[l.id] = ws; live.push(l.id);
    }
    store.set('synced', synced);
    if (changed) app.emit('cloud-data');

    const bySession = {};
    for (const c of clipRows) (bySession[c.session_id] = bySession[c.session_id] || {})[c.cue] = c;
    const work = { done: 0 };
    for (const sid of live) if (await syncClips(sid, bySession[sid] || {}, work)) changed = true;
    if (changed) app.emit('cloud-data');

    await syncRuns();
    cloud.lastSync = Date.now();
    setStatus('synced');
  } catch (e) {
    if (e.gone && cloud.user) { toast(e.message, 6000); const u = cloud.user; setTimeout(() => setUser(u), 0); return; }
    fail(e, 'sync');
  }
}

// Returns false if the cloud already had a newer version.
async function putSession(s) {
  const ts = s.updatedAt || Date.now();
  if (!s.updatedAt) { s.updatedAt = ts; await db.sessions.put(s, Q); }
  const res = check(await cloud.sb.rpc('put_session', { ws: cloud.ws.id, sid: s.id, body: s, ts, del: false }));
  return res !== null && res !== undefined;
}

async function syncClips(sid, remote, work) {
  const ws = cloud.ws.id;
  const local = await db.clips.forSession(sid);
  let pulled = false;
  for (const cue of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[cue], r = remote[cue];
    const lAt = l && l.blob ? l.at || 1 : 0;
    if (lAt && (!r || lAt > r.at)) {
      work.done++;
      setStatus('syncing', `Uploading recordings (${work.done})…`);
      const type = l.blob.type || 'audio/mpeg';
      const path = `${ws}/${sid}/${cue}-${lAt}.${/wav/.test(type) ? 'wav' : /mp4|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'mp3'}`;
      check(await cloud.sb.storage.from(BUCKET).upload(path, l.blob, { contentType: type, upsert: true }));
      check(await cloud.sb.from('clips').upsert({
        workspace_id: ws, session_id: sid, cue, key: l.key || null, source: l.source || 'generated',
        chars: l.chars || 0, at: lAt, path, size: l.blob.size, type, updated_at: new Date().toISOString(),
      }));
      if (r && r.path !== path) await cloud.sb.storage.from(BUCKET).remove([r.path]);
    } else if (r && (!lAt || r.at > lAt)) {
      work.done++;
      setStatus('syncing', `Downloading recordings (${work.done})…`);
      const data = check(await cloud.sb.storage.from(BUCKET).download(r.path));
      const blob = data instanceof Blob ? new Blob([data], { type: r.type || data.type || 'audio/mpeg' }) : new Blob([data], { type: r.type || 'audio/mpeg' });
      await db.clips.put(sid, cue, { blob, key: r.key, chars: r.chars || 0, at: r.at, source: r.source || 'generated' }, Q);
      pulled = true;
    }
  }
  return pulled;
}

async function deleteSession(sid) {
  const ws = cloud.ws.id;
  check(await cloud.sb.rpc('put_session', { ws, sid, body: {}, ts: Date.now(), del: true }));
  const rows = check(await cloud.sb.from('clips').select('path').eq('workspace_id', ws).eq('session_id', sid)) || [];
  if (rows.length) await cloud.sb.storage.from(BUCKET).remove(rows.map((r) => r.path));
  check(await cloud.sb.from('clips').delete().eq('workspace_id', ws).eq('session_id', sid));
  const synced = store.get('synced', {}); delete synced[sid]; store.set('synced', synced);
  const tomb = store.get('tomb', {}); delete tomb[sid]; store.set('tomb', tomb);
}

// Local edits are uploaded a moment after they happen.
const dirty = new Set();
let pushTimer = null;
app.on('local-change', ({ sid, deleted }) => {
  if (deleted) {
    const synced = store.get('synced', {});
    if (synced[sid] || cloud.ws) { const tomb = store.get('tomb', {}); tomb[sid] = Date.now(); store.set('tomb', tomb); }
  }
  if (!cloud.ws) return;
  dirty.add(sid);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushDirty, 1500);
});

let pushing = null;
async function pushDirty() {
  if (pushing) { pushTimer = setTimeout(pushDirty, 1000); return; }
  if (!cloud.ws || !dirty.size) return;
  const ids = [...dirty]; dirty.clear();
  pushing = (async () => {
    setStatus('syncing', 'Saving to the cloud…');
    try {
      const ws = cloud.ws.id;
      for (const sid of ids) {
        const s = await db.sessions.get(sid);
        if (!s) { if (store.get('tomb', {})[sid]) await deleteSession(sid); continue; }
        const synced = store.get('synced', {});
        if (synced[sid] && synced[sid] !== ws) continue;
        if (!(await putSession(s))) { again = true; continue; }        // someone saved a newer version: fetch it
        synced[sid] = ws; store.set('synced', synced);
        const remote = {};
        for (const c of check(await cloud.sb.from('clips').select('session_id,cue,key,source,chars,at,path,size,type').eq('workspace_id', ws).eq('session_id', sid)) || []) remote[c.cue] = c;
        if (await syncClips(sid, remote, { done: 0 })) app.emit('cloud-data');
      }
      cloud.lastSync = Date.now();
      setStatus('synced');
      if (again) syncAll();
    } catch (e) {
      ids.forEach((x) => dirty.add(x));
      fail(e, 'push');
    }
  })().finally(() => { pushing = null; });
  return pushing;
}

// ---------------------------------------------------------------- run history and resume
const RUN_KEY = 'run', HISTORY_KEY = 'runs';

async function syncRuns() {
  const ws = cloud.ws.id;
  const rows = check(await cloud.sb.from('runs').select('run_id,session_id,active,data,updated_at').eq('workspace_id', ws).order('updated_at', { ascending: false }).limit(60)) || [];
  const hist = store.get(HISTORY_KEY, []);
  const have = new Set(hist.map((x) => x.runId));
  let changed = false;
  for (const r of rows) {
    if (r.active || !r.data || have.has(r.run_id)) continue;
    hist.push(r.data); have.add(r.run_id); changed = true;
  }
  // Upload local history the cloud doesn't have yet.
  const inCloud = new Set(rows.map((r) => r.run_id));
  const missing = hist.filter((x) => x.runId && !inCloud.has(x.runId));
  if (missing.length) {
    check(await cloud.sb.from('runs').upsert(missing.map((x) => ({
      workspace_id: ws, run_id: x.runId, session_id: x.sessionId || null, active: false, data: x, updated_at: x.endedAt || x.startedAt || Date.now(),
    }))));
  }
  if (changed) {
    hist.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    store.set(HISTORY_KEY, hist.slice(0, 30));
  }
  // A run that was cut short on another computer can be resumed here.
  const cur = store.get(RUN_KEY, null);
  if (cur) {
    const r = rows.find((x) => x.run_id === cur.runId);
    if (r && !r.active && !cloud.isRunning()) { store.del(RUN_KEY); changed = true; }
  } else if (!cloud.isRunning()) {
    // Running computers report every 15 seconds; quiet for a minute means it stopped.
    const r = rows.find((x) => x.active && x.data && Date.now() - x.updated_at > 60000 && Date.now() - x.updated_at < 12 * 3600 * 1000);
    if (r) { store.set(RUN_KEY, r.data); changed = true; }
  }
  if (changed) app.emit('cloud-runs');
}

let runTimer = null, runPending = null, runSentAt = 0;
app.on('run-progress', ({ data, force }) => {
  if (!cloud.ws || !data) return;
  runPending = data;
  const wait = force ? 0 : Math.max(0, 15000 - (Date.now() - runSentAt));
  clearTimeout(runTimer);
  runTimer = setTimeout(sendRun, wait);
});
async function sendRun() {
  const d = runPending; runPending = null;
  if (!d || !cloud.ws) return;
  runSentAt = Date.now();
  try {
    check(await cloud.sb.from('runs').upsert({ workspace_id: cloud.ws.id, run_id: d.runId, session_id: d.sessionId, active: true, data: d, updated_at: d.updatedAt || Date.now() }));
  } catch (e) { log('cloud-run', errText(e)); }
}
app.on('history-add', (entry) => {
  if (!cloud.ws || !entry || !entry.runId) return;
  clearTimeout(runTimer); runPending = null;
  cloud.sb.from('runs').upsert({ workspace_id: cloud.ws.id, run_id: entry.runId, session_id: entry.sessionId || null, active: false, data: entry, updated_at: entry.endedAt || Date.now() })
    .then((res) => { if (res.error) log('cloud-history', errText(res.error)); }, (e) => log('cloud-history', errText(e)));
});

// For diagnostics.
export function cloudSummary() {
  if (!cloud.configured) return 'cloud: not set up';
  return `cloud: ${cloud.status}${cloud.detail ? ' (' + cloud.detail + ')' : ''}, signed in: ${cloud.signedIn}, workspace: ${cloud.ws ? cloud.ws.name : '-'}, members: ${cloud.members.length}, last sync: ${cloud.lastSync ? new Date(cloud.lastSync).toISOString() : 'never'}`;
}

export const _test = { syncAll, pushDirty, sleep };
