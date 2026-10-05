// Spotify: login (Authorization Code + PKCE), Web API, playback and library tools.
import { store, sleep, clamp, log, toast } from './util.js?v=3.2-3eb3c514';
import { cfg, app } from './app.js?v=3.2-3eb3c514';

export const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public',
  'user-library-read', 'user-top-read',
].join(' ');
const LIB_SCOPES = ['playlist-read-private', 'playlist-modify-private', 'user-library-read', 'user-top-read'];

export const LAUNCHER_URL = 'http://127.0.0.1:8888/';
export const redirectUri = () => (location.protocol === 'file:' ? LAUNCHER_URL : location.origin + location.pathname.replace(/index\.html$/, ''));

const saved = store.get('tok', null);
export const auth = {
  token: saved ? saved.a : null,
  refresh: saved ? saved.r : null,
  expires: saved ? saved.e || 0 : 0,
  scope: saved ? saved.s || '' : '',
  me: null,
  problem: '',   // e.g. the account isn't on the Spotify app's user list
  get connected() { return !!this.refresh; },
  get libraryOk() { const s = this.scope.split(/\s+/); return this.connected && LIB_SCOPES.every((x) => s.includes(x)); },
};

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login() {
  if (location.protocol === 'file:') { toast('Open the conductor with the launcher first. Spotify login does not work from a file.'); return; }
  if (!cfg.clientId) { toast('Paste your Spotify Client ID first.'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  store.set('pkce', { v: verifier, s: state });
  const q = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, scope: SCOPES, show_dialog: 'false',
    code_challenge_method: 'S256', code_challenge: challenge, redirect_uri: redirectUri(), state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q.toString();
}

function saveTokens(j) {
  auth.token = j.access_token;
  const renewed = j.refresh_token && j.refresh_token !== auth.refresh;
  if (j.refresh_token) auth.refresh = j.refresh_token;
  if (j.scope) auth.scope = j.scope;
  auth.expires = Date.now() + (j.expires_in || 3600) * 1000;
  store.set('tok', { a: auth.token, r: auth.refresh, e: auth.expires, s: auth.scope });
  if (renewed) { store.set('tokAt', Date.now()); app.emit('spotify-tokens', { r: auth.refresh, s: auth.scope }); }
}

// everywhere: also forget the login saved in your account (cloud sync).
export function logout(everywhere = false) {
  auth.token = auth.refresh = null; auth.expires = 0; auth.scope = ''; auth.me = null; auth.problem = '';
  store.del('tok');
  if (everywhere) { store.set('tokAt', Date.now()); app.emit('spotify-tokens', null); }
  player.shutdown();
  app.emit('spotify');
}

// A Spotify login saved in your account by another computer (cloud sync).
export function adoptLogin(sp) {
  if (!sp || !sp.r) return false;
  auth.refresh = sp.r; auth.scope = sp.s || auth.scope || ''; auth.token = null; auth.expires = 0;
  store.set('tok', { a: null, r: auth.refresh, e: 0, s: auth.scope });
  store.set('tokAt', sp.at || Date.now());
  app.emit('spotify');
  return true;
}

export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.has('sb') || (!q.has('code') && !q.has('error'))) return false;
  history.replaceState(null, '', redirectUri());
  if (q.get('error')) { toast('Spotify login was cancelled (' + q.get('error') + ').'); return false; }
  const pk = store.get('pkce', null);
  store.del('pkce');
  if (!pk || pk.s !== q.get('state')) { toast('Spotify login check failed. Press Connect again.'); return false; }
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), client_id: cfg.clientId, code_verifier: pk.v }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Spotify login failed: ' + (j.error_description || j.error || r.status));
  saveTokens(j);
  toast('Spotify connected.');
  return true;
}

