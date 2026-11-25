export declare function setViewerToken(value: string, expiresAtSeconds: number): void;
export declare function clearViewerToken(): void;
export declare function setViewerRefresher(refresh: (() => Promise<void>) | null): void;
export declare function viewerQuery(): string;
export declare function ensureViewerToken(): Promise<void>;
