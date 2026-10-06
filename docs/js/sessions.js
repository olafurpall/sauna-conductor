// Session model: everything needed to replay a sauna session exactly.
import { uid, blobToBase64, base64ToBlob, fmtSong, store } from './util.js?v=3.2.1-8eb03f85';
import { cuePlan, defaultScript, defaultText } from './script.js?v=3.2.1-8eb03f85';
import { clipKey } from './eleven.js?v=3.2.1-8eb03f85';
import { calloutOnly } from './tokens.js?v=3.2.1-8eb03f85';
import * as db from './db.js?v=3.2.1-8eb03f85';

export const DEFAULT_VOICE = {
  id: 'xuiKYsOhCzCAyIdb1aX3', name: 'Clint Brooks',
  desc: 'A clear southern baritone with deep resonance, made for storytelling.',
  labels: ['american', 'middle aged', 'male', 'narrative'],
  previewUrl: '', modelId: 'eleven_v3', stability: 0.5, similarity: 0.75, style: 0, speed: 1,
};

// Native Icelandic voices in the ElevenLabs voice library (Reykjavík accent). They need Eleven v3 or
// newer: older models (Multilingual v2, Flash) don't speak Icelandic.
export const RECOMMENDED_VOICES = {
  is: [
    { id: 'EPNZHjyiFUvsaPPq9zRU', name: 'Ingibjorg - Calm, Warm Ad', desc: 'Mellow and relaxed, smooth and reassuring. A good start for the sauna.', labels: ['icelandic', 'female', 'calm', 'warm'] },
    { id: 'rx2Jwpr6lciMIbfYvpOA', name: 'Katrin - Warm, Patient Friend', desc: 'Warm and unhurried, like an old friend settling in for a chat.', labels: ['icelandic', 'female', 'warm', 'conversational'] },
    { id: 'phADS9h1woMxkLioLz5z', name: 'Sigrun - Calm, Direct Narrator', desc: 'Plain, steady and warm narration that puts clarity first.', labels: ['icelandic', 'female', 'narrator'] },
    { id: '6LR26ZnZ2USBpLHfBBH7', name: 'Bjorn - Calm, Serious Narrator', desc: 'Low and deep, measured and unhurried.', labels: ['icelandic', 'male', 'deep', 'narrator'] },
    { id: 'bXhV5Ndu4ILBlw7Vibmd', name: 'Gunnar - Calm, Serious Narrator', desc: 'Deep and even, calm authority without drama.', labels: ['icelandic', 'male', 'deep', 'narrator'] },
    { id: 'B4dcQDH3p7a2cAn9wzSc', name: 'Baldur - Patient Support Agent', desc: 'Light and patient, clear and never rushed.', labels: ['icelandic', 'male', 'patient'] },
  ],
};
// Which narration models speak a language (Eleven v3 and newer speak 70+ languages, Icelandic included).
const V2_LANGS = ['en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru'];
export function modelSpeaks(modelId, lang) {
  const m = String(modelId || '');
  if (!lang || lang === 'en' || /_v[3-9]/.test(m)) return true;
  if (/multilingual_v2/.test(m)) return V2_LANGS.includes(lang);
  if (/(flash|turbo)_v2_5/.test(m)) return [...V2_LANGS, 'hu', 'no', 'nb', 'vi'].includes(lang);
  return true;
}
// The language and host a session's default texts are written for.
export const textOpts = (s) => ({ lang: s.lang || 'en', host: s.host });

export function newSession(over = {}) {
  const t = Date.now();
  const s = {
    id: uid(), name: '', notes: '', lang: 'en', host: '', createdAt: t, updatedAt: t, lastRunAt: null,
    music: { heat: null, cool: null, shuffle: false, smooth: true, fadeSec: 6 },
    // mode 'songs': each round is a planned set of whole songs (roundMin = the length to aim for)
    // mode 'timed': each round lasts exactly roundMin minutes
    timing: { mode: 'songs', rounds: 4, roundMin: 15, minMin: 14, maxMin: 20, breakMin: 7, autoNext: true, keepOrder: true },
    plan: null,   // { source, rounds: [[track…]…], pool: [track…], offset, seed, at,
                  //   breaks: [[track…]…] (one per cool-down), coolSource: uri or '' (= from pool), coolPool: [track…] }
    inserts: [],  // messages placed inside songs: { id, text, uri, atMs, duck, narr }
    levels: { heat: 80, cool: 45, duck: 20, narr: 100 },
    voice: { ...DEFAULT_VOICE },
    script: null,
  };
  Object.assign(s, over);
  if (!s.script) s.script = defaultScript(s.timing.rounds, s.timing.roundMin, textOpts(s));
  return s;
}

