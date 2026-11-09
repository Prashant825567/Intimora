export const SITE_ORIGIN: string;
export function renderSitemap(ids?: string[]): string;
export function readPublicJson(url: URL, timeoutMs?: number): Promise<unknown>;
export function buildSitemap(options?: {
  discoveryUrl?: string;
  requestJson?: (url: URL, timeoutMs: number) => Promise<unknown>;
  maxPages?: number;
  now?: () => number;
}): Promise<{ xml: string; videoCount: number; pages: number; complete: boolean }>;
