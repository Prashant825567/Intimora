export interface LikeCount { id: string; likes: number; version: number }
export const LIKE_COUNT_BATCH_SIZE: number;
export function likeCountKey(backend: string, id: string): string;
export function readLikeCount(id: string, value: unknown): LikeCount | null;
export function parseLikeCounts(data: unknown, requestedIds: string[]): LikeCount[];
export function mergeLikeCounts(previous: Map<string, LikeCount>, backend: string, records: LikeCount[]): Map<string, LikeCount>;
