export const ANIME_SOURCE: string;
export const ANIME_FEED_VERSION: number;

export interface AnimeCard {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  embedUrl: string;
}

export interface AnimeList {
  id: string;
  title: string;
  cards: AnimeCard[];
}

export interface AnimeFeedList {
  id: string;
  title: string;
  itemIds: string[];
}

export function animeIdFromSlug(slug: string): string | null;
export function animeEmbedUrl(id: string): string | null;
export function parseAnimeListing(html: string, options?: { source?: string; limit?: number }): AnimeCard[];
export function animeFeedPayload(
  items: AnimeCard[],
  options?: { generatedAt?: string; lists?: AnimeFeedList[] },
): { version: number; source: string; generatedAt: string; lists: AnimeFeedList[]; items: AnimeCard[] };
export function animeCards(payload: unknown, options?: { limit?: number }): AnimeCard[];
export function animeLists(payload: unknown, options?: { perList?: number }): AnimeList[];
