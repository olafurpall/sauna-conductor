// Boot: settings dialog, status pills, migration from v1, first view.
import { $, $$, h, toast, uid, sleep, diagnostics, stopDiagnostics, store } from './util.js';
import { app, cfg, saveCfg, legacyCfg, VERSION, DEFAULT_CLIENT_ID } from './app.js';
import * as db from './db.js';
import * as S from './sessions.js';
import { auth, login, logout, adoptLogin, handleRedirect, redirectUri, player, listDevices, volumeWorks, parseUri } from './spotify.js';
import { eleven } from './eleven.js';
import { libraryView } from './library.js';
import { editorView } from './editor.js';
import { liveView } from './live.js';
import { sessionView } from './overview.js';
import { timelineView } from './timeline.js';
import { calloutsView } from './calloutadmin.js';
import { preview } from './preview.js';
import { cloud, initCloud, cloudSummary, callFunction, prefs, savePrefs } from './cloud.js';
import { initAccount, paintAccount } from './account.js';
import { initInvitations, paintInvites } from './invitations.js';
import { welcomeView, onboardView, route, holdRoute, onboarded, takeLinkFromUrl, afterSpotifyRedirect } from './gate.js';
import { registerServiceWorker } from './pwa.js';

registerServiceWorker();
app.register('welcome', welcomeView);
app.register('onboard', onboardView);
app.register('library', libraryView);
app.register('editor', editorView);
app.register('live', liveView);
app.register('session', sessionView);
app.register('timeline', timelineView);
app.register('callouts', calloutsView);
preview.isRunning = () => liveView.running;

// ---------------------------------------------------------------- header
$$('.tab').forEach((t) => t.addEventListener('click', () => app.show(t.dataset.view)));
app.on('view', (v) => $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v || (['editor', 'session', 'timeline'].includes(v) && t.dataset.view === 'library'))));
app.on('view', (v) => { if (v === 'live' || v === 'library') preview.stop(); });
$$('header .pill[data-sec]').forEach((p) => p.addEventListener('click', () => app.openSettings(p.dataset.sec)));

function renderPills() {
  const sp = $('#pillSpotify');
  sp.className = 'pill';
  if (cfg.demo) { sp.textContent = 'Demo mode'; sp.classList.add('warn'); }
  else if (!auth.connected) sp.textContent = 'Spotify not connected';
  else if (auth.problem) { sp.textContent = 'Spotify: not allowed yet'; sp.classList.add('warn'); }
  else if (!auth.libraryOk) { sp.textContent = 'Spotify: reconnect'; sp.classList.add('warn'); }
  else if (player.ready) { sp.textContent = (player.mode === 'connect' ? 'Spotify → ' + (cfg.deviceName || 'device') : 'Spotify ready') + (auth.me && auth.me.display_name ? ' · ' + auth.me.display_name : ''); sp.classList.add('ok'); }
  else { sp.textContent = player.mode === 'connect' ? 'Spotify: choose device' : 'Spotify starting…'; sp.classList.add('warn'); }
  const el = $('#pillEleven');
  el.className = 'pill';
  // On the hosted site narration goes through the server: only the admin sees the credits.
  el.hidden = eleven.server && !cloud.admin;
  if (eleven.server) { el.textContent = 'ElevenLabs' + (elInfo ? ' · ' + elInfo : ''); el.classList.add(elOk === false ? 'warn' : 'ok'); el.dataset.sec = 'set-eleven-server'; }
  else if (!eleven.hasKey) el.textContent = 'ElevenLabs: add key';
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
  if (cloud.configured) paintInvites();
  $('#cfgClientId').value = cfg.clientId;
  $('#spCustom').hidden = cfg.clientId === DEFAULT_CLIENT_ID || !!cfg.demo;
  $('#redirectUri').textContent = redirectUri();
  $('#spDetail').textContent = !auth.connected ? 'Not connected.'
    : auth.problem ? 'Connected, but Spotify says ' + auth.problem + '.'
    : !auth.libraryOk ? 'Connected, but without playlist access. Press Connect Spotify again to allow it.'
    : 'Connected' + (auth.me && auth.me.display_name ? ' as ' + auth.me.display_name : '') + '.';
  $('#btnConnect').textContent = auth.connected ? 'Reconnect Spotify' : 'Connect Spotify';
  $('#cfgElKey').value = eleven.key;
  $('#set-eleven').hidden = eleven.server;
  $('#set-eleven-server').hidden = !(eleven.server && cloud.admin);
  $('#elServerDetail').textContent = elInfo ? `ElevenLabs: ${elInfo} this month.` : '';
  $$('input[name=output]').forEach((r) => { r.checked = r.value === cfg.output; });
  $('#deviceRow').hidden = cfg.output !== 'connect';
  const sel = $('#cfgDevice');
  if (cfg.deviceId && ![...sel.options].some((o) => o.value === cfg.deviceId)) sel.append(h('option', { value: cfg.deviceId }, cfg.deviceName || 'Saved device'));
  sel.value = cfg.deviceId || '';
  paintDeviceHint();
  $('#cfgSpeed').value = String(cfg.speed);
  paintTalk();
  $('#cfgDemo').checked = !!cfg.demo;
  $('#cfgFallback').checked = !!cfg.fallbackVoice;
}

