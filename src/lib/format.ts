/**
 * Rounding to "k" alone renders a short handout as a misleading "0k", so the
 * exact count is kept below a thousand.
 */
export function formatChars(count: number): string {
  if (!count) return '0 chars';
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k chars`;
}
