// Timeline: the whole session laid out left to right (songs in every round and cool-down, the
// narration at each phase) to place extra messages anywhere, even in the middle of a song.
// A message is recorded with the session's voice, dragged to its spot, and given its own music
// dip and narrator volume. "Hear it in place" plays the song there with the message on top.
import { $, h, toast, fmtSong, clamp, sleep } from './util.js';
import { app } from './app.js';
import * as db from './db.js';
import * as S from './sessions.js';
import { eleven, clipKey, prepText, isV3 } from './eleven.js';
import { preview } from './preview.js';
import { player } from './spotify.js';

const el = $('#view-timeline');
let s = null;
let recs = {};
let px = null;                 // pixels per second (null: fit the whole session on screen)
let sel = null;                // { type: 'insert', id } | { type: 'song', uri, atMs }
let layout = null;
let saveTimer = null;
let recording = null;          // insert id being recorded
let playheadTimer = null;
const durCache = new Map();    // `${cue}:${at}` -> ms
const ZOOMS = [0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

export const timelineView = {
  el,
  async enter(id) {
    const x = await db.sessions.get(id || (s && s.id));
    if (!x) { toast('That session no longer exists.'); app.show('library'); return; }
    if (!s || s.id !== x.id) { px = null; timelineView._scroll = 0; }
    s = S.ensureScript(x);
    recs = await db.clips.forSession(s.id);
    sel = null; dragOn = false;
    render();
    clearInterval(playheadTimer);
    playheadTimer = setInterval(paintPlayhead, 120);
  },
  async leave() {
    clearInterval(playheadTimer);
    preview.stop();
    if (recording) { toast('Wait until the recording has finished.'); return false; }
    await flush();
    return true;
  },
};

app.on('cloud-data', async () => {
  if (app.current !== 'timeline' || !s || saveTimer || recording) return;
  const x = await db.sessions.get(s.id);
  if (!x) return;
  s = S.ensureScript(x); recs = await db.clips.forSession(s.id);
  render();
});

// ---------------------------------------------------------------- saving
function changed() {
  clearTimeout(saveTimer);
  status('Saving…');
  saveTimer = setTimeout(flush, 600);
}
async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = null;
  try { await S.save(s); status('All changes saved'); } catch (e) { status(''); toast(e.message, 7000); }
}
function status(t) { const x = $('.tl-status', el); if (x) x.textContent = t; }

// ---------------------------------------------------------------- durations of recorded messages
function clipMs(cueId) {
  const rec = recs[cueId];
  if (rec && rec.blob) {
    const k = `${cueId}:${rec.at}`;
    if (durCache.has(k)) return durCache.get(k);
    durCache.set(k, null);
    const url = URL.createObjectURL(rec.blob);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { durCache.set(k, Math.round((a.duration || 0) * 1000)); URL.revokeObjectURL(url); if (app.current === 'timeline') render(); };
    a.onerror = () => { durCache.set(k, 4000); URL.revokeObjectURL(url); };
    a.src = url;
  }
  const k = rec ? `${cueId}:${rec.at}` : null;
  if (k && durCache.get(k)) return durCache.get(k);
  // Not recorded (or not measured yet): about 14 characters a second.
  return Math.max(2000, Math.round(prepText(S.cueText(s, cueId), s.voice.modelId).length / 14 * 1000));
}

// ---------------------------------------------------------------- layout: session time of every song and message
function buildLayout() {
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
  const closeMs = Math.max(60000, clipMs('closing') + 20000);
  segs.push({ ph: { type: 'closing', label: 'Closing', key: 'closing' }, start: t, end: t + closeMs, cue: 'closing' });
  t += closeMs;
  return { segs, songs, total: t };
}

const songAt = (ms) => layout.songs.find((x) => ms >= x.start && ms < x.end) || null;
function insertStart(ins) {
  const x = layout.songs.find((y) => y.song.uri === ins.uri);
  return x ? x.start + ins.atMs : null;
}

