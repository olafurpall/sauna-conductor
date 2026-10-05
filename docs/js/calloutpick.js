// Putting callouts into a session: the gallery (opened from 📣 on any message, like an emoji picker,
// with the callouts grouped by author) and "Suggest callouts", which places one author's callouts at
// the right moments: as small messages inside songs, and at the start or end of phase messages.
import { h, toast, store } from './util.js?v=3.2-3eb3c514';
import * as S from './sessions.js?v=3.2-3eb3c514';
import { cueForRound } from './script.js?v=3.2-3eb3c514';
import { usable, keysOf, saysOf, labelOf, catalogOf, playKey, profileBySlug, profileById, describeRef, stopPreview, calloutMs } from './callouts.js?v=3.2-3eb3c514';
import { sessionLayout, busyIntervals, fitTime, songPos, insertStartIn, messageMs } from './placement.js?v=3.2-3eb3c514';
import { tokenFor, tokensIn, refsIn, removeToken, parseRef, TOKEN_RE } from './tokens.js?v=3.2-3eb3c514';

// ---------------------------------------------------------------- putting a token in a message
// At the cursor if the person has been in the message, otherwise at the end. Fires 'input' so the
// editor saves it.
export function insertAtCursor(ta, token) {
  const touched = ta.dataset.touched === '1';
  const a = touched ? (ta.selectionStart ?? ta.value.length) : ta.value.length;
  const b = touched ? (ta.selectionEnd ?? a) : a;
  const before = ta.value.slice(0, a), after = ta.value.slice(b);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  ta.value = before + pre + token + post + after;
  const pos = (before + pre + token).length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  ta.dataset.touched = '1';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
export function trackCursor(ta) {
  const mark = () => { ta.dataset.touched = '1'; };
  ta.addEventListener('click', mark);
  ta.addEventListener('keyup', mark);
}

// The callouts in a message, readable: "📣 Bubbi Morthens: “Gerum þetta!” ▶".
export function tokenChips(text, legacyId = '') {
  const refs = refsIn(text);
  if (!refs.length) return null;
  return h('div', { class: 'co-inline' }, ...refs.map((ref) => {
    const { author, key } = parseRef(ref);
    const p = author ? profileBySlug(author) : profileById(legacyId);
    const ok = p && keysOf(p).includes(key);
    const b = h('button', { type: 'button', class: 'co-pill' + (ok ? '' : ' bad'), title: ok ? 'Play' : 'This callout isn’t available, so it’s skipped' },
      '📣 ', describeRef(ref, profileById(legacyId)), ok ? ' ▶' : ' ⚠︎');
    if (ok) b.addEventListener('click', () => playKey(p, key).catch((e) => toast(e.message || String(e))));
    return b;
  }));
}

// A message's text with its tokens spelled out for reading: "Round two. 📣 Bubbi Morthens: “Gerum þetta!”".
export function readable(text, legacyId = '') {
  return String(text || '').replace(TOKEN_RE, (m, author, key) => '📣 ' + describeRef(author ? `${author.toLowerCase()}/${key.toLowerCase()}` : key.toLowerCase(), profileById(legacyId)));
}
// The authors whose callouts a session uses.
export function authorsIn(s) {
  const legacy = profileById(s.callouts && s.callouts.profile);
  const names = new Set();
  for (const c of S.allCues(s)) for (const ref of refsIn(S.cueText(s, c.id))) {
    const { author } = parseRef(ref);
    const p = author ? profileBySlug(author) : legacy;
    names.add(p ? p.name : author || 'Callouts');
  }
  return [...names];
}

// ---------------------------------------------------------------- the gallery
let pop = null, popAnchor = null;
export function closeGallery() {
  if (!pop) return;
  stopPreview();
  pop.remove(); pop = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', onKey, true);
  if (popAnchor) popAnchor.setAttribute('aria-expanded', 'false');
  popAnchor = null;
}
const outside = (e) => { if (pop && !pop.contains(e.target) && e.target !== popAnchor && !(popAnchor && popAnchor.contains(e.target))) closeGallery(); };
const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeGallery(); } };

