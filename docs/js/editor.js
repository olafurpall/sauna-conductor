// Session creator / editor: playlists, timing, voice, editable narration, recording.
import { $, $$, h, toast, fmtDur, fmtSong, autosize, pickFile, sleep, now } from './util.js?v=2.4-c175b092';
import { planRounds } from './planner.js?v=2.4-c175b092';
import { app, cfg } from './app.js?v=2.4-c175b092';
import * as db from './db.js?v=2.4-c175b092';
import * as S from './sessions.js?v=2.4-c175b092';
import { cuePlan, defaultText } from './script.js?v=2.4-c175b092';
import { eleven, isV3, clipKey, prepText } from './eleven.js?v=2.4-c175b092';
import { auth, myPlaylists, parseUri, playlistInfo, sourceTracks } from './spotify.js?v=2.4-c175b092';

const el = $('#view-editor');
let s = null;            // the session being edited
let recs = {};           // cue id -> clip record
let dirty = false;
let busy = false;
let saved = false;       // exists in the database
const busyCues = new Set();
const audio = new Audio();
let audioBtn = null;
let audioUrl = null;
let barEl = null;

export const editorView = {
  el,
  get dirty() { return app.current === 'editor' && (dirty || busy); },
  async enter(id) {
    closePanel();
    document.body.classList.add('editing');
    for (const k of Object.keys(trackCache)) delete trackCache[k];
    planMsg = ''; planning = false; onHeatChange = null;
    if (id) {
      s = await db.sessions.get(id);
      if (!s) { toast('That session no longer exists.'); app.show('library'); return; }
      saved = true;
      recs = await db.clips.forSession(s.id);
    } else {
      s = S.newSession();
      saved = false;
      recs = {};
    }
    S.ensureScript(s);
    dirty = !id;
    build();
  },
  async leave() {
    stopAudio();
    if (busy) { toast('Wait until the recording has finished.'); return false; }
    if (dirty && !confirm('Leave without saving your changes?')) return false;
    closePanel();
    document.body.classList.remove('editing');
    closePops();
    return true;
  },
};

function touch() { dirty = true; updateBar(); }

async function persist() {
  s.name = (s.name || '').trim() || 'Untitled session';
  await S.save(s);
  saved = true; dirty = false;
  updateBar();
}

// ---------------------------------------------------------------- audio preview
function stopAudio() {
  audio.pause();
  if (audioBtn) { audioBtn.textContent = audioBtn.dataset.label; audioBtn = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
}
function playAudio(src, btn, isBlob = false) {
  const same = audioBtn === btn;
  stopAudio();
  if (same) return;
  if (isBlob) { audioUrl = URL.createObjectURL(src); src = audioUrl; }
  audio.src = src;
  audioBtn = btn;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = '■ Stop';
  audio.onended = () => stopAudio();
  audio.play().catch(() => { toast('Could not play that audio.'); stopAudio(); });
}

// ---------------------------------------------------------------- layout
function build() {
  el.innerHTML = '';
  const wrap = h('div', { class: 'ed-wrap' },
    head(), secMusic(), secTiming(), secVoice(), secScript(), secLevels());
  barEl = bar();
  el.append(wrap, barEl);
  $$('textarea', el).forEach(autosize);
  updateBar();
}

function head() {
  const name = h('input', { type: 'text', class: 'ed-name', value: s.name, 'aria-label': 'Session name', placeholder: 'Session name' });
  name.addEventListener('input', () => { s.name = name.value; touch(); });
  return h('div', { class: 'ed-head' },
    h('button', { class: 'ghost small', onclick: () => app.show('library') }, '← Sessions'),
    name);
}

// ---------------------------------------------------------------- music
let openPop = null;
function closePops() { if (openPop) { openPop.remove(); openPop = null; } }
document.addEventListener('click', (e) => { if (openPop && !e.target.closest('.pl-field')) closePops(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });

function plSub(p) {
  if (!p) return '';
  const bits = [];
  if (p.total != null) bits.push(`${p.total} songs`);
  if (p.ownerName) bits.push(p.ownerName);
  return bits.join(' · ');
}

function playlistField(label, key, optional) {
  const field = h('div', { class: 'pl-field' }, label);
  const btn = h('button', { type: 'button', class: 'pl-btn' });
  const paint = () => {
    const p = s.music[key];
    btn.innerHTML = '';
    btn.append(
      p && p.image ? h('img', { src: p.image, alt: '' }) : h('span', { class: 'pl-ph' }),
      h('span', {}, h('div', { class: 't' }, p ? p.name : optional ? 'None — keep the heat playlist, softer' : 'Choose a playlist'),
        h('div', { class: 's' }, p ? plSub(p) : optional ? 'Optional' : 'Required')),
      h('span', { class: 'caret' }, '▾'));
  };
  paint();
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (openPop && openPop.parentNode === field) closePops(); else openPicker(field, key, optional, paint); });
  field.append(btn);
  return field;
}

