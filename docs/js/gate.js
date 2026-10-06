// The way in: the front page (sign in), first-time onboarding (connect Spotify, or ask for access),
// and opening a shared session link once all that is done.
import { $, h, toast, store, fmtDur } from './util.js?v=3.2.1-8eb03f85';
import { app, cfg, saveCfg } from './app.js?v=3.2.1-8eb03f85';
import { cloud, signInWithGoogle, signInWithEmail, linkInfo, claimLink, requestAccess, refreshPeople, linkUrl } from './cloud.js?v=3.2.1-8eb03f85';
import { auth, login, getMe, player } from './spotify.js?v=3.2.1-8eb03f85';
import { installButton } from './pwa.js?v=3.2.1-8eb03f85';

const welcomeEl = $('#view-welcome');
const onboardEl = $('#view-onboard');

// ---------------------------------------------------------------- where to go
const ua = navigator.userAgent || '';
export const inAppBrowser = () => /Instagram|FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Line\/|TikTok|BytedanceWebview|musical_ly|Snapchat|LinkedInApp|Twitter for/i.test(ua);
const appName = () => (/Instagram/i.test(ua) ? 'Instagram' : /FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(ua) ? 'Facebook' : /Messenger/i.test(ua) ? 'Messenger' : /TikTok|musical_ly|Bytedance/i.test(ua) ? 'TikTok' : /Snapchat/i.test(ua) ? 'Snapchat' : 'this app');
export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
const isAndroid = () => /Android/i.test(ua);

export const onboarded = () => !!store.get('onboarded', false);
const spotifyOk = () => auth.connected && !auth.problem;
export const needsOnboarding = () => cloud.configured && cloud.signedIn && !cfg.demo && !onboarded() && !spotifyOk();

// A shared link (?s=…) is remembered until it has been opened, through sign-in and onboarding.
export function takeLinkFromUrl() {
  const q = new URLSearchParams(location.search);
  const tok = q.get('s');
  if (!tok || !/^[A-Za-z0-9_-]{16,64}$/.test(tok)) return;
  store.set('pendingLink', tok);
  q.delete('s');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
}

let routing = false;
let held = false;               // while coming back from Spotify: wait until we know what Spotify said
export const holdRoute = (v) => { held = v; };
export async function route() {
  if (!cloud.configured || routing || held) return;
  routing = true;
  try {
    if (!cloud.signedIn) {
      if (cloud.status !== 'starting' && app.current !== 'welcome') await app.show('welcome');
      return;
    }
    if (needsOnboarding()) { if (app.current !== 'onboard') await app.show('onboard'); return; }
    const tok = store.get('pendingLink', null);
    if (tok) { await openLink(tok); return; }
    if (!app.current || app.current === 'welcome' || app.current === 'onboard') await app.show('library');
  } finally { routing = false; }
}

async function openLink(tok) {
  try {
    const sid = await claimLink(tok);
    store.del('pendingLink');
    await app.show('session', sid);
    toast('This session is now in your Sessions. Press Run when everyone is seated.', 6000);
  } catch (e) {
    store.del('pendingLink');
    toast(e.message, 8000);
    await app.show('library');
  }
}

app.on('auth', () => setTimeout(route, 0));

// ---------------------------------------------------------------- front page
export const welcomeView = {
  el: welcomeEl,
  async enter() { document.body.classList.add('gate'); await renderWelcome(); },
  async leave() { document.body.classList.remove('gate'); return true; },
};

