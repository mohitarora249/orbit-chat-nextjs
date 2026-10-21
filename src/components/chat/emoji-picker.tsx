"use client";

import { useMemo, useState } from "react";
import { Popover } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";

// A compact built-in set: "emoji keywords" per entry, grouped by category.
const CATEGORIES: { name: string; emoji: string[] }[] = [
  { name: "Frequently used", emoji: [
    "👍 thumbs up yes +1", "❤️ heart love", "😂 joy laugh tears", "🎉 tada party celebrate", "🙏 pray thanks please", "🔥 fire lit hot",
    "👀 eyes look see", "✅ check done yes", "🚀 rocket ship launch", "😄 smile happy", "👏 clap applause", "💯 hundred perfect"
  ] },
  { name: "Smileys", emoji: [
    "😀 grin happy", "😃 smiley happy", "😁 beam grin", "😆 laughing", "😅 sweat smile", "🤣 rofl rolling laugh", "🙂 slight smile", "🙃 upside down",
    "😉 wink", "😊 blush", "😇 innocent halo", "🥰 smiling hearts love", "😍 heart eyes love", "🤩 star struck", "😘 kiss", "😋 yum delicious",
    "😛 tongue", "😜 wink tongue", "🤪 zany crazy", "🤔 thinking hmm", "🤨 raised eyebrow", "😐 neutral", "😑 expressionless", "😶 no mouth",
    "🙄 eye roll", "😏 smirk", "😬 grimace", "😌 relieved", "😔 pensive", "😪 sleepy", "😴 sleeping zzz", "😷 mask sick",
    "🤒 thermometer sick", "🤯 mind blown exploding", "🥳 partying party", "😎 sunglasses cool", "🤓 nerd", "🧐 monocle", "😕 confused", "😟 worried",
    "😮 open mouth wow", "😲 astonished", "😳 flushed", "🥺 pleading", "😢 cry sad", "😭 sob crying", "😱 scream", "😤 triumph huff",
    "😡 rage angry", "🤬 cursing", "💀 skull dead", "🤖 robot", "👻 ghost", "🤡 clown", "💩 poop", "🙈 see no evil monkey"
  ] },
  { name: "People", emoji: [
    "👋 wave hello hi bye", "🤚 raised back hand", "✋ raised hand stop", "👌 ok", "🤌 pinched fingers", "✌️ victory peace", "🤞 crossed fingers luck",
    "🤟 love you", "🤘 rock on", "🤙 call me", "👈 point left", "👉 point right", "👆 point up", "👇 point down", "☝️ index up",
    "👎 thumbs down no -1", "✊ fist", "👊 punch", "🙌 raised hands hooray", "🤝 handshake deal", "💪 muscle strong flex", "🧠 brain", "🫡 salute"
  ] },
  { name: "Nature & food", emoji: [
    "🐶 dog", "🐱 cat", "🦊 fox", "🐼 panda", "🐨 koala", "🦄 unicorn", "🐝 bee", "🐢 turtle", "🐙 octopus", "🌵 cactus", "🌲 tree", "🌸 blossom flower",
    "🌻 sunflower", "🌈 rainbow", "☀️ sun", "⭐ star", "🌙 moon", "⚡ lightning zap", "❄️ snowflake", "🌊 wave ocean",
    "🍎 apple", "🍕 pizza", "🍔 burger", "🌮 taco", "🍣 sushi", "🍩 donut", "🍪 cookie", "🎂 cake birthday", "☕ coffee", "🍵 tea", "🍺 beer", "🍷 wine"
  ] },
  { name: "Objects & symbols", emoji: [
    "💡 bulb idea", "📌 pin", "📎 paperclip", "📝 memo note", "📅 calendar date", "📈 chart up growth", "📉 chart down", "🔒 lock", "🔑 key", "🛠️ tools",
    "⚙️ gear settings", "🧪 test tube experiment", "🐛 bug", "💻 laptop computer", "📱 phone", "🎯 target goal", "🏆 trophy win", "🎁 gift", "🔔 bell",
    "⏰ alarm clock", "⌛ hourglass", "💬 speech chat", "❓ question", "❗ exclamation", "⚠️ warning", "🚫 prohibited no", "❌ x cross no", "➕ plus",
    "💙 blue heart", "💚 green heart", "💜 purple heart", "🧡 orange heart", "💛 yellow heart", "🖤 black heart", "✨ sparkles", "🎶 music notes"
  ] }
];

type Entry = { char: string; keywords: string };
function toEntry(item: string): Entry {
  const [char, ...words] = item.split(" ");
  return { char, keywords: words.join(" ") };
}
const GROUPS = CATEGORIES.map(category => ({ name: category.name, entries: category.emoji.map(toEntry) }));
const ENTRIES: Entry[] = [...new Map(GROUPS.flatMap(group => group.entries).map(entry => [entry.char, entry])).values()];

export function EmojiPicker({ onPick, onClose, className }: { onPick: (emoji: string) => void; onClose: () => void; className?: string }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ENTRIES.filter(entry => entry.keywords.includes(q)) : null;
  }, [query]);

  const button = (entry: Entry) => (
    <button key={entry.char} type="button" title={entry.keywords.split(" ")[0]} onClick={() => onPick(entry.char)} className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition hover:bg-zinc-100 active:scale-90">
      {entry.char}
    </button>
  );

  return (
    <Popover onClose={onClose} className={cn("w-[296px] p-2", className)}>
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search emoji" aria-label="Search emoji" className="mb-2 w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"/>
      <div className="max-h-64 overflow-y-auto pr-1">
        {matches
          ? matches.length ? <div className="grid grid-cols-8">{matches.map(button)}</div> : <p className="py-6 text-center text-xs text-zinc-400">No emoji found</p>
          : GROUPS.map(group => (
            <div key={group.name} className="mb-2">
              <div className="px-1 pb-1 text-[11px] font-medium text-zinc-400">{group.name}</div>
              <div className="grid grid-cols-8">{group.entries.map(button)}</div>
            </div>
          ))}
      </div>
    </Popover>
  );
}
