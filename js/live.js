// Live view: runs a saved session — clock, music phases, narration and song controls.
import { $, $$, h, sleep, clamp, now, fmt, fmtSong, toast, log, store, uid } from './util.js';
import { app, cfg } from './app.js';
import * as db from './db.js';
import * as S from './sessions.js';
import { cueForRound } from './script.js';
import { player, auth } from './spotify.js';
import { prefs } from './cloud.js';
import { preview } from './preview.js';
import { stripTokens, tokensIn, refsIn, calloutOnly } from './tokens.js';
import { callouts, prepareRefs as prepareCalloutRefs, pick as pickCallout, labelOf as calloutLabel, CALLOUT_MUSIC } from './callouts.js';

const el = $('#view-live');
let sess = null;          // loaded session
let clipUrls = {};        // cue -> object URL
let clipOk = {};          // cue -> true if the recording matches the text
const cueMeta = {};

export const liveView = {
  el,
  async enter(id) {
    if (id && (!sess || sess.id !== id)) {
      if (engine.running) { toast('A session is already running. End it before loading another.'); }
      else await load(id);
    }
    renderAll();
  },
  get session() { return sess; },
  get running() { return engine.running; },
  async resume(r) {
    if (engine.running) { toast('A session is already running.'); return; }
    if (!sess || sess.id !== r.sessionId) await load(r.sessionId);
    if (!sess || sess.id !== r.sessionId) return;
    renderAll();
    await resumeSession(r);
  },
};

async function load(id) {
  const s = await db.sessions.get(id);
  if (!s) { toast('That session no longer exists.'); return; }
  Object.values(clipUrls).forEach((u) => URL.revokeObjectURL(u));
  clipUrls = {}; clipOk = {};
  S.ensureScript(s);
  const r = await S.readiness(s);
  for (const c of r.list) {
    cueMeta[c.id] = c;
    const rec = r.recs[c.id];
    if (c.state === 'callout' || c.state === 'off') clipOk[c.id] = true;   // nothing recorded to play
    else if (rec && rec.blob) { clipUrls[c.id] = URL.createObjectURL(rec.blob); clipOk[c.id] = S.clipOkState(c.state); }
  }
  sess = s;
  $('#tabLive').disabled = false;
  engine.plan = buildPlan();
  buildTimeline();
  co.ready = prepareCallouts(s);
}

// ---------------------------------------------------------------- callouts
// Clips real people recorded ("Let's do this!"), from any author. Tokens in a message play just before
// it (at its start) or right after it. A message can be only callouts (a callout inside a song).
const co = { prep: null, ready: null, said: '' };
async function prepareCallouts(s) {
  if (co.prep) Object.values(co.prep.urls).flat().forEach((x) => URL.revokeObjectURL(x.url));
  co.prep = null;
  const refs = S.allCues(s).flatMap((c) => refsIn(S.cueText(s, c.id)));
  if (!refs.length || !callouts.available) return;
  let prep;
  try { prep = await prepareCalloutRefs(refs, s.callouts && s.callouts.profile); } catch (e) { log('callouts-error', e.message || String(e)); return; }
  if (sess !== s) { Object.values(prep.urls).flat().forEach((x) => URL.revokeObjectURL(x.url)); return; }
  co.prep = prep;
  if (prep.missing) toast(`${prep.missing} callout${prep.missing > 1 ? 's' : ''} could not be loaded (offline, or no longer available). The rest will play.`, 5000);
  log('callouts-ready', Object.keys(prep.names).join(','), Object.keys(prep.urls).length);
}

function calloutsFor(text) {
  const t = tokensIn(text);
  return { before: t.before, after: t.after };
}

async function playCallout(ref, tok, volume) {
  const take = pickCallout(co.prep, ref);
  if (!take) { log('callout-missing', ref); return 'none'; }
  await waitWhilePaused(tok);
  if (tok !== engine.token) return 'stopped';
  const id = 'co:' + ref;
  co.said = `${take.name || 'Callout'}: “${take.clip.said || calloutLabel(take.key)}”`;
  narr.active = id; renderNarr();
  const r = await playUrl(take.url, volume);
  if (tok === engine.token && narr.active === id) { narr.active = null; renderNarr(); }
  log('callout', `${take.author}/${take.key}`, r);
  return r;
}

// ---------------------------------------------------------------- Talk (push to talk)
// The guide presses Talk to say something: the music dips to their Talk level (Settings, 40% by
// default) and any narration that is playing fades out and is left unfinished (the guide says it).
// While talking, no narration, messages or callouts start. Resume brings the music back up.
// Where Spotify can't change the volume (a phone plays at its own volume), Talk pauses the music
// instead and Resume plays it again ("held").
const talk = { on: false, mul: 1, timer: 0, held: false, paused: false };
const canDip = () => !music.live || player.canSetVolume;
const deviceWord = () => (/tablet/i.test(cfg.deviceType || '') ? 'the tablet' : /smartphone/i.test(cfg.deviceType || '') ? 'the phone' : 'this device');
const talkLevel = () => clamp((prefs().talkLevel ?? 40) / 100, 0, 1);
function talkTo(target, ms) {
  clearInterval(talk.timer);
  const from = talk.mul, steps = Math.max(1, Math.round(ms / 50));
  let i = 0;
  talk.timer = setInterval(() => {
    i++;
    talk.mul = i >= steps ? target : from + (target - from) * (i / steps);
    music.apply();
    if (i >= steps) clearInterval(talk.timer);
  }, ms / steps);
}
function fadeOutNarration(ms = 1200) {
  if (!narr.stop && !narr.active) return;
  narr.seq++;                                   // the rest of this message (its callouts) won't play
  const mine = narr.seq;
  const a = narr.audio, v0 = a.volume, steps = 16;
  if (!narr.tts && v0 > 0.02) a.volume = v0 * 0.97;
  // The browser voice can't fade, and on iPhone a page can't change the volume: stop it at once.
  if (narr.tts || (v0 > 0.02 && Math.abs(a.volume - v0) < 0.001)) { stopNarration(); return; }
  let i = 0;
  clearInterval(narr.fade);
  narr.fade = setInterval(() => {
    if (narr.seq !== mine) { clearInterval(narr.fade); return; }     // something else took over
    i++;
    a.volume = clamp(v0 * (1 - i / steps), 0, 1);
    if (i >= steps) { clearInterval(narr.fade); stopNarration(); }
  }, ms / steps);
}
function holdMusic() {
  talk.held = true;
  if (music.live && !player.paused) { talk.paused = true; player.pause(); }
  log('talk-hold', talk.paused ? 'paused' : 'not playing');
  renderMeter(music.level * music.trans * talk.mul);
}
function releaseMusic() {
  const play = talk.paused && music.live && !engine.paused && !music.userPaused;
  talk.held = false; talk.paused = false;
  if (play) player.resume();
  renderMeter(music.level * music.trans * talk.mul);
}
function toggleTalk(force) {
  if (!engine.running && !talk.on) return;
  const on = force === undefined ? !talk.on : !!force;
  if (on === talk.on) return;
  talk.on = on;
  log('talk', on ? 'on' : 'off', canDip() ? Math.round(talkLevel() * 100) : 'pause');
  if (on) { fadeOutNarration(); if (canDip()) talkTo(talkLevel(), 900); else holdMusic(); }
  else { if (talk.held) releaseMusic(); talkTo(1, 1500); }
  render();
}
app.on('prefs', () => { if (talk.on && !talk.held) talkTo(talkLevel(), 400); });
// Spotify refused a volume change: from now on Talk pauses the music on this device.
let volumeWarned = false;
app.on('volume-blocked', () => {
  if (!engine.running) return;
  if (talk.on && !talk.held) { clearInterval(talk.timer); talk.mul = 1; holdMusic(); }
  warnVolume();
  render(); renderMeter(music.level * music.trans * talk.mul);
});
function warnVolume() {
  if (volumeWarned || !music.live || player.canSetVolume) return;
  volumeWarned = true;
  log('volume-fixed', cfg.deviceName || '');
  toast(`Spotify can’t change the volume on ${cfg.deviceName || deviceWord()}, so the music plays at ${deviceWord()}’s own volume. Talk pauses the music instead of turning it down.`, 9000);
}
const talkText = () => (talk.held ? 'You’re talking · music paused' : `You're talking · music at ${Math.round(talkLevel() * 100)}%`);

