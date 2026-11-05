export interface Tab { id: string; url: string; title?: string; canGoBack?: boolean; canGoForward?: boolean; loading?: boolean; zoomFactor?: number }
export interface TabsState { tabs: Tab[]; activeId: string }
export function allowedURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw Error('地址无效');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') throw Error('仅允许 HTTP、HTTPS 和 about:blank');
  return url.href;
}
export function normalizeAddress(value: string): string {
  const s = value.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(s)) return allowedURL(s);
  if (!/\s/.test(s) && (s.includes('.') || s.startsWith('localhost'))) return allowedURL('https://' + s);
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}
