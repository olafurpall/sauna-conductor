// Session page: one session at a glance (rounds, cool-downs, narration, messages inside songs),
// with Run, Edit, Timeline and Share. Songs and messages can be previewed from here.
import { $, h, toast, fmtSong, fmtDur, fmtDate, download, slug } from './util.js?v=3.2-3eb3c514';
import { app } from './app.js?v=3.2-3eb3c514';
import * as db from './db.js?v=3.2-3eb3c514';
import * as S from './sessions.js?v=3.2-3eb3c514';
import { langOf } from './script.js?v=3.2-3eb3c514';
import { readable, authorsIn } from './calloutpick.js?v=3.2-3eb3c514';
import { preview, previewButton } from './preview.js?v=3.2-3eb3c514';
import { cloud, sharedWithMe, roleOf, sharedOut } from './cloud.js?v=3.2-3eb3c514';
import { openInviteDialog } from './invite.js?v=3.2-3eb3c514';
import { openLinkDialog } from './sharelink.js?v=3.2-3eb3c514';

const el = $('#view-session');
let s = null;
let recs = {};
const audio = new Audio();
let audioBtn = null, audioUrl = null;

export const sessionView = {
  el,
  async enter(id) {
    if (id) {
      const x = await db.sessions.get(id);
      if (!x) { toast('That session no longer exists.'); app.show('library'); return; }
      s = S.ensureScript(x);
    }
    if (!s) { app.show('library'); return; }
    recs = await db.clips.forSession(s.id);
    render();
  },
  async leave() { stopAudio(); preview.stop(); return true; },
  get session() { return s; },
};

// Another computer or person changed it.
app.on('cloud-data', async () => {
  if (app.current !== 'session' || !s) return;
  const x = await db.sessions.get(s.id);
  if (!x) { toast('This session was deleted.'); app.show('library'); return; }
  s = S.ensureScript(x); recs = await db.clips.forSession(s.id);
  render();
});
app.on('plays', () => { if (app.current === 'session' && s) render(); });

