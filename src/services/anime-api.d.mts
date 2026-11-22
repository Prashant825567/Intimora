export const ANIME_API_BASE: string;

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

export function animeIdFromSlug(slug: string): string | null;
export function animeEmbedUrl(id: string): string | null;
export function parseAnimeResults(payload: unknown, options?: { limit?: number }): AnimeCard[];
export function fetchAnimeRows(options?: {
  base?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  limit?: number;
}): Promise<AnimeList[]>;
export function animeStreamFrom(payload: unknown): string | null;
export function isHlsLink(url: string | null | undefined): boolean;
export function fetchAnimeStream(id: string, options?: {
  base?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null>;
export function animeSearch(cards: AnimeCard[], query: string, options?: { limit?: number }): AnimeCard[];
