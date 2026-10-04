// Sauna Conductor: writes narration with Claude (Supabase Edge Function "write").
// The host describes their session in their own words; Claude writes every phase message and,
// if asked, a short check-in at the start of each song with the time left in the round.
// The texts come back as suggestions: the host reviews and edits them before anything is recorded.
//
// The browser sends: POST { lang, langName, prompt, tags, session: { name, host, rounds, breakMin },
//   cues: [{ id, title, when }], checkins: [{ id, round, song, title, artists, leftMin }] }
// with its Supabase session in "Authorization: Bearer <access token>".
//
// Setup: deploy with "Verify JWT" turned OFF (this code checks the user itself).
// The key is read from the ANTHROPIC_API_KEY secret, or from app_secrets (name 'anthropic').
// Optional secrets: WRITER_MODEL (default claude-opus-5-5), AI_DAILY_CALLS (default 20).

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
const serviceHeaders = (k: Keys): Record<string, string> => (k.service.startsWith('sb_') ? { apikey: k.service } : { apikey: k.service, Authorization: 'Bearer ' + k.service });

async function getUser(req: Request, k: Keys, f: Fetch) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const r = await f(`${k.url}/auth/v1/user`, { headers: { apikey: k.anon || k.service, Authorization: 'Bearer ' + m[1] } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? (u as { id: string }) : null;
}
const rest = (k: Keys, f: Fetch, path: string, init: RequestInit = {}) =>
  f(`${k.url}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders(k), 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) || {}) } });
async function isAdmin(k: Keys, f: Fetch, uid: string) {
  const r = await rest(k, f, `app_admins?select=user_id&user_id=eq.${encodeURIComponent(uid)}`);
  return r.ok && ((await r.json()) as unknown[]).length > 0;
}
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

type Cue = { id: string; title: string; when: string };
type Slot = { id: string; round: number; song: number; title: string; artists: string; leftMin: number };
type Round = { n: number; label: string; minutes: number; songs?: { title: string; artists: string; minutes: number }[] };
type Ask = {
  lang?: string; langName?: string; prompt?: string; tags?: boolean;
  session?: { name?: string; host?: string; rounds?: Round[]; breakMin?: number };
  cues?: Cue[]; checkins?: Slot[];
};

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

export function buildPrompt(a: Ask) {
  const langName = clip(a.langName || 'English', 40);
  const icelandic = (a.lang || '').startsWith('is');
  const system = [
    'You write the spoken narration for Sauna Conductor, an app that runs guided sauna sessions: rounds in the heat with music, short cool-down breaks outside the sauna in between, and a narrator who speaks at set moments.',
    'A text-to-speech voice reads every word you write, so write for the ear:',
    `- Write in ${langName} only, natural and idiomatic, the way a warm native speaker would say it out loud.` +
      (icelandic ? ' Use correct Icelandic grammar, declension and gender agreement, and natural Icelandic phrasing; avoid anglicisms and literal translations.' : ''),
    '- Spell out numbers and times in words (for example "fifteen minutes"), never digits or abbreviations.',
    '- Short, clear sentences. Use "..." for a breath or a pause. No emojis, lists, headings, quotation marks around the whole text, or stage directions in parentheses.',
    a.tags
      ? '- You may add an occasional delivery cue in square brackets, in English, such as [softly], [warmly], [whispers] or [laughs]: at most one or two per message.'
      : '- Do not use square-bracket cues.',
    '- Follow the host\'s description: their tone, the length they ask for, their audience and any names they give. When they ask for short messages, keep each one to one to three sentences.',
    '- Sauna safety matters. In the welcome and the cool-downs, gently remind people to drink water and to step out whenever they need to. Never encourage anyone to push through discomfort.',
    '- Do not state facts about particular songs or artists unless the host gave them.',
    '- Each message must fit the exact moment it plays (described with each message). The first round\'s message is the welcome to the whole session; the closing message ends it.',
    '- Check-ins (if any are listed) play over the music at the start of a song. Each is one short sentence of at most fifteen words, saying roughly how many minutes are left in the current round, in words, and maybe a brief encouragement. Vary the wording from one check-in to the next.',
    'Return every message listed, using its id, and one check-in for every check-in slot listed, using its id.',
  ].join('\n');

  const s = a.session || {};
  const lines: string[] = [];
  lines.push(`Session: ${clip(s.name, 80) || 'untitled'}${s.host ? ` · host: ${clip(s.host, 60)}` : ''}`);
  for (const r of (s.rounds || []).slice(0, 12)) {
    lines.push(`${clip(r.label, 30)}: about ${Math.round(r.minutes)} minutes` + (r.songs && r.songs.length ? ` · songs: ${r.songs.slice(0, 40).map((x) => `${clip(x.title, 60)} (${clip(x.artists, 60)}, ${Math.round(x.minutes)} min)`).join('; ')}` : ''));
  }
  if (s.breakMin) lines.push(`Cool-down breaks between rounds: ${Math.round(s.breakMin)} minutes each.`);
  const cues = (a.cues || []).slice(0, 20);
  const slots = (a.checkins || []).slice(0, 200);
  const user = [
    'The host describes the session:',
    '"""', clip(a.prompt, 3000) || '(no description: write warm, calm narration of medium length)', '"""',
    '',
    'The session:', ...lines,
    '',
    'Messages to write (id: when it plays):',
    ...cues.map((c) => `- ${clip(c.id, 20)}: ${clip(c.title, 40)}, ${clip(c.when, 120)}`),
    '',
    slots.length ? 'Check-in slots (id: round, song, minutes left in the round when the song starts):' : 'No check-ins.',
    ...slots.map((x) => `- ${clip(x.id, 20)}: round ${x.round}, "${clip(x.title, 60)}" by ${clip(x.artists, 60)}, ${Math.round(x.leftMin)} minutes left`),
  ].join('\n');
  return { system, user };
}

const SCHEMA = {
  type: 'object',
  properties: {
    messages: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } },
    checkins: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } },
  },
  required: ['messages', 'checkins'],
  additionalProperties: false,
};

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const k = keys(env);
  const user = await getUser(req, k, f);
  if (!user) return fail(401, 'not_signed_in', 'Sign in to write narration.');
  let a: Ask;
  try { a = await req.json(); } catch { return fail(400, 'bad_request', 'Bad request.'); }
  if (!Array.isArray(a.cues) || !a.cues.length) return fail(400, 'bad_request', 'No messages to write.');

  const key = await secret(k, f, env, 'anthropic', 'ANTHROPIC_API_KEY');
  if (!key) return fail(503, 'no_key', 'The AI writer is not set up yet: the server has no Anthropic API key.');
  const admin = await isAdmin(k, f, user.id);
  const cap = admin ? 0 : Number(env.AI_DAILY_CALLS || 20);
  if (!(await bump(k, f, user.id, 'write', 1, cap))) return fail(429, 'daily_limit', `You've written narration ${cap} times today. Try again tomorrow.`);

  const { system, user: content } = buildPrompt(a);
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.WRITER_MODEL || 'claude-opus-5-5',
      max_tokens: 12000,
      system,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    }),
  });
  if (!r.ok) {
    await bump(k, f, user.id, 'write', -1, 0).catch(() => {});
    let msg = String(r.status);
    try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* no body */ }
    return fail(502, 'ai_error', 'The AI writer had a problem: ' + msg);
  }
  const out = await r.json();
  const text = ((out.content || []).find((c: { type: string }) => c.type === 'text') || {}).text || '';
  let parsed: { messages?: { id: string; text: string }[]; checkins?: { id: string; text: string }[] };
  try { parsed = JSON.parse(text); } catch { return fail(502, 'ai_error', 'The AI writer sent back something unreadable. Try again.'); }
  const want = new Set((a.cues || []).map((c) => c.id));
  const slots = new Set((a.checkins || []).map((c) => c.id));
  const messages: Record<string, string> = {};
  for (const m of parsed.messages || []) if (want.has(m.id) && String(m.text || '').trim()) messages[m.id] = String(m.text).trim();
  const checkins: Record<string, string> = {};
  for (const m of parsed.checkins || []) if (slots.has(m.id) && String(m.text || '').trim()) checkins[m.id] = String(m.text).trim();
  return json({ messages, checkins, model: out.model || '', stop: out.stop_reason || '' });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && D.serve) D.serve((req: Request) => handle(req, D.env.toObject()));