async function openPicker(field, key, optional, paint) {
  closePops();
  const input = h('input', { type: 'search', placeholder: 'Search your playlists or paste a Spotify link' });
  const list = h('div', { class: 'pl-list' }, h('div', { class: 'muted small' }, 'Loading your playlists…'));
  const pop = h('div', { class: 'pl-pop' }, input, list);
  field.append(pop);
  openPop = pop;
  setTimeout(() => input.focus(), 0);

  let all = [];
  const choose = (p) => {
    const before = s.music[key] && s.music[key].uri;
    s.music[key] = p ? { uri: p.uri, name: p.name, image: p.image || '', total: p.total ?? null, ownerName: p.ownerName || '' } : null;
    touch(); paint(); closePops();
    if (key === 'heat' && before !== (p && p.uri) && onHeatChange) onHeatChange();
  };
  const item = (p, sub) => h('button', { type: 'button', class: 'pl-item', onclick: () => choose(p) },
    p && p.image ? h('img', { src: p.image, alt: '' }) : h('span', { class: 'pl-ph' }),
    h('span', {}, h('div', { class: 't' }, p ? p.name : 'None'), h('div', { class: 's' }, sub ?? plSub(p))));

  const render = async () => {
    const q = input.value.trim();
    list.innerHTML = '';
    const uri = parseUri(q);
    if (uri) {
      list.append(h('div', { class: 'muted small' }, 'Looking up that link…'));
      let p = { uri, name: 'Spotify playlist', image: '', total: null, ownerName: '' };
      try { p = await playlistInfo(uri); } catch { /* keep the bare link */ }
      list.innerHTML = '';
      list.append(item(p, 'Use this link'));
      return;
    }
    if (optional) list.append(item(null, 'Keep the heat playlist playing softly during breaks'));
    const ql = q.toLowerCase();
    const hits = all.filter((p) => !ql || p.name.toLowerCase().includes(ql));
    hits.slice(0, 200).forEach((p) => list.append(item(p)));
    if (!hits.length && all.length) list.append(h('div', { class: 'muted small' }, 'No playlist matches. You can paste a Spotify link instead.'));
  };
  input.addEventListener('input', render);

  if (!auth.connected || !auth.libraryOk) {
    list.innerHTML = '';
    list.append(h('div', { class: 'muted small' }, auth.connected ? 'Reconnect Spotify in Settings to list your playlists. You can also paste a playlist link above.' : 'Connect Spotify in Settings to list your playlists. You can also paste a playlist link above.'));
    if (optional) list.prepend(item(null, 'Keep the heat playlist playing softly during breaks'));
    return;
  }
  try { all = await myPlaylists(); } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, e.message)); return; }
  render();
}

function secMusic() {
  const smooth = h('input', { type: 'checkbox', checked: !!s.music.smooth });
  smooth.addEventListener('change', () => { s.music.smooth = smooth.checked; touch(); });
  const fade = h('select', {}, ...[3, 5, 6, 8, 10, 12].map((n) => h('option', { value: n, selected: n === s.music.fadeSec }, `${n} s`)));
  fade.style.minWidth = '80px';
  fade.addEventListener('change', () => { s.music.fadeSec = +fade.value; touch(); });
  const shuffle = h('input', { type: 'checkbox', checked: !!s.music.shuffle });
  shuffle.addEventListener('change', () => { s.music.shuffle = shuffle.checked; touch(); });
  return h('section', { class: 'ed-sec', id: 'ed-music' },
    h('h2', {}, 'Music'),
    h('p', { class: 'help' }, 'Each heat round picks up on the next song, so the playlist flows through the whole session.'),
    h('div', { class: 'grid2' }, playlistField('Heat playlist', 'heat', false), playlistField('Cool-down playlist', 'cool', true)),
    h('div', { class: 'row mt' },
      h('label', { class: 'chk' }, shuffle, 'Shuffle'),
      h('span', { class: 'spacer' }),
      h('label', { class: 'chk' }, smooth, 'Fade between songs'), fade),
    h('p', { class: 'muted small' }, 'Song fades apply when the music plays in this browser. If it plays through the Spotify app, turn on Crossfade in the Spotify app instead.'));
}

// ---------------------------------------------------------------- rounds & timing
const trackCache = {};
let planMsg = '';
let planning = false;
let onHeatChange = null;
const slim = (t) => ({ uri: t.uri, name: t.name, artists: t.artists, durationMs: t.durationMs, imageSm: t.imageSm || '', i: t.i ?? 0 });

