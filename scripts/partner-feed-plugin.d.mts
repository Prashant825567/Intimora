export const DEFAULT_FEED_TIMEOUT_MS: number;

export function requestPartnerFeed(
  feedUrl: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string[]>;

export function enrichPartnerItems(
  embedUrls: readonly string[],
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; concurrency?: number; limit?: number },
): Promise<import("../src/services/partner-feed.mjs").PartnerFeedItem[]>;

export function partnerFeedPlugin(options: {
  feedUrl: string;
  timeoutMs?: number;
  generate?: typeof requestPartnerFeed;
  enrich?: typeof enrichPartnerItems;
  offline?: boolean;
}): import("vite").Plugin;
