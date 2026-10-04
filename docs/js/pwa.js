// Installing Sauna Conductor as an app (home-screen icon, full screen).
// Android and desktop Chrome/Edge offer a one-tap install. Safari has no install prompt a page can
// open: on iPhone and iPad it goes through ••• → Share → Add to Home Screen, and on a Mac through
// File → Add to Dock, so the button shows those steps instead.
import { h, toast } from './util.js?v=3.0.1-b12beced';

let deferred = null;
const buttons = new Set();
const ua = navigator.userAgent || '';
const isIOS = () => /iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
const iosChrome = () => /CriOS|FxiOS|EdgiOS/.test(ua);
// Safari 17+ on a Mac (macOS Sonoma or later) can add a web app to the Dock.
const isMacSafari = () => !isIOS() && /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua)
  && +((ua.match(/Version\/(\d+)/) || [])[1] || 0) >= 17;
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canInstall = () => !isInstalled() && (!!deferred || isIOS() || isMacSafari());

function paint() {
  for (const b of buttons) {
    if (!b.isConnected) { buttons.delete(b); continue; }
    b.hidden = !canInstall();
  }
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; paint(); });
window.addEventListener('appinstalled', () => { deferred = null; paint(); toast('Sauna Conductor is installed. Open it from your home screen.', 6000); });

async function install() {
  if (deferred) {
    const d = deferred; deferred = null;
    d.prompt();
    try { await d.userChoice; } catch { /* dismissed */ }
    paint();
    return;
  }
  if (isIOS()) iosHelp();
  else if (isMacSafari()) macHelp();
}

const key = (t) => h('span', { class: 'ios-share', 'aria-hidden': 'true' }, t);

function helpDialog(title, steps, note) {
  const close = h('button', { class: 'small primary' }, 'Got it');
  const dlg = h('dialog', { class: 'ios-install', 'aria-label': title },
    h('img', { src: 'icons/icon-192.png', alt: '', width: 64, height: 64 }),
    h('h2', {}, title),
    h('ol', {}, ...steps.map((s) => h('li', {}, ...s))),
    note ? h('p', { class: 'muted small' }, note) : '',
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), close));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  close.addEventListener('click', () => dlg.close());
}

function iosHelp() {
  const b = (t) => h('b', {}, t);
  if (iosChrome()) {
    helpDialog('Add Sauna Conductor to your Home Screen', [
      ['Tap ', b('Share'), ' ', key('⬆︎'), ' next to the address bar (or under ', key('•••'), ').'],
      ['Tap ', b('Add to Home Screen'), ', then ', b('Add'), '.'],
    ], 'If you don’t see it, open this page in Safari and add it from there.');
    return;
  }
  helpDialog('Add Sauna Conductor to your Home Screen', [
    ['Tap ', key('•••'), ' next to Safari’s address bar. (Older iPhones: tap ', b('Share'), ' ', key('⬆︎'), ' in the toolbar and skip to step 3.)'],
    ['Tap ', b('Share'), '.'],
    ['Scroll down and tap ', b('Add to Home Screen'), '.'],
    ['Leave ', b('Open as Web App'), ' on and tap ', b('Add'), '.'],
  ], 'The names can differ a little with your phone’s language. In Instagram or Facebook, open this page in Safari first.');
}

function macHelp() {
  const b = (t) => h('b', {}, t);
  helpDialog('Add Sauna Conductor to your Dock', [
    ['In the menu bar, choose ', b('File'), ' → ', b('Add to Dock…'), ' (or click ', b('Share'), ' ', key('⬆︎'), ' → ', b('Add to Dock'), ').'],
    ['Click ', b('Add'), '. Sauna Conductor then opens in its own window from the Dock.'],
  ], 'Needs macOS Sonoma or later. In Chrome or Edge, use the install icon in the address bar instead.');
}

// An "Install app" button that only shows where installing is possible.
export function installButton(cls = '') {
  const b = h('button', { class: 'install-btn ' + cls, type: 'button', hidden: true },
    h('img', { src: 'icons/icon-32.png', alt: '', width: 18, height: 18 }), isIOS() ? 'Add to Home Screen' : isMacSafari() ? 'Add to Dock' : 'Install the app');
  b.addEventListener('click', install);
  buttons.add(b);
  b.hidden = !canInstall();
  return b;
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;   // not on the local test server
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
