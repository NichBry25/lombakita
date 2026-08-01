/**
 * Shortens `text` to at most `maxChars` visible characters, appending an ellipsis when it had to
 * cut. Breaks on the last whole word that fits rather than mid-word, so a trimmed title still
 * reads as words; falls back to a hard cut when a single word is longer than the budget.
 *
 * For headings that combine a fixed label with variable content ("Peserta {title}"), truncate the
 * variable part with this rather than clipping the whole string in CSS — CSS would happily eat the
 * label too on a narrow screen, leaving "Pesert…".
 */
export function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (maxChars <= 0) return "";
  if (trimmed.length <= maxChars) return trimmed;

  const clipped = trimmed.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only honour a word boundary that keeps a useful amount of the text; otherwise a title whose
  // first word is very long would collapse to almost nothing.
  const base = lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped;

  return `${base.trimEnd()}…`;
}