let refreshing = null;
export async function getToken() {
  if (auth.token && Date.now() < auth.expires - 60000) return auth.token;
  if (!auth.refresh) throw new Error('Spotify is not connected.');
  if (!refreshing) {
    refreshing = (async () => {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: cfg.clientId }),
      });
      let j = await r.json().catch(() => ({}));
      if (!r.ok && j.error === 'invalid_grant' && app.spotifyRecover) {
        // Another computer may have renewed this login; use the one saved in your account.
        const alt = await app.spotifyRecover(auth.refresh);
        if (alt) {
          log('spotify-login-from-cloud');
          adoptLogin(alt);
          const r2 = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: cfg.clientId }),
          });
          j = await r2.json().catch(() => ({}));
          if (r2.ok) { saveTokens(j); return auth.token; }
        }
      }
      if (!r.ok) {
        if (j.error === 'invalid_grant') logout();
        throw new Error('Spotify session expired. Reconnect in Settings.');
      }
      saveTokens(j);
      return auth.token;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api(method, path, body, attempt = 0) {
  const t = await getToken();
  const url = path.startsWith('https://') ? path : 'https://api.spotify.com/v1' + path;
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && attempt === 0) { auth.expires = 0; return api(method, path, body, 1); }
  if (r.status === 429 && attempt < 2) {
    const wait = Math.min(10, +(r.headers.get('Retry-After') || 2));
    await sleep(wait * 1000);
    return api(method, path, body, attempt + 1);
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { /* no body */ }
    if (r.status === 403 && /scope/i.test(msg)) msg = 'Reconnect Spotify in Settings to allow playlist access';
    else if (r.status === 403 && /regist|developer\.spotify|dashboard/i.test(msg)) msg = 'this Spotify account is not on Sauna Conductor\u2019s user list yet. Ask Ólafur to add the email address you log in to Spotify with';
    const e = new Error(`Spotify: ${msg}`); e.status = r.status; throw e;
  }
  const txt = await r.text();
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function allPages(path, cap = 2000, onPage) {
  const out = [];
  let next = path;
  while (next && out.length < cap) {
    const j = await api('GET', next);
    if (!j) break;
    out.push(...(j.items || []));
    if (onPage) onPage(out.length, j.total);
    next = j.next;
  }
  return out.slice(0, cap);
}

export function parseUri(link) {
  if (!link) return null;
  const m = String(link).trim().match(/(playlist|album)[/:]([A-Za-z0-9]{22})/);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
}
export const idOf = (uri) => String(uri || '').split(':').pop();
export const openUrl = (uri) => { const p = String(uri || '').split(':'); return p.length === 3 ? `https://open.spotify.com/${p[1]}/${p[2]}` : '#'; };

// ---------------------------------------------------------------- library
export async function getMe() {
  if (!auth.me) auth.me = await api('GET', '/me');
  return auth.me;
}

const pickImg = (imgs, small) => {
  if (!imgs || !imgs.length) return '';
  const sorted = [...imgs].sort((a, b) => (a.width || 300) - (b.width || 300));
  return (small ? sorted[0] : sorted.find((i) => (i.width || 300) >= 250) || sorted[sorted.length - 1]).url;
};

export function normTrack(t) {
  if (!t || !t.uri || (t.type && t.type !== 'track')) return null;
  return {
    uri: t.uri, name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album ? t.album.name : '',
    year: t.album && t.album.release_date ? t.album.release_date.slice(0, 4) : '',
    image: pickImg(t.album && t.album.images, false),
    imageSm: pickImg(t.album && t.album.images, true),
    durationMs: t.duration_ms || 0,
  };
}

function normPlaylist(p, meId) {
  const tr = p.items || p.tracks || {};
  return {
    id: p.id, uri: p.uri, name: p.name, description: p.description || '',
    image: pickImg(p.images, true),
    total: tr.total ?? null,
    ownerId: p.owner ? p.owner.id : '', ownerName: p.owner ? p.owner.display_name || p.owner.id : '',
    mine: !!(p.owner && p.owner.id === meId) || !!p.collaborative,
  };
}

let playlistCache = null;
export async function myPlaylists(force = false) {
  if (playlistCache && !force) return playlistCache;
  const me = await getMe();
  const items = await allPages('/me/playlists?limit=50', 1000);
  playlistCache = items.filter(Boolean).map((p) => normPlaylist(p, me.id));
  return playlistCache;
}

export async function playlistTracks(id, cap = 1000) {
  const items = await allPages(`/playlists/${id}/items?limit=50`, cap);
  return items.map((it) => normTrack(it.item || it.track)).filter(Boolean);
}

