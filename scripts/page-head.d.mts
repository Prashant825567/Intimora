export const SITE_ORIGIN: string;
export const SITE_NAME: string;
export const HOME_TITLE: string;
export const HOME_DESCRIPTION: string;
export function escapeHtml(text: unknown): string;
export function cleanPhrase(value: unknown, max?: number): string;
export function canonicalFor(route: unknown): string;
export function pageMetaFor(route?: string, options?: { videoTitle?: string }): {
  title: string;
  description: string;
  canonical: string;
  type: string;
  page: Record<string, unknown> | null;
};
export function applyPageHead(html: string, meta: ReturnType<typeof pageMetaFor>, options?: { noindex?: boolean }): string;
