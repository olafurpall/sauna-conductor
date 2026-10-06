// Cloud sync (Supabase): sign-in, your own private space, and syncing of sessions, recorded
// narration, run history, play counts and your Spotify login.
// A session can be shared by invite (collaborator or viewer) or by a link (viewer).
// The browser's own storage stays the working copy, so everything keeps working offline.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=3.2.1-8eb03f85';
import { app } from './app.js?v=3.2.1-8eb03f85';
import { store, log, toast, sleep } from './util.js?v=3.2.1-8eb03f85';
import * as db from './db.js?v=3.2.1-8eb03f85';
import { countsAsPlay } from './sessions.js?v=3.2.1-8eb03f85';

const Q = { quiet: true };            // local writes made by sync must not trigger another upload
const BUCKET = 'clips';

export const cloud = {
  configured: !!(SUPABASE_URL && SUPABASE_KEY),
  sb: null,
  user: null,
  ws: null,                           // your own space
  workspaces: [],
  members: [],
  admin: false,                       // runs the app: sees Spotify access requests and credits
  request: null,                      // your Spotify access request, if any
  requests: [],                       // admin: everyone's requests
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

// Which space a session lives in: your own, or the one that shared it with you.
const homeWs = (sid) => store.get('synced', {})[sid] || (cloud.ws && cloud.ws.id);
const sharedMap = () => store.get('shared', {});
// A session someone shared with you (it lives in their space): { ws, by, owner, email, role } or null.
export function sharedWithMe(sid) {
  const x = sharedMap()[sid];
  return x && cloud.ws && x.ws !== cloud.ws.id ? x : null;
}
// 'owner' | 'editor' (collaborator) | 'viewer'
export function roleOf(sid) {
  const x = sharedWithMe(sid);
  return x ? (x.role === 'viewer' ? 'viewer' : 'editor') : 'owner';
}
export const canEdit = (sid) => roleOf(sid) !== 'viewer';
// How many people your own sessions are shared with.
export const sharedOut = (sid) => store.get('outShares', {})[sid] || 0;
const myEmail = () => String(cloud.email || '').toLowerCase();

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
  setInterval(() => { if (cloud.ws && !cloud.dormant && document.visibilityState === 'visible' && !cloud.isRunning()) syncAll(); }, 120000);
}

export async function signInWithGoogle() {
  const { error } = await cloud.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl() } });
  if (error) throw error;
}

export async function signInWithEmail(email) {
  const { error } = await cloud.sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: returnUrl(), shouldCreateUser: true } });
  if (error) throw error;
}

// Signing out leaves nothing of yours on this computer: your sessions are safe in the cloud and come
// back when you sign in again. Sessions never synced (made without signing in) stay.
export async function signOut() {
  await syncing;
  try { await cloud.sb.auth.signOut(); } catch (e) { log('cloud-signout', errText(e)); }
  await forgetLocalCopies();
  for (const k of ['prefs', 'tok', 'tokAt', 'shared', 'outShares', 'plays', 'playsSent', 'runs', 'run', 'tomb', 'ws', 'wsKnown', 'onboarded', 'pendingLink', 'elkey', 'elkeyAt']) store.del(k);
  signedOut();
}

async function forgetLocalCopies() {
  const synced = store.get('synced', {});
  for (const sid of Object.keys(synced)) {
    try { await db.clips.delSession(sid, Q); await db.sessions.del(sid, Q); } catch (e) { log('cloud-forget', errText(e)); }
  }
  store.del('synced');
}

function signedOut() {
  cloud.user = null; cloud.ws = null; cloud.workspaces = []; cloud.members = []; cloud.admin = false; cloud.request = null; cloud.requests = [];
  setStatus('signed-out');
  app.emit('auth', { signedIn: false });
}

async function setUser(user) {
  const first = !cloud.user;
  cloud.user = user;
  setStatus('syncing', 'Signing in…');
  if (first) app.emit('auth', { signedIn: true });
  try {
    cloud.workspaces = check(await cloud.sb.rpc('bootstrap')) || [];
    const ws = cloud.workspaces.find((w) => w.created_by === user.id) || cloud.workspaces[0] || null;
    await loadPeople();
    await useWorkspace(ws);
  } catch (e) { fail(e, 'bootstrap'); }
}

// Are you the admin, and where is your Spotify access request?
async function loadPeople() {
  try { cloud.admin = !!check(await cloud.sb.rpc('is_admin')); } catch (e) { cloud.admin = false; log('cloud-admin', errText(e)); }
  try {
    const rows = check(await cloud.sb.from('access_requests').select('user_id,email,name,spotify_email,note,status,created_at,updated_at').order('created_at', { ascending: false })) || [];
    cloud.request = rows.find((r) => r.user_id === cloud.user.id) || null;
    cloud.requests = cloud.admin ? rows : [];
  } catch (e) { log('cloud-requests', errText(e)); }
  app.emit('people');
}

