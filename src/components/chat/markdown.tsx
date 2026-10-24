"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { mentionsToText } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import type { ChatUser } from "@/lib/types";

// Links open in a new tab without telling the site where they came from. The parser only yields http(s) URLs.
export const LINK_REL = "noopener noreferrer nofollow";

type Context = { usersById: Map<string, ChatUser>; meId: string };

// Syntax highlighting is loaded the first time a code block is shown, so messages without code don't pay for it.
type Lowlight = ReturnType<typeof import("lowlight").createLowlight>;
let highlighter: Lowlight | null = null;
let loadingHighlighter: Promise<Lowlight> | null = null;

function loadHighlighter() {
  return loadingHighlighter ??= import("lowlight").then(({ common, createLowlight }) => highlighter = createLowlight(common));
}

// Blocks without a language are guessed, but only shown highlighted when the guess is confident.
const MIN_AUTO_RELEVANCE = 5;
const MAX_CACHED = 200;
const highlighted = new Map<string, ReactNode[] | null>();

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };
const HIGHLIGHT_CLASS = /^(?:hljs-[\w-]+|[a-z]+_)$/;

// The highlighter's tree is rebuilt from text and <span class="hljs-…"> only, so it can never add markup of its own.
function fromHast(nodes: HastNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value ?? "";
    if (node.type !== "element" || !node.children) return null;
    const children = fromHast(node.children);
    const className = node.properties?.className;
    const classes = Array.isArray(className) ? className.filter((name): name is string => typeof name === "string" && HIGHLIGHT_CLASS.test(name)) : [];
    return node.tagName === "span" && classes.length ? <span key={index} className={classes.join(" ")}>{children}</span> : <Fragment key={index}>{children}</Fragment>;
  });
}

function highlight(lowlight: Lowlight, lang: string | null, code: string) {
  const key = `${lang ?? ""}\0${code}`;
  if (highlighted.has(key)) return highlighted.get(key)!;
  let result: ReactNode[] | null = null;
  try {
    if (lang && lowlight.registered(lang)) result = fromHast(lowlight.highlight(lang, code).children as HastNode[]);
    else if (!lang) {
      const guess = lowlight.highlightAuto(code);
      if ((guess.data?.relevance ?? 0) >= MIN_AUTO_RELEVANCE) result = fromHast(guess.children as HastNode[]);
    }
  } catch {
    result = null;
  }
  if (highlighted.size >= MAX_CACHED) highlighted.delete(highlighted.keys().next().value!);
  highlighted.set(key, result);
  return result;
}

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const [lowlight, setLowlight] = useState(highlighter);
  useEffect(() => {
    if (!lowlight) loadHighlighter().then(setLowlight, () => {});
  }, [lowlight]);
  const tokens = useMemo(() => lowlight ? highlight(lowlight, lang, code) : null, [lowlight, lang, code]);
  return (
    <pre className="max-w-full overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[12.5px] leading-5 text-zinc-800">
      <code>{tokens ?? code}</code>
    </pre>
  );
}

function Mention({ mention, context }: { mention: Extract<Inline, { type: "mention" }>["mention"]; context: Context }) {
  const forMe = mention.kind !== "user" || mention.userId === context.meId;
  const label = mention.kind === "user" ? context.usersById.get(mention.userId)?.displayName ?? "unknown user" : mention.kind;
  return <span className={cn("rounded px-0.5 font-semibold", forMe ? "bg-amber-200/80 text-amber-900" : "bg-brand-50 text-brand-700")}>@{label}</span>;
}

function renderInline(nodes: Inline[], context: Context): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>;
      case "strong": return <strong key={index} className="font-semibold">{renderInline(node.children, context)}</strong>;
      case "em": return <em key={index}>{renderInline(node.children, context)}</em>;
      case "code": return <code key={index} className="rounded border border-zinc-200 bg-zinc-50 px-1 py-px font-mono text-[12.5px] text-zinc-800">{mentionsToText(node.text, id => context.usersById.get(id)?.displayName)}</code>;
      case "link": return <a key={index} href={node.url} target="_blank" rel={LINK_REL} className="text-brand-600 underline decoration-brand-200 underline-offset-2 transition hover:decoration-brand-500">{node.url}</a>;
      case "mention": return <Mention key={index} mention={node.mention} context={context}/>;
    }
  });
}

// `trailing` (like "(edited)") follows the last line of text when the message ends in one.
function renderBlocks(blocks: Block[], context: Context, trailing?: ReactNode): ReactNode {
  const last = blocks[blocks.length - 1];
  return (
    <>
      {blocks.map((block, index) => {
        const end = index === blocks.length - 1 && block.type === "paragraph" ? trailing : null;
        switch (block.type) {
          case "paragraph": return <p key={index} className="whitespace-pre-wrap">{renderInline(block.children, context)}{end}</p>;
          case "code": return <CodeBlock key={index} lang={block.lang} code={mentionsToText(block.text, id => context.usersById.get(id)?.displayName)}/>;
          case "quote": return <blockquote key={index} className="space-y-1 border-l-[3px] border-zinc-300 pl-3">{renderBlocks(block.children, context)}</blockquote>;
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index} start={block.ordered && block.start !== 1 ? block.start : undefined} className={cn("space-y-0.5 pl-5 marker:text-zinc-400", block.ordered ? "list-decimal" : "list-disc [&_ul]:list-[circle]")}>
                {block.items.map((item, itemIndex) => <li key={itemIndex} className="space-y-1 pl-0.5">{renderBlocks(item, context)}</li>)}
              </List>
            );
          }
        }
      })}
      {last?.type !== "paragraph" && trailing && <p>{trailing}</p>}
    </>
  );
}

export function Markdown({ body, usersById, meId, trailing }: { body: string; usersById: Map<string, ChatUser>; meId: string; trailing?: ReactNode }) {
  const blocks = useMemo(() => parseMarkdown(body), [body]);
  return <div className="space-y-1">{renderBlocks(blocks, { usersById, meId }, trailing)}</div>;
}
