import type { VastAdData } from "./vast-loader.mjs";

export function normaliseCachedAd(ad: unknown): (VastAdData & { source: "cached" }) | null;

export function loadCachedAd(
  url?: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<(VastAdData & { source: "cached" }) | null>;