// ---------------------------------------------------------------- music level
// Volume = phase level × song-transition multiplier.
const music = {
  level: 0, trans: 1, demoCtx: null,
  get live() { return !cfg.demo && player.ready; },
  apply() {
    const v = clamp(this.level * this.trans * talk.mul, 0, 1);
    if (this.live) player.setVolume(v);
    renderMeter(v);
  },
  set(v) { this.level = clamp(v, 0, 1); this.apply(); },
  async fadeTo(target, ms, tok) {
    const start = this.level;
    const stepMs = player.mode === 'connect' && !cfg.demo ? 250 : 100;
    const steps = Math.max(1, Math.round(ms / stepMs));
    for (let i = 1; i <= steps; i++) {
      if (tok !== undefined && tok !== engine.token) return false;
      this.set(i === steps ? target : start + (target - start) * (i / steps));
      await sleep(ms / steps);
    }
    log('level', target.toFixed(2));
    return true;
  },
};

const heatUri = () => sess && sess.music.heat && sess.music.heat.uri;
const coolUri = () => (sess && sess.music.cool && sess.music.cool.uri) || heatUri();
let heatResume = null;

async function switchMusic(kind, tok, startLevel) {
  if (!music.live) {
    const ctx = kind === 'heat' ? 'demo:heat' : sess.music.cool ? 'demo:cool' : 'demo:heat';
    if (music.demoCtx && music.demoCtx !== ctx) { await music.fadeTo(0, 2500, tok); if (tok !== engine.token) return; }
    music.demoCtx = ctx;
    renderNowPlaying();
    await music.fadeTo(startLevel, 1500, tok);
    return;
  }
  const uri = kind === 'heat' ? heatUri() : coolUri();
  if (!uri) return;
  const res = resumeFor(uri);
  if (player.contextUri === uri && !res) {
    if (player.paused && !talk.held) await player.resume();
    await music.fadeTo(startLevel, 2500, tok);
    return;
  }
  if (!player.paused) { await music.fadeTo(0, 2500, tok); if (tok !== engine.token) return; }
  if (player.contextUri && player.contextUri === heatUri() && uri !== heatUri()) heatResume = player.nextUri();
  music.trans = 1;
  music.set(0);
  const go = () => player.playContext(uri, res ? res.trackUri : uri === heatUri() ? heatResume : null, !!sess.music.shuffle, res ? res.positionMs : 0);
  await go();
  if (tok !== engine.token) return;
  const id = uri.split(':').pop();
  await ensureSwitched((t, ctx) => !!ctx && ctx.endsWith(id), go, tok, 'playlist');
  if (tok !== engine.token) return;
  if (engine.paused) await player.pause();
  else if (talk.held) { talk.paused = true; await player.pause(); }
  await music.fadeTo(startLevel, 3000, tok);
}

// Spotify sometimes ignores or delays a switch. Check that the new music is really playing; try once more if not.
async function ensureSwitched(match, retry, tok, what) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await player.waitForTrack(match, 5000)) { log('switch-ok', what, attempt); return true; }
    if (tok !== engine.token) return false;
    log('switch-check-failed', what, attempt, player.current ? player.current.name : '-');
    if (attempt === 1) { try { await retry(); } catch (e) { log('retry-error', e.message); } }
  }
  toast(`Spotify didn't switch to the ${what === 'list' ? "round's songs" : 'new playlist'}. Press Next song, or check the Spotify app.`, 8000);
  return false;
}

// When resuming after a crash: where to pick up the music for this phase.
let resumeInfo = null;
function resumeFor(uriOrList) {
  if (!resumeInfo || !resumeInfo.trackUri) return null;
  if (Array.isArray(uriOrList)) return uriOrList.some((t) => t.uri === resumeInfo.trackUri) ? resumeInfo : null;
  return resumeInfo.contextUri === uriOrList ? resumeInfo : null;
}

// A planned round: play exactly its songs, from the first one.
async function startSet(p, tok, startLevel) {
  await startList(p.tracks, tok, startLevel, () => { p.started = true; p.seen = -1; p.sent = p.tracks.length; });
}

async function startList(tracks, tok, startLevel, onStarted) {
  if (!music.live) {
    music.demoCtx = 'demo:list';
    if (onStarted) onStarted();
    renderNowPlaying();
    await music.fadeTo(startLevel, 1500, tok);
    return;
  }
  if (!player.paused) { await music.fadeTo(0, 2500, tok); if (tok !== engine.token) return; }
  music.trans = 1;
  music.set(0);
  const res = resumeFor(tracks);
  const uris = tracks.map((t) => t.uri);
  const go = () => player.playUris(uris, res ? res.trackUri : null, res ? res.positionMs : 0);
  await go();
  if (tok !== engine.token) return;
  // The song that must be playing now: the list's first song (or the resume song).
  const first = tracks.find((x) => x.uri === (res ? res.trackUri : uris[0])) || tracks[0];
  await ensureSwitched((t) => t.uri === first.uri || (t.name === first.name && t.artists === first.artists), go, tok, 'list');
  if (tok !== engine.token) return;
  if (onStarted) onStarted();
  if (engine.paused) await player.pause();
  else if (talk.held) { talk.paused = true; await player.pause(); }
  await music.fadeTo(startLevel, 3000, tok);
}

