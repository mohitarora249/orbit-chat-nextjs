// Search query syntax, shared by the server (parsing) and the ⌘K palette (suggestions). No server imports.
//
//   in:#channel  in:@person (your DM)  from:@person  from:me  has:file  has:link
//   before:/after:/on: YYYY-MM-DD, today or yesterday (in the searcher's time zone)
//   free text: words (prefix-matched), "exact phrases", OR, -excluded
//
// Repeated in: or from: filters match any of them; everything else must all match.

export const HAS_VALUES = ["file", "link"] as const;
export type HasValue = (typeof HAS_VALUES)[number];
export type DateFilterKey = "before" | "after" | "on";

export type ParsedSearch = {
  // Free text as a to_tsquery string, or "" if there is none. Every word or phrase is a quoted operand, which
  // Postgres splits with the same parser that built the index (so URLs, emails and hyphenated words match).
  tsquery: string;
  inChannels: string[];
  inDms: string[];
  from: string[];
  has: HasValue[];
  dates: { key: DateFilterKey; value: string }[];
  // Filters that could not be understood, as typed, so the palette can say why nothing matched.
  invalid: string[];
};

const FILTER = /^(-?)(in|from|has|before|after|on):(.*)$/i;
const DATE_KEYS = new Set(["before", "after", "on"]);

// People have no usernames, so from:@ and in:@ use their display name without spaces, lowercased
// (from:@janedoe). The server also accepts the part of their email before the @.
export function personHandle(displayName: string) {
  return displayName.toLowerCase().replace(/\s+/g, "");
}

// Splits on spaces, keeping "quoted text" together (including in filter values: from:@"Jane Doe").
function tokenize(query: string) {
  const tokens: { text: string; quoted: boolean }[] = [];
  const pattern = /(-?)"([^"]*)"?|(\S*?:@?)"([^"]*)"?|\S+/g;
  for (const match of query.matchAll(pattern)) {
    if (match[2] !== undefined) tokens.push({ text: match[1] + match[2], quoted: true });
    else if (match[4] !== undefined) tokens.push({ text: match[3] + match[4], quoted: false });
    else tokens.push({ text: match[0], quoted: false });
  }
  return tokens;
}

function operand(text: string) {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function parseSearch(query: string): ParsedSearch {
  const parsed: ParsedSearch = { tsquery: "", inChannels: [], inDms: [], from: [], has: [], dates: [], invalid: [] };
  const terms: string[] = [];
  let pendingOr = false;

  for (const token of tokenize(query)) {
    const filter = token.quoted ? null : FILTER.exec(token.text);
    if (filter) {
      const [, negated, rawKey, rawValue] = filter;
      const key = rawKey.toLowerCase();
      const value = rawValue.trim().toLowerCase();
      if (!value || value === "#" || value === "@") continue; // still being typed
      if (negated) { parsed.invalid.push(token.text); continue; }
      if (key === "in" && value.startsWith("#") && value.length > 1) parsed.inChannels.push(value.slice(1));
      else if (key === "in" && value.startsWith("@") && value.length > 1) parsed.inDms.push(personHandle(value.slice(1)));
      else if (key === "from" && value === "me") parsed.from.push("me");
      else if (key === "from" && value.startsWith("@") && value.length > 1) parsed.from.push(personHandle(value.slice(1)));
      else if (key === "has" && (HAS_VALUES as readonly string[]).includes(value)) parsed.has.push(value as HasValue);
      else if (DATE_KEYS.has(key) && /^(\d{4}-\d{2}-\d{2}|today|yesterday)$/.test(value)) parsed.dates.push({ key: key as DateFilterKey, value });
      else parsed.invalid.push(token.text);
      continue;
    }

    if (!token.quoted && token.text === "OR") { pendingOr = terms.length > 0; continue; }
    const negated = token.text.startsWith("-") && token.text.length > 1;
    const text = negated ? token.text.slice(1) : token.text;
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    // Typed words match as prefixes ("deplo" finds "deploy", "deployment"); phrases and exclusions are exact.
    const term = `${negated ? "!" : ""}${operand(text)}${token.quoted || negated ? "" : ":*"}`;
    if (pendingOr) terms[terms.length - 1] = `${terms[terms.length - 1]} | ${term}`;
    else terms.push(term);
    pendingOr = false;
  }

  parsed.tsquery = terms.join(" & ");
  return parsed;
}

export function hasSearchFilters(parsed: ParsedSearch) {
  return parsed.inChannels.length + parsed.inDms.length + parsed.from.length + parsed.has.length + parsed.dates.length + parsed.invalid.length > 0;
}

// The filter being typed at the end of the query, for the palette's suggestions:
// "deploy in:#gen" → { start: 7, key: "in:#", partial: "gen" }, where start is the index the filter begins at.
export function trailingFilter(query: string): { start: number; key: string; partial: string } | null {
  const match = /(^|\s)(in:#|in:@|from:@|in:|from:|has:|before:|after:|on:)("?[^\s"]*)$/i.exec(query);
  if (!match) return null;
  return { start: match.index + match[1].length, key: match[2].toLowerCase(), partial: match[3].replace(/^"/, "").toLowerCase() };
}
