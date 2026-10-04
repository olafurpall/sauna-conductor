// Sessions library: saved sessions, import/export, and the Claude playlist workflow.
import { $, h, toast, fmt, fmtDur, fmtDate, fmtSong, download, pickFile, slug, store } from './util.js?v=2.5.1-24e6cfcc';
import { liveView, interruptedRun, discardRun, HISTORY_KEY } from './live.js?v=2.5.1-24e6cfcc';
import { app } from './app.js?v=2.5.1-24e6cfcc';
import * as db from './db.js?v=2.5.1-24e6cfcc';
import * as S from './sessions.js?v=2.5.1-24e6cfcc';
import { auth, exportLibrary, importPlan, openUrl } from './spotify.js?v=2.5.1-24e6cfcc';
import { eleven } from './eleven.js?v=2.5.1-24e6cfcc';
import { sharedWithMe } from './cloud.js?v=2.5.1-24e6cfcc';

const el = $('#view-library');

export const libraryView = {
  el,
  async enter() { await render(); },
};

// ---------------------------------------------------------------- resume + history
async function resume(r) {
  await app.show('live', r.sessionId);
  await liveView.resume(r);
}

const when = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

function renderResumeAndHistory() {
  const r = liveView.running ? null : interruptedRun();
  const b = $('#resumeBanner');
  b.innerHTML = '';
  b.hidden = !r;
  if (r) {
    b.append(h('div', {}, h('b', {}, `“${r.name}” stopped unexpectedly`), ` in ${r.phaseName} with ${fmt(r.remaining)} left (${when(r.updatedAt)}).`),
      h('div', { class: 'row' },
        h('button', { class: 'small primary', onclick: () => resume(r) }, `Resume ${r.phaseName}`),
        h('button', { class: 'small ghost', onclick: () => { discardRun(); renderResumeAndHistory(); } }, 'Dismiss')));
  }
  const list = store.get(HISTORY_KEY, []);
  const card = $('#historyCard'), ol = $('#historyList');
  card.hidden = !list.length && !r;
  ol.innerHTML = '';
  if (r) {
    ol.append(h('li', {}, h('span', { class: 'w' }, when(r.startedAt)), h('span', { class: 'n' }, r.name),
      h('span', { class: 'chip warn' }, 'Interrupted'), h('span', { class: 'muted small' }, `stopped in ${r.phaseName}`),
      h('button', { class: 'small', onclick: () => resume(r) }, 'Resume')));
  }
  for (const x of list.slice(0, 8)) {
    const chip = x.status === 'completed' ? ['chip ok', 'Completed'] : x.status === 'ended early' ? ['chip', 'Ended early'] : ['chip warn', 'Interrupted'];
    ol.append(h('li', {}, h('span', { class: 'w' }, when(x.startedAt)), h('span', { class: 'n' }, x.name),
      h('span', { class: chip[0] }, chip[1]), h('span', { class: 'muted small' }, `${fmtDur(x.elapsedMs || 0)}${x.status === 'completed' ? '' : ', reached ' + x.reached}`)));
  }
}

