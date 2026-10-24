// Finding links in message bodies. The markdown parser (src/lib/markdown.ts) uses urlAt both for the server,
// which unfurls links, and for the renderer, which makes them clickable, so both agree on what counts as a
// link. No Node.js imports: this runs in the browser too.

export const MAX_LINKS_PER_MESSAGE = 3;
export const MAX_URL_LENGTH = 2048;

const URL_PATTERN = /https?:\/\/[^\s<>"]+/iy;
const TRAILING_PUNCTUATION = /[.,;:!?'*_~]+$/;

// "(see https://example.com/a_(b))." keeps the balanced ")" but drops the one that closes the sentence.
function trimUrl(raw: string) {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

// The http(s) link starting exactly at `index`, if any. A link must not start inside a word.
export function urlAt(text: string, index: number): string | null {
  if (index > 0 && /\w/.test(text[index - 1])) return null;
  URL_PATTERN.lastIndex = index;
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  const url = trimUrl(match[0]);
  return normalizeUrl(url) ? url : null;
}

// The cache key for a link: parsed, without the fragment (servers never see it) or credentials.
export function normalizeUrl(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// A GIF posted with /giphy: a GIPHY media URL, shown as the image itself instead of a link.
const GIF_URL = /^https:\/\/media\d?\.giphy\.com\/media\/[A-Za-z0-9]+\/[\w-]+\.(?:gif|webp)$/;

export function isGifUrl(url: string) {
  return GIF_URL.test(url);
}