$('#cfgClientId').addEventListener('change', (e) => { cfg.clientId = e.target.value.trim() || DEFAULT_CLIENT_ID; saveCfg(); paintSettings(); });
$('#btnSharedApp').addEventListener('click', () => {
  const was = cfg.clientId;
  cfg.clientId = DEFAULT_CLIENT_ID; saveCfg();
  if (was !== DEFAULT_CLIENT_ID && auth.connected) logout(false);   // a login made with another app doesn't work with this one
  paintSettings(); renderPills();
  toast('Using the shared Spotify app. Now press Connect Spotify.');
});
$('#btnCopyRedirect').addEventListener('click', () => navigator.clipboard.writeText(redirectUri()).then(() => toast('Copied.', 1500)).catch(() => toast('Select the address and copy it.')));
$('#btnConnect').addEventListener('click', () => { cfg.clientId = $('#cfgClientId').value.trim() || DEFAULT_CLIENT_ID; saveCfg(); login(); });
$('#btnDisconnect').addEventListener('click', () => { logout(true); paintSettings(); renderPills(); });

async function checkEleven(showToast) {
  if (eleven.server && !cloud.admin) { elInfo = ''; elOk = null; app.emit('eleven'); return; }
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
$('#btnElSave').addEventListener('click', () => { eleven.key = $('#cfgElKey').value; checkEleven(true); });
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
  paintDeviceHint(); renderPills();
}));

