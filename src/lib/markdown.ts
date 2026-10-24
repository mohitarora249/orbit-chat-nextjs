// The markdown subset messages support, parsed into a tree that is rendered as React elements (never as
// HTML), so a message can't inject markup:
//   **bold** __bold__   *italic* _italic_   `code`   ```lang fenced code```   > quote   - / * / + / 1. lists
// plus bare http(s) links and mention tokens. Headings, tables, images, raw HTML and [text](url) links are
// not supported: they stay plain text. Line breaks are kept as typed, as in a chat.
// Shared by the server (which unfurls links outside code) and the renderer. No Node.js imports.

import { isGifUrl, MAX_LINKS_PER_MESSAGE, normalizeUrl, urlAt } from "./links";
import { mentionAt, mentionToken, type MentionPart } from "./mentions";

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; url: string }
  | { type: "mention"; mention: Exclude<MentionPart, string> };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] };

// Deeper nesting stays plain text, which bounds the recursion however a message is written.
const MAX_INLINE_DEPTH = 8;
const MAX_BLOCK_DEPTH = 6;

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

function runLength(text: string, index: number, ch: string) {
  let end = index;
  while (text[end] === ch) end++;
  return end - index;
}

// The next run of exactly `length` backticks at or after `from`, or -1.
function closingBackticks(text: string, from: number, length: number) {
  for (let i = from; i < text.length;) {
    if (text[i] !== "`") { i++; continue; }
    const run = runLength(text, i, "`");
    if (run === length) return i;
    i += run;
  }
  return -1;
}

// Pieces emphasis can never split: an escaped character, a code span, a mention token or a link. An
// unclosed run of backticks is literal text, consumed whole so its backticks don't open a later span.
function atomAt(text: string, index: number): { node: Inline; end: number } | null {
  const ch = text[index];
  if (ch === "\\" && ESCAPABLE.test(text[index + 1] ?? "")) return { node: { type: "text", text: text[index + 1] }, end: index + 2 };
  if (ch === "`") {
    const run = runLength(text, index, "`");
    const close = closingBackticks(text, index + run, run);
    if (close === -1) return { node: { type: "text", text: "`".repeat(run) }, end: index + run };
    let code = text.slice(index + run, close);
    // "`` `a` ``" shows `a`: one space on each side is padding, as in CommonMark.
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
    return { node: { type: "code", text: code }, end: close + run };
  }
  if (ch === "<") {
    const mention = mentionAt(text, index);
    if (mention) return { node: { type: "mention", mention: mention.part }, end: index + mention.length };
  }
  if (ch === "h" || ch === "H") {
    const url = urlAt(text, index);
    if (url) return { node: { type: "link", url }, end: index + url.length };
  }
  return null;
}

// A run of * or _ can open emphasis when text follows it, and close it when text precedes it. Underscores
// inside a word (snake_case) do neither.
function canOpen(text: string, index: number, length: number, ch: string) {
  return !isSpace(text[index + length]) && (ch === "*" || !isAlnum(text[index - 1]));
}

function canClose(text: string, index: number, length: number, ch: string) {
  return !isSpace(text[index - 1]) && (ch === "*" || !isAlnum(text[index + length]));
}

// Where the emphasis opened just before `from` (`width` delimiters wide) closes, or -1. Runs that open
// emphasis of their own on the way are matched first, so "*a **b** c*" closes at the last *.
function findCloser(text: string, from: number, ch: string, width: number) {
  const open: number[] = [];
  for (let i = from; i < text.length;) {
    const atom = atomAt(text, i);
    if (atom) { i = atom.end; continue; }
    if (text[i] !== ch) { i++; continue; }
    const length = runLength(text, i, ch);
    let left = length;
    if (canClose(text, i, length, ch)) {
      while (left && open.length) {
        const take = Math.min(open[open.length - 1], left);
        open[open.length - 1] -= take;
        left -= take;
        if (!open[open.length - 1]) open.pop();
      }
      if (left >= width && !open.length) return i + length - left;
    }
    if (left && canOpen(text, i + length - left, left, ch)) open.push(left);
    i += length;
  }
  return -1;
}