function stopAudio() {
  audio.pause();
  if (audioBtn) { audioBtn.textContent = '▶'; audioBtn.classList.remove('on'); audioBtn = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
}
function clipButton(cueId) {
  const rec = recs[cueId];
  const b = h('button', { class: 'ib clipb', type: 'button', title: rec ? 'Play this message' : 'Not recorded yet', disabled: !rec || !rec.blob }, '▶');
  b.addEventListener('click', () => {
    const same = audioBtn === b;
    stopAudio();
    if (same) return;
    preview.stop();
    audioUrl = URL.createObjectURL(rec.blob);
    audio.src = audioUrl; audioBtn = b; b.textContent = '■'; b.classList.add('on');
    audio.onended = stopAudio;
    audio.play().catch(() => { toast('Could not play that message.'); stopAudio(); });
  });
  return b;
}

async function save() { await S.save(s); }

function editable(tag, cls, value, placeholder, onSave, maxlength) {
  const show = h(tag, { class: cls + (value ? '' : ' empty'), tabindex: '0', title: 'Click to change' }, value || placeholder);
  const start = () => {
    const i = h('input', { type: 'text', value: value || '', placeholder, maxlength, class: cls + '-in' });
    show.replaceWith(i); i.focus(); i.select();
    let done = false;
    const finish = async (ok) => {
      if (done) return; done = true;
      const v = i.value.trim();
      if (ok && v !== (value || '')) { await onSave(v); return; }
      i.replaceWith(show);
    };
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    i.addEventListener('blur', () => finish(true));
  };
  show.addEventListener('click', start);
  show.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  return show;
}

function render() {
  el.innerHTML = '';
  const shared = sharedWithMe(s.id);
  const role = roleOf(s.id);
  const viewer = role === 'viewer';
  const pl = S.plays(s);
  const songs = S.songMode(s);
  const t = s.timing;
  const out = sharedOut(s.id);

  const btn = (label, cls, fn, title) => h('button', { class: cls, onclick: fn, title }, label);
  const actions = h('div', { class: 'row ov-actions' },
    btn('Run', 'primary', () => app.show('live', s.id)),
    viewer ? null : btn('Edit', '', () => app.show('editor', { id: s.id, from: 'session' })),
    viewer ? null : btn('Timeline', '', () => (songs ? app.show('timeline', s.id) : toast('The timeline needs planned rounds. Edit the session and press Suggest rounds.')), 'Place messages inside songs'),
    cloud.signedIn && !viewer ? btn('Invite', '', () => openInviteDialog(s), 'Invite people as collaborators or viewers') : null,
    cloud.signedIn && !viewer ? btn('Share link', '', () => openLinkDialog(s), 'A link for Facebook, Instagram or a message') : null,
    h('span', { class: 'spacer' }),
    viewer ? null : shared ? btn('Make my own copy', 'small ghost', async () => { const c = await S.duplicate(s); c.name = s.name; await S.save(c); toast('Copied into your own sessions.'); app.show('session', c.id); })
      : btn('Duplicate', 'small ghost', async () => { const c = await S.duplicate(s); toast('Duplicated.'); app.show('session', c.id); }),
    viewer ? null : btn('Export', 'small ghost', async () => { try { download(`${slug(s.name)}.sauna.json`, await S.exportFile(s)); toast('Exported with its narration.'); } catch (e) { toast(e.message); } }),
    btn(shared ? 'Remove' : 'Delete', 'small ghost danger', async () => {
      if (!confirm(shared ? `Remove “${s.name}” from your sessions? It stays with ${shared.owner}.` : `Delete “${s.name}” and its recorded narration?${out ? ` The ${out} ${out === 1 ? 'person' : 'people'} it’s shared with lose it too.` : ''}`)) return;
      await S.remove(s); toast(shared ? 'Removed.' : 'Deleted.'); app.show('library');
    }));

  const name = viewer ? h('h1', { class: 'ov-name' }, s.name || 'Untitled session')
    : editable('h1', 'ov-name', s.name, 'Name this session', async (v) => { s.name = v || 'Untitled session'; await save(); render(); toast('Renamed.', 1500); }, 80);
  const notes = viewer ? (s.notes ? h('p', { class: 'ov-notes' }, s.notes) : null)
    : editable('p', 'ov-notes', s.notes, '+ Add notes: what this session is for, the mood, who it suits', async (v) => { s.notes = v; await save(); render(); }, 200);

  const chips = h('div', { class: 'row ov-chips' },
    shared ? h('span', { class: 'chip shared' }, `Shared · ${role === 'viewer' ? 'viewer' : 'collaborator'}`) : out ? h('span', { class: 'chip shared' }, `Shared with ${out}`) : null,
    h('span', { class: 'chip' }, 'Owner: ' + (shared ? shared.owner : 'you')),
    h('span', { class: 'chip' + (pl.n ? ' ok' : '') }, pl.n === 1 ? '▶ 1 play' : `▶ ${pl.n} plays`),
    pl.last ? h('span', { class: 'chip' }, 'Last played ' + fmtDate(pl.last)) : null,
    h('span', { class: 'chip' }, songs ? fmtDur(S.totalMs(s)) : `${t.rounds} × ${t.roundMin} min`),
    h('span', { class: 'chip' }, `${t.rounds} round${t.rounds === 1 ? '' : 's'} · ${t.breakMin} min cool-downs`),
    h('span', { class: 'chip' }, 'Voice: ' + s.voice.name.replace(/ - .*/, '')),
    s.lang && s.lang !== 'en' ? h('span', { class: 'chip' }, langOf(s.lang).native) : null,
    authorsIn(s).length ? h('span', { class: 'chip' }, '📣 Callouts: ' + authorsIn(s).join(', ')) : null,
    S.narrationOn(s) ? null : h('span', { class: 'chip' }, 'Without AI narration'));

  el.append(
    h('div', { class: 'ov-top' }, h('button', { class: 'ghost small', onclick: () => app.show('library') }, '← Sessions'), actions),
    h('div', { class: 'ov-head' }, name, notes, chips),
    flow());
}

// The session in order: each phase with its message, songs and messages inside songs.
function flow() {
  const box = h('div', { class: 'ov-flow' });
  const t = s.timing, R = t.rounds;
  const lists = S.phaseLists(s);
  const insFor = (uri) => (s.inserts || []).filter((x) => x.uri === uri).sort((a, b) => a.atMs - b.atMs);
  const cueRow = (id, title) => {
    const st = S.clipState(s, id, recs[id]);
    const chip = st === 'off' ? h('span', { class: 'chip' }, 'Not used: you lead') : S.clipOkState(st) ? null : h('span', { class: 'chip warn' }, st === 'missing' ? 'Not recorded' : 'Changed — record again');
    const text = readable(S.cueText(s, id), s.callouts && s.callouts.profile).replace(/\s+/g, ' ').trim();
    return h('div', { class: 'ov-cue' }, clipButton(id),
      h('div', { class: 'm' }, h('div', { class: 't' }, title, ' ', chip), h('div', { class: 'x' }, text.length > 220 ? text.slice(0, 219) + '…' : text)));
  };
  const songRow = (song, past) => {
    const ins = insFor(song.uri);
    return [
      h('li', { class: past ? 'past' : null }, previewButton(song),
        song.imageSm ? h('img', { src: song.imageSm, alt: '' }) : h('span', { class: 'ph' }),
        h('span', { class: 'm' }, h('div', { class: 't' }, song.name), h('div', { class: 'a' }, song.artists)),
        h('span', { class: 'd' }, fmtSong(song.durationMs))),
      ...ins.map((x) => h('li', { class: 'ins' }, h('span', { class: 'at' }, '↳ ' + fmtSong(x.atMs)), clipButton(S.insertCue(x)),
        h('span', { class: 'm' }, h('div', { class: 't' }, readable(x.text || 'Empty message', s.callouts && s.callouts.profile).replace(/\s+/g, ' ').slice(0, 160))))),
    ];
  };
  const phaseBox = (kind, title, dur, theme, cueId, cueTitle, songs, limitMs, editSec) => {
    let at = 0;
    const ol = h('ol', { class: 'rsongs' });
    for (const song of songs || []) { ol.append(...songRow(song, limitMs != null && at >= limitMs)); at += song.durationMs; }
    return h('section', { class: 'ov-phase ' + kind },
      h('div', { class: 'rhead' }, h('b', {}, title), h('span', { class: 'rdur' }, dur), theme ? h('span', { class: 'ov-theme' }, theme) : null,
        h('span', { class: 'spacer' }), roleOf(s.id) === 'viewer' ? null : h('button', { class: 'small ghost', onclick: () => app.show('editor', { id: s.id, from: 'session', section: editSec }) }, 'Edit')),
      cueRow(cueId, cueTitle),
      songs ? ol : h('p', { class: 'muted small' }, kind === 'round' ? 'Plays the heat playlist.' : S.songMode(s) ? 'Plays the cool-down songs (not planned yet; Edit to choose them).' : `Plays “${s.music.cool ? s.music.cool.name : s.music.heat ? s.music.heat.name : 'the playlist'}”.`));
  };

  if (!lists.length) {
    // Fixed-minute sessions: no song lists, just the messages.
    for (const c of S.cues(s)) box.append(h('section', { class: 'ov-phase' }, h('div', { class: 'rhead' }, h('b', {}, c.title), h('span', { class: 'muted small' }, c.when)), cueRow(c.id, c.title)));
    return box;
  }
  const cueOf = Object.fromEntries(S.cues(s).map((c) => [c.id, c]));
  for (const ph of lists) {
    if (ph.type === 'round') {
      const id = ph.n === 1 ? 'welcome' : ph.n === R && R > 1 ? 'final' : 'round' + ph.n;
      const theme = (s.plan.themes && s.plan.themes[ph.n - 1]) || '';
      box.append(phaseBox('round', ph.label, fmtSong(S.sumMs(ph.songs)), theme, id, cueOf[id].title, ph.songs, null, 'ed-timing'));
    } else {
      box.append(phaseBox('break', ph.label, `${t.breakMin} min`, '', 'end' + ph.n, cueOf['end' + ph.n].title, ph.songs, ph.limitMs, 'ed-cool'));
    }
  }
  box.append(h('section', { class: 'ov-phase closing' },
    h('div', { class: 'rhead' }, h('b', {}, 'Closing'), h('span', { class: 'muted small' }, 'The cool-down music keeps playing until you end the session.')),
    cueRow('closing', 'Closing')));
  const orphans = (s.inserts || []).filter((x) => !S.findSong(s, x.uri));
  if (orphans.length) box.append(h('p', { class: 'banner' }, `${orphans.length} message${orphans.length === 1 ? ' is' : 's are'} not placed, because ${orphans.length === 1 ? 'its song was' : 'their songs were'} removed. Open the timeline to place ${orphans.length === 1 ? 'it' : 'them'} again.`));
  return box;
}
