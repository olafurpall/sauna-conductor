// Invite people to one session by email: collaborators can change it, viewers can only run it.
import { h, toast } from './util.js?v=3.0-152b544c';
import { cloud, listShares, addShare, removeShare, setShareRole, sharedWithMe, canEdit } from './cloud.js?v=3.0-152b544c';

const ROLE_LABEL = { editor: 'Collaborator', viewer: 'Viewer' };
const roleSelect = (value, disabled) => {
  const sel = h('select', { 'aria-label': 'Role', disabled },
    h('option', { value: 'editor' }, 'Collaborator · can edit'), h('option', { value: 'viewer' }, 'Viewer · can only run it'));
  sel.value = value === 'viewer' ? 'viewer' : 'editor';
  return sel;
};

export async function openInviteDialog(s) {
  if (!cloud.signedIn) { toast('Sign in first.'); return; }
  if (!canEdit(s.id)) { toast('Only the owner and collaborators can invite people.'); return; }
  const shared = sharedWithMe(s.id);
  const list = h('ul', { class: 'people' }, h('li', { class: 'muted' }, 'Loading…'));
  const input = h('input', { type: 'email', placeholder: 'their email address (the one they sign in with)', autocomplete: 'off', spellcheck: 'false' });
  const role = roleSelect('editor');
  const invite = h('button', { class: 'small primary' }, 'Invite');
  const msg = h('p', { class: 'muted small' });
  const done = h('button', { class: 'small' }, 'Done');
  const dlg = h('dialog', { class: 'share-dlg', 'aria-label': 'Invite people' },
    h('div', { class: 'set-head' }, h('h2', {}, 'Invite people'), h('span', { class: 'spacer' }), done),
    h('div', { class: 'set-body' },
      h('p', { class: 'help' }, `“${s.name}” shows up in their Sessions. `, h('b', {}, 'Collaborators'), ' can change the songs and the narration and run it. ',
        h('b', {}, 'Viewers'), ' can only run it.'),
      shared ? h('p', { class: 'muted small' }, `This is ${shared.owner}’s session. You can invite people as a collaborator.`) : null,
      h('div', { class: 'label mt' }, 'People with access'),
      list,
      h('div', { class: 'row mt invite-row' }, input, role, invite),
      msg,
      h('p', { class: 'help mt' }, 'They open sauna.roadtalk.io and sign in with that email address. To play the music they need Spotify Premium, and Spotify has to let them in while the app is in beta.')));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  done.addEventListener('click', () => dlg.close());

  const paint = async () => {
    let rows = [];
    try { rows = await listShares(s); } catch (e) { list.innerHTML = ''; list.append(h('li', { class: 'muted' }, e.message)); return; }
    list.innerHTML = '';
    list.append(h('li', {}, h('span', { class: 'who' }, shared ? shared.owner : cloud.name || cloud.email, h('small', {}, shared ? 'owner' : 'you')), h('span', { class: 'chip info' }, 'Owner')));
    if (!rows.length) list.append(h('li', { class: 'muted' }, 'Nobody else yet.'));
    for (const r of rows) {
      const me = r.email === String(cloud.email || '').toLowerCase();
      const sel = roleSelect(r.role, me);
      sel.addEventListener('change', async () => {
        try { await setShareRole(s, r.email, sel.value); toast(`${r.email} is now a ${ROLE_LABEL[sel.value].toLowerCase()}.`); } catch (e) { toast(e.message); sel.value = r.role; }
      });
      const rm = h('button', { class: 'small ghost', hidden: me }, 'Remove');
      rm.addEventListener('click', async () => {
        if (!confirm(`Stop sharing “${s.name}” with ${r.email}?`)) return;
        try { await removeShare(s, r.email); paint(); } catch (e) { toast(e.message); }
      });
      list.append(h('li', {},
        h('span', { class: 'who' }, r.email, h('small', {}, me ? 'you' : r.via_link ? 'joined with the link' : r.invited_by_name ? `invited by ${r.invited_by_name}` : '')),
        sel, rm));
    }
  };
  const go = async () => {
    invite.disabled = true; msg.textContent = 'Inviting…';
    try {
      await addShare(s, input.value, role.value);
      msg.textContent = `Invited ${input.value.trim()} as a ${ROLE_LABEL[role.value].toLowerCase()}. Tell them to open sauna.roadtalk.io and sign in with that address.`;
      input.value = '';
      paint();
    } catch (e) { msg.textContent = e.message; }
    invite.disabled = false;
  };
  invite.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => input.focus(), 50);
  paint();
}
