// Session model: everything needed to replay a sauna session exactly.
import { uid, blobToBase64, base64ToBlob } from './util.js?v=2.4-5089199b';
import { cuePlan, defaultScript, defaultText } from './script.js?v=2.4-5089199b';
import { clipKey } from './eleven.js?v=2.4-5089199b';
import * as db from './db.js?v=2.4-5089199b';

export const DEFAULT_VOICE = {
  id: 'xuiKYsOhCzCAyIdb1aX3', name: 'Clint Brooks',
  desc: 'A clear southern baritone with deep resonance, made for storytelling.',
  labels: ['american', 'middle aged', 'male', 'narrative'],
  previewUrl: '', modelId: 'eleven_v3', stability: 0.5, similarity: 0.75, style: 0, speed: 1,
};

export function newSession(over = {}) {
  const t = Date.now();
  const s = {
    id: uid(), name: 'New session', createdAt: t, updatedAt: t, lastRunAt: null,
    music: { heat: null, cool: null, shuffle: false, smooth: true, fadeSec: 6 },
    // mode 'songs': each round is a planned set of whole songs (roundMin = the length to aim for)
    // mode 'timed': each round lasts exactly roundMin minutes
    timing: { mode: 'songs', rounds: 4, roundMin: 15, minMin: 14, maxMin: 20, breakMin: 7, autoNext: true, keepOrder: true },
    plan: null,   // { source, rounds: [[track…]…], pool: [track…], offset, seed, at }
    levels: { heat: 80, cool: 45, duck: 20, narr: 100 },
    voice: { ...DEFAULT_VOICE },
    script: defaultScript(4, 15),
  };
  return Object.assign(s, over);
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

export function ensureScript(s) {
  ensureTiming(s);
  for (const c of cues(s)) if (typeof s.script[c.id] !== 'string') s.script[c.id] = defaultText(c.id, s.timing.rounds, s.timing.roundMin);
  return s;
}

// 'missing' | 'ready' | 'outdated' | 'uploaded'
export function clipState(s, cueId, rec) {
  if (!rec || !rec.blob) return 'missing';
  if (rec.source === 'uploaded') return 'uploaded';
  return rec.key === clipKey(s.script[cueId] || '', s.voice) ? 'ready' : 'outdated';
}

export async function readiness(s) {
  const recs = await db.clips.forSession(s.id);
  const list = cues(s).map((c) => ({ ...c, state: clipState(s, c.id, recs[c.id]) }));
  const ok = list.filter((c) => c.state === 'ready' || c.state === 'uploaded').length;
  return { list, ok, total: list.length, recs };
}

export async function save(s) {
  s.updatedAt = Date.now();
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
  for (const c of cues(s)) {
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
