// Song previews while designing a session. A song plays on the Spotify player from a third of the
// way in (to hear its feel), with a small floating player to pause, scrub and stop. A recorded
// message can play over the song at its spot, with the music dipping, to hear how it sits.
import { h, toast, fmtSong, sleep, clamp, log } from './util.js?v=2.5.1-24e6cfcc';
import { app, cfg } from './app.js?v=2.5.1-24e6cfcc';
import { auth, player } from './spotify.js?v=2.5.1-24e6cfcc';

const st = {
  track: null, startedAt: 0, timer: null, el: null, parts: null,
  volume: 0.7, overlay: null, voice: new Audio(), playingOverlay: false, ended: false,
};
st.voice.preload = 'auto';

export const preview = {
  isRunning: () => false,            // set by main.js: a live session is running in this tab
  get track() { return st.track; },
  isPlaying(uri) { return !!st.track && st.track.uri === uri && !player.paused; },

  // track: { uri, name, artists, durationMs, imageSm }
  // opts: { startMs, overlay: { url, atMs, duck (0..1 of the preview volume), narr (0..1), label } }
  async play(track, opts = {}) {
    if (preview.isRunning()) { toast('Previews are off while a session is running.'); return false; }
    if (cfg.demo) { toast('Previews need Spotify. Turn off demo mode in Settings.'); return false; }
    if (!auth.connected) { toast('Connect Spotify in Settings to preview songs.'); app.openSettings('set-spotify'); return false; }
    // Chrome only lets the browser player make sound after a click: unlock it straight away.
    if (player.mode === 'browser' && player.sdk && player.sdk.activateElement) { try { player.sdk.activateElement(); } catch { /* ignore */ } }
    if (opts.overlay) { try { st.voice.muted = true; st.voice.src = opts.overlay.url; st.voice.play().then(() => { st.voice.pause(); st.voice.muted = false; st.voice.currentTime = 0; }).catch(() => { st.voice.muted = false; }); } catch { /* ignore */ } }
    if (!player.ready) {
      if (player.mode === 'connect') { toast('Choose a Spotify device in Settings (and open the Spotify app) to preview songs.'); return false; }
      player.start();
      for (let i = 0; i < 40 && !player.ready; i++) await sleep(200);
      if (!player.ready) { toast('The Spotify player is still starting. Try again in a moment.'); return false; }
    }
    stopOverlay();
    const startMs = clamp(opts.startMs ?? Math.round((track.durationMs || 0) * 0.3), 0, Math.max(0, (track.durationMs || 0) - 3000));
    st.track = track; st.overlay = opts.overlay || null; st.ended = false; st.startedAt = performance.now();
    show();
    try {
      await player.setVolume(st.volume);
      await player.playUris([track.uri], null, startMs);
      player.pos = startMs; player.posAt = performance.now(); player.paused = false;
      log('preview', track.name, '@' + Math.round(startMs / 1000) + 's');
    } catch (e) { toast(e.message); stop(); return false; }
    app.emit('preview');
    return true;
  },

  async toggle(track, opts) {
    if (st.track && st.track.uri === track.uri && !opts?.overlay) {
      if (player.paused) await player.resume(); else await player.pause();
      app.emit('preview'); paint();
      return;
    }
    await preview.play(track, opts);
  },

  stop() { stop(); },
};

function stopOverlay() {
  st.voice.pause();
  st.playingOverlay = false;
}

function stop() {
  const had = !!st.track;
  stopOverlay();
  st.track = null; st.overlay = null;
  clearInterval(st.timer); st.timer = null;
  if (st.el) st.el.hidden = true;
  if (had && !preview.isRunning() && player.ready && !cfg.demo) player.pause();
  if (had) app.emit('preview');
}