// ---------------------------------------------------------------- rendering
let dragOn = false;   // a message is being dragged: hold re-renders until it's dropped
function render() {
  if (dragOn) return;
  el.innerHTML = '';
  if (!S.songMode(s)) {
    el.append(h('div', { class: 'tl-top' }, h('button', { class: 'ghost small', onclick: () => app.show('session', s.id) }, '← Session')),
      h('div', { class: 'empty' }, h('h3', {}, 'The timeline needs planned rounds'), h('p', { class: 'muted' }, 'Edit the session, choose “Follow the songs” and press Suggest rounds. Then you can place messages inside the songs.'),
        h('button', { class: 'primary', onclick: () => app.show('editor', { id: s.id, from: 'session', section: 'ed-timing' }) }, 'Edit the session')));
    return;
  }
  layout = buildLayout();
  if (px == null) {
    // Start with the whole session in view.
    const avail = Math.max(320, (el.clientWidth || window.innerWidth) - 100);
    const fit = avail / (layout.total / 1000);
    px = ZOOMS.filter((z) => z <= fit).pop() || ZOOMS[0];
  }
  const W = Math.ceil(layout.total / 1000 * px) + 40;

  const zoomOut = h('button', { class: 'small', title: 'Zoom out', 'aria-label': 'Zoom out' }, '−');
  const zoomIn = h('button', { class: 'small', title: 'Zoom in', 'aria-label': 'Zoom in' }, '+');
  const zoomTo = (dir) => {
    const scroller = $('.tl-scroll', el);
    const centerMs = scroller ? (scroller.scrollLeft + scroller.clientWidth / 2) / px * 1000 : 0;
    const i = ZOOMS.indexOf(px);
    px = ZOOMS[clamp((i < 0 ? 5 : i) + dir, 0, ZOOMS.length - 1)];
    render();
    const sc = $('.tl-scroll', el);
    if (sc) sc.scrollLeft = centerMs / 1000 * px - sc.clientWidth / 2;
  };
  zoomOut.addEventListener('click', () => zoomTo(-1));
  zoomIn.addEventListener('click', () => zoomTo(1));
  const add = h('button', { class: 'primary small' }, '+ Add a message');
  add.addEventListener('click', addInsert);

  const top = h('div', { class: 'tl-top' },
    h('button', { class: 'ghost small', onclick: () => app.show('session', s.id) }, '← Session'),
    h('h1', {}, s.name || 'Untitled session'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted small tl-status' }),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Zoom'), zoomOut, zoomIn), add);
  const help = h('p', { class: 'muted small tl-help' },
    'Click a song to put the cursor there, then “Add a message”. Drag a message to move it, even into the middle of a song. ',
    'Each message can dip the music by its own amount. Orange: rounds. Blue: cool-downs.');

  // canvas
  const canvas = h('div', { class: 'tl-canvas', style: { width: W + 'px' }, 'data-px': String(px) });
  const x = (ms) => Math.round(ms / 1000 * px) + 'px';
  const w = (ms) => Math.max(2, Math.round(ms / 1000 * px)) + 'px';

  // ruler
  const ruler = h('div', { class: 'tl-ruler' });
  const stepMin = px >= 8 ? 1 : px >= 3 ? 2 : px >= 1.5 ? 5 : px >= 0.5 ? 10 : 15;
  for (let m = 0; m * 60000 <= layout.total; m += stepMin) ruler.append(h('span', { style: { left: x(m * 60000) } }, `${m}:00`));
  canvas.append(ruler);

  // phases
  const phases = h('div', { class: 'tl-lane tl-phases' });
  for (const sg of layout.segs) phases.append(h('div', { class: 'tl-ph ' + sg.ph.type, style: { left: x(sg.start), width: w(sg.end - sg.start) } }, h('span', {}, sg.ph.label)));
  canvas.append(phases);

  // music
  const music = h('div', { class: 'tl-lane tl-music', 'aria-label': 'Songs' });
  for (const sn of layout.songs) {
    const on = sel && sel.type === 'song' && sel.uri === sn.song.uri;
    const b = h('div', { class: `tl-song ${sn.phase.type}` + (sn.cut ? ' cut' : '') + (on ? ' sel' : ''), style: { left: x(sn.start), width: w(sn.end - sn.start) },
      title: `${sn.song.name} — ${sn.song.artists} · ${fmtSong(sn.song.durationMs)}${sn.cut ? ' (the break ends during this song)' : ''}` },
    h('span', { class: 't' }, sn.song.name), h('span', { class: 'a' }, sn.song.artists));
    b.addEventListener('click', (e) => {
      const r = b.getBoundingClientRect();
      const atMs = clamp(Math.round(((e.clientX - r.left) / px) * 1000 / 500) * 500, 0, sn.song.durationMs - 1000);
      sel = { type: 'song', uri: sn.song.uri, atMs };
      render();
    });
    music.append(b);
  }
  canvas.append(music);

  // narration
  const narr = h('div', { class: 'tl-lane tl-narr', 'aria-label': 'Narration' });
  for (const sg of layout.segs) {
    const ms = clipMs(sg.cue);
    const st = S.clipState(s, sg.cue, recs[sg.cue]);
    narr.append(h('div', { class: 'tl-cue' + (st === 'missing' || st === 'outdated' ? ' todo' : ''), style: { left: x(sg.start), width: w(ms) }, title: `${S.cueText(s, sg.cue).slice(0, 140)}…` }, h('span', {}, sg.ph.label)));
  }
  for (const ins of s.inserts || []) {
    const at = insertStart(ins);
    if (at == null) continue;
    const cue = S.insertCue(ins);
    const ms = clipMs(cue);
    const st = S.clipState(s, cue, recs[cue]);
    const on = sel && sel.type === 'insert' && sel.id === ins.id;
    const b = h('div', { class: 'tl-ins' + (on ? ' sel' : '') + (st === 'missing' || st === 'outdated' ? ' todo' : ''), style: { left: x(at), width: w(ms) },
      tabindex: '0', role: 'button', 'aria-label': `Message at ${fmtSong(ins.atMs)}: ${ins.text || 'empty'}`, title: (ins.text || 'Empty message') + ' — drag to move' },
    h('span', {}, ins.text || 'New message'));
    dragInsert(b, ins);
    narr.append(b);
  }
  canvas.append(narr);

  // cursor and playhead
  if (sel && sel.type === 'song') {
    const sn = layout.songs.find((y) => y.song.uri === sel.uri);
    if (sn) canvas.append(h('div', { class: 'tl-cursor', style: { left: x(sn.start + sel.atMs) } }));
  }
  canvas.append(h('div', { class: 'tl-play', hidden: true }));

  const lanes = h('div', { class: 'tl-lanes', 'aria-hidden': 'true' }, h('span', { style: { top: '30px' } }, 'Phases'), h('span', { style: { top: '74px' } }, 'Songs'), h('span', { style: { top: '132px' } }, 'Narration'));
  const scroller = h('div', { class: 'tl-scroll' }, lanes, canvas);
  el.append(top, help, scroller, inspector());
  const old = timelineView._scroll;
  if (old != null) scroller.scrollLeft = old;
  scroller.addEventListener('scroll', () => { timelineView._scroll = scroller.scrollLeft; });
  status(saveTimer ? 'Saving…' : '');
}