function secTiming() {
  const t = s.timing;
  const sec = h('section', { class: 'ed-sec', id: 'ed-timing' });
  const total = h('span', { class: 'val' });
  const modeSeg = h('div', { class: 'seg-ctl' });
  const body = h('div', {});
  const planBox = h('div', {});
  const suggest = h('button', { class: 'small primary' }, 'Suggest rounds');
  suggest.addEventListener('click', () => autoPlan(S.planValid(s)));
  const keep = h('input', { type: 'checkbox', checked: !!t.keepOrder });
  keep.addEventListener('change', () => { t.keepOrder = keep.checked; touch(); autoPlan(false); });
  const auto = h('input', { type: 'checkbox', checked: !!t.autoNext });
  auto.addEventListener('change', () => { t.autoNext = auto.checked; touch(); });

  const paintTotal = () => {
    total.textContent = t.mode === 'songs' && !S.planValid(s) ? 'plan the rounds below' : fmtDur(S.totalMs(s));
    updateBar();
  };

  const num = (label, key, min, max, after) => {
    const i = h('input', { type: 'number', min, max, value: t[key] });
    i.addEventListener('change', () => {
      const oldR = t.rounds, oldMin = t.roundMin;
      t[key] = Math.min(max, Math.max(min, parseInt(i.value, 10) || min));
      if (t.minMin > t.roundMin) t.minMin = t.roundMin;
      if (t.maxMin < t.roundMin) t.maxMin = t.roundMin;
      // Keep untouched default texts in step with the new numbers.
      for (const c of cuePlan(Math.max(oldR, t.rounds))) {
        if (s.script[c.id] === defaultText(c.id, oldR, oldMin)) s.script[c.id] = defaultText(c.id, t.rounds, t.roundMin);
      }
      S.ensureScript(s);
      touch();
      if (key === 'rounds' || key === 'roundMin') refreshScript();
      paint();
      if (after) after();
    });
    return h('label', { class: 'f' }, label, i);
  };

  const fmtLen = (ms) => fmtSong(ms);

  // ---- editing the rounds: move, reorder, swap, remove, add, theme
  let drag = null;
  const changed = () => { touch(); renderPlan(); paintTotal(); };
  const toPool = (song) => { s.plan.pool.push(song); s.plan.pool.sort((a, b) => a.i - b.i); };
  function moveSong(fromR, fromK, toR, toK) {
    const [song] = s.plan.rounds[fromR].splice(fromK, 1);
    if (!song) return;
    if (fromR === toR && toK > fromK) toK--;
    s.plan.rounds[toR].splice(Math.max(0, Math.min(toK, s.plan.rounds[toR].length)), 0, song);
    changed();
  }
  const clearDrop = () => $$('.rsongs .drop-before, .rsongs .drop-after, .rsongs.drop-end', el).forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-end'));

  function swapMenu(acts, songs, k) {
    const song = songs[k];
    const opts = s.plan.pool.map((p, idx) => ({ p, idx, d: p.durationMs - song.durationMs })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const sign = (d) => (d >= 0 ? '+' : '−') + fmtSong(Math.abs(d));
    const sel = h('select', { class: 'swap', 'aria-label': `Swap ${song.name} for` },
      h('option', { value: '' }, opts.length ? `Swap “${song.name}” for…` : 'No unused songs to swap in'),
      ...opts.map((o) => h('option', { value: String(o.idx) }, `${o.p.name} — ${o.p.artists} · ${fmtSong(o.p.durationMs)} (${sign(o.d)})`)));
    sel.addEventListener('change', () => {
      if (sel.value === '') return;
      const [rep] = s.plan.pool.splice(+sel.value, 1);
      songs.splice(k, 1, rep);
      toPool(song);
      changed();
    });
    sel.addEventListener('blur', () => setTimeout(renderPlan, 150));
    sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') renderPlan(); });
    acts.closest('li').classList.add('swapping');
    acts.replaceChildren(sel);
    sel.focus();
  }

  function roundCard(songs, ri) {
    const R = s.plan.rounds.length;
    const tot = S.sumMs(songs), n = songs.length;
    const inLen = tot >= t.minMin * 60000 && tot <= t.maxMin * 60000;
    const inN = n >= 3 && n <= 6;
    const [cls, lab] = !n ? ['chip warn', 'No songs'] : !inLen ? ['chip warn', tot < t.minMin * 60000 ? 'Too short' : 'Too long'] : !inN ? ['chip warn', `${n} songs`] : ['chip ok', `${n} songs`];
    const list = h('ol', { class: 'rsongs', 'data-ri': String(ri) });
    songs.forEach((song, k) => {
      const ib = (label, title, fn, disabled) => {
        const b = h('button', { class: 'ib', type: 'button', title, 'aria-label': `${title}: ${song.name}`, disabled }, label);
        b.addEventListener('click', fn);
        return b;
      };
      const acts = h('span', { class: 'acts' });
      acts.append(
        ib('▲', 'Move up', () => (k > 0 ? moveSong(ri, k, ri, k - 1) : moveSong(ri, k, ri - 1, s.plan.rounds[ri - 1].length)), k === 0 && ri === 0),
        ib('▼', 'Move down', () => (k < n - 1 ? moveSong(ri, k, ri, k + 2) : moveSong(ri, k, ri + 1, 0)), k === n - 1 && ri === R - 1),
        ib('⇄', 'Swap for an unused song', () => swapMenu(acts, songs, k), !s.plan.pool.length),
        ib('×', 'Remove from this round', () => { songs.splice(k, 1); toPool(song); changed(); }));
      const li = h('li', { draggable: 'true' },
        h('span', { class: 'grip', title: 'Drag to move', 'aria-hidden': 'true' }, '⋮⋮'),
        song.imageSm ? h('img', { src: song.imageSm, alt: '' }) : h('span', { class: 'ph' }),
        h('span', { class: 'm' }, h('div', { class: 't' }, song.name), h('div', { class: 'a' }, song.artists)),
        h('span', { class: 'd' }, fmtSong(song.durationMs)), acts);
      li.addEventListener('dragstart', (e) => {
        drag = { ri, k };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${ri}:${k}`);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); drag = null; clearDrop(); });
      li.addEventListener('dragover', (e) => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        clearDrop();
        li.classList.add(after ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        const from = drag; drag = null; clearDrop();
        moveSong(from.ri, from.k, ri, after ? k + 1 : k);
      });
      list.append(li);
    });
    list.addEventListener('dragover', (e) => { if (!drag) return; e.preventDefault(); clearDrop(); list.classList.add('drop-end'); });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop-end'); });
    list.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      const from = drag; drag = null; clearDrop();
      moveSong(from.ri, from.k, ri, songs.length);
    });

    // theme / mood for this round
    if (!s.plan.themes) s.plan.themes = [];
    const themeVal = s.plan.themes[ri] || '';
    const closedLabel = () => (s.plan.themes[ri] || '').trim() || '+ Add a theme or mood for this round';
    const sum = h('summary', {}, themeVal ? 'Theme or mood' : closedLabel());
    const ta = h('textarea', { rows: 2, placeholder: 'e.g. Slow and spacious, deep breathing. Interstellar ambient building into soft house.' }, themeVal);
    ta.addEventListener('input', () => { s.plan.themes[ri] = ta.value; touch(); });
    const theme = h('details', { class: 'rtheme', open: !!themeVal }, sum, ta);
    theme.addEventListener('toggle', () => { sum.textContent = theme.open ? 'Theme or mood' : closedLabel(); if (theme.open) ta.focus(); });

    const add = h('select', { 'aria-label': `Add a song to round ${ri + 1}` },
      h('option', { value: '' }, s.plan.pool.length ? '+ Add a song from the playlist…' : 'All songs are in use'),
      ...s.plan.pool.map((p, idx) => h('option', { value: String(idx) }, `${p.name} — ${p.artists} · ${fmtSong(p.durationMs)}`)));
    add.disabled = !s.plan.pool.length;
    add.addEventListener('change', () => {
      if (add.value === '') return;
      const [song] = s.plan.pool.splice(+add.value, 1);
      songs.push(song);
      changed();
    });
    return h('div', { class: 'rcard' + (inLen && inN ? '' : ' off') },
      h('div', { class: 'rhead' }, h('b', {}, `Round ${ri + 1}`), h('span', { class: 'rdur' }, fmtLen(tot)), h('span', { class: cls }, lab)),
      theme, list, add);
  }

  function renderPlan() {
    planBox.innerHTML = '';
    suggest.textContent = S.planValid(s) ? 'Suggest again' : 'Suggest rounds';
    suggest.disabled = planning || !s.music.heat;
    if (planning) { planBox.append(h('p', { class: 'muted small' }, 'Reading the playlist and planning rounds…')); return; }
    if (!S.planValid(s)) {
      planBox.append(h('p', { class: 'muted small' }, planMsg || (s.music.heat ? 'Press “Suggest rounds” to split the heat playlist into rounds.' : 'Choose a heat playlist above. The rounds are planned from its songs.')));
      return;
    }
    const grid = h('div', { class: 'rounds-grid' });
    s.plan.rounds.forEach((songs, ri) => grid.append(roundCard(songs, ri)));
    planBox.append(grid);
    const unused = s.plan.pool.length;
    planBox.append(h('p', { class: 'muted small mt' },
      `${unused} song${unused === 1 ? '' : 's'} from the playlist ${unused === 1 ? 'is' : 'are'} not in a round. ` +
      (s.music.cool ? '' : 'Without a cool-down playlist, those play softly during the breaks. ') +
      'Drag songs (or use ▲▼) to reorder them or move them to another round. ⇄ swaps a song for an unused one, × removes it.'));
  }

  async function autoPlan(again) {
    if (t.mode !== 'songs') return;
    if (!s.music.heat) { planMsg = ''; renderPlan(); paintTotal(); return; }
    if (!auth.libraryOk) { planMsg = auth.connected ? 'Reconnect Spotify in Settings so the conductor can read the playlist.' : 'Connect Spotify in Settings so the conductor can read the playlist.'; renderPlan(); return; }
    planning = true; planMsg = ''; renderPlan();
    try {
      const src = s.music.heat.uri;
      if (!trackCache[src]) trackCache[src] = await sourceTracks(src);
      const prev = again && S.planValid(s) ? s.plan : null;
      const o = {
        rounds: t.rounds, minMs: t.minMin * 60000, maxMs: t.maxMin * 60000, aimMs: t.roundMin * 60000, keepOrder: !!t.keepOrder,
        offset: prev ? prev.nextOffset || 0 : 0, seed: prev ? (prev.seed || 1) + 1 : 1,
      };
      const res = planRounds(trackCache[src], o);
      const themes = (s.plan && s.plan.themes) || [];
      if (res.error) { planMsg = res.error; s.plan = null; }
      else s.plan = { source: src, rounds: res.rounds.map((r) => r.map(slim)), pool: res.unused.map(slim), themes, offset: o.offset, nextOffset: res.nextOffset, seed: o.seed, at: Date.now() };
      touch();
    } catch (e) { planMsg = e.message; s.plan = null; }
    planning = false;
    renderPlan(); paintTotal();
  }
  onHeatChange = () => autoPlan(false);

  function paint() {
    [...modeSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.m === t.mode));
    body.innerHTML = '';
    if (t.mode === 'songs') {
      body.append(
        h('p', { class: 'muted small' }, 'Each round is a set of whole songs from the heat playlist, and it ends when its last song ends.'),
        h('div', { class: 'grid5' },
          num('Rounds', 'rounds', 1, 8, () => autoPlan(false)),
          num('Shortest round (min)', 'minMin', 1, 60, () => autoPlan(false)),
          num('Aim for (min)', 'roundMin', 1, 60, () => autoPlan(false)),
          num('Longest round (min)', 'maxMin', 1, 90, () => autoPlan(false)),
          num('Cool-down (min)', 'breakMin', 1, 30)),
        h('div', { class: 'row mt' }, h('label', { class: 'chk' }, keep, "Keep the playlist's song order"), h('span', { class: 'spacer' }), suggest),
        planBox);
      renderPlan();
    } else {
      body.append(h('div', { class: 'grid4' },
        num('Rounds', 'rounds', 1, 8), num('Minutes per round', 'roundMin', 1, 60), num('Minutes per cool-down', 'breakMin', 1, 30)));
    }
    body.append(h('label', { class: 'chk mt' }, auto, 'Start the next round automatically when the cool-down ends'));
    paintTotal();
  }

  [['songs', 'Follow the songs'], ['timed', 'Fixed minutes']].forEach(([m, lab]) => {
    modeSeg.append(h('button', { type: 'button', 'data-m': m, onclick: () => { t.mode = m; touch(); paint(); if (m === 'songs' && !S.planValid(s)) autoPlan(false); } }, lab));
  });

  sec.append(
    h('h2', {}, 'Rounds'),
    h('p', { class: 'help' }, 'Session length: ', total),
    h('div', { class: 'row', style: { marginBottom: '14px' } }, modeSeg),
    body);
  paint();
  if (t.mode === 'songs' && s.music.heat && !s.plan) setTimeout(() => autoPlan(false), 0);
  return sec;
}

// ---------------------------------------------------------------- voice
let voicePaint = null;
let settingsPaint = null;

function secVoice() {
  const sec = h('section', { class: 'ed-sec', id: 'ed-voice' },
    h('h2', {}, 'Voice'),
    h('p', { class: 'help' }, 'Choose the narrator and listen before recording. Recording uses your ElevenLabs credits, roughly one per character.'));

  if (!eleven.hasKey) {
    sec.append(h('div', { class: 'banner', style: { margin: '0 0 14px' } },
      'Add your ElevenLabs API key in Settings to browse voices and record narration.',
      h('div', { class: 'row' }, h('button', { class: 'small primary', onclick: () => app.openSettings('set-eleven') }, 'Open Settings'))));
  }

  // model
  const model = h('select', { 'aria-label': 'Voice model' });
  const fill = (models) => {
    model.innerHTML = '';
    const order = (m) => (isV3(m.id) ? 0 : m.id === 'eleven_multilingual_v2' ? 1 : 2);
    [...models].sort((a, b) => order(a) - order(b)).forEach((m) => {
      const note = isV3(m.id) ? ' — most expressive' : m.id === 'eleven_multilingual_v2' ? ' — steady and reliable' : '';
      model.append(h('option', { value: m.id, selected: m.id === s.voice.modelId }, m.name + note));
    });
    if (![...model.options].some((o) => o.value === s.voice.modelId)) model.prepend(h('option', { value: s.voice.modelId, selected: true }, s.voice.modelId));
  };
  fill([{ id: 'eleven_v3', name: 'Eleven v3' }, { id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2' }]);
  if (eleven.hasKey) eleven.models().then(fill).catch(() => {});
  model.addEventListener('change', () => { s.voice.modelId = model.value; voiceChanged(); });

  // selected voice card
  const card = h('div', { class: 'voice-card' });
  const picker = h('div', { class: 'picker', hidden: true });
  voicePaint = () => {
    const v = s.voice;
    card.innerHTML = '';
    const sample = h('button', { class: 'small', onclick: () => playSample(v, sample) }, '▶ Sample');
    card.append(h('div', { class: 'orb' }),
      h('div', {}, h('div', { class: 't' }, v.name), h('div', { class: 'd' }, [v.labels && v.labels.join(' · '), v.desc].filter(Boolean).join(' — '))),
      h('div', { class: 'row' }, sample,
        h('button', { class: 'small', onclick: () => { picker.hidden = !picker.hidden; if (!picker.hidden) openVoicePicker(picker); } }, 'Change voice')));
  };
  voicePaint();

  const settingsBox = h('div', { class: 'mt' });
  settingsPaint = () => paintVoiceSettings(settingsBox);
  settingsPaint();

  const hear = h('button', { class: 'small primary' }, '▶ Hear the welcome in this voice');
  hear.addEventListener('click', () => recordAndPlay('welcome', hear));

  sec.append(
    h('div', { class: 'row' }, h('label', { class: 'f', style: { flex: '1 1 260px' } }, 'Model', model)),
    h('div', { class: 'mt' }, card), picker, settingsBox,
    h('div', { class: 'row mt' }, hear, h('span', { class: 'muted small' }, 'Records the welcome message, which is then kept for the session.')),
    h('div', { class: 'hint-box', html: 'With <b>Eleven v3</b> you can add delivery cues in square brackets, such as <code>[softly]</code> <code>[warmly]</code> <code>[chuckles]</code> <code>[sighs]</code> <code>[whispers]</code>. Three dots <code>...</code> add a pause. Other models leave the cues out.' }));
  return sec;
}

function paintVoiceSettings(box) {
  const v = s.voice;
  box.innerHTML = '';
  if (isV3(v.modelId)) {
    const opts = [[0, 'Creative'], [0.5, 'Natural'], [1, 'Robust']];
    const seg = h('div', { class: 'seg-ctl' }, ...opts.map(([val, lab]) => {
      const b = h('button', { type: 'button', class: Math.abs((v.stability ?? 0.5) - val) < 0.26 ? 'on' : '' }, lab);
      b.addEventListener('click', () => { v.stability = val; voiceChanged(); });
      return b;
    }));
    box.append(h('div', { class: 'f' }, 'Delivery', h('div', { class: 'row' }, seg,
      h('span', { class: 'muted small' }, 'Creative is the most emotional, Robust the most even. Natural is a good start.'))));
    return;
  }
  const slider = (label, key, min, max, step, fmtv) => {
    const out = h('span', { class: 'val' }, fmtv(v[key]));
    const r = h('input', { type: 'range', min, max, step, value: v[key] });
    r.addEventListener('input', () => { v[key] = +r.value; out.textContent = fmtv(v[key]); });
    r.addEventListener('change', voiceChanged);
    return h('label', { class: 'f' }, h('span', {}, label, ' ', out), r);
  };
  box.append(h('div', { class: 'grid4' },
    slider('Stability', 'stability', 0, 1, 0.05, (x) => (x < 0.35 ? 'expressive' : x > 0.7 ? 'steady' : 'balanced') + ` (${Math.round(x * 100)}%)`),
    slider('Speed', 'speed', 0.7, 1.2, 0.01, (x) => x.toFixed(2) + '×'),
    slider('Style', 'style', 0, 1, 0.05, (x) => Math.round(x * 100) + '%')));
}

function voiceChanged() {
  touch();
  if (voicePaint) voicePaint();
  if (settingsPaint) settingsPaint();
  refreshCueStates();
}

async function playSample(v, btn) {
  let url = v.previewUrl;
  if (!url && eleven.hasKey) {
    try {
      const mine = await eleven.myVoices();
      url = (mine.find((x) => x.id === v.id) || {}).previewUrl;
      if (!url) {
        const lib = await eleven.library(v.name);
        url = ((lib.voices || []).find((x) => x.id === v.id) || {}).previewUrl;
      }
      if (url) v.previewUrl = url;
    } catch { /* fall through */ }
  }
  if (!url) { toast('No sample for this voice. Use “Hear the welcome” instead.'); return; }
  playAudio(url, btn);
}

async function openVoicePicker(box) {
  box.innerHTML = '';
  if (!eleven.hasKey) { box.append(h('div', { class: 'muted small' }, 'Add your ElevenLabs API key in Settings first.')); return; }
  let tab = 'library';
  const search = h('input', { type: 'search', placeholder: 'Search voices, e.g. “deep narrator”, “southern”, “calm British”' });
  const list = h('div', { class: 'vlist' });
  const tabs = h('div', { class: 'seg-ctl' });
  const more = h('button', { class: 'small ghost mt', hidden: true }, 'Show more');
  let page = 0;
  const setTab = (t) => { tab = t; page = 0; [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); load(); };
  [['library', 'Voice library'], ['mine', 'My voices']].forEach(([t, lab]) => tabs.append(h('button', { type: 'button', 'data-t': t, onclick: () => setTab(t) }, lab)));

  const row = (v) => {
    const play = h('button', { class: 'small', disabled: !v.previewUrl }, '▶');
    play.addEventListener('click', () => playAudio(v.previewUrl, play));
    const use = h('button', { class: 'small primary' }, v.id === s.voice.id ? 'Selected' : 'Use');
    use.disabled = v.id === s.voice.id;
    use.addEventListener('click', async () => {
      use.disabled = true; use.textContent = 'Adding…';
      try {
        if (v.library) await eleven.addShared(v).catch((e) => { if (!/already/i.test(e.message)) throw e; });
        Object.assign(s.voice, { id: v.id, name: v.name, desc: v.desc, labels: v.labels, previewUrl: v.previewUrl, publicOwnerId: v.publicOwnerId || '' });
        voiceChanged();
        box.hidden = true;
        stopAudio();
        toast(`Narrator is now ${v.name}.`);
      } catch (e) { toast(e.message, 7000); use.disabled = false; use.textContent = 'Use'; }
    });
    return h('div', { class: 'vrow' + (v.id === s.voice.id ? ' sel' : '') },
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, v.name), h('div', { class: 'l' }, v.labels.join(' · ')), v.desc ? h('div', { class: 'd' }, v.desc) : null),
      h('div', { class: 'row' }, play, use));
  };

  let seq = 0;
  async function load(append = false) {
    const my = ++seq;
    if (!append) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, 'Loading voices…')); }
    try {
      const q = search.value.trim();
      let voices = [], hasMore = false;
      if (tab === 'mine') {
        const all = await eleven.myVoices(true);
        const ql = q.toLowerCase();
        voices = all.filter((v) => !ql || (v.name + ' ' + v.desc + ' ' + v.labels.join(' ')).toLowerCase().includes(ql));
      } else {
        const r = await eleven.library(q, page);
        voices = r.voices; hasMore = r.more;
      }
      if (my !== seq) return;
      if (!append) list.innerHTML = '';
      voices.forEach((v) => list.append(row(v)));
      if (!voices.length && !append) list.append(h('div', { class: 'muted small' }, 'No voices found.'));
      more.hidden = !hasMore;
    } catch (e) { if (my === seq) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, e.message)); } }
  }
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { page = 0; load(); }, 350); });
  more.addEventListener('click', () => { page++; load(true); });
  box.append(h('div', { class: 'row' }, tabs, h('div', { style: { flex: '1 1 260px' } }, search)), list, more);
  search.value = 'deep narrator';
  setTab('library');
}

// ---------------------------------------------------------------- script
let scriptBox = null;
const cueEls = {};

function secScript() {
  scriptBox = h('div', {});
  const sec = h('section', { class: 'ed-sec', id: 'ed-script' },
    h('h2', {}, 'Narration'),
    h('p', { class: 'help' }, 'Edit any message. Each one is recorded as its own clip and plays at the moment shown. You can also drop in your own MP3.'),
    scriptBox);
  refreshScript();
  return sec;
}

function refreshScript() {
  if (!scriptBox) return;
  scriptBox.innerHTML = '';
  for (const k of Object.keys(cueEls)) delete cueEls[k];
  for (const c of S.cues(s)) scriptBox.append(cueEditor(c));
  $$('textarea', scriptBox).forEach(autosize);
  updateBar();
}

const STATE_LABEL = {
  ready: ['chip ok', 'Recorded'],
  uploaded: ['chip info', 'Your own MP3'],
  outdated: ['chip warn', 'Changed — record again'],
  missing: ['chip', 'Not recorded'],
};

function cueEditor(c) {
  const ta = h('textarea', { rows: 4, spellcheck: true }, s.script[c.id] || '');
  const chip = h('span', { class: 'chip' });
  const count = h('span', { class: 'n' });
  const play = h('button', { class: 'small' }, '▶ Play');
  const rec = h('button', { class: 'small' }, 'Record');
  const up = h('button', { class: 'small ghost' }, 'Use my MP3');
  const reset = h('button', { class: 'small ghost' }, 'Reset text');
  const box = h('div', { class: 'cue-ed', 'data-cue': c.id },
    h('div', { class: 'cue-top' }, h('b', {}, c.title), h('span', { class: 'w' }, c.when), chip, count),
    ta, h('div', { class: 'row' }, play, rec, up, h('span', { class: 'spacer' }), reset));

  const paint = () => {
    const st = S.clipState(s, c.id, recs[c.id]);
    const [cls, lab] = busyCues.has(c.id) ? ['chip info', 'Recording…'] : STATE_LABEL[st];
    chip.className = cls; chip.textContent = lab;
    count.textContent = `${prepText(s.script[c.id], s.voice.modelId).length} characters`;
    play.disabled = !recs[c.id] || busyCues.has(c.id);
    rec.disabled = busy;
    rec.textContent = st === 'missing' ? 'Record' : 'Record again';
  };
  cueEls[c.id] = { paint };
  paint();

  ta.addEventListener('input', () => { s.script[c.id] = ta.value; autosize(ta); touch(); paint(); });
  play.addEventListener('click', () => { if (recs[c.id]) playAudio(recs[c.id].blob, play, true); });
  rec.addEventListener('click', () => recordAndPlay(c.id, null));
  up.addEventListener('click', async () => { const [f] = await pickFile('audio/*'); if (f) useUpload(c.id, f); });
  reset.addEventListener('click', () => {
    const def = defaultText(c.id, s.timing.rounds, s.timing.roundMin);
    if (ta.value !== def && !confirm('Replace this message with the original text?')) return;
    ta.value = def; s.script[c.id] = def; autosize(ta); touch(); paint();
  });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) useUpload(c.id, f); });
  return box;
}

function refreshCueStates() { Object.values(cueEls).forEach((x) => x.paint()); updateBar(); }

async function useUpload(cueId, file) {
  if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|wav|ogg)$/i.test(file.name)) { toast('That is not an audio file.'); return; }
  await persist();
  const rec = { blob: file, key: 'upload', chars: 0, at: Date.now(), source: 'uploaded' };
  await db.clips.put(s.id, cueId, rec);
  recs[cueId] = rec;
  refreshCueStates();
  toast('Your MP3 will play for this message.');
}

// ---------------------------------------------------------------- recording (with progress panel)
const TTS_TIMEOUT_MS = window.__scTtsTimeout || 90000;
const PARALLEL = 2;
let job = null;          // the recording in progress
let msPerChar = null;    // learned from finished messages

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const guessMs = (chars) => 2500 + chars * (msPerChar ?? (isV3(s.voice.modelId) ? 24 : 12));
const fmtSecs = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

function timeLeft() {
  const t = now();
  let running = 0, waiting = 0;
  for (const it of job.items) {
    if (it.state === 'recording' || it.state === 'retrying') running += Math.max(1500, guessMs(it.chars) - (t - it.started));
    else if (it.state === 'waiting') waiting += guessMs(it.chars);
  }
  return (running + waiting) / PARALLEL;
}

function renderPanel() {
  if (!job || !job.panel) return;
  const p = job.panel;
  const t = now();
  const done = job.items.filter((x) => x.state === 'done').length;
  const total = job.items.length;
  const active = job.items.map((x, i) => (x.state === 'recording' || x.state === 'retrying' ? i + 1 : 0)).filter(Boolean);
  // progress by characters, counting partly finished messages by elapsed time
  const allChars = job.items.reduce((n, x) => n + x.chars, 0) || 1;
  let doneChars = 0;
  for (const x of job.items) {
    if (x.state === 'done') doneChars += x.chars;
    else if (x.state === 'recording' || x.state === 'retrying') doneChars += x.chars * Math.min(0.9, (t - x.started) / guessMs(x.chars));
  }
  const pct = job.result === 'done' ? 100 : Math.round((doneChars / allChars) * 100);

  let head;
  if (job.result === 'done') head = `Done. ${total} message${total === 1 ? '' : 's'} recorded in ${fmtSecs(t - job.started)}.`;
  else if (job.result === 'cancelled') head = `Stopped. ${done} of ${total} recorded.`;
  else if (job.result === 'failed') head = 'Recording stopped because of a problem.';
  else if (job.stage) head = job.stage;
  else {
    const left = timeLeft();
    const slow = job.items.some((x) => x.state === 'recording' && t - x.started > guessMs(x.chars) * 1.6 + 10000);
    const which = active.length > 1 ? `messages ${active[0]}–${active[active.length - 1]}` : active.length ? `message ${active[0]}` : `message ${Math.min(total, done + 1)}`;
    head = `Recording ${which} of ${total} · ` +
      (slow ? 'ElevenLabs is taking longer than usual…' : left < 4000 ? 'almost done' : `about ${fmtSecs(left)} left`);
  }
  p.head.textContent = head;
  p.spin.hidden = !!job.result;
  p.bar.style.width = pct + '%';
  p.bar.classList.toggle('bad', job.result === 'failed');
  p.list.innerHTML = '';
  for (const x of job.items) {
    const sym = { waiting: '○', recording: '', retrying: '', done: '✓', failed: '!', cancelled: '–' }[x.state];
    const what = x.state === 'waiting' ? 'waiting'
      : x.state === 'recording' ? `recording… ${fmtSecs(t - x.started)}`
      : x.state === 'retrying' ? `trying again… ${fmtSecs(t - x.started)}`
      : x.state === 'done' ? fmtSecs(x.took)
      : x.state === 'failed' ? 'failed' : 'skipped';
    p.list.append(h('li', { class: 'st-' + x.state },
      h('span', { class: 'sym' }, sym || h('span', { class: 'spin sm' })), h('span', { class: 't' }, x.title), h('span', { class: 'w' }, what)));
  }
  p.err.hidden = !job.error;
  p.err.textContent = job.error || '';
  p.foot.textContent = `Elapsed ${fmtSecs(t - job.started)}`;
  p.btn.textContent = job.result ? 'Close' : 'Stop';
}

function openPanel() {
  const head = h('div', { class: 'rp-head' });
  const spin = h('span', { class: 'spin' });
  const bar = h('i');
  const list = h('ol', { class: 'rp-list' });
  const err = h('div', { class: 'rp-err', hidden: true });
  const foot = h('span', { class: 'muted small' });
  const btn = h('button', { class: 'small' }, 'Stop');
  btn.addEventListener('click', () => {
    if (!job) return;
    if (job.result) { closePanel(); return; }
    job.cancelled = true;
    job.controllers.forEach((c) => c.abort());
    job.stage = 'Stopping…';
    renderPanel();
  });
  const box = h('div', { class: 'rec-panel', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'row' }, spin, head),
    h('div', { class: 'rp-bar' }, bar), err, list,
    h('div', { class: 'row' }, foot, h('span', { class: 'spacer' }), btn));
  el.append(box);
  job.panel = { box, head, spin, bar, list, err, foot, btn };
  job.ticker = setInterval(renderPanel, 250);
  renderPanel();
}

function closePanel() {
  if (!job) return;
  clearInterval(job.ticker);
  if (job.panel) job.panel.box.remove();
  job = null;
}

async function ttsWithRetry(text, it) {
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    job.controllers.add(ctrl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TTS_TIMEOUT_MS);
    try {
      return await eleven.tts(text, s.voice, ctrl.signal);
    } catch (e) {
      if (job.cancelled) throw e;
      const retryable = timedOut || e.network || e.status === 429 || (e.status >= 500);
      if (attempt < 2 && retryable) { it.state = 'retrying'; it.started = now(); await sleep(2000); it.state = 'recording'; continue; }
      if (timedOut) throw new Error(`ElevenLabs didn't answer within ${TTS_TIMEOUT_MS / 1000} seconds for “${it.title}”. Try again in a moment.`);
      throw e;
    } finally {
      clearTimeout(timer);
      job.controllers.delete(ctrl);
    }
  }
}

// Record cues with ElevenLabs. Saves the session first so the clips have a home.
async function record(ids) {
  if (!eleven.hasKey) { toast('Add your ElevenLabs API key in Settings first.'); app.openSettings('set-eleven'); return false; }
  if (job && !job.result) { toast('A recording is already running.'); return false; }
  closePanel();   // a finished panel from an earlier recording
  const titles = Object.fromEntries(S.cues(s).map((c) => [c.id, c.title]));
  job = {
    started: now(), stage: 'Checking with ElevenLabs…', result: null, error: '', cancelled: false, controllers: new Set(),
    items: ids.map((id) => ({ id, title: titles[id] || id, chars: prepText(s.script[id], s.voice.modelId).length, state: 'waiting', started: 0, took: 0 })),
  };
  busy = true;
  updateBar();
  openPanel();
  let failed = null;
  try {
    const models = await withTimeout(eleven.models(), 20000, 'ElevenLabs did not answer. Check the internet connection.').catch((e) => { if (e.status === 401) throw e; return []; });
    const m = models.find((x) => x.id === s.voice.modelId);
    for (const it of job.items) {
      if (!it.chars) throw new Error(`The “${it.title}” message is empty.`);
      if (m && it.chars > m.maxChars) throw new Error(`The “${it.title}” message is too long for this model (${it.chars} of ${m.maxChars} characters).`);
    }
    job.stage = 'Saving the session…'; renderPanel();
    await persist();
    job.stage = 'Getting the voice ready…'; renderPanel();
    await withTimeout(eleven.ensureVoice(s.voice), 30000, 'ElevenLabs did not answer while preparing the voice. Try again.');
    job.stage = '';
    const queue = [...job.items];
    const worker = async () => {
      while (queue.length && !failed && !job.cancelled) {
        const it = queue.shift();
        it.state = 'recording'; it.started = now();
        busyCues.add(it.id); refreshCueStates();
        try {
          const text = s.script[it.id];
          const blob = await ttsWithRetry(text, it);
          const rec = { blob, key: clipKey(text, s.voice), chars: it.chars, at: Date.now(), source: 'generated' };
          await db.clips.put(s.id, it.id, rec);
          recs[it.id] = rec;
          it.state = 'done'; it.took = now() - it.started;
          const per = Math.max(2, (it.took - 2500) / Math.max(1, it.chars));
          msPerChar = msPerChar == null ? per : msPerChar * 0.5 + per * 0.5;
        } catch (e) {
          if (job.cancelled) it.state = 'cancelled';
          else { it.state = 'failed'; failed = e; }
        }
        busyCues.delete(it.id); refreshCueStates();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } catch (e) { if (!job.cancelled) failed = e; }
  for (const it of job.items) if (it.state === 'waiting') it.state = 'cancelled';
  ids.forEach((id) => busyCues.delete(id));
  busy = false;
  refreshCueStates();
  job.stage = '';
  job.result = failed ? 'failed' : job.cancelled ? 'cancelled' : 'done';
  job.error = failed ? failed.message : '';
  renderPanel();
  const ok = job.result === 'done';
  if (ok) setTimeout(() => { if (job && job.result === 'done') closePanel(); }, 2500);
  return ok;
}

async function recordAndPlay(cueId, btn) {
  const st = S.clipState(s, cueId, recs[cueId]);
  if (btn && st === 'ready') { playAudio(recs[cueId].blob, btn, true); return; }
  if (btn) { btn.disabled = true; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = 'Recording…'; }
  const ok = await record([cueId]);
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  if (!ok) return;
  const playBtn = btn || $(`.cue-ed[data-cue="${cueId}"] .row button`, el);
  if (playBtn) playAudio(recs[cueId].blob, playBtn, true);
}

// ---------------------------------------------------------------- levels
function secLevels() {
  const l = s.levels;
  const slider = (label, key, min, max, sfx) => {
    const out = h('span', { class: 'val' }, l[key] + sfx);
    const r = h('input', { type: 'range', min, max, value: l[key] });
    r.addEventListener('input', () => { l[key] = +r.value; out.textContent = l[key] + sfx; touch(); });
    return h('label', { class: 'f' }, h('span', {}, label, ' ', out), r);
  };
  return h('section', { class: 'ed-sec', id: 'ed-levels' },
    h('h2', {}, 'Levels'),
    h('p', { class: 'help' }, 'How loud the music is in each phase, and how far it dips while the narrator speaks.'),
    h('div', { class: 'grid4' },
      slider('Heat music', 'heat', 0, 100, '%'), slider('Cool-down music', 'cool', 0, 100, '%'),
      slider('Music under narration', 'duck', 0, 60, '% of normal'), slider('Narration', 'narr', 0, 100, '%')));
}

// ---------------------------------------------------------------- bottom bar
let sumEl, saveBtn, createBtn;
function bar() {
  sumEl = h('div', { class: 'sum' });
  saveBtn = h('button', { onclick: async () => { try { await persist(); toast('Saved.'); } catch (e) { toast(e.message, 9000); } } }, 'Save draft');
  createBtn = h('button', { class: 'primary', onclick: createSession }, 'Create session');
  return h('div', { class: 'ed-bar' }, sumEl, h('span', { class: 'spacer' }),
    h('button', { class: 'ghost', onclick: () => app.show('library') }, 'Close'), saveBtn, createBtn);
}

function pending() {
  return S.cues(s).filter((c) => { const st = S.clipState(s, c.id, recs[c.id]); return st === 'missing' || st === 'outdated'; });
}

function updateBar() {
  if (!sumEl) return;
  const list = S.cues(s);
  const todo = pending();
  const chars = todo.reduce((n, c) => n + prepText(s.script[c.id], s.voice.modelId).length, 0);
  sumEl.innerHTML = '';
  sumEl.append(h('b', {}, `${list.length} messages`), ' · ',
    todo.length ? `${todo.length} to record, about ${chars.toLocaleString()} characters` : 'all recorded',
    dirty ? ' · unsaved changes' : '');
  createBtn.textContent = todo.length ? `Create session · record ${todo.length}` : 'Save session';
  createBtn.disabled = busy;
  saveBtn.disabled = busy;
}

async function createSession() {
  if (!s.music.heat && !cfg.demo) {
    toast('Choose a heat playlist first.');
    $('#ed-music', el).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (s.timing.mode === 'songs' && (!S.planValid(s) || s.plan.rounds.some((r) => !r.length))) {
    toast(S.planValid(s) ? 'Every round needs at least one song.' : 'Plan the rounds first (Rounds → Suggest rounds).');
    $('#ed-timing', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const todo = pending().map((c) => c.id);
  if (todo.length) {
    const ok = await record(todo);
    if (!ok) return;
    await sleep(1200);   // let the "Done" line show for a moment
  }
  try { await persist(); } catch (e) { toast(e.message, 9000); return; }
  closePanel();
  toast(todo.length ? 'Session created and narration recorded.' : 'Session saved.');
  app.show('library');
}
