export interface ActiveTarget {
  backend: string | null;
  php: boolean;
}

export function setActiveTarget(target: { backend?: string | null; php?: boolean } | null): void;
export function activeTarget(): ActiveTarget;
export function isPhpBackend(origin: string | null | undefined): boolean;
export function phpSessionPending(options?: { storage?: any; now?: number; freshMs?: number }): boolean;
export function requestPhpUnlock(navigation?: { path?: string; challenge?: boolean; cors?: boolean }, storage?: any): boolean;
export function notePhpFailure(detail?: { challenge?: boolean; blocked?: boolean; cors?: boolean; shape?: boolean; status?: number; path?: string } | null): void;
export function phpFailureReason(): { kind: string; status?: number; path?: string } | null;
export function confirmPhpSession(options?: { storage?: any; now?: number }): void;
export function resetPhpSession(storage?: any): void;
