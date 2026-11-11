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
