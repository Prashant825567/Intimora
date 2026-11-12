export const SPONSORED_EVERY: number;

export interface SponsoredCard {
  id: string;
  embedUrl: string;
  title: string;
  thumbnail: string | null;
}

export function sponsoredCards(payload: unknown, options?: { limit?: number }): SponsoredCard[];

export type GridEntry<T> =
  | { kind: "video"; video: T }
  | { kind: "sponsored"; card: SponsoredCard };

export function interleaveSponsored<T>(
  videos: readonly T[],
  cards: readonly SponsoredCard[],
  options?: { every?: number },
): GridEntry<T>[];
