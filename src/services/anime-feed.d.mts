export const ANIME_SOURCE: string;
export const ANIME_FEED_VERSION: number;

export interface AnimeCard {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  embedUrl: string;
}

export function animeIdFromSlug(slug: string): string | null;
export function animeEmbedUrl(id: string): string | null;
export function parseAnimeListing(html: string, options?: { source?: string; limit?: number }): AnimeCard[];
export function animeFeedPayload(items: AnimeCard[], options?: { generatedAt?: string }): { version: number; source: string; generatedAt: string; items: AnimeCard[] };
export function animeCards(payload: unknown, options?: { limit?: number }): AnimeCard[];
