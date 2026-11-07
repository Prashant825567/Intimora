export interface VisitorRequestOptions {
  fetcher?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
}

export function createVisitorRequest(options?: VisitorRequestOptions): (
  url: string,
  init?: RequestInit,
) => Promise<any>;
