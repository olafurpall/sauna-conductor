// ElevenLabs: voices, voice library, models and text-to-speech.
// On the hosted site every call goes through the app's server function ("eleven"), which holds the
// key; signed-in people never need one. Without the cloud (the launcher version) the user's own key is used.
import { store, hash } from './util.js?v=3.1-c91bd7fc';
import { stripTokens } from './tokens.js?v=3.1-c91bd7fc';

const BASE = 'https://api.elevenlabs.io';

export const isV3 = (m) => /(^|_)v3(\b|_|$)/.test(m || '');
const snap3 = (v) => (v < 0.25 ? 0 : v < 0.75 ? 0.5 : 1);

export function voiceSettings(v) {
  if (isV3(v.modelId)) return { stability: snap3(v.stability ?? 0.5) };
  return {
    stability: v.stability ?? 0.5,
    similarity_boost: v.similarity ?? 0.75,
    style: v.style ?? 0,
    use_speaker_boost: true,
    speed: v.speed ?? 1,
  };
}

// Delivery tags like [softly] only work in Eleven v3; other models would read them aloud.
// Callout tokens like {callout-lets-start} are played from recordings, never read out.
export function prepText(text, modelId) {
  let t = stripTokens(String(text || '').replace(/\r/g, '')).trim();
  if (!isV3(modelId)) t = t.replace(/\[[^\]\n]{1,40}\]\s*/g, '');
  return t;
}

export const clipKey = (text, v) => hash(JSON.stringify([prepText(text, v.modelId), v.id, v.modelId, voiceSettings(v)]));

const SERVER_CODES = ['daily_limit', 'private_voice', 'no_key', 'not_signed_in', 'admin_only', 'not_allowed', 'too_long', 'empty'];
function niceError(status, code, msg, server) {
  if (server && SERVER_CODES.includes(code)) return msg;
  if (server && status === 401) return 'Sign in again to record narration.';
  if (status === 401 && !/permission/i.test(msg)) return server ? 'The ElevenLabs key on the server was not accepted. The admin needs to check it.' : 'ElevenLabs did not accept the API key. Check it in Settings.';
  if (code === 'quota_exceeded' || /quota/i.test(msg)) return 'Your ElevenLabs credits for this month are used up.';
  if (code === 'missing_permissions' || /permission/i.test(msg)) return `ElevenLabs: ${msg} (edit the key's permissions at elevenlabs.io → Developers → API keys).`;
  if (code === 'voice_not_found' || status === 404) return 'That voice is not in your ElevenLabs account. Pick it again from the voice library.';
  if (code === 'too_many_concurrent_requests' || status === 429) return 'ElevenLabs is busy. Wait a moment and try again.';
  return `ElevenLabs: ${msg}`;
}

const normVoice = (v) => ({
  id: v.voice_id, name: v.name, desc: v.description || (v.labels && v.labels.description) || '',
  labels: v.labels ? [v.labels.accent, v.labels.age, v.labels.gender, v.labels.descriptive || v.labels.use_case].filter(Boolean) : [],
  previewUrl: v.preview_url || '', category: v.category || '', mine: true,
});
const normShared = (v) => ({
  id: v.voice_id, publicOwnerId: v.public_owner_id, name: v.name, desc: v.description || '',
  labels: [v.accent, v.age, v.gender, v.descriptive, v.use_case].filter(Boolean).map((x) => String(x).replace(/_/g, ' ')),
  previewUrl: v.preview_url || '', category: v.category || '', library: true,
});

