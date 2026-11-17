export interface ActiveTarget {
  backend: string | null;
  php: boolean;
}

export function setActiveTarget(target: { backend?: string | null; php?: boolean } | null): void;
export function activeTarget(): ActiveTarget;
export function isPhpBackend(origin: string | null | undefined): boolean;
export function requestPhpUnlock(): boolean;
