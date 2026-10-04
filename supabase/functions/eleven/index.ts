// Sauna Conductor: ElevenLabs through the server (Supabase Edge Function "eleven").
// Every signed-in person records narration with the app's ElevenLabs account, but the key never
// reaches a browser. Only the calls the app needs are let through, with a daily limit per person.
//
// The browser sends: POST { method: 'GET' | 'POST', path: '/v1/…', body?: {…} }
// with its Supabase session in "Authorization: Bearer <access token>".
//
// Setup: deploy with "Verify JWT" turned OFF (this code checks the user itself, which also works
// with the new Supabase API keys). The key is read from the ELEVENLABS_API_KEY secret, or from the
// app_secrets table (name 'elevenlabs'). Optional secrets: TTS_DAILY_CHARS (default 25000),
// VOICE_ADDS_DAILY (default 10).

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json({ detail: { status: code, message } }, status);

function keys(env: Env) {
  let service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  let anon = env.SUPABASE_ANON_KEY || '';
  try { if (!service && env.SUPABASE_SECRET_KEYS) service = String(Object.values(JSON.parse(env.SUPABASE_SECRET_KEYS))[0] || ''); } catch { /* ignore */ }
  try { if (!anon && env.SUPABASE_PUBLISHABLE_KEYS) anon = String(Object.values(JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS))[0] || ''); } catch { /* ignore */ }
  return { url: String(env.SUPABASE_URL || '').replace(/\/$/, ''), service, anon };
}
type Keys = ReturnType<typeof keys>;
// New-style keys (sb_…) go only in the apikey header; legacy JWT keys also as the bearer.
const serviceHeaders = (k: Keys): Record<string, string> => (k.service.startsWith('sb_') ? { apikey: k.service } : { apikey: k.service, Authorization: 'Bearer ' + k.service });

async function getUser(req: Request, k: Keys, f: Fetch) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const r = await f(`${k.url}/auth/v1/user`, { headers: { apikey: k.anon || k.service, Authorization: 'Bearer ' + m[1] } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? (u as { id: string; email?: string }) : null;
}

const rest = (k: Keys, f: Fetch, path: string, init: RequestInit = {}) =>
  f(`${k.url}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders(k), 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) || {}) } });

async function isAdmin(k: Keys, f: Fetch, uid: string) {
  const r = await rest(k, f, `app_admins?select=user_id&user_id=eq.${encodeURIComponent(uid)}`);
  return r.ok && ((await r.json()) as unknown[]).length > 0;
}

// Adds n to today's usage; false (and nothing added) when that would pass the cap. cap 0 = no limit.
async function bump(k: Keys, f: Fetch, uid: string, what: string, n: number, cap: number) {
  const r = await rest(k, f, 'rpc/bump_usage', { method: 'POST', body: JSON.stringify({ uid, what, n, cap }) });
  if (!r.ok) throw new Error('usage check failed: ' + r.status);
  return (await r.json()) === true;
}

async function secret(k: Keys, f: Fetch, env: Env, name: string, envName: string) {
  if (env[envName]) return String(env[envName]);
  const r = await rest(k, f, `app_secrets?select=value&name=eq.${encodeURIComponent(name)}`);
  const rows = r.ok ? ((await r.json()) as { value: string }[]) : [];
  return (rows[0] && rows[0].value) || '';
}

// Voices someone else may use: stock voices and voices copied from the ElevenLabs library.
// Voices the account owner made or cloned themselves (is_owner) stay theirs alone.
const isPublicVoice = (v: { is_owner?: boolean; category?: string }) => v && v.is_owner !== true && v.category !== 'cloned';
const voiceCache = new Map<string, boolean>();

const ALLOW: [string, RegExp, string][] = [
  ['GET', /^\/v1\/models$/, 'read'],
  ['GET', /^\/v2\/voices(\?[\w=&%.\-]*)?$/, 'voices'],
  ['GET', /^\/v1\/shared-voices(\?[\w=&%.+\-]*)?$/, 'read'],
  ['GET', /^\/v1\/user\/subscription$/, 'admin'],
  ['POST', /^\/v1\/voices\/add\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/, 'add'],
  ['POST', /^\/v1\/text-to-speech\/[A-Za-z0-9_-]+(\?output_format=[a-z0-9_]+)?$/, 'tts'],
];

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const k = keys(env);
  const user = await getUser(req, k, f);
  if (!user) return fail(401, 'not_signed_in', 'Sign in to record narration.');

  let body: { method?: string; path?: string; body?: Record<string, unknown> };
  try { body = await req.json(); } catch { return fail(400, 'bad_request', 'Bad request.'); }
  const method = String(body.method || 'GET').toUpperCase();
  const path = String(body.path || '');
  const rule = ALLOW.find(([m, re]) => m === method && re.test(path));
  if (!rule) return fail(403, 'not_allowed', 'That ElevenLabs call is not allowed.');
  const kind = rule[2];
  const admin = await isAdmin(k, f, user.id);
  if (kind === 'admin' && !admin) return fail(403, 'admin_only', 'Only the admin can see this.');

  const key = await secret(k, f, env, 'elevenlabs', 'ELEVENLABS_API_KEY');
  if (!key) return fail(503, 'no_key', 'Narration is not set up yet: the server has no ElevenLabs key.');
  const el = (p: string, init: RequestInit = {}) => f('https://api.elevenlabs.io' + p, { ...init, headers: { 'xi-api-key': key, ...((init.headers as Record<string, string>) || {}) } });

  let charged = 0;
  if (kind === 'tts') {
    const text = String((body.body && body.body.text) || '');
    if (!text.trim()) return fail(400, 'empty', 'This message is empty.');
    if (text.length > 10000) return fail(400, 'too_long', 'This message is too long.');
    const voiceId = path.split('/')[3].split('?')[0];
    if (!admin) {
      let ok = voiceCache.get(voiceId);
      if (ok === undefined) {
        const r = await el(`/v1/voices/${voiceId}`);
        if (r.ok) { ok = isPublicVoice(await r.json()); voiceCache.set(voiceId, ok); }
      }
      if (ok === false) return fail(403, 'private_voice', 'That voice is private. Pick a voice from the voice library.');
    }
    const cap = admin ? 0 : Number(env.TTS_DAILY_CHARS || 25000);
    if (!(await bump(k, f, user.id, 'tts', text.length, cap))) {
      return fail(429, 'daily_limit', `You've used today's narration allowance (${cap.toLocaleString('en')} characters). It starts again tomorrow.`);
    }
    charged = text.length;
  }
  if (kind === 'add' && !admin) {
    const cap = Number(env.VOICE_ADDS_DAILY || 10);
    if (!(await bump(k, f, user.id, 'voice_add', 1, cap))) return fail(429, 'daily_limit', 'You have added enough voices for today. Try again tomorrow.');
  }

  const r = await el(path, {
    method,
    headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(kind === 'tts' ? { Accept: 'audio/mpeg' } : {}) },
    body: method === 'POST' ? JSON.stringify(body.body || {}) : undefined,
  });
  if (!r.ok && charged) await bump(k, f, user.id, 'tts', -charged, 0).catch(() => {});   // don't count failed recordings

  if (kind === 'voices' && r.ok && !admin) {
    const j = await r.json();
    j.voices = (j.voices || []).filter(isPublicVoice);
    return json(j);
  }
  return new Response(r.body, { status: r.status, headers: { ...CORS, 'Content-Type': r.headers.get('Content-Type') || 'application/json' } });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && D.serve) D.serve((req: Request) => handle(req, D.env.toObject()));
