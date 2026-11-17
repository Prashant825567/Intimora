export const RECOVERY_LIMIT: number;
export const RECOVERY_DELAY_MS: number;
export const MEDIA_ERR_ABORTED: number;
export const MEDIA_ERR_NETWORK: number;
export const MEDIA_ERR_DECODE: number;
export const MEDIA_ERR_SRC_NOT_SUPPORTED: number;

export function shouldAutoRecover(options?: { code?: number; recoveries?: number; maxRecoveries?: number }): boolean;
export function playbackFailureMessage(options?: { code?: number }): string;
