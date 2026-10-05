// The Callouts page (admin only): set up callout profiles, one per person who recorded callouts,
// and the clips for each callout. A profile can be published (chosen by everyone for their sessions)
// once the admin confirms the person agreed to their recordings being used.
import { $, h, toast } from './util.js';
import { app } from './app.js';
import { cloud } from './cloud.js';
import { LANGS } from './script.js';
import { chooseRecording } from './recorder.js';
import { tokenFor } from './tokens.js';
import { callouts, CATALOG, labelOf, catalogOf, suggestedLine, slugKey, KEY_RE, uuid4, loadProfiles, saveProfile, deleteProfile, addClip, updateClip, deleteClip, playClip } from './callouts.js';

const el = $('#view-callouts');
let selId = null;
let extraKeys = {};                      // profile id -> custom keys added here but not recorded yet

export const calloutsView = {
  el,
  async enter(id) {
    if (id) selId = id;
    render();
    await loadProfiles(true);
    render();
  },
};
app.on('people', () => { if (app.current === 'callouts') render(); });

function audioDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (ms) => { URL.revokeObjectURL(url); res(ms); };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
    a.onerror = () => done(null);
    a.src = url;
    setTimeout(() => done(null), 4000);
  });
}
const countText = (p) => { const n = new Set((p.clips || []).map((c) => c.key)).size; return ` ${n} callout${n === 1 ? '' : 's'} · ${(p.clips || []).length} take${(p.clips || []).length === 1 ? '' : 's'}`; };
const secs = (ms) => (ms ? (ms / 1000).toFixed(1).replace(/\.0$/, '') + ' s' : '');