export function parseInline(text: string, depth = 0): Inline[] {
  const nodes: Inline[] = [];
  let buffer = "";
  const push = (node: Inline) => {
    if (node.type === "text") { buffer += node.text; return; }
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
    nodes.push(node);
  };
  for (let i = 0; i < text.length;) {
    const atom = atomAt(text, i);
    if (atom) { push(atom.node); i = atom.end; continue; }
    const ch = text[i];
    if (ch !== "*" && ch !== "_") { buffer += ch; i++; continue; }
    const length = runLength(text, i, ch);
    let matched = false;
    if (depth < MAX_INLINE_DEPTH && canOpen(text, i, length, ch)) {
      for (const width of length >= 2 ? [2, 1] : [1]) {
        const close = findCloser(text, i + width, ch, width);
        if (close <= i + width) continue;
        push({ type: width === 2 ? "strong" : "em", children: parseInline(text.slice(i + width, close), depth + 1) });
        i = close + width;
        matched = true;
        break;
      }
    }
    if (!matched) { buffer += ch.repeat(length); i += length; }
  }
  if (buffer) nodes.push({ type: "text", text: buffer });
  return nodes;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LANGUAGE = /^[\w+#.-]{1,32}$/;
// "> " or a lone ">", so ">_<" and ">.>" stay text.
const QUOTE = /^ {0,3}>(?: (.*))?$/;
const LIST_ITEM = /^( *)([-*+]|(\d{1,9})[.)])( +)(.*)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    // ```js … ``` — a fence left open runs to the end of the message. As people often type it in chat,
    // "```some code" puts the code on the opening line and "code```" closes on the last one.
    const fence = FENCE.exec(line);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      endParagraph();
      const marker = fence[1];
      const info = fence[2].trim();
      const lang = LANGUAGE.test(info) ? info.toLowerCase() : null;
      const code = info && !lang ? [info] : [];
      const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`);
      for (i++; i < lines.length; i++) {
        if (closing.test(lines[i])) { i++; break; }
        if (marker[0] === "`" && lines[i].trimEnd().endsWith(marker)) { code.push(lines[i].trimEnd().slice(0, -marker.length)); i++; break; }
        code.push(lines[i]);
      }
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }

    if (depth < MAX_BLOCK_DEPTH && QUOTE.test(line)) {
      endParagraph();
      const quoted: string[] = [];
      for (let match; i < lines.length && (match = QUOTE.exec(lines[i])); i++) quoted.push(match[1] ?? "");
      blocks.push({ type: "quote", children: parseBlocks(quoted, depth + 1) });
      continue;
    }

    // A list can interrupt a paragraph ("Options:\n- a\n- b"), but a numbered one only from 1, so a
    // line that happens to start with "2020. " doesn't become a list.
    const first = LIST_ITEM.exec(line);
    if (depth < MAX_BLOCK_DEPTH && first && (!paragraph.length || first[3] === undefined || first[3] === "1")) {
      endParagraph();
      const ordered = first[3] !== undefined;
      const items: Block[][] = [];
      for (let item: RegExpExecArray | null = first; item && (item[3] !== undefined) === ordered;) {
        // The item's own lines are the ones indented past its marker; they may hold a nested list.
        const markerIndent = item[1].length;
        const contentIndent = markerIndent + item[2].length + Math.min(item[4].length, 4);
        const content = [item[5]];
        for (i++; i < lines.length && lines[i].trim() && indentOf(lines[i]) > markerIndent; i++) {
          content.push(lines[i].slice(Math.min(indentOf(lines[i]), contentIndent)));
        }
        items.push(parseBlocks(content, depth + 1));
        // Blank lines between items keep the list going.
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        item = LIST_ITEM.exec(lines[next] ?? "");
        if (item && (item[3] !== undefined) === ordered) i = next;
      }
      blocks.push({ type: "list", ordered, start: ordered ? Number(first[3]) : 1, items });
      continue;
    }

    if (!line.trim()) endParagraph();
    else paragraph.push(line);
    i++;
  }
  endParagraph();
  return blocks;
}

export function parseMarkdown(body: string): Block[] {
  return parseBlocks(body.replace(/\r\n?/g, "\n").split("\n"), 0);
}

function inlineText(nodes: Inline[]): string {
  return nodes.map(node => {
    if (node.type === "text" || node.type === "code") return node.text;
    if (node.type === "link") return node.url;
    if (node.type === "mention") return mentionToken(node.mention);
    return inlineText(node.children);
  }).join("");
}

function blocksText(blocks: Block[]): string {
  return blocks.map(block => {
    if (block.type === "paragraph") return inlineText(block.children);
    if (block.type === "code") return block.text;
    if (block.type === "quote") return blocksText(block.children);
    return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${blocksText(item)}`).join("\n");
  }).join("\n");
}

// The text of a message without its markdown, mention tokens kept, for notifications and previews.
export function markdownToText(body: string) {
  return blocksText(parseMarkdown(body));
}

function collectLinks(blocks: Block[], into: string[]) {
  const walk = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "link") into.push(node.url);
      else if (node.type === "strong" || node.type === "em") walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "paragraph") walk(block.children);
    else if (block.type === "quote") collectLinks(block.children, into);
    else if (block.type === "list") for (const item of block.items) collectLinks(item, into);
  }
  return into;
}

// The distinct links in a message, in order, to unfurl: the ones the renderer makes clickable, so not
// those inside code. GIFs are already shown inline, so they are skipped.
export function extractLinks(body: string) {
  const urls = new Set<string>();
  for (const link of collectLinks(parseMarkdown(body), [])) {
    if (isGifUrl(link)) continue;
    const url = normalizeUrl(link);
    if (url) urls.add(url);
    if (urls.size === MAX_LINKS_PER_MESSAGE) break;
  }
  return [...urls];
}
