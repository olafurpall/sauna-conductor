// Settings → Callout recordings (admin): invite people to record callouts on the public recording page,
// and see who has opened their link and who has sent their recordings.
import { $, h, toast, fmtDate } from './util.js';
import { app } from './app.js';
import { cloud } from './cloud.js';
import { callouts, createInvite, listInvites, revokeInvite, inviteUrl, inviteMessage, loadProfiles, profileById } from './callouts.js';

let invites = [];
let fresh = null;          // the invitation just made: its links are shown open

const from = () => (cloud.name || '').split(/[\s@]/)[0] || '';
function mailto(inv) {
  const m = inviteMessage(inv, from());
  return `mailto:${encodeURIComponent(inv.email || '')}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
}
function sendButtons(inv) {
  const copy = h('button', { class: 'small', title: 'Copy the link to their recording page' }, 'Copy link');
  copy.addEventListener('click', () => navigator.clipboard.writeText(inviteUrl(inv.token)).then(() => toast('Link copied. Send it to ' + inv.name + '.', 2500)).catch(() => toast(inviteUrl(inv.token), 8000)));
  const mail = h('a', { class: 'btn small', href: mailto(inv), title: 'Opens your email app with the message ready' }, 'Email');
  const share = navigator.share ? h('button', { class: 'small ghost', title: 'Text message, WhatsApp, Messenger…' }, 'Share…') : null;
  if (share) share.addEventListener('click', () => { const m = inviteMessage(inv, from()); navigator.share({ title: m.subject, text: m.body }).catch(() => {}); });
  return [copy, mail, share];
}

function statusOf(inv) {
  if (inv.revoked) return ['', 'Link turned off'];
  const p = profileById(inv.profile_id);
  const n = p ? (p.clips || []).length : 0;
  if (inv.status === 'submitted') return ['ok', `Sent ${n} callout${n === 1 ? '' : 's'}`];
  if (inv.status === 'opened') return ['info', 'Opened the link'];
  return ['', 'Not opened yet'];
}

export async function paintInvites() {
  const sec = $('#set-callouts');
  sec.hidden = !cloud.signedIn || !cloud.admin;
  if (sec.hidden) return;
  const ul = $('#inviteList');
  try { [invites] = await Promise.all([listInvites(), loadProfiles(true)]); }
  catch (e) { ul.innerHTML = ''; ul.append(h('li', { class: 'muted' }, /callout_invites|relation|schema cache/i.test(e.message || '') ? 'Invitations aren’t set up in the database yet.' : e.message)); return; }
  ul.innerHTML = '';
  if (!invites.length) ul.append(h('li', { class: 'muted' }, 'No invitations yet.'));
  for (const inv of invites) {
    const [cls, label] = statusOf(inv);
    const off = h('button', { class: 'small ghost danger', title: 'The link stops working. Recordings already sent stay.' }, 'Turn off link');
    off.addEventListener('click', async () => {
      if (!confirm(`Turn off ${inv.name}’s link? Recordings they already sent stay.`)) return;
      try { await revokeInvite(inv); paintInvites(); } catch (e) { toast(e.message); }
    });
    ul.append(h('li', { class: 'inv' + (fresh === inv.id ? ' fresh' : '') },
      h('span', { class: 'who' }, inv.name, h('small', {}, [inv.email, inv.lang === 'is' ? 'Íslenska' : 'English', 'invited ' + fmtDate(new Date(inv.created_at).getTime())].filter(Boolean).join(' · '))),
      h('span', { class: 'chip ' + cls }, label),
      ...(inv.revoked ? [] : sendButtons(inv)),
      inv.revoked ? null : off));
  }
}

export function initInvitations() {
  $('#lnkCallouts').addEventListener('click', (e) => { e.preventDefault(); $('#settings').close(); app.show('callouts'); });
  $('#btnInvite').addEventListener('click', async () => {
    const b = $('#btnInvite');
    const name = $('#invName').value.trim();
    if (!name) { toast('Write their name first.'); $('#invName').focus(); return; }
    b.disabled = true;
    try {
      const inv = await createInvite({ name, email: $('#invEmail').value, lang: $('#invLang').value, note: $('#invNote').value });
      fresh = inv.id;
      $('#invName').value = ''; $('#invEmail').value = ''; $('#invNote').value = '';
      toast(`Invitation ready. Send ${name} the link: Copy link, Email or Share.`, 5000);
      await paintInvites();
    } catch (e) { toast(e.message || String(e), 7000); }
    b.disabled = false;
  });
}
