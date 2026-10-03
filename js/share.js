// Share one session with collaborators: they see it in their Sessions and can edit and run it.
import { h, toast } from './util.js';
import { cloud, listShares, addShare, removeShare, sharedWithMe } from './cloud.js';

export async function openShareDialog(s) {
  if (!cloud.signedIn) { toast('Sign in first (Settings → Account and sync).'); return; }
  const list = h('ul', { class: 'people' }, h('li', { class: 'muted' }, 'Loading…'));
  const input = h('input', { type: 'email', placeholder: 'their email address (the one they sign in with)', autocomplete: 'off', spellcheck: 'false' });
  const invite = h('button', { class: 'small primary' }, 'Invite');
  const msg = h('p', { class: 'muted small' });
  const done = h('button', { class: 'small' }, 'Done');
  const shared = sharedWithMe(s.id);
  const dlg = h('dialog', { class: 'share-dlg', 'aria-label': 'Share this session' },
    h('div', { class: 'set-head' }, h('h2', {}, 'Share this session'), h('span', { class: 'spacer' }), done),
    h('div', { class: 'set-body' },
      h('p', { class: 'help' }, `Invite people to “${s.name}”. It shows up in their Sessions. They can change the songs and the narration, run it, and make their own copy. Changes anyone makes reach everyone.`),
      shared ? h('p', { class: 'muted small' }, `${shared.by} shared this session with you.`) : null,
      !shared && cloud.members.length > 1 ? h('p', { class: 'muted small' }, `Everyone in your workspace already has it: ${cloud.members.map((m) => m.name || m.email).join(', ')}.`) : null,
      h('div', { class: 'label mt' }, 'Invited to this session'),
      list,
      h('div', { class: 'row mt' }, input, invite),
      msg,
      h('p', { class: 'help mt' }, 'They open sauna.roadtalk.io and sign in with that email address. To play it they need Spotify Premium and their Spotify account on the app’s user list (Spotify allows 5). To record new narration they need an ElevenLabs key in their own Settings.')));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  done.addEventListener('click', () => dlg.close());

  const paint = async () => {
    let rows = [];
    try { rows = await listShares(s); } catch (e) { list.innerHTML = ''; list.append(h('li', { class: 'muted' }, e.message)); return; }
    list.innerHTML = '';
    if (!rows.length) list.append(h('li', { class: 'muted' }, 'Nobody yet.'));
    for (const r of rows) {
      const rm = h('button', { class: 'small ghost' }, 'Remove');
      rm.addEventListener('click', async () => {
        if (!confirm(`Stop sharing “${s.name}” with ${r.email}?`)) return;
        try { await removeShare(s, r.email); paint(); } catch (e) { toast(e.message); }
      });
      list.append(h('li', {}, h('span', { class: 'who' }, r.email, r.invited_by_name ? h('small', {}, `invited by ${r.invited_by_name}`) : null), rm));
    }
  };
  const go = async () => {
    invite.disabled = true; msg.textContent = 'Inviting…';
    try {
      await addShare(s, input.value);
      msg.textContent = `Invited ${input.value.trim()}. Tell them to open sauna.roadtalk.io and sign in with that address.`;
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
