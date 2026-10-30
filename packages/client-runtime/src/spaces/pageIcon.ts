import { SPACE_PAGE_ICON_PATTERN } from "@t2code/contracts/spaces";

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

/** The single emoji in `input`, or null when it is empty or anything else. */
export function normalizeSpacePageIcon(input: string): string | null {
  const text = input.trim();
  return text.length <= 32 && SPACE_PAGE_ICON_PATTERN.test(text) ? text : null;
}
