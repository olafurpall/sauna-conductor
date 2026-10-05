// Callouts: short clips real people recorded for Sauna Conductor ("Let's do this!", "Last song!",
// "That's a wrap!") that play next to the narration. Each person is an author (a callout profile with a
// short name, its "slug"). Any message can include any author's callouts as tokens like
// {callout:bubbi-morthens/lets-start}, picked from the gallery or placed by "Suggest callouts".
// Authors record their callouts on a public page the admin invites them to (record.html), or the admin
// adds them on the Callouts page. The clips live in the "callouts" storage bucket and are kept in the
// browser's cache for offline runs.
import { log, store } from './util.js';
import { app } from './app.js';
import { cloud } from './cloud.js';
import { parseRef } from './tokens.js';

// The callouts every author is asked for, with a suggested line (they say it their own way).
export const CATALOG = [
  { key: 'lets-start', label: 'Let’s do this', is: 'Gerum þetta!', when: 'Start of a round, after its message', isWhen: 'Í byrjun umferðar' },
  { key: 'getting-hot', label: 'It’s getting hot in here', is: 'Nú er farið að hitna hérna!', when: 'Middle of a round', isWhen: 'Um miðja umferð' },
  { key: 'almost-there', label: 'Hang in, we’re almost there', is: 'Haldið út, við erum alveg að verða komin!', when: 'Late in a round', isWhen: 'Seint í umferð' },
  { key: 'one-minute-left', label: '1 minute left', is: 'Ein mínúta eftir!', when: 'One minute before a round ends', isWhen: 'Þegar ein mínúta er eftir af umferð' },
  { key: 'last-song', label: 'Last song', is: 'Síðasta lagið!', when: 'When the last song of a round starts', isWhen: 'Þegar síðasta lag umferðar byrjar' },
  { key: 'done', label: 'Round done, nice work', is: 'Vel gert!', when: 'When a round ends, before the cool-down message', isWhen: 'Þegar umferð lýkur' },
  { key: 'final-done', label: 'That’s a wrap', is: 'Þá er þetta komið!', when: 'End of the session, before the last message', isWhen: 'Í lok gufustundarinnar' },
  { key: 'amazing', label: 'That was amazing', is: 'Þetta var geggjað!', when: 'After the last message', isWhen: 'Alveg í lokin' },
];
// Callouts play over the music: it only dips a little (to 90% of normal) unless set otherwise.
export const CALLOUT_MUSIC = 90;
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const catalogOf = (key) => CATALOG.find((c) => c.key === key) || null;
export const labelOf = (key) => (catalogOf(key) || {}).label || key.replace(/-/g, ' ');
export const suggestedLine = (key, lang) => { const c = catalogOf(key); return c ? (lang === 'is' ? c.is : c.label.replace(/’/g, "'") + '!') : ''; };
// The template a person is asked to record, in their language.
export const templateFor = (lang) => CATALOG.map((c) => ({ key: c.key, text: suggestedLine(c.key, lang), when: lang === 'is' ? c.isWhen : c.when }));

// "Þóra Hrund" → "thora-hrund" (Icelandic letters spelled out, accents dropped).
export const slugify = (s, max = 40) => String(s || '').toLowerCase()
  .replace(/þ/g, 'th').replace(/æ/g, 'ae').replace(/ð/g, 'd').replace(/ø/g, 'o').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
export const slugKey = (s) => slugify(s, 40);
export function uniqueSlug(name, taken) {
  const base = slugify(name, 50) || 'author';
  let s = base, n = 2;
  while (taken.has(s)) s = `${base}-${n++}`;
  return s;
}

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
  profiles: store.get(LIST_KEY, []),     // [{ id, slug, name, about, lang, consent, published, source, clips: [{ id, key, said, path, type, size, duration_ms }] }]
  loadedAt: 0,
  error: '',                             // why the profiles couldn't be loaded (e.g. the tables aren't there yet)
};
export const profileById = (id) => (id && callouts.profiles.find((p) => p.id === id)) || null;
export const profileBySlug = (slug) => (slug && callouts.profiles.find((p) => p.slug === slug)) || null;
const order = (k) => { const i = CATALOG.findIndex((c) => c.key === k); return i < 0 ? 100 : i; };
export const keysOf = (p) => (p ? [...new Set((p.clips || []).map((c) => c.key))].sort((a, b) => order(a) - order(b) || a.localeCompare(b)) : []);
// Authors anyone can use: published, with recordings.
export const usable = () => callouts.profiles.filter((p) => p.published && p.slug && (p.clips || []).length);
// What a callout says: the words of its first take, or the standard label.
export function saysOf(p, key) {
  const t = p && (p.clips || []).find((c) => c.key === key && c.said);
  return t ? t.said : labelOf(key);
}
// How long a callout plays (its longest take), for placing messages so they don't overlap.
export function calloutMs(ref, legacyId = '') {
  const { author, key } = parseRef(ref);
  const p = author ? profileBySlug(author) : profileById(legacyId);
  const ds = ((p && p.clips) || []).filter((c) => c.key === key).map((c) => c.duration_ms || 0);
  return ds.length ? Math.max(800, ...ds) : 1800;
}
// For showing a token to people: "📣 Bubbi: “Gerum þetta!”".
export function describeRef(ref, legacyProfile) {
  const { author, key } = parseRef(ref);
  const p = author ? profileBySlug(author) : legacyProfile;
  return p ? `${p.name}: “${saysOf(p, key)}”` : `“${labelOf(key)}”`;
}