export function ensureTiming(s) {
  const t = s.timing;
  if (!t.mode) t.mode = 'timed';
  if (t.minMin == null) t.minMin = Math.max(1, t.roundMin - 1);
  if (t.maxMin == null) t.maxMin = t.roundMin + 5;
  if (t.keepOrder == null) t.keepOrder = true;
  if (s.plan === undefined) s.plan = null;
  return s;
}

export const sumMs = (list) => (list || []).reduce((n, x) => n + (x.durationMs || 0), 0);

// A plan is usable when it was made from the current heat playlist for the current number of rounds.
export function planValid(s) {
  const p = s.plan;
  return !!(p && s.music.heat && p.source === s.music.heat.uri && Array.isArray(p.rounds) && p.rounds.length === s.timing.rounds);
}
export const songMode = (s) => s.timing.mode === 'songs' && planValid(s);

export function roundMs(s, r) {
  return songMode(s) ? sumMs(s.plan.rounds[r - 1]) : s.timing.roundMin * 60000;
}

export function totalMs(s) {
  const t = s.timing;
  let ms = Math.max(0, t.rounds - 1) * t.breakMin * 60000;
  for (let r = 1; r <= t.rounds; r++) ms += roundMs(s, r);
  return ms;
}

export const cues = (s) => cuePlan(s.timing.rounds);

// ---------------------------------------------------------------- songs per phase
// Planned cool-down songs exist when the plan has one list per break.
export const breaksPlanned = (s) => !!(songMode(s) && Array.isArray(s.plan.breaks) && s.plan.breaks.length === Math.max(0, s.timing.rounds - 1));
// The pool that cool-down songs are swapped with / added from.
export const coolPoolOf = (s) => (s.plan && s.plan.coolSource ? (s.plan.coolPool = s.plan.coolPool || []) : (s.plan ? s.plan.pool : []));

// Every phase that plays a known list of songs, in session order.
export function phaseLists(s) {
  const out = [];
  if (!songMode(s)) return out;
  const R = s.timing.rounds, br = breaksPlanned(s);
  for (let r = 1; r <= R; r++) {
    out.push({ key: 'r' + r, type: 'round', n: r, label: r === R && R > 1 ? 'Final round' : `Round ${r}`, songs: s.plan.rounds[r - 1] });
    if (r < R) out.push({ key: 'b' + r, type: 'break', n: r, label: `Cool-down ${r}`, songs: br ? s.plan.breaks[r - 1] : null, limitMs: s.timing.breakMin * 60000 });
  }
  return out;
}

// Where a song is in the session (the first place it appears).
export function findSong(s, uri) {
  for (const ph of phaseLists(s)) {
    const k = (ph.songs || []).findIndex((t) => t.uri === uri);
    if (k >= 0) return { phase: ph, k, song: ph.songs[k] };
  }
  return null;
}