let devices = [];
// Remembers what the chosen device allows: phones play at their own volume (Talk pauses the music there).
function rememberDevice(d) {
  cfg.deviceType = d ? d.type : '';
  cfg.deviceVolume = d ? volumeWorks(d) : null;
  player.volumeOk = cfg.deviceVolume;
}
function paintDeviceHint() {
  const el = $('#deviceHint');
  const blocked = cfg.output === 'connect' && !!cfg.deviceId && cfg.deviceVolume === false;
  el.hidden = !blocked;
  if (blocked) el.textContent = `Spotify can’t change the volume on ${cfg.deviceName || 'this device'}: phones play at their own volume. `
    + 'Talk pauses the music there instead of turning it down. For the music to dip, play it on a computer or a speaker.';
}
async function loadDevices() {
  const sel = $('#cfgDevice');
  if (!auth.connected) { toast('Connect Spotify first.'); return; }
  try {
    const list = (await listDevices()).filter((d) => d.name !== 'Sauna Conductor');
    devices = list;
    sel.innerHTML = '';
    sel.append(h('option', { value: '' }, list.length ? 'Choose a device…' : 'No devices found. Open the Spotify app.'));
    list.forEach((d) => sel.append(h('option', { value: d.id, selected: d.id === cfg.deviceId }, `${d.name} (${d.type}${volumeWorks(d) ? '' : ', plays at its own volume'})`)));
    let mine = list.find((d) => d.id === cfg.deviceId);
    if (cfg.deviceId && !mine) {
      mine = list.find((d) => d.name === cfg.deviceName);   // device ids can change when the app restarts
      if (mine) { cfg.deviceId = mine.id; sel.value = mine.id; }
    }
    if (mine) { rememberDevice(mine); saveCfg(); }
    paintDeviceHint();
  } catch (e) { toast(e.message); }
}
$('#btnDevices').addEventListener('click', loadDevices);
$('#cfgDevice').addEventListener('change', (e) => {
  const o = e.target.selectedOptions[0];
  const d = devices.find((x) => x.id === e.target.value);
  cfg.deviceId = e.target.value;
  cfg.deviceName = d ? d.name : o ? o.textContent.replace(/ \([^)]*\)$/, '') : '';
  rememberDevice(d);
  saveCfg(); renderPills(); paintDeviceHint(); app.emit('spotify');
});

// Talk button: how loud the music stays while the guide talks (yours, on all your devices).
function paintTalk() {
  const v = prefs().talkLevel ?? 40;
  $('#cfgTalk').value = String(v);
  $('#talkVal').textContent = v + '%';
}
$('#cfgTalk').addEventListener('input', (e) => { $('#talkVal').textContent = e.target.value + '%'; });
$('#cfgTalk').addEventListener('change', (e) => { savePrefs({ talkLevel: +e.target.value }); toast(`While you talk, the music plays at ${e.target.value}%.`, 2200); });
app.on('prefs', () => { if ($('#settings').open) paintTalk(); });

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
if (cloud.configured) initInvitations();
app.on('cloud-data', () => { if (app.current === 'library') libraryView.enter(); });
app.on('cloud-runs', () => { if (app.current === 'library') libraryView.enter(); });
// On the hosted site, ElevenLabs is reached through the server function, with the app's key.
if (cloud.configured && location.protocol !== 'file:') {
  eleven.transport = (method, path, body, signal) => callFunction('eleven', { method, path, body }, signal);
  eleven.ready = () => cloud.signedIn;
  store.del('elkey'); store.del('elkeyAt');            // a key from older versions is no longer needed here
}
app.on('people', () => { eleven.admin = cloud.admin; checkEleven(false); renderPills(); });
app.on('auth', ({ signedIn }) => { if (!signedIn) { elInfo = ''; renderPills(); } });
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
  stopDiagnostics();
  cloud.dormant = true;
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
  if (bc) { bc.postMessage({ type: 'hello', id: TAB_ID }); await sleep(300); if (takeoverRefused) { document.body.classList.remove('booting'); return; } }
  takeLinkFromUrl();
  const q0 = new URLSearchParams(location.search);
  holdRoute(q0.has('code') && !q0.has('sb'));          // back from Spotify: decide after the login is checked
  try { await initCloud(); } catch (e) { console.error(e); }
  let fromSpotify = false;
  try { fromSpotify = await handleRedirect(); } catch (e) { toast(e.message, 8000); }
  holdRoute(false);
  try { await migrate(); } catch (e) { console.error(e); }
  renderPills();
  if (auth.connected && !cfg.demo) player.start();
  if (eleven.hasKey && !eleven.server) checkEleven(false);
  try {
    if (cloud.configured && location.protocol !== 'file:') {
      // The front page, first-time setup, a shared link, or the sessions.
      if (fromSpotify && cloud.signedIn && !onboarded()) await afterSpotifyRedirect();
      else await route();
    } else {
      await app.show('library');
      if (!auth.connected && !cfg.clientId && !cfg.demo) app.openSettings('set-spotify');
    }
  } finally { document.body.classList.remove('booting'); }
}
boot();
