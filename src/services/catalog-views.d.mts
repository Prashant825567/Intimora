import type { Video } from "../data/mockVideos";

export function selectTrending(videos: Video[]): Video[];
export function selectNewReleases(videos: Video[], now?: number): Video[];
export function selectExclusive(videos: Video[]): Video[];
