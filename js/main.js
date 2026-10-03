// Boot: settings dialog, status pills, migration from v1, first view.
import { $, $$, h, toast, uid, sleep, diagnostics } from './util.js';
import { app, cfg, saveCfg, legacyCfg, VERSION } from './app.js';
import * as db from './db.js';
import * as S from './sessions.js';
import { auth, login, logout, adoptLogin, handleRedirect, redirectUri, player, listDevices, parseUri } from './spotify.js';
import { eleven } from './eleven.js';
import { libraryView } from './library.js';
import { editorView } from './editor.js';
import { liveView } from './live.js';
import { cloud, initCloud, pushElevenKey, cloudSummary } from './cloud.js';
import { initAccount, paintAccount } from './account.js';

app.register('library', libraryView);
app.register('editor', editorView);
app.register('live', liveView);

// ---------------------------------------------------------------- header
$$('.tab').forEach((t) => t.addEventListener('click', () => app.show(t.dataset.view)));
app.on('view', (v) => $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v || (v === 'editor' && t.dataset.view === 'library'))));
$$('.pill').forEach((p) => p.addEventListener('click', () => app.openSettings(p.dataset.sec)));

function renderPills() {
  const sp = $('#pillSpotify');
  sp.className = 'pill';
  if (cfg.demo) { sp.textContent = 'Demo mode'; sp.classList.add('warn'); }
  else if (!auth.connected) sp.textContent = 'Spotify not connected';
  else if (!auth.libraryOk) { sp.textContent = 'Spotify: reconnect'; sp.classList.add('warn'); }
  else if (player.ready) { sp.textContent = (player.mode === 'connect' ? 'Spotify → ' + (cfg.deviceName || 'device') : 'Spotify ready') + (auth.me && auth.me.display_name ? ' · ' + auth.me.display_name : ''); sp.classList.add('ok'); }
  else { sp.textContent = player.mode === 'connect' ? 'Spotify: choose device' : 'Spotify starting…'; sp.classList.add('warn'); }
  const el = $('#pillEleven');
  el.className = 'pill';
  if (!eleven.hasKey) el.textContent = 'ElevenLabs: add key';
  else { el.textContent = 'ElevenLabs' + (elInfo ? ' · ' + elInfo : ''); el.classList.add(elOk === false ? 'warn' : 'ok'); }
}
let elInfo = '', elOk = null;
app.on('spotify', renderPills);
app.on('eleven', renderPills);

// ---------------------------------------------------------------- settings
const dlg = $('#settings');
app.openSettings = (sectionId) => {
  if (!dlg.open) dlg.showModal();
  paintSettings();
  if (sectionId) { const s = document.getElementById(sectionId); if (s) s.scrollIntoView({ block: 'start' }); }
};
$('#btnSettings').addEventListener('click', () => app.openSettings());
$('#btnCloseSettings').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { renderPills(); app.emit('spotify'); });

function paintSettings() {
  paintAccount();
  $('#cfgClientId').value = cfg.clientId;
  $('#redirectUri').textContent = redirectUri();
  $('#spDetail').textContent = !auth.connected ? 'Not connected.'
    : !auth.libraryOk ? 'Connected, but without playlist access. Press Connect Spotify again to allow it.'
    : 'Connected' + (auth.me && auth.me.display_name ? ' as ' + auth.me.display_name : '') + '.';
  $('#btnConnect').textContent = auth.connected ? 'Reconnect Spotify' : 'Connect Spotify';
  $('#cfgElKey').value = eleven.key;
  $$('input[name=output]').forEach((r) => { r.checked = r.value === cfg.output; });
  $('#deviceRow').hidden = cfg.output !== 'connect';
  const sel = $('#cfgDevice');
  if (cfg.deviceId && ![...sel.options].some((o) => o.value === cfg.deviceId)) sel.append(h('option', { value: cfg.deviceId }, cfg.deviceName || 'Saved device'));
  sel.value = cfg.deviceId || '';
  $('#cfgSpeed').value = String(cfg.speed);
  $('#cfgDemo').checked = !!cfg.demo;
  $('#cfgFallback').checked = !!cfg.fallbackVoice;
}

$('#cfgClientId').addEventListener('change', (e) => { cfg.clientId = e.target.value.trim(); saveCfg(); });
$('#btnCopyRedirect').addEventListener('click', () => navigator.clipboard.writeText(redirectUri()).then(() => toast('Copied.', 1500)).catch(() => toast('Select the address and copy it.')));
$('#btnConnect').addEventListener('click', () => { cfg.clientId = $('#cfgClientId').value.trim(); saveCfg(); login(); });
$('#btnDisconnect').addEventListener('click', () => { logout(true); paintSettings(); renderPills(); });