function paintPlayhead() {
  const ph = $('.tl-play', el);
  if (!ph || !layout) return;
  const tr = preview.track;
  const sn = tr && layout.songs.find((y) => y.song.uri === tr.uri);
  if (!sn) { ph.hidden = true; return; }
  ph.hidden = false;
  ph.style.left = Math.round((sn.start + player.position()) / 1000 * px) + 'px';
}

// ---------------------------------------------------------------- dragging a message
function dragInsert(b, ins) {
  let startX = 0, orig = 0, moved = false;
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX; orig = insertStart(ins); moved = false;
    b.setPointerCapture(e.pointerId);
    b.classList.add('dragging'); dragOn = true;
  });
  b.addEventListener('pointermove', (e) => {
    if (!b.classList.contains('dragging')) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    b.style.left = Math.round((orig / 1000) * px + dx) + 'px';
    const at = orig + (dx / px) * 1000;
    const sn = songAt(at);
    b.classList.toggle('bad', !sn);
    b.dataset.tip = sn ? `${sn.song.name} · ${fmtSong(at - sn.start)}` : 'Drop it on a song';
    status(b.dataset.tip);
  });
  const end = (e) => {
    if (!b.classList.contains('dragging')) return;
    b.classList.remove('dragging'); dragOn = false;
    const dx = e.clientX - startX;
    if (!moved) { sel = { type: 'insert', id: ins.id }; render(); return; }
    const at = orig + (dx / px) * 1000;
    const sn = songAt(at);
    if (!sn) { toast('Drop the message on a song.'); render(); return; }
    ins.uri = sn.song.uri;
    ins.atMs = clamp(Math.round((at - sn.start) / 500) * 500, 0, Math.max(0, sn.song.durationMs - 1000));
    sel = { type: 'insert', id: ins.id };
    changed(); render();
  };
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', () => { b.classList.remove('dragging'); dragOn = false; render(); });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { sel = { type: 'insert', id: ins.id }; render(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); nudge(ins, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5000 : 1000)); }
  });
}

