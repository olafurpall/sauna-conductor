// Sauna Conductor: the public recording page for callouts (Supabase Edge Function "collect").
// Someone the admin invited opens record.html?i=<token>, records short lines ("Let's do this!",
// "Last song!") and their own, and sends them. There is no sign-in: the invitation's long random token
// is the key, and only these three calls are possible with it:
//   { action: 'info', token }                       → the invitation: name, language, note, lines, what's been sent
//   { action: 'upload', token, key, said, type, data (base64), duration_ms }
//                                                    → saves one recording (replacing that line's earlier one)
//   { action: 'submit', token, name, consent: true, keep: [keys] }
//                                                    → done: the author is named, has agreed, and is published
// Setup: deploy with "Verify JWT" turned OFF (anyone with the link may call it). Uses the service key.

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const MAX_BYTES = 3 * 1024 * 1024;       // one recording (a few seconds of WAV is ~200 KB)
const MAX_LINES = 40;                    // different callouts one person can send
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const TYPES: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function keys(env: Env) {
  let service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  try { if (!service && env.SUPABASE_SECRET_KEYS) service = String(Object.values(JSON.parse(env.SUPABASE_SECRET_KEYS))[0] || ''); } catch { /* ignore */ }
  return { url: String(env.SUPABASE_URL || '').replace(/\/$/, ''), service };
}
type Keys = ReturnType<typeof keys>;
const serviceHeaders = (k: Keys): Record<string, string> => (k.service.startsWith('sb_') ? { apikey: k.service } : { apikey: k.service, Authorization: 'Bearer ' + k.service });

async function rest(k: Keys, f: Fetch, path: string, init: RequestInit = {}) {
  const r = await f(`${k.url}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders(k), 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) || {}) } });
  if (!r.ok) throw new Error(`database ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const enc = encodeURIComponent;

// What a recording really is, from its first bytes (so only audio is stored).
function sniff(b: Uint8Array): string {
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (s(4, 4) === 'ftyp') return 'm4a';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return '';
}
function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function removeClips(k: Keys, f: Fetch, rows: { id: string; path: string }[]) {
  if (!rows.length) return;
  await rest(k, f, `callout_clips?id=in.(${rows.map((r) => enc(r.id)).join(',')})`, { method: 'DELETE' });
  await f(`${k.url}/storage/v1/object/callouts`, { method: 'DELETE', headers: { ...serviceHeaders(k), 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: rows.map((r) => r.path) }) }).catch(() => null);
}

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const k = keys(env);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, 'bad_request', 'Bad request.'); }
  const token = String(body.token || '');
  if (!TOKEN_RE.test(token)) return fail(404, 'gone', 'This link doesn’t work.');

  try {
    const invs = await rest(k, f, `callout_invites?token=eq.${enc(token)}&revoked=eq.false&select=*`);
    const inv = invs && invs[0];
    if (!inv) return fail(404, 'gone', 'This link doesn’t work any more.');
    const mine = () => rest(k, f, `callout_clips?invite_id=eq.${enc(inv.id)}&select=id,key,said,path,duration_ms`) as Promise<{ id: string; key: string; said: string; path: string; duration_ms: number }[]>;

    if (body.action === 'info') {
      if (!inv.opened_at) {
        await rest(k, f, `callout_invites?id=eq.${enc(inv.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ opened_at: new Date().toISOString(), status: inv.status === 'sent' ? 'opened' : inv.status }) });
      }
      const profs = await rest(k, f, `callout_profiles?id=eq.${enc(inv.profile_id)}&select=name`);
      const sent = (await mine()).map(({ key, said, duration_ms }) => ({ key, said, duration_ms }));
      return json({ name: (profs && profs[0] && inv.status === 'submitted' ? profs[0].name : inv.name), lang: inv.lang, note: inv.note, from: inv.invited_by_name,
        template: inv.template || [], status: inv.status, sent });
    }

    if (body.action === 'upload') {
      const key = String(body.key || '');
      if (!KEY_RE.test(key)) return fail(400, 'bad_key', 'Bad request.');
      const said = String(body.said || '').trim().slice(0, 200);
      const data = String(body.data || '');
      if (data.length > MAX_BYTES * 1.4) return fail(413, 'too_big', 'That recording is too long. Keep it to a few seconds.');
      let bytes: Uint8Array;
      try { bytes = fromBase64(data); } catch { return fail(400, 'bad_audio', 'That recording could not be read.'); }
      if (bytes.length < 200 || bytes.length > MAX_BYTES) return fail(413, 'too_big', 'That recording is too long. Keep it to a few seconds.');
      const ext = sniff(bytes);
      const type = String(body.type || '').split(';')[0].toLowerCase();
      if (!ext || !TYPES[type]) return fail(415, 'not_audio', 'That isn’t a recording the app can play.');
      const before = await mine();
      if (!before.some((c) => c.key === key) && new Set(before.map((c) => c.key)).size >= MAX_LINES) return fail(429, 'too_many', 'That’s as many callouts as one person can send.');
      const id = crypto.randomUUID();
      const path = `${inv.profile_id}/${id}.${ext}`;
      const up = await f(`${k.url}/storage/v1/object/callouts/${path}`, { method: 'POST', headers: { ...serviceHeaders(k), 'Content-Type': type, 'x-upsert': 'false' }, body: bytes });
      if (!up.ok) throw new Error(`storage ${up.status}: ${(await up.text()).slice(0, 200)}`);
      const dur = Math.round(Number(body.duration_ms) || 0);
      await rest(k, f, 'callout_clips', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ id, profile_id: inv.profile_id, invite_id: inv.id, key, said, path, type, size: bytes.length, duration_ms: dur > 0 && dur < 600000 ? dur : null }) });
      await removeClips(k, f, before.filter((c) => c.key === key));          // the earlier take of this line
      return json({ ok: true, id });
    }

    if (body.action === 'submit') {
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 80) return fail(400, 'name', 'Write your name.');
      if (body.consent !== true) return fail(400, 'consent', 'Tick that you agree first.');
      const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map(String).filter((x) => KEY_RE.test(x)));
      const all = await mine();
      await removeClips(k, f, all.filter((c) => !keep.has(c.key)));          // lines they took out
      const count = all.filter((c) => keep.has(c.key)).length;
      if (!count) return fail(400, 'empty', 'Record at least one line first.');
      const now = new Date().toISOString();
      // The first time they send, they're published. If the admin has taken them down since, sending
      // again doesn't put them back (only the admin can).
      const cur = (await rest(k, f, `callout_profiles?id=eq.${enc(inv.profile_id)}&select=published`)) || [];
      const publish = inv.status !== 'submitted' || !!(cur[0] && cur[0].published);
      await rest(k, f, `callout_profiles?id=eq.${enc(inv.profile_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ name, consent: true, published: publish, updated_at: now }) });
      await rest(k, f, 'callout_notes', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ profile_id: inv.profile_id, consent_note: `${name} agreed on the recording page on ${now.slice(0, 10)} (invitation to ${inv.name}).`, updated_at: now }) });
      await rest(k, f, `callout_invites?id=eq.${enc(inv.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'submitted', submitted_at: now }) });
      return json({ ok: true, count });
    }
    return fail(400, 'bad_request', 'Bad request.');
  } catch (e) {
    console.error(e);
    return fail(500, 'server', 'Something went wrong on the server. Try again in a moment.');
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && D.serve) D.serve((req: Request) => handle(req, D.env.toObject()));