// "+1 song": add the next unused song to this round. It is handed to Spotify when the
// round's last song is ending (Spotify's own queue is avoided: it would leak into later phases).
let extraUsed = new Set();
function addSong() {
  const p = phase();
  const pool = (sess.plan && sess.plan.pool) || [];
  const t = pool.find((x) => !extraUsed.has(x.uri) && !p.tracks.some((y) => y.uri === x.uri));
  if (!t) { toast('No unused songs left in the playlist.'); return; }
  extraUsed.add(t.uri);
  p.tracks.push({ ...t });
  engine.extraMs += t.durationMs;
  engine.holding = false;
  log('add-song', t.name);
  toast(`Added “${t.name}” (${fmtSong(t.durationMs)}) to the end of this round.`, 3500);
  render(); renderQueue();
  saveRun(true);
}

function extendIfNeeded(p) {
  if (!musicClock(p) || !p.sent || p.sent >= p.tracks.length || p.extending || talk.held) return false;
  const idx = setIndex(p);
  const lastSent = p.sent - 1;
  const curRem = player.current ? (player.current.durationMs || 0) - player.position() : 0;
  const stopped = p.seen >= lastSent && player.paused && !music.userPaused && !engine.paused;
  if ((idx === lastSent && curRem < 1500) || stopped) {
    p.extending = true;
    const rest = p.tracks.slice(p.sent);
    log('extend', rest.length);
    player.playUris(rest.map((t) => t.uri))
      .then(() => { p.sent = p.tracks.length; })
      .catch((e) => toast(e.message))
      .finally(() => { p.extending = false; });
    return true;
  }
  return false;
}

// Gentle fade out at the end of each song and back in on the next (browser playback only).
let transFading = false;
function songTransitions() {
  if (!engine.running || engine.paused || !music.live || player.mode !== 'browser' || !sess.music.smooth) return;
  if (narr.active || transFading || player.paused || !player.current) return;
  const fadeMs = (sess.music.fadeSec || 6) * 1000;
  const rem = player.current.durationMs - player.position();
  if (rem > 0 && rem < fadeMs) {
    const t = Math.max(0.12, rem / fadeMs);
    if (Math.abs(t - music.trans) > 0.02) { music.trans = t; music.apply(); }
  }
}
app.on('track', async () => {
  renderNowPlaying(); renderQueue();
  if (music.trans < 1 && !transFading) {
    transFading = true;
    const start = music.trans;
    for (let i = 1; i <= 20; i++) { music.trans = start + (1 - start) * (i / 20); music.apply(); await sleep(110); }
    music.trans = 1; music.apply();
    transFading = false;
  }
});
app.on('playback', () => renderNowPlaying());
app.on('queue', () => renderQueue());

// ---------------------------------------------------------------- narration
// seq changes whenever the narration is stopped, so a message made of several parts (callouts and
// the recording) knows not to carry on with its next part.
const narr = { audio: new Audio(), active: null, stop: null, paused: false, tts: false, seq: 0, fade: 0 };
narr.audio.preload = 'auto';

function stopNarration() {
  narr.seq++;
  clearInterval(narr.fade);
  if (narr.stop) narr.stop();
  narr.stop = null; narr.active = null; narr.paused = false;
  renderNarr();
}

function playUrl(url, volume) {
  clearInterval(narr.fade);            // a fade-out (Talk) never reaches a new clip
  if (narr.stop) narr.stop();          // never leave an earlier clip's promise waiting
  return new Promise((resolve) => {
    const a = narr.audio;
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; a.onended = a.onerror = null; narr.stop = null; resolve(r); };
    a.onended = () => done('ended');
    a.onerror = () => done('error');
    narr.stop = () => { a.pause(); done('stopped'); };
    a.src = url;
    a.volume = clamp(volume ?? (sess.levels.narr ?? 100) / 100, 0, 1);
    narr.tts = false;
    a.play().catch(() => done('error'));
  });
}

let cachedVoice;
function pickVoice() {
  if (cachedVoice !== undefined) return cachedVoice;
  const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  const en = vs.filter((v) => /^en[-_]/i.test(v.lang));
  const pref = ['Daniel', 'Alex', 'Fred', 'Aaron', 'Google UK English Male', 'Microsoft Guy'];
  cachedVoice = pref.map((n) => en.find((v) => v.name.includes(n))).find(Boolean) || en[0] || null;
  return cachedVoice;
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { cachedVoice = undefined; };

function speak(text) {
  if (narr.stop) narr.stop();
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve('none');
    const clean = stripTokens(text).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return resolve('none');
    const synth = window.speechSynthesis;
    synth.cancel();
    const parts = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean];
    const voice = pickVoice();
    let i = 0, stopped = false, settled = false, guard = null;
    narr.tts = true;
    const finish = (r) => { if (settled) return; settled = true; stopped = true; clearTimeout(guard); narr.stop = null; resolve(r); };
    narr.stop = () => { stopped = true; synth.cancel(); finish('stopped'); };
    const next = () => {
      clearTimeout(guard);
      if (stopped) return;
      if (i >= parts.length) return finish('ended');
      const part = parts[i++];
      const u = new SpeechSynthesisUtterance(part);
      if (voice) u.voice = voice;
      u.rate = 0.9; u.pitch = 0.85;
      u.onend = next; u.onerror = next;
      const est = (part.split(/\s+/).length / 2.2) * 1000 + 2500;
      const arm = () => { guard = setTimeout(() => { if (narr.paused) arm(); else next(); }, est); };
      arm();
      synth.speak(u);
    };
    next();
  });
}

async function waitWhilePaused(tok) { while (engine.paused && tok === engine.token) await sleep(200); }

async function narrate(id, tok, ph) {
  await waitWhilePaused(tok);
  if (tok !== engine.token) return 'stopped';
  if (talk.on) { log('narration-skipped-talk', id); return 'talk'; }      // the guide is talking
  const text = S.cueText(sess, id);
  const extra = calloutsFor(text, ph);
  const seq = narr.seq;
  const live = () => tok === engine.token && seq === narr.seq;
  for (const k of extra.before) { await playCallout(k, tok); if (!live()) return 'stopped'; }
  let result = 'none';
  if (S.narrationOn(sess) || !S.isPhaseCue(id)) {                    // without AI narration the guide speaks
    narr.active = id; renderNarr();
    if (clipUrls[id]) result = await playUrl(clipUrls[id]);
    if ((result === 'none' || result === 'error') && cfg.fallbackVoice && live() && !calloutOnly(text)) result = await speak(text);
    if (tok === engine.token && narr.active === id) { narr.active = null; renderNarr(); }
  } else result = 'off';
  for (const k of extra.after) { if (!live()) break; await playCallout(k, tok); }
  log('narrated', id, result);
  return result;
}

// ---------------------------------------------------------------- engine
const engine = {
  plan: [], idx: -1, running: false, paused: false, holding: false,
  phaseStart: 0, pausedAt: 0, pausedMs: 0, extraMs: 0, token: 0, replayTok: 0,
  sessionStart: 0, sessionPausedMs: 0,
};
window.__sc = { engine, music, player, narr, get session() { return sess; } };