function nudge(ins, ms) {
  const sn = layout.songs.find((y) => y.song.uri === ins.uri);
  if (!sn) return;
  const at = insertStart(ins) + ms;
  const to = songAt(clamp(at, 0, layout.total - 1)) || sn;
  ins.uri = to.song.uri;
  ins.atMs = clamp(Math.round((at - to.start) / 500) * 500, 0, Math.max(0, to.song.durationMs - 1000));
  sel = { type: 'insert', id: ins.id };
  changed(); render();
  const nb = $('.tl-ins.sel', el); if (nb) nb.focus();
}

function addInsert() {
  let uri, atMs;
  if (sel && sel.type === 'song') { uri = sel.uri; atMs = sel.atMs; }
  else {
    const first = layout.songs[0];
    if (!first) { toast('There are no songs to place a message in.'); return; }
    uri = first.song.uri; atMs = Math.min(60000, Math.max(0, first.song.durationMs - 30000));
  }
  const ins = S.newInsert({ uri, atMs });
  s.inserts.push(ins);
  sel = { type: 'insert', id: ins.id };
  changed(); render();
  const ta = $('.tl-insp textarea', el); if (ta) ta.focus();
}

// ---------------------------------------------------------------- inspector
function inspector() {
  const box = h('section', { class: 'tl-insp ed-sec' });
  if (!sel) {
    box.append(h('p', { class: 'muted small' }, 'Select a song (click it) or a message. ', h('b', {}, (s.inserts || []).length ? `${s.inserts.length} message${s.inserts.length === 1 ? '' : 's'} inside songs.` : 'No messages inside songs yet.')));
    return box;
  }
  if (sel.type === 'song') {
    const sn = layout.songs.find((y) => y.song.uri === sel.uri);
    if (!sn) { sel = null; return inspector(); }
    const play = h('button', { class: 'small' }, `▶ Play from ${fmtSong(sel.atMs)}`);
    play.addEventListener('click', () => preview.play(sn.song, { startMs: sel.atMs }));
    const add = h('button', { class: 'small primary' }, `+ Add a message at ${fmtSong(sel.atMs)}`);
    add.addEventListener('click', addInsert);
    box.append(h('div', { class: 'row' },
      sn.song.imageSm ? h('img', { class: 'tl-art', src: sn.song.imageSm, alt: '' }) : null,
      h('div', {}, h('b', {}, sn.song.name), h('div', { class: 'muted small' }, `${sn.song.artists} · ${sn.phase.label} · ${fmtSong(sn.song.durationMs)}`)),
      h('span', { class: 'spacer' }), play, add));
    return box;
  }
  const ins = (s.inserts || []).find((x) => x.id === sel.id);
  if (!ins) { sel = null; return inspector(); }
  const cue = S.insertCue(ins);
  const st = S.clipState(s, cue, recs[cue]);
  const at = layout.songs.find((y) => y.song.uri === ins.uri);

  const ta = h('textarea', { rows: 3, placeholder: 'What should the narrator say here? e.g. “This one is by Ólafur Arnalds, recorded in a lighthouse in Reykjanes…”' }, ins.text || '');
  const chip = h('span', { class: 'chip' });
  const count = h('span', { class: 'muted small' });
  const paintState = () => {
    const stt = recording === ins.id ? 'recording' : S.clipState(s, cue, recs[cue]);
    const [c, l] = { recording: ['chip info', 'Recording…'], ready: ['chip ok', `Recorded · ${fmtSong(clipMs(cue))}`], uploaded: ['chip info', 'Your own MP3'], outdated: ['chip warn', 'Changed — record again'], missing: ['chip', 'Not recorded'] }[stt];
    chip.className = c; chip.textContent = l;
    count.textContent = `${prepText(ins.text, s.voice.modelId).length} characters`;
  };
  paintState();
  ta.addEventListener('input', () => { ins.text = ta.value; paintState(); changed(); const blk = $('.tl-ins.sel span', el); if (blk) blk.textContent = ins.text || 'New message'; });

  const rec = h('button', { class: 'small primary' }, st === 'missing' ? 'Record' : 'Record again');
  rec.disabled = !!recording;
  rec.addEventListener('click', () => recordInsert(ins));
  const hear = h('button', { class: 'small' }, '▶ Hear it in place');
  hear.disabled = !recs[cue] || !at;
  hear.addEventListener('click', () => hearInPlace(ins));
  const del = h('button', { class: 'small ghost danger' }, 'Delete');
  del.addEventListener('click', () => {
    if (!confirm('Delete this message?')) return;
    s.inserts = s.inserts.filter((x) => x !== ins);
    db.clips.del(s.id, cue).catch(() => {});
    delete recs[cue];
    sel = null; changed(); render();
  });

  const nb = (label, ms) => { const b = h('button', { class: 'small ghost', title: `${ms > 0 ? 'Later' : 'Earlier'} by ${Math.abs(ms / 1000)} s` }, label); b.addEventListener('click', () => nudge(ins, ms)); return b; };
  const where = at ? `${at.phase.label} · in “${at.song.name}” at ${fmtSong(ins.atMs)} of ${fmtSong(at.song.durationMs)}` : 'Not placed: drag it onto a song';
  const overlaps = at && layout.segs.some((sg) => { const st0 = sg.start, en = sg.start + clipMs(sg.cue), a = at.start + ins.atMs; return a < en && a + clipMs(cue) > st0; });

  const slider = (label, key, def, fmtv, help) => {
    const v = ins[key] ?? def;
    const out = h('span', { class: 'val' }, fmtv(v));
    const r = h('input', { type: 'range', min: 0, max: 100, value: v });
    r.addEventListener('input', () => { ins[key] = +r.value; out.textContent = fmtv(+r.value); });
    r.addEventListener('change', changed);
    return h('label', { class: 'f' }, h('span', {}, label, ' ', out), r, h('span', { class: 'muted small' }, help));
  };

  box.append(
    h('div', { class: 'row' }, h('b', {}, 'Message inside a song'), chip, count, h('span', { class: 'spacer' }), del),
    h('div', { class: 'muted small tl-where' }, where, overlaps ? h('span', { class: 'chip warn', style: { marginLeft: '8px' } }, 'Overlaps a phase message, so it waits until that one ends') : null),
    ta,
    h('div', { class: 'row' }, rec, hear, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'Move'), nb('−5 s', -5000), nb('−1 s', -1000), nb('+1 s', 1000), nb('+5 s', 5000)),
    h('div', { class: 'grid2 mt' },
      slider('Music during the message', 'duck', s.levels.duck, (x) => `${x}% of normal`, 'Lower means the music dips more while the narrator speaks.'),
      slider('Narrator volume', 'narr', s.levels.narr ?? 100, (x) => `${x}%`, 'How loud this message is.')),
    isV3(s.voice.modelId) ? h('p', { class: 'muted small' }, 'Delivery cues like [softly] or [warmly] work here too.') : null);
  return box;
}