async function renderWelcome() {
  const tok = store.get('pendingLink', null);
  const msg = h('p', { class: 'muted small gate-msg', role: 'status' });
  const google = h('button', { class: 'primary big gate-google' }, h('span', { class: 'g', 'aria-hidden': 'true' }, 'G'), 'Continue with Google');
  google.addEventListener('click', async () => {
    google.disabled = true;
    try { await signInWithGoogle(); } catch (e) { msg.textContent = e.message; google.disabled = false; }
  });
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', spellcheck: 'false', 'aria-label': 'Email address' });
  const send = h('button', {}, 'Email me a link');
  const sendLink = async () => {
    const v = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { msg.textContent = 'Type your email address first.'; return; }
    send.disabled = true; msg.textContent = 'Sending…';
    try { await signInWithEmail(v); msg.textContent = `Check ${v} for a sign-in link, and open it in this same browser.`; }
    catch (e) {
      msg.textContent = /rate|limit/i.test(e.message) ? 'Too many sign-in emails just now. Wait a few minutes, or use Google.'
        : /not authori[sz]ed|signups? not allowed/i.test(e.message) ? 'Email sign-in isn’t open to everyone yet. Please use Google for now.' : e.message;
    } finally { send.disabled = false; }
  };
  send.addEventListener('click', sendLink);
  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });

  const linkCard = h('div', { class: 'gate-link', hidden: true });
  const inApp = inAppBrowser() ? inAppNotice() : null;

  welcomeEl.innerHTML = '';
  welcomeEl.append(h('div', { class: 'gate-wrap' },
    h('div', { class: 'gate-card' },
      h('img', { class: 'gate-logo', src: 'icons/icon.svg', alt: '', width: 88, height: 88 }),
      h('div', { class: 'gate-brand' }, 'Sauna ', h('span', {}, 'Conductor')),
      h('h1', { class: 'gate-title' }, 'Guided sauna sessions, with your music and a voice that leads the way.'),
      linkCard, inApp,
      h('div', { class: 'gate-actions' }, google,
        h('details', { class: 'gate-email' }, h('summary', {}, 'Sign in with email instead'), h('div', { class: 'row' }, email, send))),
      msg,
      h('ul', { class: 'gate-points' },
        h('li', {}, h('b', {}, 'Rounds from your Spotify playlists. '), 'Songs planned for every round and every cool-down.'),
        h('li', {}, h('b', {}, 'A narrator in your language. '), 'Welcomes everyone, calls the cool-downs and checks in mid-song. English, Icelandic and more.'),
        h('li', {}, h('b', {}, 'Share it. '), 'Invite friends to build it with you, or post a link for others to run it.')),
      h('p', { class: 'muted small gate-fine' }, 'You need Spotify Premium. Sauna Conductor is in a small beta, and Spotify only lets a few people in, so you may need to wait to be let in. ',
        h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy')),
      installButton('gate-install'))));

  if (tok) {
    const info = await linkInfo(tok);
    if (info) {
      linkCard.hidden = false;
      linkCard.append(h('div', { class: 'label' }, `${info.owner || 'Someone'} shared a session with you`),
        h('div', { class: 'gate-link-name' }, info.session_name),
        h('div', { class: 'muted small' }, [info.rounds ? `${info.rounds} rounds` : '', info.minutes ? fmtDur(info.minutes * 60000) : '', info.notes].filter(Boolean).join(' · ')),
        h('div', { class: 'small' }, 'Sign in to open it.'));
    }
  }
}

function inAppNotice() {
  const url = location.href;
  const copy = h('button', { class: 'small' }, 'Copy the link');
  copy.addEventListener('click', () => navigator.clipboard.writeText(url).then(() => toast('Copied. Paste it into Safari or Chrome.')).catch(() => toast('Press and hold the address to copy it.')));
  const chrome = isAndroid()
    ? h('a', { class: 'btn small primary', href: `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end` }, 'Open in Chrome')
    : null;
  return h('div', { class: 'banner warn gate-inapp' },
    h('b', {}, `You're inside ${appName()}. `),
    `Google doesn't allow signing in here. Tap ••• (top right) and choose ${/iPhone|iPad/i.test(ua) ? '“Open in Safari” or “Open in browser”' : '“Open in browser”'}.`,
    h('div', { class: 'row mt' }, chrome, copy));
}

// ---------------------------------------------------------------- first time: connect Spotify
export const onboardView = {
  el: onboardEl,
  async enter() { document.body.classList.add('gate'); paintOnboard(true); },
  async leave() { document.body.classList.remove('gate'); stopPolling(); shownState = ''; return true; },
};

let checking = false;
let poll = null;
const stopPolling = () => { clearInterval(poll); poll = null; };

async function recheck() {
  if (!auth.connected || checking) return;
  checking = true; paintOnboard();
  auth.me = null; auth.problem = '';
  try { await getMe(); } catch (e) { if (e.status === 403) auth.problem = e.message.replace(/^Spotify: /, ''); }
  checking = false;
  app.emit('spotify');
  paintOnboard();
}

function finish() {
  store.set('onboarded', true);
  stopPolling();
  if (isPhone() && cfg.output === 'browser') { cfg.output = 'connect'; saveCfg(); }   // phones play through the Spotify app
  if (auth.connected && !cfg.demo) player.restart();
  route();
}

