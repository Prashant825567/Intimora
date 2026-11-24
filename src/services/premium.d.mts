export interface PremiumReferrals {
  total: number;
  used: number;
  available: number;
  availableCodes: string[];
  secondsEach: number;
  hoursEach: number;
}

export interface PremiumStatus {
  active: boolean;
  until: number;
  remainingSeconds: number;
  /** The server's clock when it answered (epoch seconds); 0 when it sent none. */
  serverNow: number;
  /** When this answer reached the browser (`Date.now()`), for the local tick. */
  receivedAt?: number;
  referralCode: string;
  referrals: PremiumReferrals;
}

export interface PremiumEntry {
  id: string;
  seconds: number;
  refsUsed: string[];
  startedAt: number;
  endsAt: number;
  status: PremiumStatus | null;
}

export interface PremiumPeriod {
  id: string;
  source: string;
  seconds: number;
  refsUsed: string[];
  amountPaise: number;
  startedAt: number;
  endsAt: number;
  at: number;
}

export interface PremiumHistory {
  periods: PremiumPeriod[];
  total: {
    seconds: number;
    amountPaise: number;
    bySource: Record<string, { periods: number; seconds: number; amountPaise: number }>;
  };
  status: PremiumStatus | null;
}

export function parsePremiumStatus(payload: unknown): PremiumStatus | null;
export function parsePremiumEntry(payload: unknown): PremiumEntry | null;
export function parsePremiumPeriods(payload: unknown): PremiumHistory;
export function premiumSecondsLeft(status: PremiumStatus | null, now?: number): number;
export function redemptionSeconds(status: PremiumStatus | null, count: number): number;
export function redeemErrorCode(message: unknown): "none_available" | "not_enough" | "too_few" | "unavailable";
export function redeemErrorMessage(code: string): string;
export const PREMIUM_CODES: string[];
export function formatPremiumWindow(totalSeconds: number): string;
