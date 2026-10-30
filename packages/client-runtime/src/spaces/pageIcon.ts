export const SPACE_PAGE_ICONS: readonly string[] = [
  "📄",
  "📝",
  "📚",
  "📌",
  "📎",
  "📅",
  "📊",
  "📈",
  "💡",
  "🎯",
  "🚀",
  "🔥",
  "⭐",
  "✅",
  "⚠️",
  "❤️",
  "🧠",
  "🛠️",
  "🐛",
  "🔒",
  "🔍",
  "💬",
  "🧪",
  "🗂️",
  "🏠",
  "🌱",
  "☕",
  "🎨",
  "🎵",
  "🌍",
  "💰",
  "🔗",
];

const pictograph = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?`;
const singleEmoji = new RegExp(
  String.raw`^(?:${pictograph}(?:\u200D${pictograph})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$`,
  "u",
);

/** The single emoji in `input`, or null when it is empty or anything else. */
export function normalizeSpacePageIcon(input: string): string | null {
  const text = input.trim();
  return text.length <= 32 && singleEmoji.test(text) ? text : null;
}