async function hearInPlace(ins) {
  const cue = S.insertCue(ins);
  const at = layout.songs.find((y) => y.song.uri === ins.uri);
  if (!at || !recs[cue]) return;
  const url = URL.createObjectURL(recs[cue].blob);
  await preview.play(at.song, {
    startMs: Math.max(0, ins.atMs - 6000),
    overlay: { url, atMs: ins.atMs, duck: (ins.duck ?? s.levels.duck) / 100, narr: (ins.narr ?? s.levels.narr ?? 100) / 100, label: (ins.text || 'message').slice(0, 40) },
  });
}

// ---------------------------------------------------------------- recording one message
async function recordInsert(ins) {
  if (!eleven.hasKey) { toast('Add your ElevenLabs API key in Settings first.'); app.openSettings('set-eleven'); return; }
  const text = (ins.text || '').trim();
  if (!text) { toast('Write the message first.'); return; }
  recording = ins.id;
  render();
  const cue = S.insertCue(ins);
  try {
    await flush();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), window.__scTtsTimeout || 90000);
    let blob;
    try {
      await eleven.ensureVoice(s.voice);
      blob = await eleven.tts(ins.text, s.voice, ctrl.signal);
    } finally { clearTimeout(timer); }
    const rec = { blob, key: clipKey(ins.text, s.voice), chars: prepText(ins.text, s.voice.modelId).length, at: Date.now(), source: 'generated' };
    await db.clips.put(s.id, cue, rec);
    recs[cue] = rec;
    toast('Recorded.', 1800);
  } catch (e) {
    toast(e.name === 'AbortError' ? "ElevenLabs didn't answer in time. Try again." : e.message, 7000);
  }
  recording = null;
  render();
  await sleep(50);
}