function buildPlan() {
  const t = sess.timing, R = t.rounds;
  const songs = S.songMode(sess);
  const breaks = S.breaksPlanned(sess);
  // Messages inside songs go with the phase where their song plays.
  const inserts = {};
  for (const ins of sess.inserts || []) {
    const at = songs && S.findSong(sess, ins.uri);
    if (at) (inserts[at.phase.key] = inserts[at.phase.key] || []).push({ ...ins, done: false });
  }
  const plan = [];
  for (let r = 1; r <= R; r++) {
    const tracks = songs ? sess.plan.rounds[r - 1].map((x) => ({ ...x })) : null;
    const theme = (sess.plan && sess.plan.themes && sess.plan.themes[r - 1]) || '';
    plan.push({ type: 'round', n: r, of: R, durMs: songs ? S.sumMs(tracks) : t.roundMin * 60000, tracks, theme, cue: cueForRound(r, R), inserts: inserts['r' + r] || [] });
    if (r < R) {
      const b = { type: 'break', n: r, of: R, durMs: t.breakMin * 60000, cue: 'end' + r, inserts: inserts['b' + r] || [] };
      if (breaks) b.planned = sess.plan.breaks[r - 1].map((x) => ({ ...x }));
      plan.push(b);
    }
  }
  plan.push({ type: 'closing', durMs: null, cue: 'closing', planned: breaks ? [] : null, inserts: [] });
  return plan;
}

// Songs left over for the cool-downs and the closing (planned songs come first, then these).
function coolRest() {
  if (!S.breaksPlanned(sess)) return [];
  const rest = sess.plan.coolSource ? sess.plan.coolPool || [] : sess.plan.pool || [];
  return rest.filter((x) => !extraUsed.has(x.uri));
}

const phase = () => engine.plan[engine.idx];
const speed = () => clamp(+cfg.speed || 1, 1, 120);
function elapsedMs() { const t = engine.paused ? engine.pausedAt : now(); return (t - engine.phaseStart - engine.pausedMs) * speed(); }

// In a song round played live (not in rehearsal), the music itself is the clock.
const musicClock = (p) => !!(p && p.tracks && p.started && music.live && speed() === 1);
function setIndex(p) {
  const cur = player.current;
  if (!cur) return -1;
  let i = p.tracks.findIndex((t) => t.uri === cur.uri);
  if (i < 0) i = p.tracks.findIndex((t) => t.name === cur.name && t.artists === cur.artists);
  return i;
}
function setRemaining(p) {
  const i = setIndex(p);
  if (i < 0) return null;
  p.seen = Math.max(p.seen ?? -1, i);
  let rem = Math.max(0, (player.current.durationMs || p.tracks[i].durationMs) - player.position());
  for (let k = i + 1; k < p.tracks.length; k++) rem += p.tracks[k].durationMs;
  return rem;
}
function remainingMs() {
  const p = phase();
  if (!p || p.durMs == null) return null;
  if (musicClock(p)) { const r = setRemaining(p); if (r != null) return r; }
  return p.durMs + engine.extraMs - elapsedMs();
}
function sessionElapsed() { const t = engine.paused ? engine.pausedAt : now(); return (t - engine.sessionStart - engine.sessionPausedMs) * speed(); }

// Checks shared by Start and Resume. Waits a few seconds for the Spotify player if it is still starting.
async function readyToPlay() {
  if (sess.timing.mode === 'songs' && (!S.planValid(sess) || sess.plan.rounds.some((r) => !r.length))) {
    toast('This session follows the songs, but its rounds are not planned. Edit the session and press Suggest rounds.', 7000);
    return false;
  }
  if (cfg.demo) return true;
  if (!auth.connected) { toast('Connect Spotify in Settings, or turn on demo mode to rehearse.'); app.openSettings('set-spotify'); return false; }
  if (!heatUri()) { toast('This session has no heat playlist. Edit the session to choose one.'); return false; }
  if (!player.ready) {
    if (player.mode === 'connect') { toast('Choose a Spotify device in Settings and make sure the Spotify app is open.'); return false; }
    player.start();
    toast('Waiting for the Spotify player…', 3000);
    for (let i = 0; i < 40 && !player.ready; i++) await sleep(250);
    if (!player.ready) { toast('The Spotify player did not start. Reload the page and try again.', 7000); return false; }
  }
  if (player.mode === 'connect') await Promise.race([player.checkVolume(), sleep(2500)]);
  return true;
}

function unlockAudio() {
  if (!cfg.demo && player.mode === 'browser' && player.sdk && player.sdk.activateElement) { try { player.sdk.activateElement(); } catch { /* ignore */ } }
  try { narr.audio.muted = true; narr.audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; narr.audio.play().catch(() => {}).finally(() => { narr.audio.muted = false; }); } catch { /* ignore */ }
}

function resetRunState() {
  engine.running = true; engine.paused = false;
  heatResume = null; music.demoCtx = null; music.trans = 1; music.userPaused = false;
  talk.on = false; talk.mul = 1; talk.held = false; talk.paused = false; clearInterval(talk.timer);
  extraUsed = new Set();
  music.set(0);
  volumeWarned = false; warnVolume();
}

async function startSession() {
  if (engine.running || !sess) return;
  unlockAudio();   // inside the click, before any waiting
  preview.stop();
  if (!(await readyToPlay())) return;
  if (co.ready) await Promise.race([co.ready, sleep(4000)]);
  const missing = engine.plan.filter((p) => !clipOk[p.cue]).length + (sess.inserts || []).filter((x) => !clipOk[S.insertCue(x)]).length;
  if (missing && !confirm(`${missing} narration message${missing > 1 ? 's are' : ' is'} not recorded (or out of date). ${cfg.fallbackVoice ? 'They will be read by the browser voice.' : 'They will be skipped.'} Start anyway?`)) return;
  requestWakeLock();
  engine.plan = buildPlan();
  resetRunState();
  engine.sessionStart = now(); engine.sessionPausedMs = 0;
  buildTimeline();
  sess.lastRunAt = Date.now();
  db.sessions.put(sess).catch(() => {});
  run.id = uid(); run.startedAt = Date.now();
  log('session-start', sess.name);
  enterPhase(0);
}

// Pick up an interrupted session where it stopped: same phase, same song, same position.
async function resumeSession(r) {
  if (engine.running || !sess) return;
  unlockAudio();
  preview.stop();
  if (!(await readyToPlay())) return;
  requestWakeLock();
  engine.plan = buildPlan();
  const p = engine.plan[r.idx];
  if (!p) { toast('That session has changed too much to resume.'); return; }
  if (r.tracks && p.tracks) { p.tracks = r.tracks.map((x) => ({ ...x })); p.durMs = S.sumMs(p.tracks); }
  resetRunState();
  extraUsed = new Set(r.extraUsed || []);
  engine.sessionStart = now() - (r.sessionElapsed || 0) / speed(); engine.sessionPausedMs = 0;
  buildTimeline();
  run.id = r.runId; run.startedAt = r.startedAt;
  resumeInfo = { trackUri: r.trackUri, positionMs: r.positionMs || 0, contextUri: r.contextUri };
  log('session-resume', sess.name, 'phase', r.idx, r.trackUri || '-', r.positionMs || 0);
  await enterPhase(r.idx, r);
  resumeInfo = null;
}