// Songs of a playlist or album, for planning rounds.
export async function sourceTracks(uri) {
  const id = idOf(uri);
  if (String(uri).startsWith('spotify:album:')) {
    const a = await api('GET', `/albums/${id}`);
    const img = pickImg(a.images, true);
    const items = await allPages(`/albums/${id}/tracks?limit=50`, 500);
    return items.map((t) => { const n = normTrack(t); if (n && !n.imageSm) n.imageSm = img; return n; }).filter(Boolean);
  }
  try { return await playlistTracks(id, 1500); }
  catch (e) {
    if (e.status === 403 || e.status === 404) {
      const err = new Error('Spotify only lets the conductor read playlists you own or collaborate on. In Spotify, add these songs to a playlist of your own (or ask the owner to make you a collaborator), then pick that one.');
      err.status = e.status; throw err;
    }
    throw e;
  }
}

export async function playlistInfo(uri) {
  const id = idOf(uri);
  if (String(uri).startsWith('spotify:album:')) {
    const a = await api('GET', `/albums/${id}`);
    return { uri, name: a.name, image: pickImg(a.images, true), total: a.total_tracks ?? null, ownerName: (a.artists || []).map((x) => x.name).join(', ') };
  }
  const cached = (playlistCache || []).find((p) => p.uri === uri);
  if (cached) return cached;
  const me = await getMe().catch(() => ({ id: '' }));
  return normPlaylist(await api('GET', `/playlists/${id}`), me.id);
}

export async function exportLibrary(onProgress = () => {}) {
  const me = await getMe();
  onProgress('Reading your playlists…');
  const lists = await myPlaylists(true);
  const compact = (t) => ({ name: t.name, artists: t.artists, album: t.album, year: t.year, duration_s: Math.round(t.durationMs / 1000), uri: t.uri });
  const playlists = [];
  let i = 0;
  for (const p of lists) {
    i++;
    const entry = { name: p.name, uri: p.uri, owner: p.ownerName, mine: p.mine, total: p.total, description: p.description };
    if (p.mine) {
      onProgress(`Reading playlist ${i} of ${lists.length}: ${p.name}`);
      try { entry.tracks = (await playlistTracks(p.id, 500)).map(compact); } catch (e) { entry.error = e.message; }
    }
    playlists.push(entry);
  }
  onProgress('Reading your liked songs…');
  let liked = [];
  try {
    const items = await allPages('/me/tracks?limit=50', 3000, (n, total) => onProgress(`Reading liked songs… ${n}${total ? ' of ' + Math.min(total, 3000) : ''}`));
    liked = items.map((it) => normTrack(it.track || it.item)).filter(Boolean).map(compact);
  } catch (e) { log('liked failed', e.message); }
  onProgress('Reading your top tracks and artists…');
  const top = {};
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    try {
      const j = await api('GET', `/me/top/tracks?limit=50&time_range=${range}`);
      top['tracks_' + range] = (j.items || []).map(normTrack).filter(Boolean).map(compact);
    } catch { /* not available */ }
  }
  try {
    const j = await api('GET', '/me/top/artists?limit=50&time_range=medium_term');
    top.artists_medium_term = (j.items || []).map((a) => ({ name: a.name, genres: a.genres || [], uri: a.uri }));
  } catch { /* not available */ }
  return {
    format: 'sauna-conductor-spotify-library', version: 1, exported_at: new Date().toISOString(),
    user: { display_name: me.display_name || '', country: me.country || '' },
    playlists, liked_songs: liked, top,
  };
}

