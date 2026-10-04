// App-wide config, view router and a tiny event bus.
import { store } from './util.js';

export const VERSION = '3.1';

// Olafur's Spotify developer app ("Thora sauna conductor"). A Client ID is public, not a secret.
export const DEFAULT_CLIENT_ID = '346821c157414b1c8d0639c5d0cc9df8';

const DEFAULTS = {
  clientId: DEFAULT_CLIENT_ID,
  output: 'browser',      // 'browser' (this page plays) | 'connect' (Spotify app / speaker)
  deviceId: '', deviceName: '',
  fallbackVoice: false,   // read missing clips with the browser's voice
  speed: 1,               // rehearsal clock multiplier
  demo: false,            // run without Spotify
};
const v1 = store.get('cfg', {});
export const cfg = Object.assign({}, DEFAULTS, v1.clientId ? { clientId: v1.clientId } : {}, store.get('cfg2', {}));
if (!cfg.clientId) cfg.clientId = DEFAULT_CLIENT_ID;
export const saveCfg = () => store.set('cfg2', cfg);
export const legacyCfg = v1;

const views = {};
const handlers = {};

export const app = {
  current: null,
  register(name, view) { views[name] = view; },
  async show(name, arg) {
    const cur = app.current && views[app.current];
    if (cur && cur.leave && app.current !== name) {
      const ok = await cur.leave(name);
      if (ok === false) return false;
    }
    for (const [n, v] of Object.entries(views)) v.el.hidden = n !== name;
    app.current = name;
    if (views[name].enter) await views[name].enter(arg);
    app.emit('view', name);
    window.scrollTo(0, 0);
    return true;
  },
  on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
  emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};