async function enterPhase(i, resumeRun) {
  const tok = ++engine.token;
  narr.owner = null;
  stopNarration();
  if (engine.paused) { engine.sessionPausedMs += now() - engine.pausedAt; engine.paused = false; }
  engine.idx = i; engine.phaseStart = now(); engine.pausedMs = 0; engine.extraMs = 0; engine.holding = false;
  if (resumeRun) {
    engine.phaseStart = now() - (resumeRun.phaseElapsed || 0) / speed();
    engine.extraMs = resumeRun.extraMs || 0;
  }
  const p = phase();
  p.musicOn = false;
  log('phase', p.type, p.n || '', p.cue);
  render(); renderQueue();
  saveRun(true);
  try {
    const isRound = p.type === 'round';
    const target = (isRound ? sess.levels.heat : sess.levels.cool) / 100;
    const duck = target * sess.levels.duck / 100;
    // The music starts under the narrator. Callouts on their own only dip it a little, and with
    // nothing to say it starts at its full level.
    const phaseText = S.cueText(sess, p.cue);
    const narrated = S.narrationOn(sess) && !calloutOnly(phaseText);
    const startLevel = resumeRun ? 0.02 : narrated ? duck : refsIn(phaseText).length ? target * CALLOUT_MUSIC / 100 : target;
    // The music change runs in the background: the old music fades out, the new music fades in
    // under the narrator. The narration starts straight away, at full volume.
    const musicJob = (async () => {
      if (isRound && p.tracks) await startSet(p, tok, startLevel);
      else if (!isRound && p.planned && (p.planned.length || coolRest().length)) {
        // The planned cool-down songs, then the rest of the cool-down songs so the music never runs out.
        const rest = coolRest().filter((x) => !p.planned.some((y) => y.uri === x.uri));
        p.list = [...p.planned, ...rest].slice(0, 60).map((x) => ({ ...x }));
        await startList(p.list, tok, startLevel);
      }
      else if (!isRound && S.songMode(sess) && !sess.music.cool && sess.plan.pool.some((x) => !extraUsed.has(x.uri))) {
        p.list = sess.plan.pool.filter((x) => !extraUsed.has(x.uri));   // unused songs, minus any played with "+1 song"
        await startList(p.list, tok, startLevel);
      }
      else await switchMusic(isRound ? 'heat' : 'cool', tok, startLevel);
      if (tok !== engine.token) return;
      p.musicOn = true;
      renderQueue();
    })();
    if (resumeRun) {
      await musicJob;
      if (tok !== engine.token) return;
      toast(`Resumed: ${phaseName(p)}.`, 3500);
      await music.fadeTo(target, 4000, tok);
      return;
    }
    await Promise.all([musicJob, narrate(p.cue, tok, p)]);
    await waitWhilePaused(tok);
    if (tok !== engine.token || narr.owner === 'replay') return;
    await music.fadeTo(target, isRound ? 3000 : 4000, tok);
  } catch (e) {
    console.error(e);
    log('error', e.message || String(e));
    toast(e.message || String(e), 7000);
  }
}

function advance() { if (engine.running && engine.idx < engine.plan.length - 1) enterPhase(engine.idx + 1); }

function togglePause() {
  if (!engine.running) return;
  if (!engine.paused) {
    engine.paused = true; engine.pausedAt = now();
    if (music.live) player.pause();
    if (narr.stop) { narr.paused = true; if (narr.tts) window.speechSynthesis && speechSynthesis.pause(); else narr.audio.pause(); }
  } else {
    const d = now() - engine.pausedAt;
    engine.pausedMs += d; engine.sessionPausedMs += d; engine.paused = false;
    if (music.live && !talk.held) player.resume();
    if (narr.paused) { narr.paused = false; if (narr.tts) window.speechSynthesis && speechSynthesis.resume(); else narr.audio.play().catch(() => {}); }
  }
  render();
}

function extend() {
  const p = phase();
  if (!engine.running || !p || p.durMs == null) return;
  if (p.tracks) { addSong(); return; }
  engine.extraMs += 60000; engine.holding = false;
  toast('Added a minute.', 1600);
  render();
}

// Replay the current message. It never cancels the phase's own music start.
async function replay() {
  const p = phase();
  if (!engine.running || !p) return;
  if (talk.on) toggleTalk(false);
  if (!p.musicOn) { toast('One moment, the music for this phase is still starting.'); return; }
  const tok = engine.token;
  const rtok = ++engine.replayTok;
  narr.owner = 'replay';
  stopNarration();
  const target = (p.type === 'round' ? sess.levels.heat : sess.levels.cool) / 100;
  await music.fadeTo(target * sess.levels.duck / 100, 1500, tok);
  if (tok !== engine.token || rtok !== engine.replayTok) return;
  await narrate(p.cue, tok, p);
  if (tok !== engine.token || rtok !== engine.replayTok) return;
  narr.owner = null;
  await music.fadeTo(target, 3000, tok);
}

async function stopSession() {
  if (!engine.running || !confirm('End the session now?')) return;
  const tok = ++engine.token;
  const p = phase();
  endRun(p && p.type === 'closing' ? 'completed' : 'ended early');
  stopNarration();
  engine.paused = false;
  await music.fadeTo(0, 2500, tok);
  if (music.live) await player.pause();
  engine.running = false; engine.idx = -1; engine.holding = false;
  talk.on = false; clearInterval(talk.timer); talk.mul = 1; talk.held = false; talk.paused = false;
  releaseWakeLock();
  render(); renderQueue(); renderResume();
}

// ---------------------------------------------------------------- run log (for resume and history)
const run = { id: null, startedAt: 0, savedAt: 0 };
export const RUN_KEY = 'run', HISTORY_KEY = 'runs';

function saveRun(force) {
  if (!engine.running || !sess || !run.id) return;
  const t = Date.now();
  if (!force && t - run.savedAt < 2000) return;
  run.savedAt = t;
  const p = phase();
  store.set(RUN_KEY, {
    runId: run.id, sessionId: sess.id, name: sess.name, startedAt: run.startedAt, updatedAt: t,
    idx: engine.idx, phaseName: phaseName(p), phaseType: p ? p.type : '',
    phaseElapsed: Math.round(elapsedMs()), remaining: Math.round(remainingMs() ?? 0), extraMs: engine.extraMs,
    sessionElapsed: Math.round(sessionElapsed()),
    tracks: p && p.tracks ? p.tracks.map((x) => ({ uri: x.uri, name: x.name, artists: x.artists, durationMs: x.durationMs, imageSm: x.imageSm || '', i: x.i ?? 0 })) : null,
    extraUsed: [...extraUsed],
    trackUri: player.current ? player.current.uri : null, positionMs: Math.round(player.position()), contextUri: player.contextUri,
  });
  app.emit('run-progress', { data: store.get(RUN_KEY, null), force: !!force });
}

