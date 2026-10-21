// Finding links in message bodies. Shared by the server (which unfurls them) and the renderer (which makes
// them clickable), so both agree on what counts as a link. No Node.js imports: this runs in the browser too.

export const MAX_LINKS_PER_MESSAGE = 3;
export const MAX_URL_LENGTH = 2048;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'*_~]+$/;

export type LinkPart = string | { url: string };

// "(see https://example.com/a_(b))." keeps the balanced ")" but drops the one that closes the sentence.
function trimUrl(raw: string) {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

export function parseLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!normalizeUrl(url)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ url });
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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

// The distinct links in a message, in order, to unfurl. GIFs are already shown inline, so they are skipped.
export function extractLinks(body: string) {
  const urls = new Set<string>();
  for (const part of parseLinks(body)) {
    if (typeof part === "string" || isGifUrl(part.url)) continue;
    const url = normalizeUrl(part.url);
    if (url) urls.add(url);
    if (urls.size === MAX_LINKS_PER_MESSAGE) break;
  }
  return [...urls];
}