async function checkEleven(showToast) {
  if (!eleven.hasKey) { elInfo = ''; elOk = null; $('#elDetail').textContent = ''; app.emit('eleven'); return; }
  $('#elDetail').textContent = 'Checking…';
  try {
    const sub = await eleven.subscription();
    const left = Math.max(0, (sub.character_limit || 0) - (sub.character_count || 0));
    elInfo = `${left.toLocaleString()} credits left`; elOk = true;
    $('#elDetail').textContent = `Connected · ${sub.tier ? sub.tier + ' plan · ' : ''}${left.toLocaleString()} of ${(sub.character_limit || 0).toLocaleString()} credits left this period.`;
    if (showToast) toast('ElevenLabs connected.');
  } catch (e) {
    if (e.status === 401 && /permission/i.test(e.message)) {
      // Key works but cannot read the subscription; try the voice list instead.
      try { await eleven.myVoices(true); elInfo = ''; elOk = true; $('#elDetail').textContent = 'Connected. (Give the key “User: read” to show remaining credits here.)'; app.emit('eleven'); return; } catch { /* fall through */ }
    }
    elInfo = 'check key'; elOk = false;
    $('#elDetail').textContent = e.message;
  }
  app.emit('eleven');
}
$('#btnElSave').addEventListener('click', () => { eleven.key = $('#cfgElKey').value; pushElevenKey(); checkEleven(true); });
$('#btnElShow').addEventListener('click', (e) => {
  const i = $('#cfgElKey');
  i.type = i.type === 'password' ? 'text' : 'password';
  e.currentTarget.textContent = i.type === 'password' ? 'Show' : 'Hide';
});

$$('input[name=output]').forEach((r) => r.addEventListener('change', () => {
  cfg.output = r.value; saveCfg();
  $('#deviceRow').hidden = cfg.output !== 'connect';
  if (liveView.running) toast('The change takes effect after the current session.');
  else player.restart();
  if (cfg.output === 'connect') loadDevices();
  renderPills();
}));

async function loadDevices() {
  const sel = $('#cfgDevice');
  if (!auth.connected) { toast('Connect Spotify first.'); return; }
  try {
    const list = (await listDevices()).filter((d) => d.name !== 'Sauna Conductor');
    sel.innerHTML = '';
    sel.append(h('option', { value: '' }, list.length ? 'Choose a device…' : 'No devices found. Open the Spotify app.'));
    list.forEach((d) => sel.append(h('option', { value: d.id, selected: d.id === cfg.deviceId }, `${d.name} (${d.type})`)));
    if (cfg.deviceId && !list.some((d) => d.id === cfg.deviceId)) {
      const same = list.find((d) => d.name === cfg.deviceName);   // device ids can change when the app restarts
      if (same) { cfg.deviceId = same.id; saveCfg(); sel.value = same.id; }
    }
  } catch (e) { toast(e.message); }
}
$('#btnDevices').addEventListener('click', loadDevices);
$('#cfgDevice').addEventListener('change', (e) => {
  const o = e.target.selectedOptions[0];
  cfg.deviceId = e.target.value;
  cfg.deviceName = o ? o.textContent.replace(/ \([^)]*\)$/, '') : '';
  saveCfg(); renderPills(); app.emit('spotify');
});

$('#cfgSpeed').addEventListener('change', (e) => {
  if (liveView.running) { e.target.value = String(cfg.speed); toast('Change the clock speed between sessions.'); return; }
  cfg.speed = +e.target.value; saveCfg();
});
$('#cfgDemo').addEventListener('change', (e) => {
  if (liveView.running) { e.target.checked = cfg.demo; toast('Change demo mode between sessions.'); return; }
  cfg.demo = e.target.checked; saveCfg();
  if (!cfg.demo && auth.connected) player.start();
  renderPills(); app.emit('spotify');
});
$('#cfgFallback').addEventListener('change', (e) => { cfg.fallbackVoice = e.target.checked; saveCfg(); });
$('#btnDiag').addEventListener('click', () => {
  const head = [
    `Sauna Conductor ${VERSION}`, `time: ${new Date().toString()}`, `browser: ${navigator.userAgent}`,
    `spotify: ${auth.connected ? 'connected' : 'not connected'}, output: ${cfg.output}${cfg.output === 'connect' ? ' (' + cfg.deviceName + ')' : ''}, player ready: ${player.ready}`,
    `elevenlabs key: ${eleven.hasKey ? 'set' : 'not set'}, demo: ${cfg.demo}, speed: ${cfg.speed}`, cloudSummary(), `address: ${location.origin}`, '',
  ].join('\n');
  navigator.clipboard.writeText(head + diagnostics()).then(() => toast('Diagnostics copied. Paste them into the chat.')).catch(() => toast('Could not copy. Try again.'));
});

