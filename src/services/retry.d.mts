export const CATALOG_RETRY_DELAYS_MS: number[];
export const UNLOCK_RETRY_DELAYS_MS: number[];
export const SHARED_LINK_RETRY_DELAYS_MS: number[];
export const SEARCH_RETRY_DELAYS_MS: number[];

export function retryWithDelays<T>(
  task: (attempt: number) => Promise<T>,
  options?: {
    delays?: number[];
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    sleep?: (ms: number) => Promise<unknown>;
  },
): Promise<T>;
