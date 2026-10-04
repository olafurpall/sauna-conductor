// The account button and menu in the header (Settings, Install, Sign out), Settings → Account,
// and for the admin: Spotify access requests.
import { $, h, toast } from './util.js';
import { app } from './app.js';
import { cloud, signOut, syncAll, setRequestStatus, refreshPeople } from './cloud.js';
import { installButton, isInstalled } from './pwa.js';

let isRunning = () => false;

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const firstName = () => (cloud.name || '').split(/[\s@]/)[0];

export function renderCloudPill() {
  const p = $('#pillCloud');
  p.hidden = !cloud.configured || !cloud.signedIn;
  const req = $('#pillRequests');
  const waiting = cloud.admin ? cloud.requests.filter((r) => r.status === 'pending').length : 0;
  req.hidden = !waiting;
  req.textContent = waiting === 1 ? '1 waiting for Spotify' : `${waiting} waiting for Spotify`;
  if (p.hidden) { closeMenu(); return; }
  p.className = 'pill acct-pill';
  const st = cloud.status;
  p.textContent = (firstName() || 'Account') + ' ▾';
  p.classList.add(st === 'synced' ? 'ok' : st === 'syncing' ? 'sync' : st === 'offline' || st === 'error' ? 'warn' : 'ok');
  p.title = st === 'synced' ? 'Synced' + (cloud.lastSync ? ' ' + ago(cloud.lastSync) : '') : st === 'syncing' ? (cloud.detail || 'Syncing…') : st === 'offline' ? 'Offline: changes sync when you are back online' : st === 'error' ? 'Sync problem: ' + cloud.detail : '';
  $('#acctMenuWho').innerHTML = '';
  $('#acctMenuWho').append(h('b', {}, cloud.name || ''), h('small', {}, cloud.email), h('small', { class: 'st' }, p.title));
}

function closeMenu() { $('#acctMenu').hidden = true; $('#pillCloud').setAttribute('aria-expanded', 'false'); }
function toggleMenu() {
  const m = $('#acctMenu');
  m.hidden = !m.hidden;
  $('#pillCloud').setAttribute('aria-expanded', String(!m.hidden));
  const inst = document.querySelector('.install-btn:not([hidden])');
  $('#btnMenuInstall').hidden = isInstalled() || !inst;
  if (inst) $('#btnMenuInstall').textContent = inst.textContent.trim();   // "Add to Home Screen" on iPhone
  $('#btnMenuCallouts').hidden = !cloud.admin;
}

export function paintAccount() {
  const sec = $('#set-account');
  sec.hidden = !cloud.configured || !cloud.signedIn;
  if (sec.hidden) { $('#set-access').hidden = true; return; }
  $('#acctWho').textContent = cloud.email;
  const chip = $('#acctStatus');
  chip.className = 'chip ' + (cloud.status === 'synced' ? 'ok' : cloud.status === 'syncing' ? 'info' : cloud.status === 'error' || cloud.status === 'offline' ? 'warn' : '');
  chip.textContent = cloud.status === 'synced' ? 'Synced' : cloud.status === 'syncing' ? (cloud.detail || 'Syncing…') : cloud.status === 'offline' ? 'Offline' : cloud.status === 'error' ? 'Sync problem' : '…';
  chip.title = cloud.detail || '';
  $('#acctLast').textContent = cloud.status === 'error' ? cloud.detail : cloud.lastSync ? 'Last synced ' + ago(cloud.lastSync) : '';
  const row = $('#installRow');
  if (!row.firstChild) row.append(installButton('small'));
  paintAccess();
}

// Admin: people Spotify turned away, waiting to be added to the app's user list.
function paintAccess() {
  const sec = $('#set-access');
  sec.hidden = !cloud.admin;
  if (!cloud.admin) return;
  const ul = $('#accessList');
  ul.innerHTML = '';
  const rows = [...cloud.requests].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.created_at).localeCompare(String(a.created_at)));
  if (!rows.length) ul.append(h('li', { class: 'muted' }, 'Nobody is waiting.'));
  for (const r of rows) {
    const mark = (status, label, cls) => {
      const b = h('button', { class: 'small ' + cls }, label);
      b.addEventListener('click', async () => { b.disabled = true; try { await setRequestStatus(r.user_id, status); toast(status === 'added' ? `${r.name || r.email} can connect Spotify now.` : 'Declined.'); } catch (e) { toast(e.message); b.disabled = false; } });
      return b;
    };
    const copy = h('button', { class: 'small ghost', title: 'Copy the Spotify email' }, 'Copy email');
    copy.addEventListener('click', () => navigator.clipboard.writeText(r.spotify_email).then(() => toast('Copied.', 1500)).catch(() => {}));
    ul.append(h('li', { class: 'req' },
      h('span', { class: 'who' }, r.name || r.email, h('small', {}, `Spotify: ${r.spotify_email}${r.email && r.email !== r.spotify_email ? ' · signs in as ' + r.email : ''}`), r.note ? h('small', { class: 'note' }, '“' + r.note + '”') : null),
      h('span', { class: 'chip ' + (r.status === 'pending' ? 'warn' : r.status === 'added' ? 'ok' : '') }, r.status === 'pending' ? 'Waiting' : r.status === 'added' ? 'Added' : 'Declined'),
      r.status === 'pending' ? copy : null,
      r.status !== 'added' ? mark('added', 'Mark as added', 'primary') : null,
      r.status === 'pending' ? mark('declined', 'Decline', 'ghost') : null));
  }
}

export function initAccount(opts) {
  isRunning = opts.isRunning;
  app.on('cloud', () => { renderCloudPill(); if ($('#settings').open) paintAccount(); });
  app.on('people', () => { renderCloudPill(); if ($('#settings').open) paintAccount(); });

  $('#pillCloud').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#acctWrap')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  $('#btnMenuSettings').addEventListener('click', () => { closeMenu(); app.openSettings('set-account'); });
  $('#btnMenuCallouts').addEventListener('click', () => { closeMenu(); if (isRunning()) { toast('End the session first.'); return; } app.show('callouts'); });
  $('#btnMenuInstall').addEventListener('click', () => { closeMenu(); const b = document.querySelector('.install-btn:not([hidden])'); if (b) b.click(); });
  const out = async () => {
    closeMenu();
    if (isRunning()) { toast('End the session first.'); return; }
    if ($('#settings').open) $('#settings').close();
    await signOut();
    toast('Signed out.');
  };
  $('#btnSignOutTop').addEventListener('click', out);
  $('#btnSignOut').addEventListener('click', out);
  $('#btnSyncNow').addEventListener('click', () => { syncAll(); refreshPeople(); });
  // The admin hears about new requests on the next sync.
  app.on('cloud', () => { if (cloud.admin && cloud.status === 'synced' && Date.now() - (initAccount.t || 0) > 60000) { initAccount.t = Date.now(); refreshPeople(); } });
  renderCloudPill();
}
