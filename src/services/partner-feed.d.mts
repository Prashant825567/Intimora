export const PARTNER_FEED_LIMIT: number;

export function decodeHtmlEntities(value: string): string;

export function parsePartnerFeed(
  text: string,
  options?: { limit?: number; hosts?: readonly string[] },
): string[];

export function partnerFeedPayload(urls: readonly string[]): string;