const check = (res) => { if (res && res.error) throw res.error; return res ? res.data : null; };

// Profiles you can see (published ones; the admin sees all). Cached for offline use.
export async function loadProfiles(force = false) {
  if (!callouts.available || !cloud.sb) return callouts.profiles;
  if (!force && Date.now() - callouts.loadedAt < 60000) return callouts.profiles;
  try {
    const ps = check(await cloud.sb.from('callout_profiles').select('id,slug,name,about,lang,consent,published,source,created_at,updated_at').order('name', { ascending: true })) || [];
    const ids = ps.map((p) => p.id);
    const cs = ids.length ? check(await cloud.sb.from('callout_clips').select('id,profile_id,key,said,path,type,size,duration_ms,created_at').in('profile_id', ids)) || [] : [];
    // How each person agreed: only the admin can read these (others get no rows).
    let notes = [];
    try { notes = ids.length ? check(await cloud.sb.from('callout_notes').select('profile_id,consent_note').in('profile_id', ids)) || [] : []; } catch { /* not the admin */ }
    const noteOf = (id) => ((notes.find((n) => n.profile_id === id) || {}).consent_note) || '';
    callouts.profiles = ps.map((p) => ({ ...p, _savedNote: noteOf(p.id), consent_note: noteOf(p.id),
      clips: cs.filter((c) => c.profile_id === p.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) }));
    callouts.loadedAt = Date.now();
    callouts.error = '';
    store.set(LIST_KEY, callouts.profiles.map(({ consent_note, _savedNote, ...p }) => p));   // notes stay off the device
    app.emit('callouts');
  } catch (e) { callouts.error = e.message || String(e); log('callouts-load', callouts.error); }
  return callouts.profiles;
}
app.on('auth', (a) => { if (a && a.signedIn) loadProfiles(true); else { callouts.profiles = []; callouts.loadedAt = 0; store.del(LIST_KEY); } });
const remember = () => store.set(LIST_KEY, callouts.profiles.map(({ consent_note, _savedNote, ...p }) => p));

// ---------------------------------------------------------------- the admin's changes
export async function saveProfile(p) {
  if (!p.slug) p.slug = uniqueSlug(p.name, new Set(callouts.profiles.filter((x) => x !== p).map((x) => x.slug)));
  const row = { id: p.id, slug: p.slug, name: p.name.trim() || 'Unnamed', about: p.about || '', lang: p.lang || 'is', consent: !!p.consent,
    published: !!(p.published && p.consent), source: p.source || 'admin', updated_at: new Date().toISOString() };
  if (!p.created_at) row.created_by = cloud.user && cloud.user.id;
  check(await cloud.sb.from('callout_profiles').upsert(row));
  if ((p.consent_note || '') !== (p._savedNote || '')) {
    check(await cloud.sb.from('callout_notes').upsert({ profile_id: p.id, consent_note: p.consent_note || '', updated_at: row.updated_at }));
    p._savedNote = p.consent_note || '';
  }
  if (!p.created_at) p.created_at = row.updated_at;
  Object.assign(p, row);
  if (!p.clips) p.clips = [];
  if (!callouts.profiles.includes(p)) callouts.profiles.push(p);
  remember();
  app.emit('callouts');
  return p;
}

export async function deleteProfile(p) {
  const paths = (p.clips || []).map((c) => c.path);
  check(await cloud.sb.from('callout_profiles').delete().eq('id', p.id));
  if (paths.length) await cloud.sb.storage.from(BUCKET).remove(paths).catch(() => {});
  callouts.profiles = callouts.profiles.filter((x) => x.id !== p.id);
  remember();
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
  remember();
  app.emit('callouts');
  return row;
}

export async function updateClip(p, clip, patch) {
  check(await cloud.sb.from('callout_clips').update(patch).eq('id', clip.id));
  Object.assign(clip, patch);
  remember();
}

export async function deleteClip(p, clip) {
  check(await cloud.sb.from('callout_clips').delete().eq('id', clip.id));
  await cloud.sb.storage.from(BUCKET).remove([clip.path]).catch(() => {});
  p.clips = (p.clips || []).filter((c) => c.id !== clip.id);
  mem.delete(clip.path);
  remember();
  app.emit('callouts');
}

