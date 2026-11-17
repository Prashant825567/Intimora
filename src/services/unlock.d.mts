export const UNLOCK_QUERY: string;

export interface UnlockState {
  at?: number;
  blocked?: boolean;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

export function readUnlockState(storage?: Store): UnlockState;
export function markUnlockAttempt(storage?: Store, options?: { now?: number; blocked?: boolean }): void;
export function clearUnlockAttempt(storage?: Store): void;
export function shouldRequestUnlock(options?: { storage?: Store; now?: number; freshMs?: number }): boolean;
export function isChallengeContentType(contentType: string | null | undefined): boolean;
export function unlockUrl(phpOrigin: string, href?: string, options?: { query?: string }): string | null;
export function showUnlockSplash(options?: { document?: Document; message?: string }): void;
export function removeUnlockSplash(options?: { document?: Document }): void;
export function requestUnlockNavigation(options?: {
  phpOrigin?: string;
  href?: string;
  storage?: Store;
  now?: number;
  freshMs?: number;
  splashMs?: number;
  document?: Document;
  navigate?: (url: string) => void;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
}): boolean;
export function completeUnlockReturn(options?: {
  location?: Location;
  history?: History;
  storage?: Store;
  now?: number;
}): boolean;
