export const PARTNER_CAMPAIGN_SOURCE: string;
export const DEFAULT_PARTNER_EMBED_URL: string;
export const PARTNER_EMBED_HOSTS: readonly string[];
export const PARTNER_FEED_HOSTS: readonly string[];

export function partnerEmbedUrl(
  value: string,
  options?: { source?: string; hosts?: readonly string[]; requireVideoPath?: boolean },
): string | null;

export function partnerFeedUrl(
  value: string,
  options?: { source?: string },
): string | null;

export interface PartnerSource {
  mode: "feed" | "embed";
  url: string;
}

export function partnerSource(
  value: string,
  options?: { source?: string; hosts?: readonly string[] },
): PartnerSource | null;
