// Share a session as a link (Facebook, Instagram stories, messages…). Whoever opens it signs in,
// connects Spotify, and then gets the session as a viewer: they can run it but not change it.
import { h, toast } from './util.js';
import { cloud, getLink, createLink, revokeLink, linkUrl, listShares, canEdit } from './cloud.js';

export async function openLinkDialog(s) {
  if (!cloud.signedIn) { toast('Sign in first.'); return; }
  if (!canEdit(s.id)) { toast('Only the owner and collaborators can share a link.'); return; }
  const body = h('div', { class: 'set-body' });
  const done = h('button', { class: 'small' }, 'Done');
  const dlg = h('dialog', { class: 'share-dlg link-dlg', 'aria-label': 'Share a link' },
    h('div', { class: 'set-head' }, h('h2', {}, 'Share a link'), h('span', { class: 'spacer' }), done), body);
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  done.addEventListener('click', () => dlg.close());

  const paint = async (token) => {
    body.innerHTML = '';
    body.append(h('p', { class: 'help' }, `Anyone with the link can open “${s.name}”: they sign in, connect Spotify, and the session opens for them, ready to run. They can’t change it.`));
    if (!token) {
      const make = h('button', { class: 'primary' }, 'Create a link');
      make.addEventListener('click', async () => {
        make.disabled = true; make.textContent = 'Creating…';
        try { paint(await createLink(s)); } catch (e) { toast(e.message); make.disabled = false; make.textContent = 'Create a link'; }
      });
      body.append(make);
      return;
    }
    const url = linkUrl(token);
    const field = h('input', { type: 'text', readonly: true, value: url, class: 'link-field', 'aria-label': 'Link' });
    field.addEventListener('focus', () => field.select());
    const copy = h('button', { class: 'small primary' }, 'Copy');
    copy.addEventListener('click', () => navigator.clipboard.writeText(url).then(() => toast('Link copied.')).catch(() => { field.select(); toast('Press Ctrl+C (⌘C) to copy.'); }));
    const text = `${s.name} · a guided sauna session on Sauna Conductor`;
    const native = navigator.share ? h('button', { class: 'small' }, 'Share…') : null;
    if (native) native.addEventListener('click', () => navigator.share({ title: s.name, text, url }).catch(() => {}));
    const fb = h('a', { class: 'btn small', href: 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url), target: '_blank', rel: 'noopener' }, 'Facebook');
    const stop = h('button', { class: 'small ghost danger' }, 'Stop this link');
    stop.addEventListener('click', async () => {
      if (!confirm('Stop this link? People who already opened it keep the session; new people can’t use the link.')) return;
      try { await revokeLink(s); toast('The link no longer works.'); paint(null); } catch (e) { toast(e.message); }
    });
    let joined = 0;
    try { joined = (await listShares(s)).filter((x) => x.via_link).length; } catch { /* ignore */ }
    body.append(
      h('div', { class: 'row' }, field, copy),
      h('div', { class: 'row mt' }, native, fb, h('span', { class: 'spacer' }), stop),
      h('p', { class: 'muted small mt' }, h('b', {}, 'Instagram story: '), 'copy the link, then add it to your story with the ', h('b', {}, 'Link'), ' sticker.'),
      h('p', { class: 'muted small' }, joined ? `${joined} ${joined === 1 ? 'person has' : 'people have'} opened it so far (see Invite).` : 'Nobody has opened it yet.'),
      h('p', { class: 'muted small' }, 'To play the music they need Spotify Premium, and Spotify has to let them in while the app is in beta. You’ll see their requests in Settings.'));
  };
  body.append(h('p', { class: 'muted' }, 'Loading…'));
  try { paint(await getLink(s)); } catch (e) { body.innerHTML = ''; body.append(h('p', { class: 'muted' }, e.message)); }
}