export function addHistory(entry) {
  const list = store.get(HISTORY_KEY, []).filter((x) => x.runId !== entry.runId);
  list.unshift(entry);
  store.set(HISTORY_KEY, list.slice(0, 200));
  app.emit('history-add', entry);
}

function endRun(status) {
  if (!run.id) return;
  addHistory({ runId: run.id, sessionId: sess.id, name: sess.name, startedAt: run.startedAt, endedAt: Date.now(), status, reached: phaseName(phase()), elapsedMs: Math.round(sessionElapsed()) });
  store.del(RUN_KEY);
  log('session-end', status);
  run.id = null;
}

// An unfinished run left behind by a crash, closed tab or dead battery (not this tab's own run).
export function interruptedRun() {
  const r = store.get(RUN_KEY, null);
  if (!r || (engine.running && r.runId === run.id)) return null;
  if (r.phaseType === 'closing' || Date.now() - r.updatedAt > 12 * 3600 * 1000) {
    addHistory({ runId: r.runId, sessionId: r.sessionId, name: r.name, startedAt: r.startedAt, endedAt: r.updatedAt, status: r.phaseType === 'closing' ? 'completed' : 'interrupted', reached: r.phaseName, elapsedMs: r.sessionElapsed });
    store.del(RUN_KEY);
    return null;
  }
  return r;
}

export function discardRun() {
  const r = store.get(RUN_KEY, null);
  if (!r) return;
  addHistory({ runId: r.runId, sessionId: r.sessionId, name: r.name, startedAt: r.startedAt, endedAt: r.updatedAt, status: 'interrupted', reached: r.phaseName, elapsedMs: r.sessionElapsed });
  store.del(RUN_KEY);
}

function renderResume() {
  const btn = $('#btnResume');
  const r = !engine.running && sess ? interruptedRun() : null;
  const mine = r && r.sessionId === sess.id;
  btn.hidden = !mine;
  if (mine) btn.title = `Resume ${r.phaseName} (${fmt(r.remaining)} left)`;
  // With a run to resume, Resume is the big button in the ring and Start becomes the quieter option.
  const st = $('#btnStart');
  st.textContent = mine ? 'Start over' : 'Start session';
  st.classList.toggle('primary', !mine);
  st.classList.toggle('ghost', !!mine);
}

function tick() {
  if (!engine.running) { if (app.current === 'live') renderSong(); return; }
  const p = phase();
  saveRun(false);
  if (p && !engine.paused && musicClock(p)) {
    // Song round: ends when its last song has finished (or playback moved past it).
    if (extendIfNeeded(p) || p.extending) { if (app.current === 'live') { render(); renderSong(); } return; }
    const rem = setRemaining(p);
    const last = p.tracks.length - 1;
    const idx = setIndex(p);
    const wrapped = idx >= 0 && idx < last && now() - (music.lastBack || 0) > 4000;   // Spotify went back to the start of the list
    const pastEnd = p.seen === last && !narr.active && !music.userPaused && !talk.held && (idx < 0 || wrapped || (player.paused && player.position() < 1500));
    const overdue = elapsedMs() > p.durMs + engine.extraMs + 45000;
    if ((rem != null && rem <= 700) || pastEnd || overdue) { log('set-end', rem, pastEnd, overdue); advance(); return; }
  } else if (p && !engine.paused) {
    const rem = remainingMs();
    if (rem != null && rem <= 0) {
      if (p.type === 'break' && !sess.timing.autoNext) {
        if (!engine.holding) { engine.holding = true; toast(`Cool-down over. Press “Start round ${p.n + 1}” when everyone is back in.`, 6000); }
      } else { advance(); return; }
    }
  }
  if (p && !engine.paused) checkInserts(p);
  songTransitions();
  if (app.current === 'live') { render(); renderSong(); }
}
setInterval(tick, 200);

// ---------------------------------------------------------------- messages inside songs
// A message plays when its song reaches its spot: the music dips to the message's level,
// the narrator speaks at the message's volume, and the music comes back up afterwards.
let insertBusy = false;
function checkInserts(p) {
  if (!p.inserts || !p.inserts.length || !p.musicOn || !music.live) return;
  const cur = player.current;
  if (!cur || player.paused) return;
  const pos = player.position();
  for (const ins of p.inserts) {
    if (cur.uri !== ins.uri) continue;
    if (ins.done) { if (!insertBusy && pos < ins.atMs - 3000) ins.done = false; continue; }   // went back before it: play it again
    if (pos < ins.atMs) continue;
    if (pos > ins.atMs + 20000) { ins.done = true; log('insert-skipped', ins.id); continue; }   // skipped past it
    if (narr.active || insertBusy || talk.on) return;                                            // let the narrator (or the guide) finish first
    ins.done = true;
    playInsert(p, ins);
    return;
  }
}

async function playInsert(p, ins) {
  const id = S.insertCue(ins);
  const text = S.cueText(sess, id);
  const extra = calloutsFor(text, null);
  const speech = !!clipUrls[id] || (cfg.fallbackVoice && !calloutOnly(text));
  if (!speech && !(co.prep && (extra.before.length || extra.after.length))) { log('insert-missing', id); return; }
  const tok = engine.token;
  const seq = narr.seq;                 // a Replay or stop while the music dips cancels this message
  insertBusy = true;
  const target = (p.type === 'round' ? sess.levels.heat : sess.levels.cool) / 100;
  const duck = (ins.duck ?? (calloutOnly(text) ? CALLOUT_MUSIC : sess.levels.duck)) / 100;   // callouts: the music only dips a little
  const vol = (ins.narr ?? sess.levels.narr ?? 100) / 100;
  log('insert', id, Math.round(player.position() / 1000));
  try {
    await music.fadeTo(target * duck, 1200, tok);
    if (tok === engine.token) {
      const live = () => tok === engine.token && seq === narr.seq;
      for (const k of extra.before) { if (!live()) break; await playCallout(k, tok, vol); }
      let r = 'none';
      if (speech && live()) {
        narr.active = id; renderNarr();
        r = clipUrls[id] ? await playUrl(clipUrls[id], vol) : 'none';
        if ((r === 'none' || r === 'error') && cfg.fallbackVoice && live() && !calloutOnly(text)) r = await speak(text);
        if (tok === engine.token && narr.active === id) { narr.active = null; renderNarr(); }
      }
      for (const k of extra.after) { if (!live()) break; await playCallout(k, tok, vol); }
      log('insert-done', id, r);
    }
    await waitWhilePaused(tok);
    if (tok === engine.token && narr.owner !== 'replay') await music.fadeTo(target, 2000, tok);
  } finally { insertBusy = false; }
}