// onPick(profile, key). Opens below (or above) the anchor; on a phone it is a sheet at the bottom.
export function openGallery(anchor, onPick, opts = {}) {
  if (pop && popAnchor === anchor) { closeGallery(); return; }
  closeGallery();
  const authors = usable();
  popAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  pop = h('div', { class: 'cog', role: 'dialog', 'aria-label': 'Callouts' });
  if (!authors.length) {
    pop.append(h('p', { class: 'muted small cog-empty' }, 'No callouts yet. When people the admin invited have recorded theirs, they show up here.'));
  } else {
    let cur = authors.find((p) => p.slug === store.get('coAuthor', '')) || authors[0];
    const tabs = h('div', { class: 'cog-tabs', role: 'tablist' });
    const grid = h('div', { class: 'cog-grid' });
    const paint = () => {
      tabs.innerHTML = '';
      for (const p of authors) {
        const n = keysOf(p).length;
        const t = h('button', { type: 'button', role: 'tab', class: 'cog-tab' + (p === cur ? ' on' : ''), 'aria-selected': String(p === cur) },
          h('b', {}, p.name), h('span', {}, ` ${n} callout${n === 1 ? '' : 's'}`));
        t.addEventListener('click', () => { cur = p; store.set('coAuthor', p.slug); paint(); });
        tabs.append(t);
      }
      grid.innerHTML = '';
      for (const k of keysOf(cur)) {
        const c = catalogOf(k);
        const tile = h('button', { type: 'button', class: 'cog-tile', title: c ? c.when : 'Their own callout' },
          h('b', {}, saysOf(cur, k)), h('small', {}, c ? labelOf(k) : 'Their own'));
        tile.addEventListener('click', () => { const p = cur; closeGallery(); onPick(p, k); });
        const play = h('button', { type: 'button', class: 'cog-play', title: 'Listen', 'aria-label': `Listen to ${saysOf(cur, k)}` }, '▶');
        play.addEventListener('click', (e) => { e.stopPropagation(); playKey(cur, k).catch((er) => toast(er.message || String(er))); });
        grid.append(h('div', { class: 'cog-cell' }, tile, play));
      }
    };
    paint();
    pop.append(tabs, grid, h('p', { class: 'muted small cog-hint' }, opts.hint || 'Click one to add it. At the start of a message it plays just before the narrator; anywhere else, right after.'));
  }
  document.body.append(pop);
  place();
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}
function place() {
  if (!pop || !popAnchor) return;
  if (window.innerWidth <= 640) { pop.classList.add('sheet'); return; }
  const r = popAnchor.getBoundingClientRect();
  const w = Math.min(520, window.innerWidth - 24);
  pop.style.width = w + 'px';
  const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
  pop.style.left = left + 'px';
  const ph = pop.offsetHeight;
  const below = r.bottom + 8;
  pop.style.top = (below + ph > window.innerHeight - 8 && r.top - ph - 8 > 8 ? r.top - ph - 8 : below) + 'px';
}
window.addEventListener('resize', () => place());
window.addEventListener('scroll', () => { if (pop && !pop.classList.contains('sheet')) place(); }, { passive: true, capture: true });