async function useWorkspace(ws) {
  const prev = store.get('ws', null);
  cloud.ws = ws;
  if (!ws) { setStatus('error', 'No workspace.'); return; }
  store.set('ws', ws.id);
  if (prev && prev !== ws.id) await forgetWorkspace(prev);
  await syncAll();
}

// Sessions from another workspace are safe in the cloud; drop the local copies when switching.
async function forgetWorkspace(wsId) {
  const synced = store.get('synced', {});
  const shared = sharedMap();
  for (const [sid, w] of Object.entries(synced)) {
    if (w !== wsId || shared[sid]) continue;
    await db.clips.delSession(sid, Q); await db.sessions.del(sid, Q);
    delete synced[sid];
  }
  store.set('synced', synced);
  app.emit('cloud-data');
}

// ---------------------------------------------------------------- your space
async function loadWorkspace() {
  const rows = check(await cloud.sb.from('workspaces').select('*').eq('id', cloud.ws.id)) || [];
  if (!rows[0]) { const e = new Error('Your space was not found. Signing in again.'); e.gone = true; throw e; }
  cloud.ws = rows[0];
}

// ---------------------------------------------------------------- Spotify access requests
// Spotify lets only the people on the app's user list in (5 at most). Anyone turned away asks here,
// and the admin adds them in Spotify's developer dashboard.
export async function requestAccess(spotifyEmail, note = '') {
  check(await cloud.sb.rpc('request_access', { spotify_email: String(spotifyEmail || '').trim(), note }));
  await loadPeople();
}
export async function refreshPeople() { if (cloud.user) await loadPeople(); }
export async function setRequestStatus(uid, status) {
  check(await cloud.sb.rpc('set_request_status', { uid, new_status: status }));
  await loadPeople();
}

// ---------------------------------------------------------------- server functions
// Calls a Supabase Edge Function as the signed-in person ("eleven": narration, "write": AI writer).
export async function callFunction(name, payload, signal) {
  if (!cloud.sb || !cloud.user) { const e = new Error('Sign in first.'); e.status = 401; throw e; }
  let token = '';
  try { token = check(await cloud.sb.auth.getSession()).session.access_token; } catch { /* below */ }
  if (!token) { const e = new Error('Sign in again.'); e.status = 401; throw e; }
  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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

// ---------------------------------------------------------------- your own preferences (e.g. the Talk volume)
// Kept on this device and in your account, so they follow you to your other devices.
export const prefs = () => store.get('prefs', {});
export function savePrefs(patch) {
  const p = { ...prefs(), ...patch, at: Date.now() };
  store.set('prefs', p);
  app.emit('prefs', p);
  if (cloud.user && cloud.sb) saveUserSettings({ prefs: p }).catch((e) => log('cloud-prefs', errText(e)));
  return p;
}
async function syncPrefs() {
  const remote = (await userSettings()).prefs || null;
  const local = store.get('prefs', null);
  if (remote && (!local || (remote.at || 0) > (local.at || 0))) { store.set('prefs', remote); app.emit('prefs', remote); }
  else if (local && (!remote || (local.at || 0) > (remote.at || 0))) await saveUserSettings({ prefs: local });
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
    await syncSpotify();
    await syncPrefs().catch((e) => log('cloud-prefs', errText(e)));

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

    if (await syncShared(byId, work)) app.emit('cloud-data');
    await syncOutShares();
    await syncRuns();
    await syncPlays();
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
  const res = check(await cloud.sb.rpc('put_session', { ws: homeWs(s.id), sid: s.id, body: s, ts, del: false }));
  return res !== null && res !== undefined;
}

async function syncClips(sid, remote, work, ws = homeWs(sid)) {
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
  const ws = homeWs(sid);
  if (ws !== cloud.ws.id && sharedMap()[sid]) {
    // Someone else's session: just stop collaborating on it. It stays with them.
    check(await cloud.sb.from('session_shares').delete().eq('workspace_id', ws).eq('session_id', sid).eq('email', myEmail()));
    const sh = sharedMap(); delete sh[sid]; store.set('shared', sh);
    const synced = store.get('synced', {}); delete synced[sid]; store.set('synced', synced);
    const tomb = store.get('tomb', {}); delete tomb[sid]; store.set('tomb', tomb);
    return;
  }
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
        const home = synced[sid] || ws;
        if (home !== ws && !sharedMap()[sid]) continue;                // belongs to another workspace
        if (home !== ws && roleOf(sid) === 'viewer') continue;          // viewers can't change it
        if (!(await putSession(s))) { again = true; continue; }        // someone saved a newer version: fetch it
        synced[sid] = home; store.set('synced', synced);
        const remote = {};
        for (const c of check(await cloud.sb.from('clips').select('session_id,cue,key,source,chars,at,path,size,type').eq('workspace_id', home).eq('session_id', sid)) || []) remote[c.cue] = c;
        if (await syncClips(sid, remote, { done: 0 }, home)) app.emit('cloud-data');
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
  if (countsAsPlay(entry) && entry.sessionId) sendPlays([entry]).then(() => syncPlays()).catch((e) => log('cloud-plays', errText(e)));
  clearTimeout(runTimer); runPending = null;
  cloud.sb.from('runs').upsert({ workspace_id: cloud.ws.id, run_id: entry.runId, session_id: entry.sessionId || null, active: false, data: entry, updated_at: entry.endedAt || Date.now() })
    .then((res) => { if (res.error) log('cloud-history', errText(res.error)); }, (e) => log('cloud-history', errText(e)));
});

