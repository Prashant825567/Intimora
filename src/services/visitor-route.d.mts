export interface VisitorRequestOptions {
  discoveryUrl: string;
  fetcher?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  monotonicNow?: () => number;
  reuseStoredSelection?: boolean;
  backendOverride?: string;
  requestUnlock?: (context: { path: string; challenge: boolean }) => boolean;
  onTarget?: (target: { backend: string; php: boolean }) => void;
  onPhpSuccess?: () => void;
  onOutcome?: (outcome: { path: string; php: boolean; ok: boolean; challenge: boolean; blocked: boolean; status?: number }) => void;
}

export interface VisitorTarget {
  backend: string;
  php: boolean;
}

export interface VisitorRequest {
  selectBackend(): Promise<string>;
  selectTarget(): Promise<VisitorTarget>;
  resolveTarget(pinnedBackend?: string): Promise<VisitorTarget>;
  // `headers` carries at most one header: a bearer token for a public read the
  // backend answers differently when it knows who is asking.
  requestJson(path: string, init?: Pick<RequestInit, "method" | "signal" | "body" | "headers">, pinnedBackend?: string): Promise<{ body: any; backend: string; invalidate(): void }>;
}

export function createVisitorRequest(options: VisitorRequestOptions): VisitorRequest;