// Plan format (from Claude): { playlists: [ { name, description, uris: [...] } ] }
export async function importPlan(plan, onProgress = () => {}) {
  const lists = (plan && (plan.playlists || (Array.isArray(plan) ? plan : null))) || [];
  if (!lists.length) throw new Error('That file has no playlists in it.');
  const made = [];
  for (const [i, p] of lists.entries()) {
    const uris = (p.uris || (p.tracks || []).map((t) => (typeof t === 'string' ? t : t.uri)))
      .filter((u) => /^spotify:(track|episode):[A-Za-z0-9]{22}$/.test(u || ''));
    if (!uris.length) continue;
    onProgress(`Creating “${p.name}” (${i + 1} of ${lists.length})…`);
    const pl = await api('POST', '/me/playlists', { name: p.name || `Sauna playlist ${i + 1}`, description: p.description || 'Made with Sauna Conductor', public: false });
    for (let k = 0; k < uris.length; k += 100) await api('POST', `/playlists/${pl.id}/items`, { uris: uris.slice(k, k + 100) });
    made.push({ name: pl.name, uri: pl.uri, count: uris.length });
  }
  playlistCache = null;
  return made;
}

// Search the whole Spotify catalogue for songs. Development-mode apps get at most 10 results per page.
export async function searchTracks(q, offset = 0) {
  const j = await api('GET', `/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(q)}`);
  const tr = (j && j.tracks) || {};
  return { items: (tr.items || []).map(normTrack).filter(Boolean), more: !!tr.next, offset: offset + (tr.items || []).length };
}

export async function listDevices() {
  const j = await api('GET', '/me/player/devices');
  return (j && j.devices) || [];
}