// ---------------------------------------------------------------- suggest callouts
// Where one author's callouts go. In sessions whose rounds follow the songs they become small messages
// inside the songs (so they can be dragged, changed or deleted on the timeline), never overlapping
// another message:
//   Let's do this right after each round's message, It's getting hot as a song near the middle of the
//   round starts, Hang in late in a long round, Last song as the last song starts, 1 minute left one
//   minute before the round ends, Round done just before it ends (That's a wrap in the final round),
//   and That was amazing after the closing message.
// Sessions with fixed-length rounds get them at the start and end of the phase messages instead.
// Everything suggested is remembered, so suggesting again (or another author) replaces it.
export function planSuggestions(s, p, lenOf) {
  const has = new Set(keysOf(p));
  const tok = (k) => tokenFor(p.slug, k);
  const tokens = [], inserts = [];
  const R = s.timing.rounds;
  const len = lenOf || ((cue) => messageMs(s, cue));
  const phaseTok = (cue, k, where) => {
    if (!has.has(k) || typeof s.script[cue] !== 'string') return;
    if (refsIn(s.script[cue]).some((r) => parseRef(r).key === k)) return;          // already has one
    tokens.push({ cue, k, token: tok(k), where });
  };
  if (!S.songMode(s)) {
    for (let r = 1; r <= R; r++) {
      phaseTok(cueForRound(r, R), 'lets-start', 'after');
      if (r < R) phaseTok('end' + r, 'done', 'before');
    }
    phaseTok('closing', 'final-done', 'before');
    phaseTok('closing', 'amazing', 'after');
    return { tokens, inserts };
  }
  phaseTok('closing', 'amazing', 'after');
  // Messages inside songs, placed one by one in free spots.
  const others = (s.inserts || []).filter((x) => x.ai !== 'callout');
  const view = { ...s, inserts: others };
  const L = sessionLayout(view, len);
  const busy = busyIntervals(view, L, len, null);
  const coLen = (k) => calloutMs(`${p.slug}/${k}`) + 300;
  const put = (k, want, range) => {
    if (!has.has(k)) return;
    const n = coLen(k);
    const t = fitTime(L, busy, n, want, range);
    if (t == null) return;
    const pos = songPos(L, t);
    if (!pos) return;
    inserts.push(S.newInsert({ text: tok(k), uri: pos.uri, atMs: pos.atMs, ai: 'callout' }));
    busy.push([t, t + n]);
  };
  for (const sg of L.segs.filter((x) => x.ph.type === 'round')) {
    const songs = L.songs.filter((x) => x.phase === sg.ph);
    if (!songs.length) continue;
    const range = [sg.start, sg.end];
    const total = sg.end - sg.start;
    const last = songs.length - 1;
    put('lets-start', sg.start + len(sg.cue) + 600, range);
    if (songs.length >= 3) {
      const i = songs.findIndex((x, k) => k > 0 && k < last && x.start - sg.start >= total * 0.4);
      if (i > 0) put('getting-hot', songs[i].start + 2000, range);
    }
    if (songs.length >= 4 && total >= 12 * 60000) {
      const i = songs.findIndex((x, k) => k > 0 && k < last && x.start - sg.start >= total * 0.7);
      if (i > 0) put('almost-there', songs[i].start + 2000, range);
    }
    if (songs.length >= 2) put('last-song', songs[last].start + 2000, range);
    if (total >= 4 * 60000) put('one-minute-left', sg.end - 60000, range);
    const fin = sg.ph.n === R;
    const k = fin ? 'final-done' : 'done';
    put(k, sg.end - coLen(k) - 2500, range);
  }
  inserts.sort((a, b) => insertStartIn(L, a) - insertStartIn(L, b));
  return { tokens, inserts };
}

export function suggestedCount(s) {
  const sug = s.callouts && s.callouts.suggested;
  return (s.inserts || []).filter((x) => x.ai === 'callout').length + (sug && sug.tokens ? sug.tokens.length : 0);
}

export function removeSuggestions(s) {
  const n = suggestedCount(s);
  s.inserts = (s.inserts || []).filter((x) => x.ai !== 'callout');
  const sug = s.callouts && s.callouts.suggested;
  if (sug && sug.tokens) for (const t of sug.tokens) if (typeof s.script[t.cue] === 'string') s.script[t.cue] = removeToken(s.script[t.cue], t.token);
  if (s.callouts) delete s.callouts.suggested;
  return n;
}