function render() {
  el.innerHTML = '';
  if (!cloud.signedIn || !cloud.admin) {
    el.append(h('div', { class: 'empty' }, h('h3', {}, 'Callouts'), h('p', { class: 'muted' }, 'Only the admin can set up callout profiles.'),
      h('button', { onclick: () => app.show('library') }, '← Sessions')));
    return;
  }
  if (callouts.error && /callout_|relation|schema cache|does not exist/i.test(callouts.error)) {
    el.append(h('div', { class: 'empty' }, h('h3', {}, 'Callouts'),
      h('p', { class: 'muted' }, 'Callouts aren’t set up in the database yet. Run supabase/schema.sql in the Supabase SQL Editor, then reload.'),
      h('button', { onclick: () => app.show('library') }, '← Sessions')));
    return;
  }
  const ps = callouts.profiles;
  if (selId && !ps.some((p) => p.id === selId)) selId = null;
  if (!selId && ps.length) selId = ps[0].id;
  const add = h('button', { class: 'primary small' }, '+ New profile');
  add.addEventListener('click', newProfile);
  const list = h('div', { class: 'co-list' },
    ...ps.map((p) => {
      const b = h('button', { class: 'co-item' + (p.id === selId ? ' on' : '') },
        h('b', {}, p.name),
        h('span', { class: 'co-meta' }, h('span', { class: 'chip ' + (p.published ? 'ok' : '') }, p.published ? 'Published' : p.source === 'invite' && !(p.clips || []).length ? 'Invited, waiting' : 'Draft'),
          h('span', { class: 'co-count' }, countText(p))));
      b.addEventListener('click', () => { selId = p.id; render(); });
      return b;
    }),
    ps.length ? null : h('p', { class: 'muted small' }, 'No profiles yet.'));
  const p = ps.find((x) => x.id === selId);
  el.append(
    h('div', { class: 'co-head' },
      h('button', { class: 'ghost small', onclick: () => app.show('library') }, '← Sessions'),
      h('h2', {}, 'Callouts'), h('span', { class: 'spacer' }), add),
    h('p', { class: 'help co-intro' }, 'Short clips people recorded for Sauna Conductor, like “Let’s do this!” or “Last song!”, grouped by author. Everyone can add published callouts to any message. To get recordings from someone, ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.openSettings('set-callouts'); } }, 'send them an invitation'), ': they record on their phone, no account needed. Only you see this page.'),
    h('div', { class: 'co-grid' }, list, p ? detail(p) : h('div', { class: 'co-detail co-blank' }, h('p', { class: 'muted' }, 'Make a profile for each person who records callouts.'))));
}

async function newProfile() {
  const p = { id: uuid4(), name: 'New profile', about: '', lang: 'is', consent: false, consent_note: '', published: false, clips: [] };
  try { await saveProfile(p); selId = p.id; render(); const n = $('.co-name', el); if (n) { n.focus(); n.select(); } }
  catch (e) { toast(e.message || String(e), 7000); }
}

function detail(p) {
  const status = h('span', { class: 'muted small', role: 'status' });
  let timer = null;
  const save = (now = false) => {
    clearTimeout(timer);
    status.textContent = 'Saving…';
    const run = async () => {
      try { await saveProfile(p); status.textContent = 'Saved'; paintList(); }
      catch (e) { status.textContent = ''; toast(e.message || String(e), 7000); }
    };
    if (now) run(); else timer = setTimeout(run, 500);
  };
  const paintList = () => {
    const item = $(`.co-item.on`, el);
    if (item) { item.querySelector('b').textContent = p.name; const ch = item.querySelector('.chip'); ch.className = 'chip ' + (p.published ? 'ok' : ''); ch.textContent = p.published ? 'Published' : 'Draft'; }
  };

  const name = h('input', { type: 'text', class: 'co-name', value: p.name, maxlength: 80, 'aria-label': 'Name' });
  name.addEventListener('input', () => { p.name = name.value; consentText.textContent = consentLabel(); save(); });
  const about = h('input', { type: 'text', value: p.about || '', placeholder: 'e.g. Singer and songwriter', maxlength: 120, 'aria-label': 'About' });
  about.addEventListener('input', () => { p.about = about.value; save(); });
  const lang = h('select', { 'aria-label': 'Language' }, ...LANGS.map((l) => h('option', { value: l.code }, `${l.native} (${l.name})`)));
  lang.value = p.lang || 'is';
  lang.addEventListener('change', () => { p.lang = lang.value; save(true); renderKeys(); });

  const consentLabel = () => `${p.name || 'This person'} agreed that these recordings can be played in Sauna Conductor sessions`;
  const consentText = h('span', {}, consentLabel());
  const consent = h('input', { type: 'checkbox', checked: !!p.consent });
  const note = h('input', { type: 'text', value: p.consent_note || '', placeholder: 'How and when they agreed, e.g. “Email from Bubbi, 4 Oct 2026”', maxlength: 200, 'aria-label': 'How they agreed' });
  const pub = h('input', { type: 'checkbox', checked: !!p.published });
  const pubText = h('span', {});
  const paintPub = () => {
    pub.disabled = !p.consent;
    pubText.textContent = p.consent ? 'Published: everyone signed in can choose this profile for their sessions' : 'Published (tick the agreement first)';
  };
  consent.addEventListener('change', () => { p.consent = consent.checked; if (!p.consent) { p.published = false; pub.checked = false; } paintPub(); save(true); });
  note.addEventListener('input', () => { p.consent_note = note.value; save(); });
  pub.addEventListener('change', () => {
    if (pub.checked && !(p.clips || []).length) toast('Published, but it has no callouts yet. Add some below.', 4000);
    p.published = pub.checked; save(true);
  });
  paintPub();

  const del = h('button', { class: 'small ghost danger' }, 'Delete this profile');
  del.addEventListener('click', async () => {
    if (!confirm(`Delete ${p.name} and all of their recordings? Sessions using this profile stop playing its callouts.`)) return;
    try { await deleteProfile(p); selId = null; render(); toast('Deleted.'); } catch (e) { toast(e.message || String(e), 7000); }
  });

  const keysBox = h('div', { class: 'co-keys' });
  const renderKeys = () => {
    keysBox.innerHTML = '';
    const cnt = $('.co-item.on .co-count', el);
    if (cnt) cnt.textContent = countText(p);
    const custom = [...new Set([...(p.clips || []).map((c) => c.key), ...(extraKeys[p.id] || [])])].filter((k) => !catalogOf(k));
    for (const k of [...CATALOG.map((c) => c.key), ...custom]) keysBox.append(keyCard(p, k, renderKeys));
    const nk = h('input', { type: 'text', placeholder: 'e.g. breathe-out', maxlength: 40, 'aria-label': 'Name of the new callout' });
    const addKey = h('button', { class: 'small' }, 'Add');
    const go = () => {
      const k = slugKey(nk.value);
      if (!KEY_RE.test(k)) { toast('Give it a short name: letters, numbers and dashes.'); return; }
      if (catalogOf(k) || custom.includes(k)) { toast('That callout is already on the list.'); return; }
      (extraKeys[p.id] = extraKeys[p.id] || []).push(k);
      renderKeys();
    };
    addKey.addEventListener('click', go);
    nk.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    keysBox.append(h('div', { class: 'co-addkey' }, h('span', { class: 'muted small' }, 'Another callout:'), nk, addKey));
  };
  renderKeys();

  return h('div', { class: 'co-detail' },
    h('p', { class: 'muted small' }, 'Short name in messages: ', h('code', {}, p.slug || '(set when saved)'),
      p.source === 'invite' ? ' · Recorded through an invitation; they agreed on the recording page.' : ''),
    h('div', { class: 'co-fields' },
      h('label', { class: 'f' }, h('span', {}, 'Name'), name),
      h('label', { class: 'f' }, h('span', {}, 'Language'), lang),
      h('label', { class: 'f wide' }, h('span', {}, 'About'), about)),
    h('div', { class: 'co-consent' },
      h('label', { class: 'chk' }, consent, consentText),
      note,
      h('label', { class: 'chk' }, pub, pubText)),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), del),
    h('h3', { class: 'co-sub' }, 'Callouts'),
    h('p', { class: 'help' }, 'Record one or more takes of each callout (a take is picked at random each time). Short and punchy works best: one to three seconds. In a message, the token shown plays that callout.'),
    keysBox);
}