export const eleven = {
  _models: null, _voices: null,
  // Set by main.js on the hosted site: (method, path, body, signal) => Response from the server function.
  transport: null,
  ready: () => false,            // signed in, so the server function can be used
  admin: false,                  // the admin sees credits
  get server() { return !!this.transport; },
  get key() { return store.get('elkey', ''); },
  set key(v) { store.set('elkey', String(v || '').trim()); this._models = null; this._voices = null; },
  get hasKey() { return this.server ? this.ready() : !!this.key; },
  get missingMsg() { return this.server ? 'Sign in to record narration.' : 'Add your ElevenLabs API key in Settings first.'; },

  async req(path, { method = 'GET', body, blob = false, signal } = {}) {
    if (!this.hasKey) throw new Error(this.missingMsg);
    let r;
    try {
      r = this.server
        ? await this.transport(method, path, body, signal)
        : await fetch(BASE + path, {
          method, signal,
          headers: Object.assign({ 'xi-api-key': this.key }, body ? { 'Content-Type': 'application/json' } : {}, blob ? { Accept: 'audio/mpeg' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      const e = new Error('Could not reach ElevenLabs. Check the internet connection.'); e.network = true; throw e;
    }
    if (!r.ok) {
      let msg = String(r.status), code = '';
      try {
        const j = await r.json();
        const d = j.detail !== undefined ? j.detail : j;
        if (typeof d === 'string') msg = d;
        else if (d) { msg = d.message || JSON.stringify(d); code = d.status || d.code || ''; }
      } catch { /* no body */ }
      const e = new Error(niceError(r.status, code, msg, this.server)); e.status = r.status; e.code = code; throw e;
    }
    try { return blob ? new Blob([await r.arrayBuffer()], { type: 'audio/mpeg' }) : await r.json(); }
    catch (err) {
      if (err && err.name === 'AbortError') throw err;
      const e = new Error('The connection to ElevenLabs dropped. Try again.'); e.network = true; throw e;
    }
  },

  async subscription() { return this.req('/v1/user/subscription'); },

  async models() {
    if (this._models) return this._models;
    const j = await this.req('/v1/models');
    this._models = (j || []).filter((m) => m.can_do_text_to_speech !== false).map((m) => ({
      id: m.model_id, name: m.name, description: m.description || '',
      maxChars: m.max_characters_request_subscribed_user || m.max_characters_request_free_user || 5000,
    }));
    return this._models;
  },

  async myVoices(force = false) {
    if (this._voices && !force) return this._voices;
    const out = [];
    let token = '';
    for (let i = 0; i < 5; i++) {
      const j = await this.req('/v2/voices?page_size=100' + (token ? '&next_page_token=' + encodeURIComponent(token) : ''));
      out.push(...((j && j.voices) || []).map(normVoice));
      if (!j || !j.has_more || !j.next_page_token) break;
      token = j.next_page_token;
    }
    this._voices = out;
    return out;
  },

  async library(search = '', page = 0, language = 'en') {
    const q = new URLSearchParams({ page_size: '30', language: language || 'en', page: String(page) });
    if (search) q.set('search', search);
    const j = await this.req('/v1/shared-voices?' + q.toString());
    return { voices: ((j && j.voices) || []).map(normShared), more: !!(j && j.has_more) };
  },

  async addShared(v) {
    await this.req(`/v1/voices/add/${encodeURIComponent(v.publicOwnerId)}/${encodeURIComponent(v.id)}`, { method: 'POST', body: { new_name: v.name } });
    this._voices = null;
  },

  // Library voices must be in "My voices" before the API will speak with them.
  async ensureVoice(v) {
    const mine = await this.myVoices().catch(() => []);
    if (mine.some((x) => x.id === v.id)) return;
    let src = v.publicOwnerId ? v : null;
    if (!src) {
      const found = await this.library(v.name, 0, v.lang || 'en').catch(() => ({ voices: [] }));
      src = found.voices.find((x) => x.id === v.id) || null;
    }
    if (!src) return; // let TTS report the problem
    try { await this.addShared(src); } catch (e) { if (!/already/i.test(e.message)) throw e; }
  },

  async tts(text, v, signal) {
    const t = prepText(text, v.modelId);
    if (!t) throw new Error('This message is empty.');
    const body = { text: t, model_id: v.modelId, voice_settings: voiceSettings(v) };
    return this.req(`/v1/text-to-speech/${encodeURIComponent(v.id)}?output_format=mp3_44100_128`, { method: 'POST', body, blob: true, signal });
  },
};
