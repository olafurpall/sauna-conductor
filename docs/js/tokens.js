// Callout tokens in narration text, e.g. "{callout-lets-start} Round two starts now."
// A token plays a short clip from the session's callout profile (a person who recorded callouts).
// Tokens are never read out: they are taken out of the text before it goes to ElevenLabs.
// Tokens before the first words play just before the message; anywhere else, right after it.

export const TOKEN_RE = /\{callout-([a-z0-9][a-z0-9-]{0,39})\}/gi;
export const hasTokens = (text) => /\{callout-[a-z0-9]/i.test(String(text || ''));
export const tokenFor = (key) => `{callout-${key}}`;

// The text without its tokens (unchanged when there are none, so existing recordings stay valid).
export function stripTokens(text) {
  const t = String(text || '');
  if (!hasTokens(t)) return t;
  return t.replace(TOKEN_RE, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?…:;])/g, '$1').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
}

// { before: [keys], after: [keys] } in the order they appear.
export function tokensIn(text) {
  const t = String(text || '');
  const out = { before: [], after: [] };
  if (!hasTokens(t)) return out;
  // Where the words start (delivery tags like [softly] don't count as words).
  const blank = (m) => ' '.repeat(m.length);
  const firstWord = t.replace(TOKEN_RE, blank).replace(/\[[^\]\n]{1,40}\]/g, blank).search(/[^\s]/);
  for (const m of t.matchAll(TOKEN_RE)) {
    const key = m[1].toLowerCase();
    (firstWord < 0 || m.index < firstWord ? out.before : out.after).push(key);
  }
  return out;
}

// A message that is only callouts: nothing to record.
export const calloutOnly = (text) => hasTokens(text) && !stripTokens(text).replace(/\[[^\]\n]{1,40}\]/g, '').trim();