// Which screen of the setup to show; it is only redrawn when this changes (so typing isn't lost).
function onboardState() {
  if (!auth.connected) return !cloud.lastSync && cloud.status === 'syncing' ? 'loading' : 'connect';
  if (checking) return 'checking';
  if (auth.problem) return 'request:' + (cloud.request ? cloud.request.status : 'none');
  return 'ok:' + ((auth.me && auth.me.product) || '');
}
let shownState = '';
function paintOnboard(force = false) {
  if (app.current !== 'onboard') return;
  const state = onboardState();
  if (!force && state === shownState) return;
  shownState = state;
  const first = (cloud.name || '').split(/[\s@]/)[0];
  const box = h('div', { class: 'gate-card onb' });
  const skip = h('button', { class: 'ghost small' }, 'Look around first');
  skip.addEventListener('click', finish);
  const steps = (n) => h('ol', { class: 'onb-steps' },
    ...['Sign in', 'Connect Spotify', 'Start a session'].map((t, i) => h('li', { class: i < n ? 'done' : i === n ? 'on' : '' }, t)));

  if (!auth.connected) {
    if (!cloud.lastSync && cloud.status === 'syncing') {
      box.append(steps(1), h('h1', {}, first ? `Welcome, ${first}` : 'Welcome'), h('p', { class: 'muted' }, 'Getting your account ready…'), h('div', { class: 'spin' }));
    } else {
      const go = h('button', { class: 'primary big' }, 'Connect Spotify');
      go.addEventListener('click', () => login());
      box.append(steps(1), h('h1', {}, first ? `Welcome, ${first}` : 'Welcome'),
        h('p', { class: 'onb-lead' }, 'One step left: connect your Spotify account, so Sauna Conductor can play your playlists. You need Spotify Premium.'),
        go,
        h('p', { class: 'muted small' }, 'Spotify asks you to agree once. Sauna Conductor plays music and reads your playlists, and only makes a playlist when you ask it to.'),
        h('div', { class: 'row' }, skip));
    }
  } else if (checking) {
    box.append(steps(1), h('h1', {}, 'Checking with Spotify…'), h('div', { class: 'spin' }));
  } else if (auth.problem) {
    box.append(steps(1), ...accessRequest(skip));
  } else {
    const me = auth.me || {};
    const premium = !me.product || me.product === 'premium';
    const cont = h('button', { class: 'primary big' }, store.get('pendingLink') ? 'Open the shared session' : 'Start');
    cont.addEventListener('click', finish);
    box.append(steps(2), h('h1', {}, 'You’re all set'),
      h('p', { class: 'onb-lead' }, `Spotify is connected${me.display_name ? ' as ' + me.display_name : ''}.`),
      premium ? null : h('p', { class: 'banner warn' }, 'This Spotify account isn’t Premium, so music won’t play. You can still look around and plan sessions.'),
      isPhone() ? h('p', { class: 'muted small' }, 'On a phone the music plays in your Spotify app: open Spotify once, then choose it under Settings → Where the music plays.') : null,
      cont);
  }
  onboardEl.innerHTML = '';
  onboardEl.append(h('div', { class: 'gate-wrap' }, box));
}

// Spotify turned them away: they're not on the app's user list (5 people at most).
function accessRequest(skip) {
  const r = cloud.request;
  const tryAgain = h('button', { class: 'small' }, 'Try again');
  tryAgain.addEventListener('click', recheck);
  if (r && r.status === 'added') {
    return [h('h1', {}, 'You’ve been let in'), h('p', { class: 'onb-lead' }, 'Press Try again to finish connecting Spotify.'), h('div', { class: 'row' }, tryAgain, skip)];
  }
  if (r && r.status === 'pending') {
    if (!poll) poll = setInterval(async () => { await refreshPeople(); if (cloud.request && cloud.request.status !== 'pending') paintOnboard(); }, 30000);
    return [h('h1', {}, 'Your request is in'),
      h('p', { class: 'onb-lead' }, `We’ll let ${r.spotify_email} in as soon as there’s room. Spotify allows only a few people while the app is in beta.`),
      h('p', { class: 'muted small' }, 'Come back later and press Try again. Meanwhile you can look around and plan sessions.'),
      h('div', { class: 'row' }, tryAgain, skip)];
  }
  const em = h('input', { type: 'email', value: (r && r.spotify_email) || cloud.email || '', autocomplete: 'email', spellcheck: 'false', 'aria-label': 'Email you log in to Spotify with' });
  const note = h('input', { type: 'text', maxlength: 300, placeholder: 'Optional: a word about you or your sauna' });
  const send = h('button', { class: 'primary' }, 'Ask for access');
  const out = h('p', { class: 'muted small' });
  send.addEventListener('click', async () => {
    send.disabled = true; out.textContent = 'Sending…';
    try { await requestAccess(em.value, note.value); paintOnboard(true); } catch (e) { out.textContent = e.message; send.disabled = false; }
  });
  return [h('h1', {}, 'Spotify hasn’t let you in yet'),
    h('p', { class: 'onb-lead' }, 'Spotify only lets people on Sauna Conductor’s guest list use it while the app is in beta. Ask to be added: tell us the email address you log in to Spotify with.'),
    r && r.status === 'declined' ? h('p', { class: 'banner warn' }, 'Your last request wasn’t accepted, perhaps because the list is full. You can ask again.') : null,
    h('label', { class: 'f' }, 'Spotify email', em), h('label', { class: 'f' }, 'Note', note),
    h('div', { class: 'row mt' }, send, tryAgain, skip), out];
}

app.on('spotify', () => {
  if (app.current !== 'onboard') return;
  if (spotifyOk() && auth.me) paintOnboard();
});
app.on('cloud', () => { if (app.current === 'onboard') paintOnboard(); });
app.on('people', () => { if (app.current === 'onboard') paintOnboard(); });
// A Spotify login saved in the account (from another computer) arrives after sign-in.
app.on('cloud-spotify', () => {
  if (app.current !== 'onboard') return;
  // Connected on another device already: nothing to set up here.
  setTimeout(async () => { await recheck(); if (spotifyOk()) finish(); }, 300);
});

// Back from Spotify during first-time setup: check whether Spotify lets this account in.
export async function afterSpotifyRedirect() {
  if (app.current !== 'onboard') await app.show('onboard');
  await recheck();
}

export const shareUrl = linkUrl;