// ---------------------------------------------------------------- sessions shared with you
// Sessions other people shared with you live in their workspace; they sync here like your own.
async function syncShared(localById, work) {
  const mine = myEmail();
  if (!mine) return false;
  const rows = (check(await cloud.sb.from('session_shares').select('workspace_id,session_id,email,invited_by_name,owner_name,role').eq('email', mine)) || [])
    .filter((r) => r.workspace_id !== cloud.ws.id);
  const before = sharedMap();
  const now = {};
  const byWs = {};
  for (const r of rows) {
    now[r.session_id] = { ws: r.workspace_id, by: r.invited_by_name || r.owner_name || 'someone', owner: r.owner_name || r.invited_by_name || 'someone', email: r.email, role: r.role === 'viewer' ? 'viewer' : 'editor' };
    (byWs[r.workspace_id] = byWs[r.workspace_id] || []).push(r.session_id);
  }
  const synced = store.get('synced', {});
  let changed = false;
  // No longer shared (or deleted by its owner): remove the local copy.
  for (const [sid, x] of Object.entries(before)) {
    if (now[sid]) continue;
    if (synced[sid] === x.ws) { await db.clips.delSession(sid, Q); await db.sessions.del(sid, Q); delete synced[sid]; changed = true; }
  }
  store.set('shared', now);
  for (const [w, sids] of Object.entries(byWs)) {
    const ss = check(await cloud.sb.from('sessions').select('id,data,updated_at,deleted').eq('workspace_id', w).in('id', sids)) || [];
    const cs = check(await cloud.sb.from('clips').select('session_id,cue,key,source,chars,at,path,size,type').eq('workspace_id', w).in('session_id', sids)) || [];
    for (const r of ss) {
      const l = localById.get(r.id);
      synced[r.id] = w;
      if (r.deleted) {
        if (l) { await db.clips.delSession(r.id, Q); await db.sessions.del(r.id, Q); changed = true; }
        continue;
      }
      const viewer = now[r.id] && now[r.id].role === 'viewer';
      if (!l || (l.updatedAt || 0) < r.updated_at || (viewer && (l.updatedAt || 0) !== r.updated_at)) { await db.sessions.put(r.data, Q); changed = true; }
      else if ((l.updatedAt || 0) > r.updated_at) { store.set('synced', synced); await putSession(l); }
      const remote = {};
      for (const c of cs.filter((x) => x.session_id === r.id)) remote[c.cue] = c;
      if (await syncClips(r.id, remote, work, w)) changed = true;
    }
  }
  store.set('synced', synced);
  return changed;
}

// How many people each of your own sessions is shared with (for the "Shared with 2" label).
async function syncOutShares() {
  const rows = check(await cloud.sb.from('session_shares').select('session_id').eq('workspace_id', cloud.ws.id)) || [];
  const out = {};
  for (const r of rows) out[r.session_id] = (out[r.session_id] || 0) + 1;
  if (JSON.stringify(out) !== JSON.stringify(store.get('outShares', {}))) { store.set('outShares', out); app.emit('plays'); }
}

// Make sure a session (and its recordings) is in the cloud before sharing it.
async function ensureUploaded(s) {
  const synced = store.get('synced', {});
  if (!synced[s.id]) { synced[s.id] = cloud.ws.id; store.set('synced', synced); }
  if (canEdit(s.id)) {
    await putSession(s);
    const remote = {};
    for (const c of check(await cloud.sb.from('clips').select('session_id,cue,key,source,chars,at,path,size,type').eq('workspace_id', homeWs(s.id)).eq('session_id', s.id)) || []) remote[c.cue] = c;
    await syncClips(s.id, remote, { done: 0 });
  }
}