// ---------------------------------------------------------------- the floating player
function build() {
  const art = h('img', { alt: '' });
  const title = h('div', { class: 't' });
  const artist = h('div', { class: 'a' });
  const pp = h('button', { class: 'ib', type: 'button', 'aria-label': 'Pause' }, '❚❚');
  const back = h('button', { class: 'ib', type: 'button', title: 'Back 10 seconds' }, '−10');
  const fwd = h('button', { class: 'ib', type: 'button', title: 'Forward 10 seconds' }, '+10');
  const close = h('button', { class: 'ib', type: 'button', title: 'Stop preview', 'aria-label': 'Stop preview' }, '✕');
  const pos = h('span', { class: 'tm' }, '0:00');
  const dur = h('span', { class: 'tm' }, '0:00');
  const scrub = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Position in the song' });
  const note = h('div', { class: 'note' });
  pp.addEventListener('click', async () => { if (player.paused) await player.resume(); else { await player.pause(); stopOverlay(); } paint(); app.emit('preview'); });
  back.addEventListener('click', () => player.seek(player.position() - 10000));
  fwd.addEventListener('click', () => player.seek(player.position() + 10000));
  close.addEventListener('click', stop);
  let dragging = false;
  scrub.addEventListener('input', () => { dragging = true; pos.textContent = fmtSong((+scrub.value / 1000) * (st.track ? st.track.durationMs : 0)); });
  scrub.addEventListener('change', async () => { dragging = false; if (st.track) { stopOverlay(); await player.seek((+scrub.value / 1000) * st.track.durationMs); } });
  st.parts = { art, title, artist, pp, pos, dur, scrub, note, isDragging: () => dragging };
  st.el = h('div', { class: 'pv', role: 'region', 'aria-label': 'Song preview', hidden: true },
    art, h('div', { class: 'm' }, title, artist, note),
    h('div', { class: 'ctl' }, back, pp, fwd, close),
    h('div', { class: 'bar' }, pos, scrub, dur));
  document.body.append(st.el);
}

function show() {
  if (!st.el) build();
  st.el.hidden = false;
  paint();
  clearInterval(st.timer);
  st.timer = setInterval(tickPreview, 150);
}

function paint() {
  if (!st.el || !st.track) return;
  const p = st.parts, t = st.track;
  if (t.imageSm) p.art.src = t.imageSm; else p.art.removeAttribute('src');
  p.title.textContent = t.name;
  p.artist.textContent = t.artists || '';
  p.note.textContent = st.overlay ? `With “${st.overlay.label || 'message'}” at ${fmtSong(st.overlay.atMs)}` : 'Preview';
  p.pp.textContent = player.paused ? '▶' : '❚❚';
  p.pp.setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
  p.dur.textContent = fmtSong(t.durationMs);
  const ms = Math.min(player.position(), t.durationMs || 0);
  if (!p.isDragging()) { p.scrub.value = String(t.durationMs ? Math.round((ms / t.durationMs) * 1000) : 0); p.pos.textContent = fmtSong(ms); }
}

async function fadeVolume(to, ms) {
  const from = player.level ?? st.volume, steps = Math.max(1, Math.round(ms / 100));
  for (let i = 1; i <= steps; i++) { if (!st.track) return; await player.setVolume(from + (to - from) * (i / steps)); await sleep(ms / steps); }
}

function tickPreview() {
  if (!st.track) return;
  // Something else took over the player (another song, or the song ended).
  const cur = player.current;
  if (performance.now() - st.startedAt > 4000 && cur && cur.uri !== st.track.uri) { stop(); return; }
  if (performance.now() - st.startedAt > 4000 && player.paused && player.position() >= (st.track.durationMs || 0) - 1500) { stop(); return; }
  const o = st.overlay;
  if (o && !st.playingOverlay && !player.paused) {
    const ms = player.position();
    if (ms >= o.atMs && ms < o.atMs + 2500) {
      st.playingOverlay = true;
      const v = st.voice;
      v.src = o.url; v.currentTime = 0; v.volume = clamp(o.narr ?? 1, 0, 1);
      fadeVolume(st.volume * clamp(o.duck ?? 0.2, 0, 1), o.fadeMs || 1200);
      v.onended = () => { st.playingOverlay = 'done'; fadeVolume(st.volume, 2000); };
      v.play().catch((e) => { log('preview-voice', e.message); st.playingOverlay = 'done'; fadeVolume(st.volume, 800); });
    }
  }
  if (o && st.playingOverlay === 'done' && player.position() < o.atMs - 500) st.playingOverlay = false;   // scrubbed back
  paint();
}

// A small ▶ button that previews a song, and shows ■ while that song is previewing.
const paintButton = (b) => { const on = preview.isPlaying(b.dataset.uri); b.textContent = on ? '■' : '▶'; b.classList.toggle('on', on); };
app.on('preview', () => document.querySelectorAll('button.pvb').forEach(paintButton));
app.on('playback', () => { if (st.track) document.querySelectorAll('button.pvb').forEach(paintButton); });

export function previewButton(track, cls = 'ib pvb') {
  const b = h('button', { class: cls.includes('pvb') ? cls : cls + ' pvb', type: 'button', title: `Preview “${track.name}”`, 'aria-label': `Preview ${track.name}`, 'data-uri': track.uri }, '▶');
  b.addEventListener('click', (e) => { e.stopPropagation(); if (preview.isPlaying(track.uri)) preview.stop(); else preview.play(track); });
  paintButton(b);
  return b;
}
