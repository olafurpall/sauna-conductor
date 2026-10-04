// Installing Sauna Conductor as an app (home-screen icon, full screen).
// Android and desktop Chrome/Edge offer a one-tap install; on iPhone and iPad, Safari only allows
// it through Share → Add to Home Screen, so the button shows those two steps instead.
import { h, toast } from './util.js?v=3.0-152b544c';

let deferred = null;
const buttons = new Set();
const ua = navigator.userAgent || '';
const isIOS = () => /iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canInstall = () => !isInstalled() && (!!deferred || isIOS());

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
}

function iosHelp() {
  const close = h('button', { class: 'small primary' }, 'Got it');
  const dlg = h('dialog', { class: 'ios-install', 'aria-label': 'Add to Home Screen' },
    h('img', { src: 'icons/icon-192.png', alt: '', width: 64, height: 64 }),
    h('h2', {}, 'Add Sauna Conductor to your Home Screen'),
    h('ol', {},
      h('li', {}, 'Tap the ', h('b', {}, 'Share'), ' button ', h('span', { class: 'ios-share', 'aria-hidden': 'true' }, '⬆︎'), ' in Safari’s toolbar.'),
      h('li', {}, 'Scroll down and tap ', h('b', {}, 'Add to Home Screen'), ', then ', h('b', {}, 'Add'), '.')),
    h('p', { class: 'muted small' }, 'Only Safari can do this on iPhone and iPad. In another app’s browser, open this page in Safari first.'),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), close));
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  close.addEventListener('click', () => dlg.close());
}

// An "Install app" button that only shows where installing is possible.
export function installButton(cls = '') {
  const b = h('button', { class: 'install-btn ' + cls, type: 'button', hidden: true },
    h('img', { src: 'icons/icon-32.png', alt: '', width: 18, height: 18 }), isIOS() ? 'Add to Home Screen' : 'Install the app');
  b.addEventListener('click', install);
  buttons.add(b);
  b.hidden = !canInstall();
  return b;
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;   // not on the local test server
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
