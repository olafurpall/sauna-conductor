// Round planner: splits a playlist into rounds of whole songs.
// Each round has minSongs–maxSongs songs and lasts between minMs and maxMs,
// as close to aimMs as possible. Dynamic programming over the song sequence.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const playable = (tracks) => tracks.filter((t) => /^spotify:track:/.test(t.uri || '') && t.durationMs > 0);
export const sumMs = (list) => list.reduce((n, t) => n + (t.durationMs || 0), 0);

// Returns { rounds: [[track…]…], unused: [track…] } or { error }.
export function planRounds(allTracks, o) {
  const R = o.rounds, minS = o.minSongs ?? 3, maxS = o.maxSongs ?? 6;
  const tracks = playable(allTracks).map((t, i) => ({ ...t, i }));
  if (tracks.length < R * minS) {
    return { error: `The playlist has ${tracks.length} playable songs. ${R} rounds of at least ${minS} songs need ${R * minS}.` };
  }
  let seq;
  if (o.keepOrder) {
    const off = ((o.offset || 0) % tracks.length + tracks.length) % tracks.length;
    seq = tracks.slice(off).concat(tracks.slice(0, off));
  } else {
    const rand = rng(o.seed || 1);
    seq = tracks.slice();
    for (let i = seq.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
  }
  const n = seq.length;
  const SKIP = o.keepOrder ? 1.2 : 0.02;
  const dev = (ms) => { const d = (ms - o.aimMs) / 60000; return d >= 0 ? d * d * 0.5 : d * d * 1.3; };

  const best = Array.from({ length: n + 1 }, () => new Float64Array(R + 1).fill(Infinity));
  const prev = Array.from({ length: n + 1 }, () => new Int32Array(R + 1).fill(-2));
  best[0][0] = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < R; r++) {
      const c0 = best[i][r];
      if (c0 === Infinity) continue;
      if (c0 + SKIP < best[i + 1][r]) { best[i + 1][r] = c0 + SKIP; prev[i + 1][r] = -1; }
      let sum = 0;
      for (let k = 1; k <= maxS && i + k <= n; k++) {
        sum += seq[i + k - 1].durationMs;
        if (sum > o.maxMs) break;
        if (k < minS || sum < o.minMs) continue;
        const c = c0 + dev(sum);
        if (c < best[i + k][r + 1]) { best[i + k][r + 1] = c; prev[i + k][r + 1] = i; }
      }
    }
  }
  let end = -1, bestCost = Infinity;
  for (let i = 0; i <= n; i++) if (best[i][R] < bestCost) { bestCost = best[i][R]; end = i; }
  if (end < 0) {
    const mins = (ms) => Math.round(ms / 60000);
    return { error: `Couldn't fit ${R} rounds of ${minS}–${maxS} songs between ${mins(o.minMs)} and ${mins(o.maxMs)} minutes from this playlist. Try a longer playlist, fewer rounds, or a wider range.` };
  }
  const rounds = [];
  let i = end, r = R;
  while (r > 0) {
    const p = prev[i][r];
    if (p === -1) { i -= 1; continue; }
    rounds.unshift(seq.slice(p, i));
    i = p; r -= 1;
  }
  const used = new Set(rounds.flat().map((t) => t.i));
  const unused = tracks.filter((t) => !used.has(t.i));
  // index after the last song used, so "suggest again" can continue from there
  const lastUsed = rounds.length ? rounds[rounds.length - 1][rounds[rounds.length - 1].length - 1].i : 0;
  return { rounds, unused, nextOffset: lastUsed + 1 };
}
