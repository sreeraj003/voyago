/**
 * Removes anything that could identify a person or place from error text before it is logged:
 * emails, phone-like numbers, long ids and tokens, precise coordinates, and URL query strings.
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\?[^\s)'"]*/g, '?[query]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/-?\d{1,3}\.\d{4,}/g, '[number]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]');
}
