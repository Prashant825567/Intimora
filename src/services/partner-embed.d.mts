export const PARTNER_CAMPAIGN_SOURCE: string;
export const DEFAULT_PARTNER_EMBED_URL: string;
export const PARTNER_EMBED_HOSTS: readonly string[];

export function partnerEmbedUrl(
  value: string,
  options?: { source?: string; hosts?: readonly string[] },
): string | null;