export function applySuggestions(s, p, lenOf) {
  removeSuggestions(s);
  const plan = planSuggestions(s, p, lenOf);
  for (const t of plan.tokens) {
    const text = s.script[t.cue];
    s.script[t.cue] = t.where === 'before' ? `${t.token} ${text}` : `${text.replace(/\s+$/, '')} ${t.token}`;
  }
  s.inserts = [...(s.inserts || []), ...plan.inserts];
  s.callouts = { ...(s.callouts || {}), suggested: { author: p.slug, tokens: plan.tokens.map(({ cue, token }) => ({ cue, token })) } };
  return { tokens: plan.tokens.length, inserts: plan.inserts.length };
}

// The "Suggest callouts" dialog: pick an author, see where they go, add them.
export function suggestDialog(s, onDone, lenOf) {
  const authors = usable();
  if (!authors.length) { toast('No callouts are ready yet.'); return; }
  const prior = suggestedCount(s);
  const priorBy = s.callouts && s.callouts.suggested && profileBySlug(s.callouts.suggested.author);
  let cur = authors.find((p) => p.slug === store.get('coAuthor', '')) || authors[0];
  const list = h('div', { class: 'sug-list', role: 'radiogroup' });
  const preview = h('div', { class: 'sug-preview' });
  const go = h('button', { class: 'primary' }, 'Add callouts');
  const cancel = h('button', {}, 'Cancel');
  const dlg = h('dialog', { class: 'share-dlg sug-dlg', 'aria-label': 'Suggest callouts' },
    h('div', { class: 'set-head' }, h('h2', {}, 'Suggest callouts'), h('span', { class: 'spacer' }), cancel),
    h('div', { class: 'set-body' },
      h('p', { class: 'help' }, 'Choose whose callouts to use. They’re placed at good moments in the session as small messages you can move, change or delete.'),
      list, preview,
      prior ? h('p', { class: 'muted small' }, `This replaces the ${prior} callout${prior === 1 ? '' : 's'} suggested earlier${priorBy ? ' (' + priorBy.name + ')' : ''}.`) : null,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), go)));
  const paint = () => {
    list.innerHTML = '';
    for (const p of authors) {
      const n = keysOf(p).length;
      const r = h('label', { class: 'sug-author' + (p === cur ? ' on' : '') },
        h('input', { type: 'radio', name: 'sugAuthor', checked: p === cur }),
        h('b', {}, p.name), h('span', { class: 'muted small' }, ` ${n} callout${n === 1 ? '' : 's'}${p.about ? ' · ' + p.about : ''}`));
      r.querySelector('input').addEventListener('change', () => { cur = p; store.set('coAuthor', p.slug); paint(); });
      list.append(r);
    }
    const plan = planSuggestions(s, cur, lenOf);
    const where = [];
    for (const t of plan.tokens) where.push(`${saysOf(cur, t.k)}: ${t.where === 'before' ? 'before' : 'after'} “${(S.cues(s).find((c) => c.id === t.cue) || {}).title || t.cue}”`);
    const byKey = {};
    for (const x of plan.inserts) { const k = parseRef(tokensIn(x.text).before[0] || '').key; byKey[k] = (byKey[k] || 0) + 1; }
    for (const [k, n] of Object.entries(byKey)) where.push(`${saysOf(cur, k)}: inside songs${n > 1 ? `, ${n} times` : ''}`);
    preview.innerHTML = '';
    preview.append(h('div', { class: 'label' }, `${plan.tokens.length + plan.inserts.length} callouts`), h('ul', { class: 'sug-where' }, ...where.map((w) => h('li', {}, w))),
      S.songMode(s) ? h('p', { class: 'muted small' }, 'None of them play over another message. Drag them on the timeline to change when they play.')
        : h('p', { class: 'muted small' }, 'Callouts inside songs need rounds that follow the songs (Rounds → Follow the songs). This session gets them at the start and end of rounds.'));
    go.disabled = !(plan.tokens.length + plan.inserts.length);
  };
  paint();
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => { stopPreview(); dlg.remove(); });
  cancel.addEventListener('click', () => dlg.close());
  go.addEventListener('click', () => {
    const n = applySuggestions(s, cur, lenOf);
    dlg.close();
    onDone && onDone(n, cur);
  });
}