// People a session is shared with: [{ email, role, invited_by_name, via_link, created_at }].
export async function listShares(s) {
  const ws = homeWs(s.id);
  return check(await cloud.sb.from('session_shares').select('email,role,invited_by_name,via_link,created_at').eq('workspace_id', ws).eq('session_id', s.id).order('created_at')) || [];
}
export async function setShareRole(s, email, role) {
  check(await cloud.sb.from('session_shares').update({ role }).eq('workspace_id', homeWs(s.id)).eq('session_id', s.id).eq('email', email));
  await syncOutShares().catch(() => {});
}
export async function addShare(s, email, role = 'editor') {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That does not look like an email address.');
  if (e === myEmail()) throw new Error('That is you.');
  await ensureUploaded(s);
  check(await cloud.sb.from('session_shares').upsert({ workspace_id: homeWs(s.id), session_id: s.id, email: e, role: role === 'viewer' ? 'viewer' : 'editor', invited_by: cloud.user.id, invited_by_name: cloud.name }));
  await syncOutShares().catch(() => {});
}
export async function removeShare(s, email) {
  check(await cloud.sb.from('session_shares').delete().eq('workspace_id', homeWs(s.id)).eq('session_id', s.id).eq('email', email));
  await syncOutShares().catch(() => {});
}

// ---------------------------------------------------------------- share links
// A link anyone can open: after signing in they get the session as viewers.
const randomToken = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(22)), (b) => a[b % a.length]).join('');
};
export const linkUrl = (token) => location.origin + location.pathname.replace(/index\.html$/, '') + '?s=' + token;
export async function getLink(s) {
  const rows = check(await cloud.sb.from('session_links').select('token,revoked,created_at').eq('workspace_id', homeWs(s.id)).eq('session_id', s.id).eq('revoked', false)) || [];
  return rows.length ? rows[0].token : null;
}
export async function createLink(s) {
  await ensureUploaded(s);
  const token = randomToken();
  check(await cloud.sb.from('session_links').insert({ token, workspace_id: homeWs(s.id), session_id: s.id, created_by: cloud.user.id, created_by_name: cloud.name }));
  return token;
}
export async function revokeLink(s) {
  check(await cloud.sb.from('session_links').update({ revoked: true }).eq('workspace_id', homeWs(s.id)).eq('session_id', s.id));
}
// What a link points to (works before signing in).
export async function linkInfo(token) {
  if (!cloud.sb) return null;
  try { return (check(await cloud.sb.rpc('link_info', { tok: token })) || [])[0] || null; } catch (e) { log('cloud-linkinfo', errText(e)); return null; }
}
// Opening a link once signed in: the session becomes yours to run. Returns its id.
export async function claimLink(token) {
  const row = (check(await cloud.sb.rpc('claim_link', { tok: token })) || [])[0];
  if (!row) throw new Error('This link no longer works. Ask for a new one.');
  await syncAll();
  return row.session_id;
}

// ---------------------------------------------------------------- play counts
// Every run that finishes (or lasts 10 minutes) counts as a play, from any computer and any collaborator.
async function sendPlays(entries) {
  const sent = new Set(store.get('playsSent', []));
  const rows = entries.filter((e) => e.runId && e.sessionId && !sent.has(e.runId) && countsAsPlay(e)).map((e) => ({
    workspace_id: homeWs(e.sessionId), session_id: e.sessionId, run_id: e.runId,
    played_at: new Date(e.endedAt || e.startedAt || Date.now()).toISOString(), elapsed_ms: Math.round(e.elapsedMs || 0), status: e.status || '',
  }));
  for (const r of rows) {
    const res = await cloud.sb.from('session_plays').upsert(r);
    if (!res.error) sent.add(r.run_id); else log('cloud-play', errText(res.error));
  }
  store.set('playsSent', [...sent].slice(-500));
}
async function syncPlays() {
  await sendPlays(store.get('runs', []));
  const rows = check(await cloud.sb.rpc('play_counts')) || [];
  const next = {};
  for (const r of rows) next[r.session_id] = { n: Number(r.plays) || 0, last: r.last_played ? Date.parse(r.last_played) : 0 };
  if (JSON.stringify(next) !== JSON.stringify(store.get('plays', {}))) { store.set('plays', next); app.emit('plays'); }
}

// For diagnostics.
export function cloudSummary() {
  if (!cloud.configured) return 'cloud: not set up';
  return `cloud: ${cloud.status}${cloud.detail ? ' (' + cloud.detail + ')' : ''}, signed in: ${cloud.signedIn}, admin: ${cloud.admin}, shared with me: ${Object.keys(sharedMap()).length}, last sync: ${cloud.lastSync ? new Date(cloud.lastSync).toISOString() : 'never'}`;
}

export const _test = { syncAll, pushDirty, sleep };
