// Settings → Account and sync, and the sync pill in the header.
import { $, h, toast } from './util.js?v=2.5-6e8466df';
import { app } from './app.js?v=2.5-6e8466df';
import { cloud, signInWithGoogle, signInWithEmail, signOut, syncAll, invite, cancelInvite, removeMember, switchWorkspace, renameWorkspace } from './cloud.js?v=2.5-6e8466df';

let isRunning = () => false;

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export function renderCloudPill() {
  const p = $('#pillCloud');
  p.hidden = !cloud.configured;
  if (!cloud.configured) return;
  p.className = 'pill';
  const st = cloud.status;
  if (!cloud.signedIn) { p.textContent = st === 'starting' ? 'Starting…' : 'Sign in'; if (st === 'error' || st === 'offline') p.classList.add('warn'); return; }
  const first = (cloud.name || '').split(/[\s@]/)[0];
  if (st === 'syncing') { p.textContent = 'Syncing…'; p.classList.add('sync'); }
  else if (st === 'synced') { p.textContent = 'Synced' + (first ? ' · ' + first : ''); p.classList.add('ok'); }
  else if (st === 'offline') { p.textContent = 'Offline'; p.classList.add('warn'); }
  else if (st === 'error') { p.textContent = 'Sync problem'; p.classList.add('warn'); }
  else p.textContent = first || 'Signed in';
}

export function paintAccount() {
  const sec = $('#set-account');
  sec.hidden = !cloud.configured;
  if (!cloud.configured) return;
  $('#acctOut').hidden = cloud.signedIn;
  $('#acctIn').hidden = !cloud.signedIn;
  if (!cloud.signedIn) {
    if (cloud.status === 'error' || cloud.status === 'offline') $('#acctMsg').textContent = cloud.detail;
    return;
  }
  $('#acctWho').textContent = cloud.email;
  const chip = $('#acctStatus');
  chip.className = 'chip ' + (cloud.status === 'synced' ? 'ok' : cloud.status === 'syncing' ? 'info' : cloud.status === 'error' || cloud.status === 'offline' ? 'warn' : '');
  chip.textContent = cloud.status === 'synced' ? 'Synced' : cloud.status === 'syncing' ? (cloud.detail || 'Syncing…') : cloud.status === 'offline' ? 'Offline' : cloud.status === 'error' ? 'Sync problem' : '…';
  chip.title = cloud.detail || '';
  $('#acctLast').textContent = cloud.status === 'error' ? cloud.detail : cloud.lastSync ? 'Last synced ' + ago(cloud.lastSync) : '';

  const sel = $('#acctWs');
  sel.innerHTML = '';
  for (const w of cloud.workspaces) sel.append(h('option', { value: w.id, selected: cloud.ws && w.id === cloud.ws.id }, w.id === (cloud.ws && cloud.ws.id) ? cloud.ws.name : w.name));
  sel.disabled = cloud.workspaces.length < 2;
  const name = $('#acctWsName');
  if (document.activeElement !== name) name.value = cloud.ws ? cloud.ws.name : '';

  const me = cloud.members.find((m) => m.user_id === cloud.user.id);
  const owner = me && me.role === 'owner';
  const ul = $('#acctPeople');
  ul.innerHTML = '';
  for (const m of cloud.members) {
    const self = m.user_id === cloud.user.id;
    ul.append(h('li', {},
      h('span', { class: 'who' }, m.name || m.email, h('small', {}, m.email || '')),
      h('span', { class: 'chip' + (m.role === 'owner' ? ' info' : '') }, self ? 'You' : m.role === 'owner' ? 'Owner' : 'Member'),
      !self && owner ? h('button', { class: 'small ghost', onclick: () => confirmRemove(m) }, 'Remove') : null));
  }
  for (const i of cloud.invites) {
    ul.append(h('li', {},
      h('span', { class: 'who' }, i.email, h('small', {}, 'invited, has not signed in yet')),
      h('span', { class: 'chip warn' }, 'Invited'),
      h('button', { class: 'small ghost', onclick: () => cancelInvite(i.email).catch((e) => toast(e.message)) }, 'Cancel')));
  }
  if (!cloud.members.length && !cloud.invites.length) ul.append(h('li', { class: 'muted' }, 'Loading…'));
}

async function confirmRemove(m) {
  if (!confirm(`Remove ${m.name || m.email} from this workspace? They will no longer see its sessions.`)) return;
  try { await removeMember(m.user_id); toast('Removed.'); } catch (e) { toast(e.message); }
}

function guardRunning() {
  if (isRunning()) { toast('Sign in after the session. Signing in reloads the page.'); return true; }
  return false;
}

export function initAccount(opts) {
  isRunning = opts.isRunning;
  app.on('cloud', () => { renderCloudPill(); if ($('#settings').open) paintAccount(); });

  $('#btnGoogle').addEventListener('click', async () => {
    if (guardRunning()) return;
    try { await signInWithGoogle(); } catch (e) { $('#acctMsg').textContent = e.message; }
  });
  const sendLink = async () => {
    if (guardRunning()) return;
    const email = $('#acctEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('#acctMsg').textContent = 'Type your email address first.'; return; }
    $('#btnEmailLink').disabled = true;
    $('#acctMsg').textContent = 'Sending…';
    try {
      await signInWithEmail(email);
      $('#acctMsg').textContent = `Check ${email} for a sign-in link. Open it in this same browser.`;
    } catch (e) {
      $('#acctMsg').textContent = /rate|limit/i.test(e.message) ? 'Too many sign-in emails just now. Wait a few minutes, or use Google.' : e.message;
    } finally { $('#btnEmailLink').disabled = false; }
  };
  $('#btnEmailLink').addEventListener('click', sendLink);
  $('#acctEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });

  const doInvite = async () => {
    const i = $('#inviteEmail');
    try { await invite(i.value); toast(`Invited ${i.value.trim()}. They sign in here with that address.`, 5000); i.value = ''; }
    catch (e) { toast(e.message); }
  };
  $('#btnInvite').addEventListener('click', doInvite);
  $('#inviteEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') doInvite(); });

  $('#btnSyncNow').addEventListener('click', () => syncAll());
  $('#btnSignOut').addEventListener('click', async () => {
    if (isRunning()) { toast('End the session first.'); return; }
    await signOut();
    toast('Signed out. Sessions on this computer stay here.');
  });
  $('#acctWs').addEventListener('change', (e) => {
    if (isRunning()) { toast('Switch workspace between sessions.'); paintAccount(); return; }
    switchWorkspace(e.target.value);
  });
  $('#acctWsName').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && cloud.ws && v !== cloud.ws.name) renameWorkspace(v).catch((err) => toast(err.message));
  });
  renderCloudPill();
}
