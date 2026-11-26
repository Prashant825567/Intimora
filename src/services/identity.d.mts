export interface RegisterEntryOptions {
  payload?: string;
  origin?: string;
  fetcher?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  href?: string;
  now?: number;
  splashMs?: number;
  navigate?: (url: string) => void;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  document?: Document;
}

export interface RegisterEntryResult {
  ok: boolean;
  skipped?: boolean;
  status?: number;
  down?: boolean;
  challenge?: boolean;
  unlocking?: boolean;
}

export function identityOrigin(configured?: string): string | null;

export function registerEntry(options?: RegisterEntryOptions): Promise<RegisterEntryResult>;
