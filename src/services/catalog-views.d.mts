import type { Video } from "../data/mockVideos";

export function selectTrending(videos: Video[]): Video[];
export function selectNewReleases(videos: Video[], now?: number): Video[];
export function selectExclusive(videos: Video[]): Video[];
export const HOME_FILTERS: string[];
export function isAnimeVideo(video: Video): boolean;
export function selectHomeFilter(videos: Video[], filter?: "all" | "desi" | "anime" | "sponsored"): Video[];