// ---------------------------------------------------------------- cloud sync
cloud.isRunning = () => liveView.running;
initAccount({ isRunning: () => liveView.running });
app.on('cloud-data', () => { if (app.current === 'library') libraryView.enter(); });
app.on('cloud-runs', () => { if (app.current === 'library') libraryView.enter(); });
app.on('cloud-eleven', () => { if ($('#settings').open) $('#cfgElKey').value = eleven.key; checkEleven(false); });
app.on('cloud-spotify', (sp) => {
  if (liveView.running) return;
  if (adoptLogin(sp)) { toast('Spotify connected from your account.', 3000); if (!cfg.demo) player.restart(); renderPills(); }
});

// ---------------------------------------------------------------- migration from the first version
async function migrate() {
  if (legacyCfg.migrated || !legacyCfg.heatPlaylist) return;
  const existing = await db.sessions.all();
  if (existing.length) return;
  const heat = parseUri(legacyCfg.heatPlaylist), cool = parseUri(legacyCfg.coolPlaylist);
  const s = S.newSession({ name: 'My first session' });
  if (heat) s.music.heat = { uri: heat, name: 'Heat playlist', image: '', total: null, ownerName: '' };
  if (cool) s.music.cool = { uri: cool, name: 'Cool-down playlist', image: '', total: null, ownerName: '' };
  s.music.shuffle = !!legacyCfg.shuffle;
  Object.assign(s.timing, { rounds: legacyCfg.rounds || 4, roundMin: legacyCfg.roundMin || 15, breakMin: legacyCfg.breakMin || 7, autoNext: legacyCfg.autoNext !== false });
  Object.assign(s.levels, { heat: legacyCfg.heatVol ?? 80, cool: legacyCfg.coolVol ?? 45, duck: legacyCfg.duckPct ?? 20, narr: legacyCfg.narrVol ?? 100 });
  s.script = {};
  S.ensureScript(s);
  await S.save(s);
  try { localStorage.setItem('sc.cfg', JSON.stringify(Object.assign({}, legacyCfg, { migrated: true }))); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- storage problems
app.on('storage-blocked', () => { $('#storageBanner').hidden = false; });
app.on('storage-ok', () => { $('#storageBanner').hidden = true; if (app.current === 'library') app.show('library'); });

// ---------------------------------------------------------------- one tab at a time
// The newest tab takes over; an older tab steps aside unless it is running a session or has unsaved edits.
const TAB_ID = uid();
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('sauna-conductor') : null;
let dormant = false;
function goDormant(title, text) {
  if (dormant) return;
  dormant = true;
  db.shutdown();
  player.shutdown();
  document.body.append(h('div', { class: 'dormant' }, h('div', { class: 'card' },
    h('h2', {}, title), h('p', { class: 'muted' }, text),
    h('button', { class: 'primary', onclick: () => location.reload() }, 'Use this tab instead'))));
}
let takeoverRefused = false;
if (bc) {
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (dormant || m.id === TAB_ID) return;
    if (m.type === 'hello') {
      if (liveView.running || editorView.dirty) bc.postMessage({ type: 'busy', id: TAB_ID, to: m.id, running: liveView.running });
      else goDormant('Opened in another tab', 'Sauna Conductor was opened in another tab, so this tab has stepped aside. You can close it.');
    }
    if (m.type === 'busy' && m.to === TAB_ID) {
      takeoverRefused = true;
      goDormant('Already open in another tab', m.running
        ? 'A session is running in another Sauna Conductor tab. Use that tab, or end the session there first.'
        : 'Sauna Conductor is open in another tab with unsaved changes. Save or close them there first, then use this tab.');
    }
  };
}

// ---------------------------------------------------------------- boot
$('#appVersion').textContent = 'Version ' + VERSION;
async function boot() {
  if (bc) { bc.postMessage({ type: 'hello', id: TAB_ID }); await sleep(300); if (takeoverRefused) return; }
  try { await initCloud(); } catch (e) { console.error(e); }
  try { await handleRedirect(); } catch (e) { toast(e.message, 8000); }
  try { await migrate(); } catch (e) { console.error(e); }
  renderPills();
  if (auth.connected && !cfg.demo) player.start();
  if (eleven.hasKey) checkEleven(false);
  await app.show('library');
  if (cloud.configured && !cloud.signedIn && cloud.status !== 'starting') {
    let none = false;
    try { none = !(await db.sessions.all()).length; } catch { /* ignore */ }
    if (none) app.openSettings('set-account');
  } else if (!auth.connected && !cfg.clientId && !cfg.demo) app.openSettings('set-spotify');
}
boot();
