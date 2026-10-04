// "Write the narration with AI": the host describes the session in their own words; Claude (through
// the server function "write") writes every phase message, and optionally a short check-in at the start
// of each song with the time left in the round. Nothing is recorded until the host has read it through.
import * as S from './sessions.js?v=3.0.1-b12beced';
import { langOf } from './script.js?v=3.0.1-b12beced';
import { isV3 } from './eleven.js?v=3.0.1-b12beced';
import { callFunction } from './cloud.js?v=3.0.1-b12beced';

const minutes = (ms) => Math.round((ms / 60000) * 10) / 10;

// Check-ins: every song after the first in a round (the round's own message covers the first),
// when at least a minute of the round is left.
export function checkinSlots(s) {
  if (!S.songMode(s)) return [];
  const out = [];
  s.plan.rounds.forEach((songs, i) => {
    const total = S.sumMs(songs);
    let at = 0;
    songs.forEach((t, k) => {
      const left = total - at;
      if (k > 0 && left >= 60000) out.push({ id: `r${i + 1}s${k}`, round: i + 1, song: k, uri: t.uri, title: t.name, artists: t.artists, leftMin: Math.max(1, Math.round(left / 60000)) });
      at += t.durationMs || 0;
    });
  });
  return out;
}

export function buildAsk(s, prompt, withCheckins) {
  const lang = langOf(s.lang || 'en');
  const R = s.timing.rounds;
  const songs = S.songMode(s);
  const rounds = [];
  for (let r = 1; r <= R; r++) {
    rounds.push({
      n: r, label: r === 1 ? 'Round 1 (the first)' : r === R ? `Round ${r} (the final round)` : `Round ${r}`,
      minutes: minutes(S.roundMs(s, r)),
      songs: songs ? s.plan.rounds[r - 1].map((t) => ({ title: t.name, artists: t.artists, minutes: minutes(t.durationMs || 0) })) : undefined,
    });
  }
  return {
    lang: lang.code, langName: lang.name, prompt: String(prompt || '').trim(), tags: isV3(s.voice.modelId),
    session: { name: s.name || '', host: s.host || '', rounds, breakMin: s.timing.breakMin },
    cues: S.cues(s).map((c) => ({ id: c.id, title: c.title, when: c.when })),
    checkins: withCheckins ? checkinSlots(s).map(({ uri, ...x }) => x) : [],
  };
}

async function readError(r) {
  try { const j = await r.json(); const d = j.detail || j; return (d && d.message) || JSON.stringify(d); } catch { return `The AI writer answered ${r.status}.`; }
}

// Returns { messages: {cueId: text}, checkins: {slotId: text} }.
export async function writeNarration(s, prompt, withCheckins, signal) {
  const ask = buildAsk(s, prompt, withCheckins);
  let r;
  try { r = await callFunction('write', ask, signal); } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(e.status === 401 ? e.message : 'Could not reach the AI writer. Check the internet connection.');
  }
  if (!r.ok) throw new Error(await readError(r));
  return r.json();
}

// Puts the written texts into the session: phase messages replace the old text, check-ins replace
// earlier AI check-ins (messages you placed yourself stay).
export function applyNarration(s, result, withCheckins) {
  let msgs = 0, checks = 0;
  for (const c of S.cues(s)) {
    const t = result.messages && result.messages[c.id];
    if (t) { s.script[c.id] = t; msgs++; }
  }
  if (withCheckins) {
    s.inserts = (s.inserts || []).filter((x) => x.ai !== 'checkin');
    for (const slot of checkinSlots(s)) {
      const t = result.checkins && result.checkins[slot.id];
      if (!t) continue;
      s.inserts.push(S.newInsert({ text: t, uri: slot.uri, atMs: 4000, ai: 'checkin' }));
      checks++;
    }
  }
  return { msgs, checks };
}