// ---------------------------------------------------------------- music controls
async function musicToggle() {
  if (cfg.demo || !player.ready) return;
  if (player.paused) { music.userPaused = false; talk.held = false; talk.paused = false; await player.resume(); }
  else { music.userPaused = true; await player.pause(); }
  renderNowPlaying();
}
const nextSong = () => { if (!cfg.demo && player.ready) player.next(); };
const prevSong = () => { if (!cfg.demo && player.ready) { music.lastBack = now(); player.previous(); } };

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function requestWakeLock() { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ } }
function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && engine.running) requestWakeLock(); });

// ---------------------------------------------------------------- rendering
const RING_C = 2 * Math.PI * 186;
$('#ringProg').style.strokeDasharray = RING_C;
$('#ringProg').style.strokeDashoffset = RING_C;

function phaseName(p) {
  if (!p) return '';
  if (p.type === 'round') return p.n === p.of && p.of > 1 ? 'Final round' : `Round ${p.n}`;
  if (p.type === 'break') return `Cool-down ${p.n}`;
  return 'Closing';
}

function buildTimeline() {
  const tl = $('#timeline'), lb = $('#segLabels');
  tl.innerHTML = ''; lb.innerHTML = '';
  if (!sess) return;
  const plan = engine.running ? engine.plan : buildPlan();
  plan.filter((p) => p.durMs != null).forEach((p, i) => {
    const seg = h('div', { class: 'seg ' + p.type, 'data-i': String(i) }, h('i'));
    seg.style.flex = String(p.durMs);
    tl.appendChild(seg);
    const l = h('span', {}, p.type === 'round' ? 'R' + p.n : '');
    l.style.flex = String(p.durMs);
    lb.appendChild(l);
  });
}

function render() {
  const body = document.body;
  const p = engine.running ? phase() : null;
  body.classList.toggle('phase-idle', !p);
  $('.ring-center').classList.toggle('idle', !engine.running && !!sess);
  $('.ring-center').classList.toggle('running', engine.running);
  const tb = $('#btnTalk');
  tb.hidden = !engine.running;
  tb.classList.toggle('on', talk.on);
  tb.textContent = talk.on ? '▶ Resume' : '🎙 Talk';
  tb.title = talk.on ? (talk.held ? 'Play the music again (T)' : 'Bring the music back up (T)')
    : canDip() ? `Say something: the music dips to ${Math.round(talkLevel() * 100)}% and the narrator stops (T)`
    : `Say something: the music pauses (Spotify can’t turn down ${deviceWord()}) and the narrator stops (T)`;
  body.classList.toggle('talking', talk.on);
  body.classList.toggle('phase-heat', !!p && p.type === 'round');
  body.classList.toggle('phase-cool', !!p && p.type === 'break');
  body.classList.toggle('phase-done', !!p && p.type === 'closing');
  body.classList.toggle('paused', engine.paused);
  if (!sess) return;

  const prog = $('#ringProg');
  const t = sess.timing;
  const theme = $('#theme');
  if (!p) {
    const first = engine.plan[0];
    const r = interruptedRun();
    const back = r && r.sessionId === sess.id ? r : null;   // an interrupted run: the ring shows where it stopped
    $('#kicker').textContent = back ? 'Interrupted' : cfg.demo ? 'Ready for launch · demo' : 'Ready for launch';
    $('#title').textContent = back ? back.phaseName : S.songMode(sess) ? `${t.rounds} rounds of songs` : `${t.rounds} rounds · ${t.roundMin} min`;
    $('#timer').textContent = back ? fmt(back.remaining) : fmt(first && first.durMs ? first.durMs : t.roundMin * 60000);
    $('#sub').textContent = 'Press Start when everyone is seated';
    theme.textContent = '';
    prog.style.strokeDashoffset = RING_C;
    $('#total').textContent = 'Not started';
  } else {
    const next = engine.plan[engine.idx + 1];
    $('#kicker').textContent = engine.paused ? 'Paused' : p.type === 'round' ? 'In the heat' : p.type === 'break' ? 'Cooling down' : 'Mission complete';
    $('#title').textContent = phaseName(p) + (p.type === 'round' ? ` of ${p.of}` : '');
    theme.textContent = p.theme || '';
    if (p.durMs == null) {
      $('#timer').textContent = fmt(sessionElapsed());
      $('#sub').textContent = talk.on ? talkText() : 'Total session time';
      prog.style.strokeDashoffset = 0;
    } else {
      const rem = remainingMs(), dur = p.durMs + engine.extraMs;
      $('#timer').textContent = fmt(rem);
      prog.style.strokeDashoffset = RING_C * clamp(rem / dur, 0, 1);
      $('#sub').textContent = talk.on ? talkText() : engine.holding ? `Waiting. Press “Start round ${p.n + 1}”` : next ? `Next: ${phaseName(next)}` : '';
    }
    $('#total').textContent = `Elapsed ${fmt(sessionElapsed())}` + (cfg.speed > 1 ? `  ·  rehearsal ×${cfg.speed}` : '');
  }
  $('#liveName').textContent = sess.name;

  $$('#timeline .seg').forEach((seg) => {
    const i = +seg.dataset.i;
    let f = 0;
    if (p) {
      if (i < engine.idx || p.type === 'closing') f = 1;
      else if (i === engine.idx) { const dur = p.durMs + engine.extraMs; f = clamp(1 - (remainingMs() ?? dur) / dur, 0, 1); }
    }
    seg.firstChild.style.width = (f * 100).toFixed(2) + '%';
    seg.classList.toggle('current', !!p && i === engine.idx);
  });

  $('#btnStart').hidden = engine.running;
  if (engine.running) $('#btnResume').hidden = true;
  $('#btnPause').disabled = !engine.running || (p && p.type === 'closing');
  $('#btnPause').textContent = engine.paused ? 'Resume' : 'Pause';
  const nb = $('#btnNext');
  nb.disabled = !engine.running || !p || p.type === 'closing';
  nb.textContent = !p ? 'Next phase' : p.type === 'round' ? (p.n === p.of ? 'Finish session' : 'Go to cool-down') : p.type === 'break' ? `Start round ${p.n + 1}` : 'Next phase';
  nb.classList.toggle('primary', !!engine.holding);
  $('#btnExtend').disabled = !engine.running || !p || p.durMs == null;
  $('#btnExtend').textContent = p && p.tracks ? '+1 song' : '+1 min';
  $('#btnReplay').disabled = !engine.running;
  $('#btnStop').disabled = !engine.running;
}

function renderMeter(v) {
  // A phone plays at its own volume: don't show a level the app can't set.
  const fixed = music.live && !player.canSetVolume;
  $('#meterFill').parentElement.classList.toggle('fixed', fixed);
  $('#meterFill').style.width = (fixed ? (talk.held || player.paused ? 0 : 100) : Math.round(v * 100)) + '%';
  $('#meterVal').textContent = fixed ? (talk.held ? 'Paused while you talk' : `Set on ${deviceWord()}`) : Math.round(v * 100) + '%';
}

