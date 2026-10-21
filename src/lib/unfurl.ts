import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import type { LinkPreviewStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { MAX_URL_LENGTH } from "./links";

// Link previews: the server fetches a page someone linked and reads its Open Graph tags. The URL comes from
// a chat message, so it is untrusted and the fetch must not become a way to reach internal services (SSRF):
//   - only http/https on their default ports, no credentials in the URL;
//   - every address the host resolves to must be public, and the connection goes to the address that was
//     checked (the check runs inside the socket's DNS lookup, so DNS rebinding cannot swap it afterwards);
//   - redirects are followed by hand, a few hops at most, each one checked the same way;
//   - one deadline covers the whole fetch, and at most MAX_HTML_BYTES of (decompressed) HTML is read.

const DEADLINE_MS = 5000;
const SOCKET_TIMEOUT_MS = 3000;
const MAX_REDIRECTS = 3;
// Some large sites (YouTube) put their tags ~800 KB into the head.
const MAX_HTML_BYTES = 1024 * 1024;
const USER_AGENT = "OrbitChatBot/1.0 (link previews)";

// How long a stored result is reused before it is fetched again.
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 60 * 60 * 1000;

export type UnfurledLink = { title: string | null; description: string | null; siteName: string | null; imageUrl: string | null };

// ---- Address checks ----------------------------------------------------------------------------------------

// Private, loopback, link-local (cloud metadata lives at 169.254.169.254), shared, multicast and reserved ranges.
const blockedRanges = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) blockedRanges.addSubnet(network, prefix, "ipv4");
// IPv6 must be global unicast (2000::/3), which already excludes loopback, unique-local, link-local, multicast,
// IPv4-mapped and NAT64. Within it, block ranges that tunnel to IPv4 (6to4, Teredo) and documentation ranges.
const globalUnicast = new net.BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedRanges.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
  try {
    const family = net.isIP(address);
    if (family === 4) return !blockedRanges.check(address, "ipv4");
    if (family === 6) return globalUnicast.check(address, "ipv6") && !blockedRanges.check(address, "ipv6");
  } catch {
    // Addresses BlockList cannot parse (e.g. with a zone id) are not public.
  }
  return false;
}

// Used as the socket's DNS lookup, so the address that is checked is the one that gets connected to.
// A host with any non-public address is refused outright rather than filtered.
const safeLookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || !addresses.every(entry => isPublicAddress(entry.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EADDRBLOCKED" }));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as net.LookupFunction;

function assertFetchable(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported protocol ${url.protocol}`);
  if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
  if (url.port) throw new Error("Only default ports are fetched");
  if (url.href.length > MAX_URL_LENGTH) throw new Error("URL too long");
  // Sockets skip the lookup for IP literals, so check those here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error("Address is not public");
}

// ---- Fetching ------------------------------------------------------------------------------------------------

function get(url: URL, signal: AbortSignal) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en"
      },
      lookup: safeLookup,
      // No connection pooling: every request goes through safeLookup.
      agent: false,
      signal,
      timeout: SOCKET_TIMEOUT_MS
    }, resolve);
    request.on("timeout", () => request.destroy(new Error("Socket timed out")));
    request.on("error", reject);
    request.end();
  });
}

function decoded(response: http.IncomingMessage): Readable {
  const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const noop = () => undefined;
  if (encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return pipeline(response, zlib.createGunzip(), noop);
  if (encoding === "deflate") return pipeline(response, zlib.createInflate(), noop);
  if (encoding === "br") return pipeline(response, zlib.createBrotliDecompress(), noop);
  throw new Error(`Unsupported content encoding ${encoding}`);
}

// Reads up to MAX_HTML_BYTES after decompression (so a compression bomb stops there too), and stops early once
// the head has ended, since that is where the tags are.
async function readHead(response: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  let tail = "";
  try {
    for await (const chunk of decoded(response)) {
      const buffer = chunk as Buffer;
      const room = MAX_HTML_BYTES - size;
      chunks.push(buffer.length > room ? buffer.subarray(0, room) : buffer);
      size += Math.min(buffer.length, room);
      const text = tail + buffer.toString("latin1").toLowerCase();
      if (size >= MAX_HTML_BYTES || text.includes("</head")) break;
      tail = text.slice(-6);
    }
  } finally {
    response.destroy();
  }
  return Buffer.concat(chunks);
}

function charsetOf(contentType: string, head: Buffer) {
  const fromHeader = contentType.match(/charset\s*=\s*"?([\w-]+)/i)?.[1];
  const fromMeta = head.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1];
  return fromHeader ?? fromMeta ?? "utf-8";
}

function decodeText(bytes: Buffer, charset: string) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchHtml(start: URL): Promise<{ html: string; url: URL }> {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  let url = start;
  for (let hop = 0; ; hop++) {
    assertFetchable(url);
    const response = await get(url, signal);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      url = new URL(response.headers.location, url);
      continue;
    }
    const contentType = response.headers["content-type"] ?? "";
    if (status !== 200 || !/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      response.destroy();
      throw new Error(`Not an HTML page (HTTP ${status}, ${contentType || "no content type"})`);
    }
    const bytes = await readHead(response);
    return { html: decodeText(bytes, charsetOf(contentType, bytes)), url };
  }
}

// ---- Parsing -------------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function clean(value: string | undefined, maxLength: number) {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

// Images are loaded by viewers' browsers, so only absolute https URLs are kept (no mixed content).
function imageUrl(value: string | undefined, base: URL) {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

export function parseOpenGraph(html: string, pageUrl: URL): UnfurledLink | null {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
    }
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = attributes.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const title = clean(meta.get("og:title") ?? meta.get("twitter:title") ?? head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 300);
  const description = clean(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), 500);
  if (!title && !description) return null;
  return {
    title,
    description,
    siteName: clean(meta.get("og:site_name"), 100),
    imageUrl: imageUrl(meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src"), pageUrl)
  };
}

export async function unfurl(rawUrl: string): Promise<UnfurledLink | null> {
  const { html, url } = await fetchHtml(new URL(rawUrl));
  return parseOpenGraph(html, url);
}

// ---- Cache -----------------------------------------------------------------------------------------------------

function isFresh(preview: { status: LinkPreviewStatus; fetchedAt: Date | null }) {
  if (preview.status === "PENDING" || !preview.fetchedAt) return false;
  return Date.now() - preview.fetchedAt.getTime() < (preview.status === "OK" ? OK_TTL_MS : FAILED_TTL_MS);
}

// Several messages linking the same page at once share one fetch in this process.
const inFlight = new Map<string, Promise<boolean>>();

// Fetches the preview for a URL unless the stored one is still fresh. Returns whether a preview was stored.
// A failed refresh keeps the last good preview rather than removing it from older messages.
async function refreshPreview(url: string): Promise<boolean> {
  const stored = await prisma.linkPreview.findUnique({ where: { url }, select: { status: true, fetchedAt: true } });
  if (!stored || isFresh(stored)) return false;
  const result = await unfurl(url).catch(error => {
    console.warn(`Link preview for ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const fetchedAt = new Date();
  await prisma.linkPreview.update({
    where: { url },
    data: result ? { status: "OK", ...result, fetchedAt } : stored.status === "OK" ? { fetchedAt } : { status: "FAILED", fetchedAt }
  });
  return result !== null;
}

export async function refreshPreviews(urls: string[]) {
  const results = await Promise.all(urls.map(url => {
    let pending = inFlight.get(url);
    if (!pending) {
      pending = refreshPreview(url).finally(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }
    return pending;
  }));
  return results.some(Boolean);
}
