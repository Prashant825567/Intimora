import type { ApiVideo, BackendCursor, CatalogResponse } from "./api";

export function collectCatalog(options: {
  firstPage: CatalogResponse;
  fetchPage: (cursor: BackendCursor) => Promise<CatalogResponse>;
  onPage: (videos: ApiVideo[], backend: string) => void;
  isCancelled?: () => boolean;
  pageSize?: number;
  maxPages?: number;
  pauseMs?: number;
}): Promise<{ complete: boolean; cancelled: boolean; pages: number }>;
