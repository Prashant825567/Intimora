export const PARTNER_FEED_LIMIT: number;

export function decodeHtmlEntities(value: string): string;

export function parsePartnerFeed(
  text: string,
  options?: { limit?: number; hosts?: readonly string[] },
): string[];

export interface PartnerFeedItem {
  embedUrl: string;
  title: string;
  thumbnail: string | null;
}

export function parseEmbedPreview(html: string): { title: string; thumbnail: string | null };

export function partnerFeedPayload(items: readonly (string | Partial<PartnerFeedItem>)[]): string;