export async function render() {
  banner();
  renderResumeAndHistory();
  const wrap = $('#sessionCards');
  let list;
  try { list = await db.sessions.all(); }
  catch (e) {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'empty' }, h('h3', {}, "Can't open your saved sessions"), h('p', { class: 'muted' }, e.message),
      h('button', { class: 'primary', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  wrap.innerHTML = '';
  $('#libSortRow').hidden = list.length < 2;
  const by = store.get('libSort', 'changed');
  const name = (s) => (s.name || '').toLocaleLowerCase();
  const sorters = {
    changed: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    plays: (a, b) => S.plays(b).n - S.plays(a).n || S.plays(b).last - S.plays(a).last,
    played: (a, b) => S.plays(b).last - S.plays(a).last,
    name: (a, b) => name(a).localeCompare(name(b)),
  };
  list.sort(sorters[by] || sorters.changed);
  if (!list.length) {
    wrap.append(h('div', { class: 'empty' },
      h('h3', {}, 'No sessions yet'),
      h('p', { class: 'muted' }, 'Create one to choose the playlists, timing, narrator and the messages it reads.'),
      h('button', { class: 'primary', onclick: () => app.show('editor') }, 'New session')));
    return;
  }
  for (const s of list) wrap.append(await card(s));
}

function banner() {
  const b = $('#libBanner');
  b.innerHTML = '';
  const lines = [];
  if (!auth.connected) lines.push(['Connect Spotify so the conductor can play music and list your playlists.', 'Connect Spotify', 'set-spotify']);
  else if (!auth.libraryOk) lines.push(['Reconnect Spotify once so the conductor can read your playlists and create new ones.', 'Reconnect Spotify', 'set-spotify']);
  if (!eleven.hasKey) lines.push(['Add your ElevenLabs API key so narration is recorded in a real voice.', 'Add API key', 'set-eleven']);
  b.hidden = !lines.length;
  for (const [txt, btn, sec] of lines) {
    b.append(h('div', { class: 'row', style: { justifyContent: 'space-between', margin: '4px 0' } },
      h('span', {}, txt), h('button', { class: 'small primary', onclick: () => app.openSettings(sec) }, btn)));
  }
}
app.on('spotify', () => { if (app.current === 'library') banner(); });
app.on('eleven', () => { if (app.current === 'library') banner(); });

async function card(s) {
  const r = await S.readiness(s);
  const pl = S.plays(s);
  const shared = sharedWithMe(s.id);
  const open = () => app.show('session', s.id);
  const t = s.timing, m = s.music;
  const status = r.ok === r.total ? h('span', { class: 'chip ok' }, `Narration ready · ${r.total} messages`)
    : r.ok === 0 ? h('span', { class: 'chip warn' }, 'Narration not recorded yet')
    : h('span', { class: 'chip warn' }, `${r.total - r.ok} of ${r.total} messages need recording`);
  const art = h('div', { class: 'scard-art' },
    m.heat && m.heat.image ? h('img', { src: m.heat.image, alt: '' }) : null,
    m.cool && m.cool.image ? h('img', { src: m.cool.image, alt: '' }) : null);
  const body = h('div', { class: 'scard-body', role: 'button', tabindex: '0', title: 'Open this session', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('h3', {}, s.name || 'Untitled session'),
    s.notes ? h('div', { class: 'notes' }, s.notes) : null,
    S.songMode(s)
      ? h('div', { class: 'meta' }, `${t.rounds} rounds: `, h('b', {}, s.plan.rounds.map((r) => fmtSong(S.sumMs(r))).join(' · ')), ` · ${t.breakMin} min cool-downs · ${fmtDur(S.totalMs(s))}`)
      : h('div', { class: 'meta' }, `${t.rounds} × ${t.roundMin} min · ${t.breakMin} min cool-downs · ${fmtDur(S.totalMs(s))}`),
    h('div', { class: 'meta' }, 'Heat: ', h('b', {}, m.heat ? m.heat.name : 'not chosen'), m.cool ? [' · Cool-down: ', h('b', {}, m.cool.name)] : null),
    h('div', { class: 'meta' }, 'Voice: ', h('b', {}, s.voice.name), ` · ${s.voice.modelId.replace(/_/g, ' ')}`),
    h('div', { class: 'meta', style: { marginTop: '8px' } }, status, s.lastRunAt ? h('span', { class: 'muted small', style: { marginLeft: '8px' } }, 'Last run ' + fmtDate(s.lastRunAt)) : null),
    h('div', { class: 'meta row', style: { marginTop: '6px' } },
      h('span', { class: 'chip' + (pl.n ? ' ok' : '') }, pl.n === 1 ? '▶ 1 play' : `▶ ${pl.n} plays`),
      (s.inserts || []).length ? h('span', { class: 'chip' }, `${s.inserts.length} message${s.inserts.length === 1 ? '' : 's'} in songs`) : null,
      shared ? h('span', { class: 'chip info' }, `Shared by ${shared.by}`) : null));
  const foot = h('div', { class: 'scard-foot' },
    h('button', { class: 'primary small', onclick: () => app.show('live', s.id) }, 'Run'),
    h('button', { class: 'small', onclick: () => app.show('editor', s.id) }, 'Edit'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small ghost', onclick: async () => { await S.duplicate(s); toast('Duplicated.'); render(); } }, 'Duplicate'),
    h('button', { class: 'small ghost', onclick: () => exportSession(s) }, 'Export'),
    h('button', { class: 'small ghost danger', onclick: async () => {
      if (!confirm(shared ? `Remove “${s.name}” from your sessions? It stays with ${shared.by}.` : `Delete “${s.name}” and its recorded narration?`)) return;
      await S.remove(s); toast(shared ? 'Removed.' : 'Deleted.'); render();
    } }, shared ? 'Remove' : 'Delete'));
  return h('article', { class: 'scard' }, art, body, foot);
}

async function exportSession(s) {
  try {
    const blob = await S.exportFile(s);
    download(`${slug(s.name)}.sauna.json`, blob);
    toast('Session exported with its narration. Import it on another computer to replay it.');
  } catch (e) { toast(e.message); }
}

$('#btnNewSession').addEventListener('click', () => app.show('editor'));
$('#libSort').value = store.get('libSort', 'changed');
$('#libSort').addEventListener('change', (e) => { store.set('libSort', e.target.value); render(); });
app.on('plays', () => { if (app.current === 'library') render(); });
$('#btnImportSession').addEventListener('click', async () => {
  const [f] = await pickFile('.json,application/json');
  if (!f) return;
  try { const s = await S.importFile(f); toast(`Imported “${s.name}”.`); render(); }
  catch (e) { toast(e.message, 6000); }
});

const status = (msg) => { $('#toolStatus').textContent = msg; };

$('#btnExportLibrary').addEventListener('click', async (e) => {
  if (!auth.libraryOk) { toast(auth.connected ? 'Reconnect Spotify first so the conductor can read your library.' : 'Connect Spotify first.'); app.openSettings('set-spotify'); return; }
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const lib = await exportLibrary(status);
    const n = lib.playlists.length, liked = lib.liked_songs.length;
    download(`spotify-library-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(lib, null, 1)], { type: 'application/json' }));
    status(`Saved ${n} playlists and ${liked} liked songs. Send the file to Claude and say what kind of sessions you want playlists for.`);
  } catch (err) { status(''); toast(err.message, 7000); }
  btn.disabled = false;
});

$('#btnImportPlan').addEventListener('click', async () => {
  if (!auth.libraryOk) { toast(auth.connected ? 'Reconnect Spotify first so the conductor can create playlists.' : 'Connect Spotify first.'); app.openSettings('set-spotify'); return; }
  const [f] = await pickFile('.json,application/json');
  if (!f) return;
  try {
    const plan = JSON.parse(await f.text());
    const made = await importPlan(plan, status);
    status('');
    const box = $('#toolStatus');
    box.append(`Created ${made.length} playlist${made.length === 1 ? '' : 's'} in your Spotify: `,
      ...made.flatMap((p, i) => [i ? ', ' : '', h('a', { href: openUrl(p.uri), target: '_blank', rel: 'noopener', style: { color: 'var(--text)' } }, p.name)]),
      '. Pick them in any session.');
  } catch (err) { status(''); toast(err.message.startsWith('Unexpected') ? 'That file is not a playlist file from Claude.' : err.message, 7000); }
});
