export interface VisitorRequestOptions {
  discoveryUrl: string;
  fetcher?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  monotonicNow?: () => number;
  reuseStoredSelection?: boolean;
  backendOverride?: string;
  proxyBackend?: string;
  requestUnlock?: (context: { path: string; challenge: boolean }) => boolean;
}

export interface VisitorRequest {
  selectBackend(): Promise<string>;
  requestJson(path: string, init?: Pick<RequestInit, "method" | "signal">, pinnedBackend?: string): Promise<{ body: any; backend: string; invalidate(): void }>;
}

export function createVisitorRequest(options: VisitorRequestOptions): VisitorRequest;