// ---------------------------------------------------------------- messages inside songs
export const insertCue = (ins) => 'x-' + ins.id;
export const findInsert = (s, cueId) => (s.inserts || []).find((x) => insertCue(x) === cueId) || null;
const short = (t, n = 46) => { const x = String(t || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x || 'New message'; };
export function insertWhen(s, ins) {
  const at = findSong(s, ins.uri);
  if (!at) return 'Not placed: its song is no longer in the session';
  return `${at.phase.label} · in “${at.song.name}” at ${fmtSong(ins.atMs)}`;
}
export function newInsert(over = {}) {
  return Object.assign({ id: uid().slice(0, 12), text: '', uri: '', atMs: 30000, duck: null, narr: null }, over);
}
// The text a cue reads: a phase message from the script, or a message placed in a song.
export function cueText(s, cueId) {
  if (String(cueId).startsWith('x-')) { const ins = findInsert(s, cueId); return ins ? ins.text || '' : ''; }
  return (s.script && s.script[cueId]) || '';
}
// Phase messages plus messages placed in songs.
export function allCues(s) {
  return [...cues(s), ...(s.inserts || []).map((ins) => ({ id: insertCue(ins), title: 'Message: ' + short(ins.text), when: insertWhen(s, ins), insert: ins }))];
}

// ---------------------------------------------------------------- plays
// Counted from this browser's run history; the cloud adds plays from other computers and people.
export const countsAsPlay = (run) => run && (run.status === 'completed' || (run.elapsedMs || 0) >= 10 * 60000);
export function localPlays() {
  const out = {};
  for (const r of store.get('runs', [])) {
    if (!r.sessionId || !countsAsPlay(r)) continue;
    const o = (out[r.sessionId] = out[r.sessionId] || { n: 0, last: 0 });
    o.n++; o.last = Math.max(o.last, r.endedAt || r.startedAt || 0);
  }
  return out;
}
export function plays(s) {
  const cloud = store.get('plays', {})[s.id];
  const local = localPlays()[s.id];
  const n = Math.max(cloud ? cloud.n : 0, local ? local.n : 0);
  const last = Math.max(cloud ? cloud.last || 0 : 0, local ? local.last : 0, s.lastRunAt || 0);
  return { n, last };
}

export function ensureScript(s) {
  ensureTiming(s);
  if (!Array.isArray(s.inserts)) s.inserts = [];
  if (typeof s.notes !== 'string') s.notes = '';
  if (!s.lang) s.lang = 'en';
  for (const c of cues(s)) if (typeof s.script[c.id] !== 'string') s.script[c.id] = defaultText(c.id, s.timing.rounds, s.timing.roundMin, textOpts(s));
  return s;
}

// "Without AI narration": the guide speaks; the phase messages aren't recorded or played
// (their callouts still play, and so do messages inside songs).
export const narrationOn = (s) => s.narration !== false;
export const isPhaseCue = (cueId) => !String(cueId).startsWith('x-');

// 'missing' | 'ready' | 'outdated' | 'uploaded' | 'callout' (only callouts: nothing to record) | 'off' (narration off)
export const clipOkState = (st) => st === 'ready' || st === 'uploaded' || st === 'callout' || st === 'off';
export function clipState(s, cueId, rec) {
  if (!narrationOn(s) && isPhaseCue(cueId)) return 'off';
  if (calloutOnly(cueText(s, cueId))) return 'callout';
  if (!rec || !rec.blob) return 'missing';
  if (rec.source === 'uploaded') return 'uploaded';
  return rec.key === clipKey(cueText(s, cueId), s.voice) ? 'ready' : 'outdated';
}

export async function readiness(s) {
  const recs = await db.clips.forSession(s.id);
  const list = allCues(s).map((c) => ({ ...c, state: clipState(s, c.id, recs[c.id]) }));
  const ok = list.filter((c) => clipOkState(c.state)).length;
  return { list, ok, total: list.length, recs };
}

export async function save(s) {
  s.updatedAt = Date.now();
  try { s.totalMin = Math.round(totalMs(s) / 60000); } catch { /* not planned yet */ }
  await db.sessions.put(s);
  return s;
}

export async function duplicate(s) {
  const copy = JSON.parse(JSON.stringify(s));
  copy.id = uid();
  copy.name = s.name + ' (copy)';
  copy.createdAt = copy.updatedAt = Date.now();
  copy.lastRunAt = null;
  const recs = await db.clips.forSession(s.id);
  for (const [cue, rec] of Object.entries(recs)) await db.clips.put(copy.id, cue, rec);
  await db.sessions.put(copy);
  return copy;
}

export async function remove(s) {
  await db.clips.delSession(s.id);
  await db.sessions.del(s.id);
}

export async function exportFile(s) {
  const recs = await db.clips.forSession(s.id);
  const clips = {};
  for (const c of allCues(s)) {
    const r = recs[c.id];
    if (r && r.blob) clips[c.id] = { key: r.key, source: r.source, chars: r.chars, at: r.at, type: r.blob.type || 'audio/mpeg', data: await blobToBase64(r.blob) };
  }
  const payload = { format: 'sauna-conductor-session', version: 1, exported_at: new Date().toISOString(), session: s, clips };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function importFile(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch { throw new Error('That file is not a Sauna Conductor session.'); }
  if (!j || j.format !== 'sauna-conductor-session' || !j.session) throw new Error('That file is not a Sauna Conductor session.');
  const s = j.session;
  const existing = await db.sessions.get(s.id);
  if (existing) { s.id = uid(); s.name = s.name + ' (imported)'; }
  s.updatedAt = Date.now();
  ensureScript(s);
  for (const [cue, c] of Object.entries(j.clips || {})) {
    await db.clips.put(s.id, cue, { blob: base64ToBlob(c.data, c.type || 'audio/mpeg'), key: c.key, source: c.source || 'generated', chars: c.chars || 0, at: c.at || Date.now() });
  }
  await db.sessions.put(s);
  return s;
}