function keyCard(p, key, rerender) {
  const c = catalogOf(key);
  const takes = (p.clips || []).filter((x) => x.key === key);
  // What they read: the line in the profile's language (Icelandic profiles get Icelandic lines).
  const head = c ? suggestedLine(key, p.lang) : (takes[0] && takes[0].said) || labelOf(key);
  const add = h('button', { class: 'small' + (takes.length ? '' : ' primary') }, takes.length ? '+ Another take' : '+ Record or upload');
  add.addEventListener('click', async () => {
    const line = suggestedLine(key, p.lang);
    const r = await chooseRecording({ title: `${p.name}: ${head}`, text: line, maxSec: 30 });
    if (!r) return;
    add.disabled = true; add.textContent = 'Saving…';
    try {
      const ms = r.durationMs || (await audioDuration(r.blob));
      await addClip(p, key, line, r.blob, ms);
      toast('Saved.', 1500);
    } catch (e) { toast(e.message || String(e), 7000); }
    rerender();
  });
  const rows = takes.map((t) => {
    const play = h('button', { class: 'small icon-txt', title: 'Play' }, '▶');
    play.addEventListener('click', () => playClip(t).catch((e) => toast(e.message || String(e))));
    const said = h('input', { type: 'text', value: t.said || '', placeholder: 'What is said', maxlength: 120, 'aria-label': 'What is said' });
    said.addEventListener('change', () => updateClip(p, t, { said: said.value }).catch((e) => toast(e.message || String(e))));
    const rm = h('button', { class: 'small ghost danger', title: 'Delete this take' }, '✕');
    rm.addEventListener('click', async () => {
      if (!confirm('Delete this take?')) return;
      try { await deleteClip(p, t); rerender(); } catch (e) { toast(e.message || String(e), 7000); }
    });
    return h('div', { class: 'co-take' }, play, said, h('span', { class: 'muted small' }, secs(t.duration_ms)), rm);
  });
  return h('div', { class: 'co-key' + (takes.length ? '' : ' none') },
    h('div', { class: 'co-key-top' }, h('b', {}, head), h('code', {}, tokenFor(p.slug, key)),
      h('span', { class: 'spacer' }), takes.length ? null : h('span', { class: 'chip' }, 'Not recorded')),
    c ? h('div', { class: 'muted small' }, c.when + (p.lang === 'is' ? ` · “${labelOf(key)}”` : '')) : h('div', { class: 'muted small' }, 'Their own callout: use its token in any message.'),
    ...rows,
    h('div', { class: 'row' }, add));
}
