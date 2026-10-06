// Session creator / editor: playlists, timing, voice, editable narration, recording.
import { $, $$, h, toast, fmtDur, fmtSong, autosize, sleep, now, store } from './util.js?v=3.2.1-8eb03f85';
import { planRounds, planBreaks } from './planner.js?v=3.2.1-8eb03f85';
import { app, cfg } from './app.js?v=3.2.1-8eb03f85';
import * as db from './db.js?v=3.2.1-8eb03f85';
import * as S from './sessions.js?v=3.2.1-8eb03f85';
import { cuePlan, defaultText, LANGS, langOf, hasBuiltInText } from './script.js?v=3.2.1-8eb03f85';
import { eleven, isV3, clipKey, prepText } from './eleven.js?v=3.2.1-8eb03f85';
import { chooseRecording, checkUpload } from './recorder.js?v=3.2.1-8eb03f85';
import { tokenFor, refsIn, parseRef, hasTokens, calloutOnly } from './tokens.js?v=3.2.1-8eb03f85';
import { loadProfiles, profileById, profileBySlug, keysOf, usable, describeRef } from './callouts.js?v=3.2.1-8eb03f85';
import { openGallery, insertAtCursor, trackCursor, tokenChips, suggestDialog, suggestedCount, removeSuggestions, closeGallery } from './calloutpick.js?v=3.2.1-8eb03f85';
import { messageMs, recordedMsGuess } from './placement.js?v=3.2.1-8eb03f85';
import { cloud, roleOf } from './cloud.js?v=3.2.1-8eb03f85';
import { writeNarration, applyNarration, checkinSlots } from './writer.js?v=3.2.1-8eb03f85';
import { auth, myPlaylists, parseUri, playlistInfo, sourceTracks, searchTracks } from './spotify.js?v=3.2.1-8eb03f85';
import { preview, previewButton } from './preview.js?v=3.2.1-8eb03f85';

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
let returnTo = 'library';   // where Close / Save go back to
const goBack = () => app.show(returnTo, returnTo === 'session' ? s.id : undefined);

export const editorView = {
  el,
  get dirty() { return app.current === 'editor' && (dirty || busy); },
  async enter(arg) {
    closePanel();
    closeSearch();
    document.body.classList.add('editing');
    for (const k of Object.keys(trackCache)) delete trackCache[k];
    planMsg = ''; planning = false; onHeatChange = null; onCoolChange = null; coolMsg = ''; coolPlanning = false;
    const o = arg && typeof arg === 'object' ? arg : { id: arg };
    const id = o.id || null;
    returnTo = o.from === 'session' && id ? 'session' : 'library';
    if (id) {
      if (roleOf(id) === 'viewer') { toast('You can run this session but not change it.'); app.show('session', id); return; }
      s = await db.sessions.get(id);
      if (!s) { toast('That session no longer exists.'); app.show('library'); return; }
      saved = true;
      recs = await db.clips.forSession(s.id);
    } else {
      const lang = store.get('lastLang', 'en');
      s = S.newSession({ lang, host: (cloud.name || '').split(/[\s@]/)[0] || '' });
      if (lang !== 'en') useLanguageVoice(s);
      saved = false;
      recs = {};
    }
    S.ensureScript(s);
    dirty = !id;
    build();
    if (cloud.configured) loadProfiles();          // fresh list of callout authors
    if (!id) setTimeout(() => { const n = $('.ed-name', el); if (n) n.focus(); }, 50);
    if (o.section) setTimeout(() => jumpTo(o.section), 60);
  },
  async leave() {
    stopAudio();
    preview.stop();
    closeSearch();
    closeGallery();
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
    head(), nav(), secMusic(), secTiming(), secVoice(), secScript(), secLevels());
  barEl = bar();
  el.append(wrap, barEl);
  $$('textarea', el).forEach(autosize);
  updateBar();
}

function head() {
  const name = h('input', { type: 'text', class: 'ed-name', value: s.name, 'aria-label': 'Session name', placeholder: 'Name this session, e.g. Friday Interstellar', maxlength: 80 });
  name.addEventListener('input', () => { s.name = name.value; touch(); });
  const notes = h('input', { type: 'text', class: 'ed-notes', value: s.notes || '', 'aria-label': 'Notes', placeholder: 'Notes: what this session is for, the mood, who it suits…', maxlength: 200 });
  notes.addEventListener('input', () => { s.notes = notes.value; touch(); });
  const lang = h('select', { class: 'ed-lang', 'aria-label': 'Narration language' },
    ...LANGS.map((l) => h('option', { value: l.code, selected: l.code === (s.lang || 'en') }, l.code === 'en' ? 'English' : `${l.native} (${l.name})`)));
  lang.addEventListener('change', () => setLanguage(lang.value));
  const host = h('input', { type: 'text', class: 'ed-host', value: s.host || '', maxlength: 40, placeholder: 'e.g. Þóra', 'aria-label': 'Who leads the heat' });
  host.addEventListener('change', () => setHost(host.value.trim()));
  return h('div', { class: 'ed-head' },
    h('button', { class: 'ghost small', onclick: goBack }, returnTo === 'session' ? '← Session' : '← Sessions'),
    h('div', { class: 'ed-names' }, h('label', { class: 'ed-lab' }, 'Session name'), name, notes,
      h('div', { class: 'ed-meta' },
        h('label', { class: 'f' }, 'Narration language', lang),
        h('label', { class: 'f' }, 'Who leads the heat', host))));
}

// ---------------------------------------------------------------- language and host
// Untouched default texts follow the language and the host's name; edited texts are left alone.
function rewriteDefaults(oldOpts) {
  const R = s.timing.rounds, min = s.timing.roundMin;
  let kept = 0;
  for (const c of S.cues(s)) {
    if (s.script[c.id] === defaultText(c.id, R, min, oldOpts)) s.script[c.id] = defaultText(c.id, R, min, S.textOpts(s));
    else kept++;
  }
  return kept;
}

// A voice and model that speak the language.
function useLanguageVoice(x) {
  const rec = S.RECOMMENDED_VOICES[x.lang];
  if (!S.modelSpeaks(x.voice.modelId, x.lang)) x.voice.modelId = 'eleven_v3';
  if (rec && !rec.some((v) => v.id === x.voice.id) && (x.voice.id === S.DEFAULT_VOICE.id || !(x.voice.labels || []).join(' ').toLowerCase().includes(langOf(x.lang).name.toLowerCase()))) {
    const v = rec[0];
    Object.assign(x.voice, { id: v.id, name: v.name, desc: v.desc, labels: v.labels, previewUrl: '', publicOwnerId: '', lang: x.lang });
  }
  x.voice.lang = x.lang;
}

