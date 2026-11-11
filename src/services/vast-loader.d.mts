export interface VastAdData {
  id: string;
  system: string;
  title: string;
  mediaUrl: string;
  mediaType: string;
  durationSeconds: number | null;
  skipAfterSeconds: number | null;
  skippable: boolean;
  clickThrough: string | null;
  clickTracking: string[];
  impressions: string[];
  errors: string[];
  events: Record<string, string[]>;
  tag: string;
  source?: "live" | "cached";
}

export function requestVastText(url: string, timeoutMs?: number): Promise<string>;

export function loadVastAd(
  tagUrl: string,
  options?: {
    timeoutMs?: number;
    skipFallbackSeconds?: number;
    maxWrappers?: number;
    fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  },
): Promise<VastAdData | null>;

export function loadPreRoll(
  tagUrl: string,
  options?: {
    timeoutMs?: number;
    skipFallbackSeconds?: number;
    maxWrappers?: number;
    cachedUrl?: string;
    liveBudgetMs?: number;
    fetchText?: (url: string, timeoutMs: number) => Promise<string>;
    fetchCached?: (url: string) => Promise<(VastAdData & { source: "cached" }) | null>;
  },
): Promise<VastAdData | null>;