// ---------------------------------------------------------------- invitations to record (admin)
// Each invitation is a private link to the public recording page. Its author profile is made right
// away (a draft); the person's recordings land in it, and it is published when they send them.
export const inviteUrl = (token) => location.origin + location.pathname.replace(/[^/]*$/, '') + 'record.html?i=' + token;
const newToken = () => { const b = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export async function listInvites() {
  return check(await cloud.sb.from('callout_invites').select('id,token,profile_id,name,email,lang,note,status,opened_at,submitted_at,revoked,created_at').order('created_at', { ascending: false })) || [];
}

export async function createInvite({ name, email = '', lang = 'is', note = '' }) {
  name = String(name || '').trim();
  if (!name) throw new Error('Write the person’s name first.');
  await loadProfiles(true);
  const p = { id: uuid4(), name, about: '', lang, consent: false, published: false, source: 'invite', clips: [] };
  p.slug = uniqueSlug(name, new Set(callouts.profiles.map((x) => x.slug)));
  await saveProfile(p);
  const row = { id: uuid4(), token: newToken(), profile_id: p.id, name, email: String(email || '').trim(), lang, note: String(note || '').trim(),
    invited_by_name: (cloud.name || '').split(/[\s@]/)[0] || '', template: templateFor(lang).map(({ key, text }) => ({ key, text })),
    status: 'sent', revoked: false, created_by: cloud.user && cloud.user.id, created_at: new Date().toISOString() };
  try { check(await cloud.sb.from('callout_invites').insert(row)); }
  catch (e) { await deleteProfile(p).catch(() => {}); throw e; }
  return row;
}

export async function revokeInvite(inv) {
  check(await cloud.sb.from('callout_invites').update({ revoked: true }).eq('id', inv.id));
  inv.revoked = true;
}

// The invitation message, in the person's language, for email or a text message.
export function inviteMessage(inv, from) {
  const link = inviteUrl(inv.token);
  if (inv.lang === 'is') {
    return {
      subject: 'Viltu taka upp nokkur hvatningarorð fyrir gufuna?',
      body: `Hæ ${inv.name},\n\nÉg er að setja saman gufustundir með appinu Sauna Conductor og langar að fá þína rödd með: nokkur stutt hvatningarorð eins og „Gerum þetta!“ og „Síðasta lagið!“ sem spilast á milli og inni í lögunum.\n\nÞetta tekur um fimm mínútur og þú þarft bara símann eða tölvuna. Opnaðu þessa slóð:\n${link}\n\nTakk kærlega!\n${from || ''}`.trim(),
    };
  }
  return {
    subject: 'Would you record a few callouts for our sauna sessions?',
    body: `Hi ${inv.name},\n\nI'm putting together sauna sessions with an app called Sauna Conductor, and I'd love to have your voice in them: a few short callouts like "Let's do this!" and "Last song!" that play between and during the songs.\n\nIt takes about five minutes, on your phone or computer. Open this link:\n${link}\n\nThank you!\n${from || ''}`.trim(),
  };
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

// Gets the callouts a session uses ready to play: { urls: { 'author/key': [{ url, clip }] }, names: { author: name }, missing }.
// refs are "author/key"; a 3.1 ref without an author uses legacyId (the session's chosen profile).
export async function prepareRefs(refs, legacyId = '', timeoutMs = 10000) {
  refs = [...new Set(refs)];
  // A 3.1 token (no author) uses the session's profile; an older saved list may not know its short name yet.
  if (legacyId && refs.some((r) => !parseRef(r).author) && !(profileById(legacyId) || {}).slug) await loadProfiles(true);
  const legacy = profileById(legacyId);
  const want = new Map();       // author slug -> Set(keys)
  let missing = 0;
  for (const ref of refs) {
    const { author, key } = parseRef(ref);
    const a = author || (legacy && legacy.slug) || '';
    if (!a) { missing++; continue; }
    if (!want.has(a)) want.set(a, new Set());
    want.get(a).add(key);
  }
  if ([...want.keys()].some((a) => !profileBySlug(a))) await loadProfiles(true);
  const urls = {}, names = {};
  const jobs = [];
  for (const [a, keys] of want) {
    const p = profileBySlug(a);
    if (!p) { missing += keys.size; continue; }
    names[a] = p.name;
    for (const c of p.clips || []) {
      if (!keys.has(c.key)) continue;
      jobs.push((async () => {
        try { const b = await clipBlob(c); (urls[`${a}/${c.key}`] = urls[`${a}/${c.key}`] || []).push({ url: URL.createObjectURL(b), clip: c }); }
        catch (e) { missing++; log('callout-missing', a, c.key, e.message || String(e)); }
      })());
    }
  }
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  return { urls, names, missing, legacy: legacy ? legacy.slug : '' };
}

// One take of a callout, avoiding the take played last time.
const lastTake = {};
export function pick(prep, ref) {
  if (!prep) return null;
  const { author, key } = parseRef(ref);
  const full = `${author || prep.legacy}/${key}`;
  const list = prep.urls && prep.urls[full];
  if (!list || !list.length) return null;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && list[i].url === lastTake[full]) i = (i + 1) % list.length;
  lastTake[full] = list[i].url;
  return { ...list[i], author: author || prep.legacy, key, name: prep.names[author || prep.legacy] || '' };
}

// A quick listen (editor, gallery and admin page).
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
export const stopPreview = () => { try { preview.pause(); } catch { /* ignore */ } };
