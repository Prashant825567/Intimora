export const DEFAULT_AD_TIMEOUT_MS: number;

export function requestTagText(url: string, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<string>;

export function buildAdSnapshot(options: {
  tagUrl: string;
  timeoutMs?: number;
  skipFallbackSeconds?: number;
  fetchImpl?: typeof fetch;
  resolve?: typeof import("../src/services/vast.mjs").resolveVastAd;
}): Promise<import("../src/services/vast-loader.mjs").VastAdData | null>;

export function adFallbackPlugin(options: {
  tagUrl: string;
  timeoutMs?: number;
  skipFallbackSeconds?: number;
  generate?: typeof buildAdSnapshot;
  offline?: boolean;
}): import("vite").Plugin;
