// Callout tokens in narration text, e.g. "{callout:bubbi-morthens/lets-start} Round two starts now."
// A token plays a short clip that a person recorded (the author: a callout profile, by its short name).
// Version 3.1 tokens without an author, like {callout-lets-start}, use the session's chosen profile.
// Tokens are never read out: they are taken out of the text before it goes to ElevenLabs.
// Tokens before the first words play just before the message; anywhere else, right after it.

export const TOKEN_RE = /\{callout(?::([a-z0-9][a-z0-9-]{0,59})\/|-)([a-z0-9][a-z0-9-]{0,39})\}/gi;
export const hasTokens = (text) => /\{callout[-:][a-z0-9]/i.test(String(text || ''));
export const tokenFor = (author, key) => (author ? `{callout:${author}/${key}}` : `{callout-${key}}`);
// A reference is "author/key", or just "key" for a 3.1 token.
export const refOf = (author, key) => (author ? `${author}/${key}` : key);
export const parseRef = (ref) => { const i = String(ref).indexOf('/'); return i < 0 ? { author: '', key: String(ref) } : { author: ref.slice(0, i), key: ref.slice(i + 1) }; };

// The text without its tokens. Each token goes with one space next to it (the one before it, or the
// one after it at the start of a line), so the rest is exactly the text as it was before the token was
// added: a recording of that text stays valid. Unchanged when there are no tokens.
const SRC = TOKEN_RE.source;
export function stripTokens(text) {
  const t = String(text || '');
  if (!hasTokens(t)) return t;
  return t.replace(new RegExp('[ \\t]' + SRC, 'gi'), '').replace(new RegExp(SRC + '[ \\t]?', 'gi'), '');
}

// { before: [refs], after: [refs] } in the order they appear.
export function tokensIn(text) {
  const t = String(text || '');
  const out = { before: [], after: [] };
  if (!hasTokens(t)) return out;
  // Where the words start (delivery tags like [softly] don't count as words).
  const blank = (m) => ' '.repeat(m.length);
  const firstWord = t.replace(TOKEN_RE, blank).replace(/\[[^\]\n]{1,40}\]/g, blank).search(/[^\s]/);
  for (const m of t.matchAll(TOKEN_RE)) {
    const ref = refOf((m[1] || '').toLowerCase(), m[2].toLowerCase());
    (firstWord < 0 || m.index < firstWord ? out.before : out.after).push(ref);
  }
  return out;
}
export const refsIn = (text) => { const t = tokensIn(text); return [...t.before, ...t.after]; };

// Takes one token out of a text (the first time it appears), with one space next to it, the same way
// stripTokens does.
export function removeToken(text, token) {
  const t = String(text || '');
  const i = t.indexOf(token);
  if (i < 0) return t;
  if (i > 0 && /[ \t]/.test(t[i - 1])) return t.slice(0, i - 1) + t.slice(i + token.length);
  return t.slice(0, i) + t.slice(i + token.length).replace(/^[ \t]/, '');
}

// A message that is only callouts: nothing to record.
export const calloutOnly = (text) => hasTokens(text) && !stripTokens(text).replace(/\[[^\]\n]{1,40}\]/g, '').trim();
