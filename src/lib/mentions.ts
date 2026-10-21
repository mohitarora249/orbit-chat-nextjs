// Mentions are stored in message bodies as tokens naming a stable id, and shown as names when rendered,
// so they survive a rename:
//   <@userId>   one person
//   <!channel>  everyone who can see the conversation
//   <!here>     everyone who is online when it is sent (live delivery only; see mentionsMe)
// The composer shows "@Display Name" while typing and encodes it on send; editing decodes it back.

export type BroadcastMention = "channel" | "here";
export type MentionPart = string | { kind: "user"; userId: string } | { kind: BroadcastMention };

const TOKEN = /<@([A-Za-z0-9_-]{1,64})>|<!(channel|here)>/g;

export const userToken = (userId: string) => `<@${userId}>`;
export const broadcastToken = (kind: BroadcastMention) => `<!${kind}>`;

export function parseMentions(body: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    if (match.index > last) parts.push(body.slice(last, match.index));
    parts.push(match[1] ? { kind: "user", userId: match[1] } : { kind: match[2] as BroadcastMention });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

// Plain-text form for notifications, previews and the edit box. People `nameOf` cannot resolve become
// `unknown`, or keep their raw token when it is null (so editing a message does not drop the mention).
export function mentionsToText(body: string, nameOf: (userId: string) => string | undefined, unknown: string | null = "unknown user") {
  return body.replace(TOKEN, (token, userId?: string, broadcast?: string) => {
    if (broadcast) return `@${broadcast}`;
    const name = nameOf(userId!);
    return name ? `@${name}` : unknown === null ? token : `@${unknown}`;
  });
}

export type MentionTarget = { label: string; token: string };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turns "@Label" into tokens. Earlier targets win when two share a label (the composer lists the people
// actually picked first). A label must start at a word boundary and not run into a longer word.
export function encodeMentions(text: string, targets: MentionTarget[]) {
  const byLabel = new Map<string, string>();
  for (const { label, token } of targets) if (!byLabel.has(label.toLowerCase())) byLabel.set(label.toLowerCase(), token);
  if (!byLabel.size) return text;
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(^|[^\\w@<])@(${labels.join("|")})(?![\\w])`, "gi");
  return text.replace(pattern, (_match, before: string, label: string) => before + byLabel.get(label.toLowerCase())!);
}

export function mentionTargets(users: { id: string; displayName: string }[], broadcasts: boolean): MentionTarget[] {
  return [
    ...users.map(user => ({ label: user.displayName, token: userToken(user.id) })),
    ...(broadcasts ? (["channel", "here"] as const).map(kind => ({ label: kind, token: broadcastToken(kind) })) : [])
  ];
}

// How a message addresses this person. The server's unread counts and Activity only know "direct" and
// "channel": whether someone was online for an @here is only known at delivery time, so @here alerts live.
export function mentionsMe(body: string, userId: string): "direct" | BroadcastMention | null {
  if (body.includes(userToken(userId))) return "direct";
  if (body.includes(broadcastToken("channel"))) return "channel";
  if (body.includes(broadcastToken("here"))) return "here";
  return null;
}