function setLanguage(code) {
  const old = S.textOpts(s);
  s.lang = code;
  store.set('lastLang', code);
  const kept = rewriteDefaults(old);
  useLanguageVoice(s);
  touch();
  refreshScript(); paintInserts();
  if (voicePaint) voicePaint();
  if (settingsPaint) settingsPaint();
  if (modelPaint) modelPaint();
  if (aiPaint) aiPaint();
  const l = langOf(code);
  if (!hasBuiltInText(code)) toast(`Press “Write narration” under Narration to get the messages in ${l.native}.`, 6000);
  else if (kept) toast(`${kept} message${kept === 1 ? '' : 's'} you edited kept their text.`, 5000);
}

function setHost(name) {
  const old = S.textOpts(s);
  s.host = name;
  rewriteDefaults(old);
  touch(); refreshScript();
}

const SECTIONS = [['ed-music', 'Music'], ['ed-timing', 'Rounds'], ['ed-cool', 'Cool-downs'], ['ed-voice', 'Voice'], ['ed-script', 'Narration'], ['ed-levels', 'Levels']];
function jumpTo(id) { const x = document.getElementById(id); if (x) x.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function nav() {
  return h('nav', { class: 'ed-nav', 'aria-label': 'Parts of the session' },
    ...SECTIONS.map(([id, lab]) => h('button', { type: 'button', class: 'small ghost', onclick: () => jumpTo(id) }, lab)));
}

// ---------------------------------------------------------------- music
let openPop = null;
function closePops() { if (openPop) { openPop.remove(); openPop = null; } }
document.addEventListener('click', (e) => { if (openPop && !e.target.closest('.pl-field, .pv')) closePops(); });
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
    if (key === 'cool' && before !== (p && p.uri) && onCoolChange) onCoolChange();
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
let onCoolChange = null;
let coolMsg = '';
let coolPlanning = false;
const slim = (t) => ({ uri: t.uri, name: t.name, artists: t.artists, durationMs: t.durationMs, imageSm: t.imageSm || '', i: t.i ?? 0 });

function secTiming() {
  const t = s.timing;
  const sec = h('section', { class: 'ed-sec', id: 'ed-timing' });
  const coolSec = h('section', { class: 'ed-sec', id: 'ed-cool' });
  const total = h('span', { class: 'val' });
  const modeSeg = h('div', { class: 'seg-ctl' });
  const body = h('div', {});
  const planBox = h('div', {});
  const coolBox = h('div', {});
  const suggest = h('button', { class: 'small primary' }, 'Suggest rounds');
  suggest.addEventListener('click', () => autoPlan(S.planValid(s)));
  const coolAgain = h('button', { class: 'small' }, 'Suggest cool-down songs again');
  coolAgain.addEventListener('click', () => planCool(true));
  const keep = h('input', { type: 'checkbox', checked: !!t.keepOrder });
  keep.addEventListener('change', () => { t.keepOrder = keep.checked; touch(); autoPlan(false); });
  const auto = h('input', { type: 'checkbox', checked: !!t.autoNext });
  auto.addEventListener('change', () => { t.autoNext = auto.checked; touch(); renderCool(); });

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
        if (s.script[c.id] === defaultText(c.id, oldR, oldMin, S.textOpts(s))) s.script[c.id] = defaultText(c.id, t.rounds, t.roundMin, S.textOpts(s));
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

  // ---- editing rounds and cool-downs: move, reorder, swap, remove, add, theme
  // kind 'round' edits s.plan.rounds (pool: unused heat songs); kind 'break' edits s.plan.breaks.
  const lists = (kind) => (kind === 'round' ? s.plan.rounds : s.plan.breaks);
  const poolOf = (kind) => (kind === 'round' ? s.plan.pool : S.coolPoolOf(s));
  let drag = null;
  const changed = () => { touch(); renderPlan(); renderCool(); paintTotal(); refreshInserts(); };
  const toPool = (kind, song) => { const pool = poolOf(kind); pool.push(song); pool.sort((a, b) => (a.i ?? 0) - (b.i ?? 0)); };
  function moveSong(kind, fromR, fromK, toR, toK) {
    const L = lists(kind);
    const [song] = L[fromR].splice(fromK, 1);
    if (!song) return;
    if (fromR === toR && toK > fromK) toK--;
    L[toR].splice(Math.max(0, Math.min(toK, L[toR].length)), 0, song);
    changed();
  }
  const clearDrop = () => $$('.rsongs .drop-before, .rsongs .drop-after, .rsongs.drop-end', el).forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-end'));

  function swapMenu(kind, acts, songs, k) {
    const song = songs[k];
    const pool = poolOf(kind);
    const opts = pool.map((p, idx) => ({ p, idx, d: p.durationMs - song.durationMs })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const sign = (d) => (d >= 0 ? '+' : '−') + fmtSong(Math.abs(d));
    const sel = h('select', { class: 'swap', 'aria-label': `Swap ${song.name} for` },
      h('option', { value: '' }, opts.length ? `Swap “${song.name}” for…` : 'No unused songs to swap in'),
      ...opts.map((o) => h('option', { value: String(o.idx) }, `${o.p.name} — ${o.p.artists} · ${fmtSong(o.p.durationMs)} (${sign(o.d)})`)));
    sel.addEventListener('change', () => {
      if (sel.value === '') return;
      const [rep] = pool.splice(+sel.value, 1);
      songs.splice(k, 1, rep);
      toPool(kind, song);
      changed();
    });
    sel.addEventListener('blur', () => setTimeout(() => { renderPlan(); renderCool(); }, 150));
    sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { renderPlan(); renderCool(); } });
    acts.closest('li').classList.add('swapping');
    acts.replaceChildren(sel);
    sel.focus();
  }

  function setCard(kind, songs, ri) {
    const R = lists(kind).length;
    const isRound = kind === 'round';
    const tot = S.sumMs(songs), n = songs.length;
    const limit = t.breakMin * 60000;
    let cls, lab, ok = true;
    if (isRound) {
      const inLen = tot >= t.minMin * 60000 && tot <= t.maxMin * 60000;
      const inN = n >= 3 && n <= 6;
      ok = inLen && inN;
      [cls, lab] = !n ? ['chip warn', 'No songs'] : !inLen ? ['chip warn', tot < t.minMin * 60000 ? 'Too short' : 'Too long'] : !inN ? ['chip warn', `${n} songs`] : ['chip ok', `${n} songs`];
    } else {
      [cls, lab] = !n ? ['chip warn', 'No songs'] : tot >= limit ? ['chip ok', `Fills the ${t.breakMin} min`] : ['chip info', `${t.breakMin} min break, more songs follow`];
    }
    const list = h('ol', { class: 'rsongs', 'data-ri': String(ri), 'data-kind': kind });
    let startAt = 0;
    songs.forEach((song, k) => {
      const ib = (label, title, fn, disabled) => {
        const b = h('button', { class: 'ib', type: 'button', title, 'aria-label': `${title}: ${song.name}`, disabled }, label);
        b.addEventListener('click', fn);
        return b;
      };
      const acts = h('span', { class: 'acts' });
      const L = lists(kind);
      acts.append(
        ib('▲', 'Move up', () => (k > 0 ? moveSong(kind, ri, k, ri, k - 1) : moveSong(kind, ri, k, ri - 1, L[ri - 1].length)), k === 0 && ri === 0),
        ib('▼', 'Move down', () => (k < n - 1 ? moveSong(kind, ri, k, ri, k + 2) : moveSong(kind, ri, k, ri + 1, 0)), k === n - 1 && ri === R - 1),
        ib('⇄', 'Swap for an unused song', () => swapMenu(kind, acts, songs, k), !poolOf(kind).length),
        ib('×', isRound ? 'Remove from this round' : 'Remove from this cool-down', () => { songs.splice(k, 1); toPool(kind, song); changed(); }));
      const past = !isRound && startAt >= limit;
      startAt += song.durationMs;
      const li = h('li', { draggable: 'true', class: past ? 'past' : null, title: past ? `Starts after the ${t.breakMin}-minute break, so it only plays if the break runs long` : null },
        h('span', { class: 'grip', title: 'Drag to move', 'aria-hidden': 'true' }, '⋮⋮'),
        previewButton(song),
        song.imageSm ? h('img', { src: song.imageSm, alt: '' }) : h('span', { class: 'ph' }),
        h('span', { class: 'm' }, h('div', { class: 't' }, song.name), h('div', { class: 'a' }, song.artists)),
        h('span', { class: 'd' }, fmtSong(song.durationMs)), acts);
      li.addEventListener('dragstart', (e) => {
        drag = { kind, ri, k };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${kind}:${ri}:${k}`);
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); drag = null; clearDrop(); });
      li.addEventListener('dragover', (e) => {
        if (!drag || drag.kind !== kind) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        clearDrop();
        li.classList.add(after ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        if (!drag || drag.kind !== kind) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        const from = drag; drag = null; clearDrop();
        moveSong(kind, from.ri, from.k, ri, after ? k + 1 : k);
      });
      list.append(li);
    });
    list.addEventListener('dragover', (e) => { if (!drag || drag.kind !== kind) return; e.preventDefault(); clearDrop(); list.classList.add('drop-end'); });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop-end'); });
    list.addEventListener('drop', (e) => {
      if (!drag || drag.kind !== kind) return;
      e.preventDefault();
      const from = drag; drag = null; clearDrop();
      moveSong(kind, from.ri, from.k, ri, songs.length);
    });

    // theme / mood for this round
    let theme = null;
    if (isRound) {
      if (!s.plan.themes) s.plan.themes = [];
      const themeVal = s.plan.themes[ri] || '';
      const closedLabel = () => (s.plan.themes[ri] || '').trim() || '+ Add a theme or mood for this round';
      const sum = h('summary', {}, themeVal ? 'Theme or mood' : closedLabel());
      const ta = h('textarea', { rows: 2, placeholder: 'e.g. Slow and spacious, deep breathing. Interstellar ambient building into soft house.' }, themeVal);
      ta.addEventListener('input', () => { s.plan.themes[ri] = ta.value; touch(); });
      theme = h('details', { class: 'rtheme', open: !!themeVal }, sum, ta);
      // Only move the cursor when you open it yourself (redrawing an open card must not jump the page).
      let byUser = false;
      sum.addEventListener('click', () => { byUser = true; });
      theme.addEventListener('toggle', () => { sum.textContent = theme.open ? 'Theme or mood' : closedLabel(); if (theme.open && byUser) ta.focus(); byUser = false; });
    }

    const pool = poolOf(kind);
    const add = h('select', { 'aria-label': `Add a song to ${isRound ? 'round' : 'cool-down'} ${ri + 1}` },
      h('option', { value: '' }, pool.length ? '+ Add a song from the playlist…' : 'All songs are in use'),
      ...pool.map((p, idx) => h('option', { value: String(idx) }, `${p.name} — ${p.artists} · ${fmtSong(p.durationMs)}`)));
    add.disabled = !pool.length;
    add.addEventListener('change', () => {
      if (add.value === '') return;
      const [song] = pool.splice(+add.value, 1);
      songs.push(song);
      changed();
    });
    const find = h('button', { type: 'button', class: 'small ghost sr-open', title: 'Search all of Spotify' }, '🔍 Search Spotify');
    find.addEventListener('click', (e) => { e.stopPropagation(); openSearch({ kind, ri }); });
    const name = isRound ? `Round ${ri + 1}` : `Cool-down ${ri + 1}`;
    return h('div', { class: (isRound ? 'rcard' : 'bcard') + (ok ? '' : ' off') },
      h('div', { class: 'rhead' }, h('b', {}, name), h('span', { class: 'rdur' }, fmtLen(tot)), h('span', { class: cls }, lab)),
      theme, list, h('div', { class: 'radd' }, add, find));
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
    s.plan.rounds.forEach((songs, ri) => grid.append(setCard('round', songs, ri)));
    planBox.append(grid);
    const unused = s.plan.pool.length;
    planBox.append(h('p', { class: 'muted small mt' },
      `${unused} song${unused === 1 ? '' : 's'} from the playlist ${unused === 1 ? 'is' : 'are'} not in a round. ` +
      'Drag songs (or use ▲▼) to reorder them or move them to another round. ⇄ swaps a song for an unused one, × removes it, ▶ previews it, and 🔍 finds any song on Spotify.'));
  }

  // ---- cool-downs: the songs that play in each break
  function renderCool() {
    coolBox.innerHTML = '';
    coolAgain.disabled = coolPlanning || !S.songMode(s);
    if (!S.songMode(s)) {
      coolBox.append(h('p', { class: 'muted small' }, t.mode === 'songs' ? 'Plan the rounds first. The cool-down songs are planned with them.' : 'With fixed minutes, the cool-downs play the cool-down playlist as it is.'));
      return;
    }
    if (t.rounds < 2) { coolBox.append(h('p', { class: 'muted small' }, 'One round, so no cool-downs. The closing music plays after the round.')); return; }
    if (coolPlanning) { coolBox.append(h('p', { class: 'muted small' }, 'Planning the cool-down songs…')); return; }
    if (!S.breaksPlanned(s)) {
      coolBox.append(h('p', { class: 'muted small' }, coolMsg
        ? `${coolMsg} Until then the breaks play “${s.music.cool ? s.music.cool.name : 'the playlist'}” as it is.`
        : 'Press “Suggest cool-down songs again” to choose the songs for each break.'));
      return;
    }
    const grid = h('div', { class: 'breaks-grid' });
    s.plan.breaks.forEach((songs, bi) => grid.append(setCard('break', songs, bi)));
    coolBox.append(grid);
    const from = s.plan.coolSource ? `“${s.music.cool ? s.music.cool.name : 'cool-down playlist'}”` : 'the heat playlist songs that are not in a round';
    coolBox.append(h('p', { class: 'muted small mt' },
      `Each break plays these songs from ${from}${t.autoNext ? `, and after ${t.breakMin} minutes the next round starts` : ''}. ` +
      'Faded songs start after the break time, so they only play if the break runs long. If a break runs out of songs, more follow from the same playlist.'));
  }

  async function planCool(again, quiet = false) {
    if (!S.songMode(s)) { renderCool(); return; }
    if (t.rounds < 2) { s.plan.breaks = []; renderCool(); return; }
    const src = s.music.cool ? s.music.cool.uri : '';
    if (src && !auth.libraryOk) { coolMsg = 'Connect Spotify in Settings so the conductor can read the cool-down playlist.'; renderCool(); return; }
    coolPlanning = true; renderCool();
    try {
      let tracks;
      if (src) {
        if (!trackCache[src]) trackCache[src] = await sourceTracks(src);
        tracks = trackCache[src];
      } else {
        // Without a cool-down playlist, the breaks use the heat songs that are not in a round.
        if (Array.isArray(s.plan.breaks) && !s.plan.coolSource) {
          for (const b of s.plan.breaks) for (const x of b) if (!s.plan.pool.some((y) => y.uri === x.uri)) s.plan.pool.push(x);
          s.plan.pool.sort((a, b) => (a.i ?? 0) - (b.i ?? 0));
        }
        tracks = s.plan.pool;
      }
      const res = planBreaks(tracks, {
        breaks: t.rounds - 1, breakMs: t.breakMin * 60000, keepOrder: !s.music.shuffle,
        offset: again ? s.plan.coolNext || 0 : 0, seed: again ? (s.plan.coolSeed || 1) + 1 : 1,
      });
      s.plan.breaks = res.breaks.map((b) => b.map(slim));
      s.plan.coolNext = res.nextOffset;
      s.plan.coolSeed = again ? (s.plan.coolSeed || 1) + 1 : 1;
      if (src) { s.plan.coolSource = src; s.plan.coolPool = res.pool.map(slim); }
      else { s.plan.coolSource = ''; s.plan.coolPool = null; s.plan.pool = res.pool.map(slim); }
      coolMsg = '';
      if (!quiet) touch();
    } catch (e) { coolMsg = e.message; s.plan.breaks = null; s.plan.coolSource = ''; s.plan.coolPool = null; }
    coolPlanning = false;
    renderCool(); renderPlan(); paintTotal();
  }
  onCoolChange = () => planCool(false);

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
    renderPlan(); paintTotal(); refreshInserts();
    if (S.songMode(s)) await planCool(false);
    else renderCool();
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
          num('Cool-down (min)', 'breakMin', 1, 30, () => planCool(false))),
        h('div', { class: 'row mt' }, h('label', { class: 'chk' }, keep, "Keep the playlist's song order"), h('span', { class: 'spacer' }), suggest),
        planBox);
      renderPlan();
    } else {
      body.append(h('div', { class: 'grid4' },
        num('Rounds', 'rounds', 1, 8), num('Minutes per round', 'roundMin', 1, 60), num('Minutes per cool-down', 'breakMin', 1, 30)));
    }
    body.append(h('label', { class: 'chk mt' }, auto, 'Start the next round automatically when the cool-down ends'));
    paintTotal();
    renderCool();
  }

  [['songs', 'Follow the songs'], ['timed', 'Fixed minutes']].forEach(([m, lab]) => {
    modeSeg.append(h('button', { type: 'button', 'data-m': m, onclick: () => { t.mode = m; touch(); paint(); if (m === 'songs' && !S.planValid(s)) autoPlan(false); } }, lab));
  });

  // The search panel adds songs here.
  addFromSearch = (target, song) => {
    if (!S.songMode(s)) return false;
    const L = target.kind === 'round' ? s.plan.rounds : s.plan.breaks;
    if (!L || !L[target.ri]) return false;
    const pool = poolOf(target.kind);
    const pi = pool.findIndex((x) => x.uri === song.uri);
    if (pi >= 0) pool.splice(pi, 1);
    L[target.ri].push(song);
    changed();
    return true;
  };
  searchTargets = () => (S.songMode(s) ? [
    ...s.plan.rounds.map((_, i) => ({ kind: 'round', ri: i, label: `Round ${i + 1}` })),
    ...(S.breaksPlanned(s) ? s.plan.breaks.map((_, i) => ({ kind: 'break', ri: i, label: `Cool-down ${i + 1}` })) : []),
  ] : []);

  sec.append(
    h('h2', {}, 'Rounds'),
    h('p', { class: 'help' }, 'Session length: ', total),
    h('div', { class: 'row', style: { marginBottom: '14px' } }, modeSeg),
    body);
  coolSec.append(
    h('div', { class: 'row' }, h('h2', {}, 'Cool-downs'), h('span', { class: 'spacer' }), coolAgain),
    h('p', { class: 'help' }, 'The songs that play in each break, so you know the feel of every cool-down. ▶ previews a song.'),
    coolBox);
  paint();
  if (t.mode === 'songs' && s.music.heat && !s.plan) setTimeout(() => autoPlan(false), 0);
  else if (S.songMode(s) && !S.breaksPlanned(s) && t.rounds > 1) setTimeout(() => planCool(false, true), 0);
  const frag = document.createDocumentFragment();
  frag.append(sec, coolSec);
  return frag;
}

// ---------------------------------------------------------------- Spotify search panel
let addFromSearch = () => false;
let searchTargets = () => [];
let searchEl = null;
function closeSearch() { if (searchEl) { searchEl.remove(); searchEl = null; } }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && searchEl && app.current === 'editor') closeSearch(); });

function openSearch(target) {
  closePops();
  if (!auth.connected) { toast('Connect Spotify in Settings to search for songs.'); app.openSettings('set-spotify'); return; }
  const targets = searchTargets();
  if (searchEl) { const sel = $('select', searchEl); if (sel) sel.value = `${target.kind}:${target.ri}`; $('input', searchEl).focus(); return; }
  const input = h('input', { type: 'search', placeholder: 'Song, artist or album…', 'aria-label': 'Search Spotify' });
  const where = h('select', { 'aria-label': 'Add songs to' }, ...targets.map((x) => h('option', { value: `${x.kind}:${x.ri}`, selected: x.kind === target.kind && x.ri === target.ri }, x.label)));
  const list = h('div', { class: 'sr-list' }, h('div', { class: 'muted small' }, 'Search all of Spotify. ▶ previews a song, Add puts it at the end of the chosen round or cool-down.'));
  const more = h('button', { class: 'small ghost', hidden: true }, 'More results');
  const close = h('button', { class: 'ib', type: 'button', title: 'Close', 'aria-label': 'Close search' }, '✕');
  close.addEventListener('click', closeSearch);
  searchEl = h('aside', { class: 'sr-panel', role: 'dialog', 'aria-label': 'Search Spotify' },
    h('div', { class: 'row' }, h('b', {}, 'Search Spotify'), h('span', { class: 'spacer' }), close),
    input, h('label', { class: 'f' }, 'Add to', where), list, more);
  document.body.append(searchEl);
  setTimeout(() => input.focus(), 0);

  let q = '', offset = 0, seq = 0;
  const row = (tr) => {
    const add = h('button', { class: 'small' }, 'Add');
    add.addEventListener('click', () => {
      const [kind, ri] = where.value.split(':');
      const ok = addFromSearch({ kind, ri: +ri }, slim({ ...tr, i: 100000 + (Date.now() % 100000) }));
      if (ok) { add.textContent = 'Added ✓'; add.disabled = true; toast(`Added “${tr.name}” to ${where.selectedOptions[0].textContent}.`, 2500); }
    });
    return h('div', { class: 'sr-row' }, previewButton(tr),
      tr.imageSm ? h('img', { src: tr.imageSm, alt: '' }) : h('span', { class: 'ph' }),
      h('span', { class: 'm' }, h('div', { class: 't' }, tr.name), h('div', { class: 'a' }, [tr.artists, tr.album].filter(Boolean).join(' · '))),
      h('span', { class: 'd' }, fmtSong(tr.durationMs)), add);
  };
  const run = async (append) => {
    const my = ++seq;
    if (!q) { list.innerHTML = ''; more.hidden = true; return; }
    if (!append) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, 'Searching…')); offset = 0; }
    try {
      const r = await searchTracks(q, offset);
      if (my !== seq) return;
      if (!append) list.innerHTML = '';
      r.items.forEach((tr) => list.append(row(tr)));
      if (!r.items.length && !append) list.append(h('div', { class: 'muted small' }, 'No songs found.'));
      offset = r.offset; more.hidden = !r.more;
    } catch (e) { if (my === seq) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, e.message)); } }
  };
  let tm = null;
  input.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { q = input.value.trim(); run(false); }, 350); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(tm); q = input.value.trim(); run(false); } });
  more.addEventListener('click', () => run(true));
}

// ---------------------------------------------------------------- voice
let voicePaint = null;
let settingsPaint = null;
let modelPaint = null;
let aiPaint = null;

function secVoice() {
  const sec = h('section', { class: 'ed-sec', id: 'ed-voice' },
    h('h2', {}, 'Voice'),
    h('p', { class: 'help' }, 'Choose the narrator and listen before recording. Recording uses your ElevenLabs credits, roughly one per character.'));

  if (!eleven.hasKey) {
    sec.append(h('div', { class: 'banner', style: { margin: '0 0 14px' } },
      eleven.server ? 'Sign in to browse voices and record narration.' : 'Add your ElevenLabs API key in Settings to browse voices and record narration.',
      eleven.server ? null : h('div', { class: 'row' }, h('button', { class: 'small primary', onclick: () => app.openSettings('set-eleven') }, 'Open Settings'))));
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
  model.addEventListener('change', () => { s.voice.modelId = model.value; voiceChanged(); if (modelPaint) modelPaint(); });
  const langWarn = h('div', { class: 'banner warn', style: { margin: '10px 0 0' }, hidden: true });
  modelPaint = () => {
    if (![...model.options].some((o) => o.value === s.voice.modelId)) model.prepend(h('option', { value: s.voice.modelId }, s.voice.modelId));
    model.value = s.voice.modelId;
    const l = langOf(s.lang || 'en');
    langWarn.hidden = S.modelSpeaks(s.voice.modelId, l.code);
    langWarn.textContent = `This model doesn't speak ${l.name}. Choose Eleven v3 (or newer) for ${l.native}.`;
  };

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
    h('div', { class: 'row' }, h('label', { class: 'f', style: { flex: '1 1 260px' } }, 'Model', model)), langWarn,
    h('div', { class: 'mt' }, card), picker, settingsBox,
    h('div', { class: 'row mt' }, hear, h('span', { class: 'muted small' }, 'Records the welcome message, which is then kept for the session.')),
    h('div', { class: 'hint-box', html: 'With <b>Eleven v3</b> you can add delivery cues in square brackets, such as <code>[softly]</code> <code>[warmly]</code> <code>[chuckles]</code> <code>[sighs]</code> <code>[whispers]</code>. Three dots <code>...</code> add a pause. Other models leave the cues out.' }));
  modelPaint();
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
        const lib = await eleven.library(v.name.replace(/ - .*/, ''), 0, s.lang || 'en');
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
  if (!eleven.hasKey) { box.append(h('div', { class: 'muted small' }, eleven.missingMsg)); return; }
  let tab = 'library';
  const search = h('input', { type: 'search', placeholder: 'Search voices, e.g. “deep narrator”, “southern”, “calm British”' });
  const list = h('div', { class: 'vlist' });
  const tabs = h('div', { class: 'seg-ctl' });
  const more = h('button', { class: 'small ghost mt', hidden: true }, 'Show more');
  let page = 0;
  const setTab = (t) => { tab = t; page = 0; [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); load(); };
  [['library', 'Voice library'], ['mine', 'My voices']].forEach(([t, lab]) => tabs.append(h('button', { type: 'button', 'data-t': t, onclick: () => setTab(t) }, lab)));

  const lang = s.lang || 'en';
  const findInLibrary = async (v) => {
    const r = await eleven.library(v.name.replace(/ - .*/, ''), 0, lang);
    return (r.voices || []).find((x) => x.id === v.id) || null;
  };
  const row = (v) => {
    const play = h('button', { class: 'small', disabled: !v.previewUrl && !v.recommended }, '▶');
    play.addEventListener('click', async () => {
      if (!v.previewUrl && v.recommended) { const f = await findInLibrary(v).catch(() => null); if (f) { v.previewUrl = f.previewUrl; v.publicOwnerId = f.publicOwnerId; } }
      if (v.previewUrl) playAudio(v.previewUrl, play); else toast('No sample for this voice.');
    });
    const use = h('button', { class: 'small primary' }, v.id === s.voice.id ? 'Selected' : 'Use');
    use.disabled = v.id === s.voice.id;
    use.addEventListener('click', async () => {
      use.disabled = true; use.textContent = 'Adding…';
      try {
        if (v.recommended && !v.publicOwnerId) { const f = await findInLibrary(v); if (f) { v.publicOwnerId = f.publicOwnerId; v.previewUrl = v.previewUrl || f.previewUrl; v.library = true; } }
        if (v.library) await eleven.addShared(v).catch((e) => { if (!/already/i.test(e.message)) throw e; });
        Object.assign(s.voice, { id: v.id, name: v.name, desc: v.desc, labels: v.labels, previewUrl: v.previewUrl, publicOwnerId: v.publicOwnerId || '', lang });
        if (!S.modelSpeaks(s.voice.modelId, lang)) s.voice.modelId = 'eleven_v3';
        if (modelPaint) modelPaint();
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
        const r = await eleven.library(q, page, lang);
        voices = r.voices; hasMore = r.more;
      }
      if (my !== seq) return;
      if (!append) list.innerHTML = '';
      const rec = tab === 'library' && !append && !q ? (S.RECOMMENDED_VOICES[lang] || []) : [];
      if (rec.length) {
        list.append(h('div', { class: 'label vrec' }, `Recommended for ${langOf(lang).native}`));
        rec.forEach((v) => list.append(row({ ...v, recommended: true })));
        voices = voices.filter((v) => !rec.some((x) => x.id === v.id));
        if (voices.length) list.append(h('div', { class: 'label vrec' }, `More ${langOf(lang).native} voices`));
      }
      voices.forEach((v) => list.append(row(v)));
      if (!voices.length && !append) list.append(h('div', { class: 'muted small' }, 'No voices found.'));
      more.hidden = !hasMore;
    } catch (e) { if (my === seq) { list.innerHTML = ''; list.append(h('div', { class: 'muted small' }, e.message)); } }
  }
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { page = 0; load(); }, 350); });
  more.addEventListener('click', () => { page++; load(true); });
  box.append(h('div', { class: 'row' }, tabs, h('div', { style: { flex: '1 1 260px' } }, search)), list, more);
  search.value = lang === 'en' ? 'deep narrator' : '';
  search.placeholder = lang === 'en' ? search.placeholder : `Search ${langOf(lang).name} voices`;
  setTab('library');
}

// ---------------------------------------------------------------- script
let scriptBox = null;
let insertBox = null;
const cueEls = {};
let refreshInserts = () => {};

function secScript() {
  scriptBox = h('div', {});
  insertBox = h('div', { class: 'ins-box' });
  const ai = aiBox();
  // With or without AI narration: without it the guide speaks, and the phase messages aren't used.
  const on = h('input', { type: 'checkbox', role: 'switch', checked: S.narrationOn(s), 'aria-label': 'AI narration' });
  const state = h('b', {});
  const note = h('p', { class: 'help narr-note' });
  const paintMode = () => {
    const yes = S.narrationOn(s);
    state.textContent = yes ? 'With AI narration' : 'Without AI narration';
    note.textContent = yes
      ? 'Edit any message. Each one is recorded as its own clip and plays at the moment shown. With Use my recording you can upload an audio file or record a message yourself.'
      : 'You lead the session yourself: the messages below aren’t recorded or played. The music, the timers, messages inside songs and callouts still work, and 🎙 Talk in the live view dips the music while you speak.';
    scriptBox.classList.toggle('narr-off', !yes);
    ai.hidden = !yes || !cloud.configured;
  };
  on.addEventListener('change', () => { s.narration = on.checked; touch(); paintMode(); refreshScript(); updateBar(); });
  const sec = h('section', { class: 'ed-sec', id: 'ed-script' },
    h('div', { class: 'narr-head' }, h('h2', {}, 'Narration'), h('span', { class: 'spacer' }),
      h('label', { class: 'switch' }, on, h('span', { class: 'track', 'aria-hidden': 'true' }), state)),
    note, ai, scriptBox, insertBox);
  paintMode();
  refreshScript();
  refreshInserts = paintInserts;
  paintInserts();
  return sec;
}

// ---------------------------------------------------------------- callouts
// Short clips real people recorded. 📣 on any message opens the gallery (grouped by author);
// "Suggest callouts" places one author's callouts at good moments in the session.
let coWarn = () => {};
app.on('callouts', () => { if (app.current === 'editor' && s) { paintInserts(); refreshCueStates(); } });

// Callouts the session uses that aren't available (author gone or unpublished, or a callout they don't have).
function missingCallouts() {
  const out = new Set();
  const legacy = profileById(s.callouts && s.callouts.profile);
  for (const c of S.allCues(s)) {
    for (const ref of refsIn(S.cueText(s, c.id))) {
      const { author, key } = parseRef(ref);
      const p = author ? profileBySlug(author) : legacy;
      if (!p || !p.published || !keysOf(p).includes(key)) out.add(ref);
    }
  }
  return [...out];
}

function calloutBar() {
  if (!cloud.configured) return null;
  const authors = usable();
  const n = suggestedCount(s);
  const warn = h('div', { class: 'co-warn' });
  coWarn = () => {
    warn.innerHTML = '';
    const miss = missingCallouts();
    if (miss.length) warn.append(h('p', { class: 'small warnline' }, `${miss.length} callout${miss.length > 1 ? 's aren’t' : ' isn’t'} available any more, so ${miss.length > 1 ? 'they are' : 'it is'} skipped: ${miss.map((r) => describeRef(r, profileById(s.callouts && s.callouts.profile))).join(', ')}.`));
  };
  if (!authors.length && !n) {
    coWarn();
    if (!cloud.admin) return warn;
    return h('div', { class: 'co-bar' }, h('span', { class: 'muted small' }, '📣 No callouts yet. Invite people to record theirs: '),
      h('button', { class: 'small ghost', onclick: () => app.openSettings('set-callouts') }, 'Invite someone'), warn);
  }
  const sug = h('button', { class: 'small', title: 'Place one author’s callouts at good moments in this session' }, '📣 Suggest callouts');
  sug.addEventListener('click', () => suggestDialog(s, (r, p) => {
    touch(); refreshScript(); paintInserts();
    toast(`Added ${r.tokens + r.inserts} callouts by ${p.name}. Change, move or remove any of them on the timeline.`, 5000);
  }, (cue) => messageMs(s, cue, recordedMsGuess(recs[cue]))));
  const rm = n ? h('button', { class: 'small ghost', title: 'Take out the callouts Suggest callouts added' }, `Remove suggested (${n})`) : null;
  if (rm) rm.addEventListener('click', () => {
    if (!confirm('Take out the suggested callouts?')) return;
    const k = removeSuggestions(s);
    touch(); refreshScript(); paintInserts();
    toast(`Took out ${k} callout${k === 1 ? '' : 's'}.`);
  });
  coWarn();
  return h('div', { class: 'co-bar' },
    h('div', { class: 'row' }, sug, rm, h('span', { class: 'muted small co-authors' },
      authors.length ? 'Callouts by ' + authors.map((p) => `${p.name} (${keysOf(p).length})`).join(', ') + '. Add one to any message with 📣.' : ''),
      cloud.admin ? h('span', { class: 'spacer' }) : null,
      cloud.admin ? h('button', { class: 'small ghost', onclick: () => app.show('callouts') }, 'Manage') : null),
    warn);
}

// ---------------------------------------------------------------- write the narration with AI
const AI_EXAMPLE = 'Example: My name is Júlía and I’m hosting a session for my friends, a group of 12 girlfriends. We were all in school together and we love Icelandic hip hop. Keep the narration short and warm, mostly the basic instructions.';
function aiBox() {
  if (!cloud.configured) { aiPaint = null; return h('div', { hidden: true }); }
  const box = h('div', { class: 'ai-box' });
  const prompt = h('textarea', { rows: 4, placeholder: AI_EXAMPLE, spellcheck: true, 'aria-label': 'Describe your session' }, s.aiPrompt || '');
  prompt.addEventListener('input', () => { s.aiPrompt = prompt.value; touch(); autosize(prompt); });
  const checks = h('input', { type: 'checkbox', checked: s.aiCheckins !== false });
  checks.addEventListener('change', () => { s.aiCheckins = checks.checked; touch(); aiPaint(); });
  const go = h('button', { class: 'primary small' }, 'Write narration');
  const status = h('span', { class: 'muted small ai-status', role: 'status' });
  const head = h('div', { class: 'ai-head' });
  const checkNote = h('span', { class: 'muted small' });
  let running = null;
  aiPaint = () => {
    const l = langOf(s.lang || 'en');
    head.innerHTML = '';
    head.append(h('b', {}, '✦ Write the narration with AI'),
      h('span', { class: 'muted small' }, ` Describe your group and the mood. Claude writes every message in ${l.native}; you read it all before anything is recorded.`));
    const slots = checkinSlots(s);
    checks.disabled = !slots.length;
    checkNote.textContent = slots.length ? `(${slots.length} songs)` : '(plan the rounds first)';
    go.disabled = !!running || !cloud.signedIn;
    if (!cloud.signedIn && cloud.configured) status.textContent = 'Sign in to use the AI writer.';
  };
  go.addEventListener('click', async () => {
    const changedTexts = S.cues(s).some((c) => s.script[c.id] !== defaultText(c.id, s.timing.rounds, s.timing.roundMin, S.textOpts(s)));
    if (changedTexts && !confirm('Replace the current messages with new ones written by the AI? Messages you placed yourself inside songs stay.')) return;
    const withChecks = !checks.disabled && checks.checked;
    running = new AbortController();
    go.disabled = true; go.textContent = 'Writing…';
    status.textContent = 'Claude is writing your narration. This takes about a minute.';
    const t0 = Date.now();
    const tick = setInterval(() => { status.textContent = `Claude is writing your narration… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    try {
      const res = await writeNarration(s, prompt.value, withChecks, running.signal);
      const n = applyNarration(s, res, withChecks);
      touch(); refreshScript(); paintInserts();
      status.textContent = `Done: ${n.msgs} messages${withChecks ? ` and ${n.checks} check-ins` : ''}. Read them through below and change anything, then press Create session to record.`;
      toast('The narration is written. Read it through before recording.', 5000);
      setTimeout(() => { const first = $('.cue-ed', el); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 200);
    } catch (e) { if (e.name !== 'AbortError') status.textContent = e.message; }
    clearInterval(tick);
    running = null; go.textContent = 'Write narration'; aiPaint();
  });
  aiPaint();
  box.append(head, prompt, h('div', { class: 'row' }, h('label', { class: 'chk' }, checks, 'Short check-ins at the start of each song, with the time left in the round'), checkNote),
    h('div', { class: 'row' }, go, status));
  setTimeout(() => autosize(prompt), 0);
  return box;
}

// Messages placed inside songs (made on the timeline). Their text can be edited here too.
function paintInserts() {
  if (aiPaint) aiPaint();
  if (!insertBox) return;
  insertBox.innerHTML = '';
  for (const k of Object.keys(cueEls)) if (k.startsWith('x-')) delete cueEls[k];
  const ins = s.inserts || [];
  const openTl = h('button', { class: 'small' }, ins.length ? 'Open the timeline' : '+ Add a message inside a song');
  openTl.addEventListener('click', async () => {
    if (!S.songMode(s)) { toast('Plan the rounds first. Messages are placed inside the songs.'); return; }
    if (dirty || !saved) { try { await persist(); } catch (e) { toast(e.message); return; } }
    app.show('timeline', s.id);
  });
  insertBox.append(h('div', { class: 'cue-top ins-head' }, h('b', {}, 'Messages inside songs'),
    h('span', { class: 'w' }, 'Short messages and callouts that play over the music, even in the middle of a song. Place them on the timeline.'),
    h('span', { class: 'spacer' }), openTl));
  const bar = calloutBar();
  if (bar) insertBox.append(bar);
  for (const x of ins) insertBox.append(calloutOnly(x.text) ? calloutRow(x) : cueEditor({ id: S.insertCue(x), title: 'Message', when: S.insertWhen(s, x), insert: x }));
  $$('textarea', insertBox).forEach(autosize);
  updateBar();
}

// A callout inside a song, in one line: who says what, where, ▶, change, remove. (Move it on the timeline.)
function calloutRow(x) {
  const pills = tokenChips(x.text, s.callouts && s.callouts.profile);
  const change = h('button', { class: 'small ghost', title: 'Pick another callout', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, 'Change');
  change.addEventListener('click', () => openGallery(change, (p, k) => { x.text = tokenFor(p.slug, k); touch(); paintInserts(); },
    { hint: 'Pick the callout to play here instead.' }));
  const rm = h('button', { class: 'small ghost' }, 'Remove');
  rm.addEventListener('click', () => { s.inserts = s.inserts.filter((y) => y !== x); touch(); paintInserts(); });
  return h('div', { class: 'co-row-ed', 'data-cue': S.insertCue(x) }, pills, h('span', { class: 'w muted small' }, S.insertWhen(s, x)), h('span', { class: 'spacer' }), change, rm);
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
  off: ['chip', 'Not used'],
  ready: ['chip ok', 'Recorded'],
  uploaded: ['chip info', 'Your own recording'],
  callout: ['chip info', 'Callouts only'],
  outdated: ['chip warn', 'Changed — record again'],
  missing: ['chip', 'Not recorded'],
};

function cueEditor(c) {
  const ins = c.insert || null;
  const ta = h('textarea', { rows: ins ? 2 : 4, spellcheck: true, placeholder: ins ? 'What should the narrator say here?' : null }, S.cueText(s, c.id));
  const chip = h('span', { class: 'chip' });
  const count = h('span', { class: 'n' });
  const play = h('button', { class: 'small' }, '▶ Play');
  const rec = h('button', { class: 'small' }, 'Record');
  const up = h('button', { class: 'small ghost', title: 'Upload an audio file or record the message yourself' }, 'Use my recording');
  const reset = h('button', { class: 'small ghost' }, ins ? 'Remove' : 'Reset text');
  const coBtn = cloud.configured ? h('button', { class: 'small ghost co-add', title: 'Add a callout (a short clip a person recorded)', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, '📣 Callout') : null;
  if (coBtn) coBtn.addEventListener('click', () => openGallery(coBtn, (p, k) => insertAtCursor(ta, tokenFor(p.slug, k))));
  const chips = h('div', { class: 'co-chips-slot' });
  const paintChips = () => { chips.innerHTML = ''; const x = tokenChips(ta.value, s.callouts && s.callouts.profile); if (x) chips.append(x); };
  trackCursor(ta);
  const box = h('div', { class: 'cue-ed' + (ins ? ' ins' : ''), 'data-cue': c.id },
    h('div', { class: 'cue-top' }, h('b', {}, c.title), h('span', { class: 'w' }, c.when), chip, count),
    ta, chips, h('div', { class: 'row' }, play, rec, up, coBtn, h('span', { class: 'spacer' }), reset));
  paintChips();

  const paint = () => {
    const st = S.clipState(s, c.id, recs[c.id]);
    const [cls, lab] = busyCues.has(c.id) ? ['chip info', 'Recording…'] : STATE_LABEL[st];
    chip.className = cls; chip.textContent = lab;
    count.textContent = st === 'off' ? '' : `${prepText(S.cueText(s, c.id), s.voice.modelId).length} characters`;
    const off = st === 'off';
    play.disabled = !recs[c.id] || busyCues.has(c.id) || st === 'callout' || off;
    rec.disabled = busy || st === 'callout' || off;
    up.disabled = st === 'callout' || off;
    reset.disabled = off;
    ta.disabled = off;
    box.classList.toggle('off', off);
    rec.textContent = st === 'missing' ? 'Record' : 'Record again';
  };
  cueEls[c.id] = { paint: () => { paint(); paintChips(); } };
  paint();

  ta.addEventListener('input', () => {
    if (ins) ins.text = ta.value; else s.script[c.id] = ta.value;
    autosize(ta); touch(); paint();
    if (hasTokens(ta.value) || ta.dataset.tok) { ta.dataset.tok = hasTokens(ta.value) ? '1' : ''; paintChips(); coWarn(); }
  });
  play.addEventListener('click', () => { if (recs[c.id]) playAudio(recs[c.id].blob, play, true); });
  rec.addEventListener('click', () => recordAndPlay(c.id, null));
  up.addEventListener('click', async () => {
    const r = await chooseRecording({ title: 'Use my recording: ' + c.title, text: S.cueText(s, c.id) });
    if (r) useUpload(c.id, r.blob, r.from);
  });
  reset.addEventListener('click', () => {
    if (ins) {
      if (!confirm('Remove this message?')) return;
      s.inserts = s.inserts.filter((x) => x !== ins);
      touch(); paintInserts();
      return;
    }
    const def = defaultText(c.id, s.timing.rounds, s.timing.roundMin, S.textOpts(s));
    if (ta.value !== def && !confirm('Replace this message with the original text?')) return;
    ta.value = def; s.script[c.id] = def; autosize(ta); touch(); paint();
  });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) useUpload(c.id, f); });
  return box;
}

function refreshCueStates() { Object.values(cueEls).forEach((x) => x.paint()); updateBar(); }

async function useUpload(cueId, file, from = 'file') {
  if (from === 'file') { const err = checkUpload(file); if (err) { toast(err); return; } }
  await persist();
  const rec = { blob: file, key: 'upload', chars: 0, at: Date.now(), source: 'uploaded' };
  await db.clips.put(s.id, cueId, rec);
  recs[cueId] = rec;
  refreshCueStates();
  toast(from === 'mic' ? 'Your recording will play for this message.' : 'Your audio file will play for this message.');
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
      const retryable = timedOut || e.network || (e.status === 429 && e.code !== 'daily_limit') || (e.status >= 500 && e.code !== 'no_key');
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
  if (!eleven.hasKey) { toast(eleven.missingMsg); if (!eleven.server) app.openSettings('set-eleven'); return false; }
  if (job && !job.result) { toast('A recording is already running.'); return false; }
  closePanel();   // a finished panel from an earlier recording
  const titles = Object.fromEntries(S.allCues(s).map((c) => [c.id, c.title]));
  job = {
    started: now(), stage: 'Checking with ElevenLabs…', result: null, error: '', cancelled: false, controllers: new Set(),
    items: ids.map((id) => ({ id, title: titles[id] || id, chars: prepText(S.cueText(s, id), s.voice.modelId).length, state: 'waiting', started: 0, took: 0 })),
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
          const text = S.cueText(s, it.id);
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
  if (st === 'callout') { toast('This message is only callouts, so there is nothing to record.'); return; }
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
    h('button', { class: 'ghost', onclick: goBack }, 'Close'), saveBtn, createBtn);
}

function pending() {
  return S.allCues(s).filter((c) => { const st = S.clipState(s, c.id, recs[c.id]); return st === 'missing' || st === 'outdated'; });
}

function updateBar() {
  if (!sumEl) return;
  const list = S.allCues(s);
  const todo = pending();
  const chars = todo.reduce((n, c) => n + prepText(S.cueText(s, c.id), s.voice.modelId).length, 0);
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
  goBack();
}
