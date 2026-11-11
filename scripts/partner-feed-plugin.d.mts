export const DEFAULT_FEED_TIMEOUT_MS: number;

export function requestPartnerFeed(
  feedUrl: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string[]>;

export function partnerFeedPlugin(options: {
  feedUrl: string;
  timeoutMs?: number;
  generate?: typeof requestPartnerFeed;
  offline?: boolean;
}): import("vite").Plugin;
