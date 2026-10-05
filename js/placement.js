// Where everything sits in session time (for sessions whose rounds follow the songs): the songs, the
// phase messages, the messages and callouts inside songs. And a free spot for a message, so that two
// never play over each other (the timeline and "Suggest callouts" both use it).
import * as S from './sessions.js';
import { prepText } from './eleven.js';
import { refsIn, calloutOnly } from './tokens.js';
import { calloutMs } from './callouts.js';

export const GAP = 500;                  // at least this much quiet between two messages

// How long a message plays (ms): its recording (measured, or estimated from the text) plus its callouts.
export function messageMs(s, cueId, recordedMs = 0) {
  const text = S.cueText(s, cueId);
  const legacy = s.callouts && s.callouts.profile;
  const co = refsIn(text).reduce((n, r) => n + calloutMs(r, legacy) + 300, 0);
  if (!S.narrationOn(s) && S.isPhaseCue(cueId)) return co;          // without narration only its callouts play
  if (calloutOnly(text)) return Math.max(800, co);
  const speech = recordedMs || Math.max(2000, Math.round(prepText(text, s.voice.modelId).length / 14 * 1000));
  return speech + co;
}
// A rough length of a recording from its size, before it has been measured.
export function recordedMsGuess(rec) {
  if (!rec || !rec.blob) return 0;
  const size = rec.blob.size || 0;
  return /wav/.test(rec.blob.type || '') ? Math.round(Math.max(0, size - 44) / 64) : Math.round(size / 16);   // 32 kHz mono WAV, 128 kbps MP3
}

export function sessionLayout(s, lenOf) {
  const R = s.timing.rounds;
  const segs = [], songs = [];
  let t = 0;
  for (const ph of S.phaseLists(s)) {
    const start = t;
    const cue = ph.type === 'round' ? (ph.n === 1 ? 'welcome' : ph.n === R && R > 1 ? 'final' : 'round' + ph.n) : 'end' + ph.n;
    if (ph.type === 'round') {
      for (const [k, song] of ph.songs.entries()) { songs.push({ song, start: t, end: t + song.durationMs, phase: ph, k }); t += song.durationMs; }
    } else {
      const limit = ph.limitMs;
      let x = t;
      for (const [k, song] of (ph.songs || []).entries()) {
        if (x - t >= limit) break;
        const end = Math.min(x + song.durationMs, t + limit);
        songs.push({ song, start: x, end, cut: end < x + song.durationMs, phase: ph, k });
        x += song.durationMs;
      }
      t += limit;
    }
    segs.push({ ph, start, end: t, cue });
  }
  const closeMs = Math.max(60000, lenOf('closing') + 20000);
  segs.push({ ph: { type: 'closing', label: 'Closing', key: 'closing' }, start: t, end: t + closeMs, cue: 'closing' });
  t += closeMs;
  return { segs, songs, total: t };
}

export const songAtIn = (L, ms) => L.songs.find((x) => ms >= x.start && ms < x.end) || null;
export function insertStartIn(L, ins) {
  const x = L.songs.find((y) => y.song.uri === ins.uri);
  return x ? x.start + ins.atMs : null;
}

// [start, end] of everything that plays narration, except one message (the one being placed).
export function busyIntervals(s, L, lenOf, exceptId) {
  const out = [];
  for (const sg of L.segs) out.push([sg.start, sg.start + lenOf(sg.cue)]);
  for (const x of s.inserts || []) {
    if (x.id === exceptId) continue;
    const st = insertStartIn(L, x);
    if (st != null) out.push([st, st + lenOf(S.insertCue(x))]);
  }
  return out;
}

// The time nearest to `want` (on a 0.5 s grid, inside a song, within range if given) where a message
// of len ms plays without overlapping anything in busy. null if there's no room.
export function fitTime(L, busy, len, want, range = null) {
  const lo = range ? range[0] : 0, hi = range ? range[1] : L.total;
  const free = (t) => t >= lo && t + Math.min(len, 1500) <= hi && !!songAtIn(L, t) && busy.every(([a, b]) => t + len + GAP <= a || t >= b + GAP);
  const w = Math.round(want / 500) * 500;
  if (free(w)) return w;
  const cands = [];
  for (const [a, b] of busy) cands.push(Math.ceil((b + GAP) / 500) * 500, Math.floor((a - len - GAP) / 500) * 500);
  for (const sn of L.songs) cands.push(Math.ceil(sn.start / 500) * 500);
  const ok = cands.filter(free).sort((x, y) => Math.abs(x - want) - Math.abs(y - want));
  return ok.length ? ok[0] : null;
}

// A session time as a place in a song: { uri, atMs }.
export function songPos(L, t) {
  const sn = songAtIn(L, t);
  if (!sn) return null;
  return { uri: sn.song.uri, atMs: Math.max(0, Math.min(Math.round(t - sn.start), Math.max(0, sn.song.durationMs - 1000))) };
}
