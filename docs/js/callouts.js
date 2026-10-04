// Callouts: short clips a person recorded for Sauna Conductor ("Let's do this!", "Last song!",
// "That's a wrap!") that play next to the narration. The admin sets up callout profiles (one per
// person) on the Callouts page; a session picks a profile, and its messages can include tokens like
// {callout-lets-start}. With "add them automatically" a session also plays them at good moments.
// The clips live in the "callouts" storage bucket and are kept in the browser's cache for offline runs.
import { log, store } from './util.js?v=3.1-c91bd7fc';
import { app } from './app.js?v=3.1-c91bd7fc';
import { cloud } from './cloud.js?v=3.1-c91bd7fc';

// The callouts every profile is asked for, with a suggested line (the person says it their own way).
export const CATALOG = [
  { key: 'lets-start', label: 'Let’s do this', is: 'Gerum þetta!', when: 'Start of a round, after its message' },
  { key: 'getting-hot', label: 'It’s getting hot in here', is: 'Nú er farið að hitna hérna!', when: 'Middle of a round' },
  { key: 'almost-there', label: 'Hang in, we’re almost there', is: 'Haldið út, við erum alveg að verða komin!', when: 'Late in a round' },
  { key: 'one-minute-left', label: '1 minute left', is: 'Ein mínúta eftir!', when: 'One minute before a round ends' },
  { key: 'last-song', label: 'Last song', is: 'Síðasta lagið!', when: 'When the last song of a round starts' },
  { key: 'done', label: 'Round done, nice work', is: 'Vel gert!', when: 'When a round ends, before the cool-down message' },
  { key: 'final-done', label: 'That’s a wrap', is: 'Þá er þetta komið!', when: 'End of the session, before the last message' },
  { key: 'amazing', label: 'That was amazing', is: 'Þetta var geggjað!', when: 'After the last message' },
];
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const catalogOf = (key) => CATALOG.find((c) => c.key === key) || null;
export const labelOf = (key) => (catalogOf(key) || {}).label || key.replace(/-/g, ' ');
export const suggestedLine = (key, lang) => { const c = catalogOf(key); return c ? (lang === 'is' ? c.is : c.label.replace(/’/g, "'") + '!') : ''; };
export const slugKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export const uuid4 = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

const BUCKET = 'callouts';
const CACHE = 'callouts-v1';            // not 'sc-…': the service worker clears those on every update
const LIST_KEY = 'callouts';

export const callouts = {
  get available() { return cloud.configured && cloud.signedIn; },
  profiles: store.get(LIST_KEY, []),     // [{ id, name, about, lang, consent, consent_note, published, clips: [{ id, key, said, path, type, size, duration_ms }] }]
  loadedAt: 0,
  error: '',                             // why the profiles couldn't be loaded (e.g. the tables aren't there yet)
};
export const profileById = (id) => (id && callouts.profiles.find((p) => p.id === id)) || null;
const order = (k) => { const i = CATALOG.findIndex((c) => c.key === k); return i < 0 ? 100 : i; };
export const keysOf = (p) => (p ? [...new Set((p.clips || []).map((c) => c.key))].sort((a, b) => order(a) - order(b) || a.localeCompare(b)) : []);
export const usable = () => callouts.profiles.filter((p) => p.published && (p.clips || []).length);

const check = (res) => { if (res && res.error) throw res.error; return res ? res.data : null; };

// Profiles you can see (published ones; the admin sees all). Cached for offline use.
export async function loadProfiles(force = false) {
  if (!callouts.available || !cloud.sb) return callouts.profiles;
  if (!force && Date.now() - callouts.loadedAt < 60000) return callouts.profiles;
  try {
    const ps = check(await cloud.sb.from('callout_profiles').select('id,name,about,lang,consent,published,created_at,updated_at').order('name', { ascending: true })) || [];
    const ids = ps.map((p) => p.id);
    const cs = ids.length ? check(await cloud.sb.from('callout_clips').select('id,profile_id,key,said,path,type,size,duration_ms,created_at').in('profile_id', ids)) || [] : [];
    // How each person agreed: only the admin can read these (others get no rows).
    let notes = [];
    try { notes = ids.length ? check(await cloud.sb.from('callout_notes').select('profile_id,consent_note').in('profile_id', ids)) || [] : []; } catch { /* not the admin */ }
    callouts.profiles = ps.map((p) => ({ ...p, _savedNote: ((notes.find((n) => n.profile_id === p.id) || {}).consent_note) || '', consent_note: ((notes.find((n) => n.profile_id === p.id) || {}).consent_note) || '',
      clips: cs.filter((c) => c.profile_id === p.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) }));
    callouts.loadedAt = Date.now();
    callouts.error = '';
    store.set(LIST_KEY, callouts.profiles);
    app.emit('callouts');
  } catch (e) { callouts.error = e.message || String(e); log('callouts-load', callouts.error); }
  return callouts.profiles;
}
app.on('auth', (a) => { if (a && a.signedIn) loadProfiles(true); else { callouts.profiles = []; callouts.loadedAt = 0; store.del(LIST_KEY); } });