// ---------------------------------------------------------------- playback
// One interface over two ways of playing:
//  - 'browser': this page is the speaker (Spotify Web Playback SDK)
//  - 'connect': remote-control a Spotify app or speaker (Spotify Connect)
export const player = {
  sdk: null, sdkDevice: null, sdkReady: false,
  current: null, pos: 0, posAt: 0, paused: true, contextUri: null,
  sdkNext: [], queue: [], queueFor: null,
  level: 0, volInflight: false, volPending: null, volSent: null,
  timer: null,

  get mode() { return cfg.output === 'connect' ? 'connect' : 'browser'; },
  get deviceId() { return this.mode === 'browser' ? this.sdkDevice : cfg.deviceId; },
  get ready() { return auth.connected && (this.mode === 'browser' ? this.sdkReady : !!cfg.deviceId); },
  position() { return this.paused ? this.pos : this.pos + (performance.now() - this.posAt); },
  nextUri() { return (this.queue[0] && this.queue[0].uri) || (this.sdkNext[0] && this.sdkNext[0].uri) || null; },

  start() {
    if (!auth.connected) return;
    if (this.mode === 'browser') this.loadSdk();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), this.mode === 'browser' ? 1000 : 1500);
    getMe().then((me) => {
      auth.problem = '';
      app.emit('spotify');
      if (me && me.product && me.product !== 'premium') toast('This Spotify account is not Premium, so playback will not work.', 8000);
    }).catch((e) => {
      if (e.status !== 403) return;
      auth.problem = e.message.replace(/^Spotify: /, '');
      toast('Spotify: ' + auth.problem + '.', 15000);
      app.emit('spotify');
    });
  },

  restart() { this.shutdown(); this.start(); app.emit('spotify'); },

  shutdown() {
    clearInterval(this.timer); this.timer = null;
    if (this.sdk) { try { this.sdk.disconnect(); } catch { /* ignore */ } }
    this.sdk = null; this.sdkReady = false; this.sdkDevice = null;
    const s = document.getElementById('sp-sdk'); if (s) s.remove();
  },

  loadSdk() {
    if (this.sdk) return;
    if (window.Spotify && window.Spotify.Player) { this.initSdk(); return; }
    window.onSpotifyWebPlaybackSDKReady = () => this.initSdk();
    if (document.getElementById('sp-sdk')) return;
    const s = document.createElement('script');
    s.id = 'sp-sdk'; s.src = 'https://sdk.scdn.co/spotify-player.js'; s.async = true;
    s.onerror = () => toast('Could not load the Spotify player. Check the internet connection.');
    document.head.appendChild(s);
  },

  initSdk() {
    if (this.sdk || this.mode !== 'browser') return;
    const p = new window.Spotify.Player({
      name: 'Sauna Conductor',
      getOAuthToken: (cb) => { getToken().then(cb).catch((e) => toast(e.message)); },
      volume: this.level,
    });
    this.sdk = p;
    p.addListener('ready', ({ device_id }) => { this.sdkDevice = device_id; this.sdkReady = true; log('sdk ready', device_id); app.emit('spotify'); });
    p.addListener('not_ready', () => { this.sdkReady = false; app.emit('spotify'); toast('Spotify player went offline. Reconnecting…'); });
    p.addListener('initialization_error', ({ message }) => toast('This browser cannot play Spotify (' + message + '). Use Chrome on a computer.', 8000));
    p.addListener('authentication_error', () => { this.sdkReady = false; toast('Spotify login expired. Reconnect in Settings.', 8000); app.emit('spotify'); });
    p.addListener('account_error', () => toast('Spotify Premium is required to play music here.', 8000));
    p.addListener('playback_error', ({ message }) => log('playback_error', message));
    p.addListener('player_state_changed', (s) => this.fromSdk(s));
    p.connect().then((ok) => { if (!ok) toast('Could not start the Spotify player.'); });
  },

  setTrack(t) {
    const changed = (t && t.uri) !== (this.current && this.current.uri);
    this.current = t;
    if (changed) { this.queueFor = null; if (t) log('track', t.name, '—', t.artists); app.emit('track', t); this.refreshQueue(); }
  },

  fromSdk(s) {
    if (!s) return;
    const tw = s.track_window || {};
    this.paused = !!s.paused;
    this.stateContext = (s.context && s.context.uri) || null;
    this.pos = s.position || 0; this.posAt = performance.now();
    this.sdkNext = (tw.next_tracks || []).map(normTrack).filter(Boolean);
    const t = normTrack(tw.current_track);
    if (t && !t.durationMs) t.durationMs = s.duration || 0;
    this.setTrack(t);
    app.emit('playback');
  },

  async poll() {
    try {
      if (this.mode === 'browser') {
        if (!this.sdk || !this.sdkReady) return;
        const s = await this.sdk.getCurrentState();
        if (s) this.fromSdk(s);
        return;
      }
      if (!cfg.deviceId) return;
      const j = await api('GET', '/me/player');
      if (!j) { this.paused = true; app.emit('playback'); return; }
      this.paused = !j.is_playing;
      this.stateContext = (j.context && j.context.uri) || null;
      this.pos = j.progress_ms || 0; this.posAt = performance.now();
      this.setTrack(normTrack(j.item));
      app.emit('playback');
    } catch (e) { log('poll', e.message); }
  },

  async refreshQueue() {
    if (!this.ready || cfg.demo) return;
    try {
      const j = await api('GET', '/me/player/queue');
      this.queue = ((j && j.queue) || []).map(normTrack).filter(Boolean).slice(0, 12);
      this.queueFor = this.current && this.current.uri;
      app.emit('queue');
    } catch (e) { log('queue', e.message); }
  },

  q() { return '?device_id=' + encodeURIComponent(this.deviceId || ''); },

  // Forget the old "up next" list straight away; Spotify's queue lags behind a switch.
  freshQueue() {
    this.queue = []; this.sdkNext = []; this.queueFor = null;
    app.emit('queue');
    [1500, 4000, 9000].forEach((ms) => setTimeout(() => this.refreshQueue(), ms));
  },

  // Wait until the playing song satisfies `match` (polling Spotify). Returns true/false.
  async waitForTrack(match, timeoutMs = 5000) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      await this.poll();
      if (this.current && match(this.current, this.stateContext)) return true;
      await sleep(350);
    }
    return false;
  },

  async playContext(uri, offsetUri, shuffle = false, positionMs = 0) {
    const body = { context_uri: uri };
    if (offsetUri) body.offset = { uri: offsetUri };
    if (positionMs > 0) body.position_ms = Math.round(positionMs);
    const go = () => api('PUT', '/me/player/play' + this.q(), body);
    try { await go(); }
    catch (e) {
      if (offsetUri && e.status !== 404) { delete body.offset; await go(); }
      else if (e.status === 404 && this.mode === 'connect') {
        await api('PUT', '/me/player', { device_ids: [cfg.deviceId], play: false });
        await sleep(600);
        await go();
      } else throw e;
    }
    this.contextUri = uri; this.uris = null; this.paused = false;
    log('play', uri, offsetUri || '-', positionMs ? '@' + Math.round(positionMs / 1000) + 's' : '');
    api('PUT', '/me/player/repeat' + this.q() + '&state=context').catch(() => {});
    api('PUT', '/me/player/shuffle' + this.q() + '&state=' + (shuffle ? 'true' : 'false')).catch(() => {});
    this.freshQueue();
  },

  async pause() {
    this.paused = true;
    if (this.mode === 'browser') { if (this.sdk) await this.sdk.pause().catch(() => {}); }
    else await api('PUT', '/me/player/pause' + this.q()).catch(() => {});
    app.emit('playback');
  },
  async resume() {
    this.paused = false;
    if (this.mode === 'browser') { if (this.sdk) await this.sdk.resume().catch(() => {}); }
    else await api('PUT', '/me/player/play' + this.q()).catch(() => {});
    app.emit('playback');
  },
  async next() {
    if (this.mode === 'browser' && this.sdk) await this.sdk.nextTrack().catch(() => {});
    else await api('POST', '/me/player/next' + this.q()).catch((e) => toast(e.message));
    setTimeout(() => this.poll(), 500);
  },
  async previous() {
    if (this.mode === 'browser' && this.sdk) await this.sdk.previousTrack().catch(() => {});
    else await api('POST', '/me/player/previous' + this.q()).catch((e) => toast(e.message));
    setTimeout(() => this.poll(), 500);
  },
  // Play an exact list of songs (a planned round).
  async playUris(uris, offsetUri, positionMs = 0) {
    const body = { uris };
    if (offsetUri) body.offset = { uri: offsetUri };
    if (positionMs > 0) body.position_ms = Math.round(positionMs);
    const go = () => api('PUT', '/me/player/play' + this.q(), body);
    try { await go(); }
    catch (e) {
      if (e.status === 404 && this.mode === 'connect') {
        await api('PUT', '/me/player', { device_ids: [cfg.deviceId], play: false });
        await sleep(600);
        await go();
      } else throw e;
    }
    this.uris = uris.slice();
    this.contextUri = 'uris:' + uris.length + ':' + (uris[0] || '');
    this.paused = false;
    log('play-uris', uris.length, offsetUri || '-', positionMs ? '@' + Math.round(positionMs / 1000) + 's' : '');
    api('PUT', '/me/player/repeat' + this.q() + '&state=off').catch(() => {});
    api('PUT', '/me/player/shuffle' + this.q() + '&state=false').catch(() => {});
    this.freshQueue();
  },
  async seek(ms) {
    ms = Math.max(0, Math.round(ms));
    if (this.mode === 'browser' && this.sdk) await this.sdk.seek(ms).catch(() => {});
    else await api('PUT', '/me/player/seek' + this.q() + '&position_ms=' + ms).catch((e) => log('seek', e.message));
    this.pos = ms; this.posAt = performance.now();
    app.emit('playback');
  },
  async jumpTo(trackUri) {
    if (this.contextUri && this.contextUri.startsWith('uris:') && this.uris) {
      if (this.uris.includes(trackUri)) { await this.playUris(this.uris, trackUri); return; }
    }
    if (!this.contextUri) return;
    await this.playContext(this.contextUri, trackUri);
  },

  // Volume 0..1. Browser: instant. Connect: throttled Web API calls, last value always lands.
  async setVolume(v) {
    v = clamp(v, 0, 1);
    this.level = v;
    if (this.mode === 'browser') { if (this.sdk && this.sdkReady) await this.sdk.setVolume(v).catch(() => {}); return; }
    if (!cfg.deviceId) return;
    const pct = Math.round(v * 100);
    if (this.volInflight) { this.volPending = pct; return; }
    if (pct === this.volSent) return;
    this.volInflight = true;
    try {
      await api('PUT', `/me/player/volume?volume_percent=${pct}&device_id=${encodeURIComponent(cfg.deviceId)}`);
      this.volSent = pct;
      await sleep(180);
    } catch (e) { log('vol', e.message); }
    this.volInflight = false;
    if (this.volPending != null && this.volPending !== this.volSent) {
      const p = this.volPending; this.volPending = null;
      this.setVolume(p / 100);
    }
  },
};