function renderNowPlaying() {
  const art = $('#npArt');
  const ctl = !cfg.demo && player.ready;
  ['#btnPrevSong', '#btnMusic', '#btnNextSong'].forEach((s) => { $(s).disabled = !ctl; });
  $('#btnMusic').classList.toggle('is-paused', player.paused);
  $('#btnMusic').setAttribute('aria-label', player.paused ? 'Play music' : 'Pause music');
  if (cfg.demo) {
    $('#npTrack').textContent = music.demoCtx === 'demo:cool' ? (sess && sess.music.cool ? sess.music.cool.name : 'Cool-down') : (sess && sess.music.heat ? sess.music.heat.name : 'Heat playlist');
    $('#npArtist').textContent = 'Demo mode, no music plays';
    art.removeAttribute('src');
    return;
  }
  const t = player.current;
  $('#npTrack').textContent = t ? t.name : '—';
  $('#npArtist').textContent = t ? t.artists : player.ready ? 'Ready' : auth.connected ? 'Starting the Spotify player…' : 'Spotify not connected';
  if (t && t.image) { if (art.getAttribute('src') !== t.image) art.src = t.image; } else art.removeAttribute('src');
}

function renderSong() {
  const t = player.current;
  if (!t || cfg.demo) { $('#npProg').style.width = '0%'; $('#npPos').textContent = '0:00'; $('#npDur').textContent = '0:00'; return; }
  const pos = Math.min(player.position(), t.durationMs || 0);
  $('#npProg').style.width = (t.durationMs ? (pos / t.durationMs) * 100 : 0).toFixed(2) + '%';
  $('#npPos').textContent = fmtSong(pos);
  $('#npDur').textContent = fmtSong(t.durationMs);
}

// What plays next. For planned rounds (and the unused songs in breaks) this comes from the plan itself,
// which is exact; otherwise from Spotify's queue, which is cleared on every switch so it never shows old songs.
function upcoming() {
  const p = engine.running ? phase() : null;
  const L = p && (p.tracks || p.list);
  if (L) {
    let i = -1;
    if (player.current) {
      i = L.findIndex((t) => t.uri === player.current.uri);
      if (i < 0) i = L.findIndex((t) => t.name === player.current.name && t.artists === player.current.artists);
    }
    if (i < 0 && (!music.live || !p.musicOn)) i = -1;
    return { list: L.slice(i + 1), planned: true };
  }
  if (cfg.demo || (p && !p.musicOn)) return { list: [], planned: false };
  return { list: player.queue.length ? player.queue : player.sdkNext, planned: false };
}

function renderQueue() {
  const ol = $('#upNext');
  ol.innerHTML = '';
  const { list, planned } = upcoming();
  const p = engine.running ? phase() : null;
  const shown = list.slice(0, 5);
  if (!shown.length) {
    ol.append(h('li', {}, h('div', { class: 'none' }, !engine.running ? 'Starts when the music does' : planned ? 'Last song of this phase' : cfg.demo ? 'Nothing in demo mode' : 'Loading…')));
  }
  for (const t of shown) {
    const onclick = () => {
      if (cfg.demo || !player.ready) return;
      music.lastBack = now();
      player.jumpTo(t.uri).catch((e) => toast(e.message));
    };
    ol.append(h('li', {}, h('button', { type: 'button', title: 'Play this song now', onclick },
      t.imageSm ? h('img', { src: t.imageSm, alt: '' }) : h('span', { class: 'ph' }),
      h('span', { class: 'm' }, h('div', { class: 't' }, t.name), h('div', { class: 'a' }, t.artists)),
      h('span', { class: 'd' }, fmtSong(t.durationMs)))));
  }
  if (list.length > shown.length) ol.append(h('li', {}, h('div', { class: 'none' }, `+ ${list.length - shown.length} more`)));
  const next = p && engine.plan[engine.idx + 1];
  if (next) ol.append(h('li', { class: 'then' }, h('div', { class: 'none' }, `Then: ${phaseName(next)}` + (next.durMs ? ` · ${fmt(next.durMs)}` : ''))));
}

function renderNarr() {
  const card = $('#narrCard');
  const isCo = !!narr.active && String(narr.active).startsWith('co:');
  const c = !isCo && narr.active && cueMeta[narr.active];
  card.classList.toggle('speaking', !!c || isCo);
  if (isCo) {
    $('#narrText').textContent = co.said || 'Callout';
    $('#narrWhen').textContent = 'Callout';
    return;
  }
  $('#narrText').textContent = c ? `Speaking: ${c.title}` + (narr.tts ? ' (browser voice)' : '') : 'Quiet';
  $('#narrWhen').textContent = c ? c.when : '';
}

function renderAll() {
  buildTimeline();
  render(); renderNowPlaying(); renderSong(); renderQueue(); renderNarr(); renderMeter(music.level * music.trans * talk.mul);
  renderResume();
  if (!sess) {
    $('#kicker').textContent = 'No session loaded';
    $('#title').textContent = 'Choose a session';
    $('#sub').textContent = 'Go to Sessions and press Run';
    $('#btnStart').disabled = true;
  } else $('#btnStart').disabled = false;
}
app.on('spotify', () => { if (app.current === 'live') { renderNowPlaying(); renderQueue(); } });

// ---------------------------------------------------------------- wiring
$('#btnStart').addEventListener('click', startSession);
$('#btnResume').addEventListener('click', () => { const r = interruptedRun(); if (r && sess && r.sessionId === sess.id) resumeSession(r); });
$('#btnPause').addEventListener('click', togglePause);
$('#btnNext').addEventListener('click', advance);
$('#btnExtend').addEventListener('click', extend);
$('#btnReplay').addEventListener('click', replay);
$('#btnStop').addEventListener('click', stopSession);
$('#btnTalk').addEventListener('click', () => toggleTalk());
$('#btnMusic').addEventListener('click', musicToggle);
$('#btnNextSong').addEventListener('click', nextSong);
$('#btnPrevSong').addEventListener('click', prevSong);
document.addEventListener('keydown', (e) => {
  if (app.current !== 'live' || $('#settings').open || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
  if (e.key === ' ') { if (tag === 'BUTTON') return; e.preventDefault(); togglePause(); }
  else if (e.key === 'n' || e.key === 'N') advance();
  else if (e.key === '+' || e.key === '=') extend();
  else if (e.key === 'r' || e.key === 'R') replay();
  else if (e.key === 't' || e.key === 'T') toggleTalk();
  else if (e.key === 'ArrowRight') nextSong();
  else if (e.key === 'ArrowLeft') prevSong();
});
window.addEventListener('beforeunload', (e) => { if (engine.running) { e.preventDefault(); e.returnValue = ''; } });