// ---------------------------------------------------------------- the admin's changes
export async function saveProfile(p) {
  const row = { id: p.id, name: p.name.trim() || 'Unnamed', about: p.about || '', lang: p.lang || 'is', consent: !!p.consent,
    published: !!(p.published && p.consent), updated_at: new Date().toISOString() };
  if (!p.created_at) row.created_by = cloud.user && cloud.user.id;
  check(await cloud.sb.from('callout_profiles').upsert(row));
  if ((p.consent_note || '') !== (p._savedNote || '')) {
    check(await cloud.sb.from('callout_notes').upsert({ profile_id: p.id, consent_note: p.consent_note || '', updated_at: row.updated_at }));
    p._savedNote = p.consent_note || '';
  }
  if (!p.created_at) p.created_at = row.updated_at;
  Object.assign(p, row);
  if (!callouts.profiles.includes(p)) callouts.profiles.push(p);
  store.set(LIST_KEY, callouts.profiles);
  app.emit('callouts');
  return p;
}

export async function deleteProfile(p) {
  const paths = (p.clips || []).map((c) => c.path);
  check(await cloud.sb.from('callout_profiles').delete().eq('id', p.id));
  if (paths.length) await cloud.sb.storage.from(BUCKET).remove(paths).catch(() => {});
  callouts.profiles = callouts.profiles.filter((x) => x.id !== p.id);
  store.set(LIST_KEY, callouts.profiles);
  app.emit('callouts');
}

const extOf = (type) => (/wav/.test(type) ? 'wav' : /mp4|aac|m4a/.test(type) ? 'm4a' : /ogg|opus/.test(type) ? 'ogg' : /webm/.test(type) ? 'webm' : 'mp3');

export async function addClip(p, key, said, blob, durationMs) {
  if (!KEY_RE.test(key)) throw new Error('A callout name can only have letters, numbers and dashes.');
  const id = uuid4();
  const type = blob.type || 'audio/mpeg';
  const path = `${p.id}/${id}.${extOf(type)}`;
  check(await cloud.sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false }));
  const row = { id, profile_id: p.id, key, said: said || '', path, type, size: blob.size, duration_ms: durationMs || null, created_at: new Date().toISOString() };
  try { check(await cloud.sb.from('callout_clips').insert(row)); } catch (e) { await cloud.sb.storage.from(BUCKET).remove([path]).catch(() => {}); throw e; }
  p.clips = [...(p.clips || []), row];
  mem.set(path, blob);
  putCache(path, blob);
  store.set(LIST_KEY, callouts.profiles);
  app.emit('callouts');
  return row;
}

export async function updateClip(p, clip, patch) {
  check(await cloud.sb.from('callout_clips').update(patch).eq('id', clip.id));
  Object.assign(clip, patch);
  store.set(LIST_KEY, callouts.profiles);
}

export async function deleteClip(p, clip) {
  check(await cloud.sb.from('callout_clips').delete().eq('id', clip.id));
  await cloud.sb.storage.from(BUCKET).remove([clip.path]).catch(() => {});
  p.clips = (p.clips || []).filter((c) => c.id !== clip.id);
  mem.delete(clip.path);
  store.set(LIST_KEY, callouts.profiles);
  app.emit('callouts');
}

// ---------------------------------------------------------------- the audio
const mem = new Map();          // path -> Blob
const cacheUrl = (path) => new URL('/__callouts/' + path, location.origin).href;
async function getCache(path) {
  try { if (!window.caches) return null; const c = await caches.open(CACHE); const r = await c.match(cacheUrl(path)); return r ? await r.blob() : null; } catch { return null; }
}
async function putCache(path, blob) {
  try { if (!window.caches) return; const c = await caches.open(CACHE); await c.put(cacheUrl(path), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } })); } catch { /* full or not allowed */ }
}

export async function clipBlob(clip) {
  if (mem.has(clip.path)) return mem.get(clip.path);
  let blob = await getCache(clip.path);
  if (!blob) {
    if (!cloud.sb) throw new Error('Sign in to hear callouts.');
    const data = check(await cloud.sb.storage.from(BUCKET).download(clip.path));
    blob = new Blob([data], { type: clip.type || data.type || 'audio/mpeg' });
    putCache(clip.path, blob);
  }
  mem.set(clip.path, blob);
  return blob;
}

// Gets a profile's clips ready to play: { key: [url, …] }. Missing ones are left out.
export async function prepare(profileId, timeoutMs = 10000) {
  const p = profileById(profileId) || (await loadProfiles(true), profileById(profileId));
  if (!p) return { profile: null, urls: {}, missing: 0 };
  const urls = {};
  let missing = 0;
  const work = Promise.all((p.clips || []).map(async (c) => {
    try { const b = await clipBlob(c); (urls[c.key] = urls[c.key] || []).push({ url: URL.createObjectURL(b), clip: c }); }
    catch (e) { missing++; log('callout-missing', c.key, e.message || String(e)); }
  }));
  await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
  return { profile: p, urls, missing };
}

// One take of a callout, avoiding the take played last time.
const lastTake = {};
export function pick(prep, key) {
  const list = prep && prep.urls && prep.urls[key];
  if (!list || !list.length) return null;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && list[i].url === lastTake[key]) i = (i + 1) % list.length;
  lastTake[key] = list[i].url;
  return list[i];
}

// A quick listen (editor and admin page).
const preview = new Audio();
let previewUrl = null;
export async function playClip(clip) {
  const b = await clipBlob(clip);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(b);
  preview.src = previewUrl;
  await preview.play().catch(() => {});
}
export async function playKey(p, key) {
  const takes = (p && p.clips || []).filter((c) => c.key === key);
  if (!takes.length) return false;
  await playClip(takes[Math.floor(Math.random() * takes.length)]);
  return true;
}
