type AccountErrorCode = "unavailable" | "unauthorized" | "username_taken" | "invalid_referral" | "already_exists" | "invalid_profile" | "unconfirmed";
export class AccountRequestError extends Error {
  constructor(code?: AccountErrorCode);
  code: AccountErrorCode;
}
export function createAuthenticatedRequest(options: {
  selectBackend: () => Promise<string>;
  allowedBackends: string[];
  fetcher?: typeof fetch;
}): (path: string, options: {
  method?: "GET" | "POST";
  token: string;
  body?: unknown;
  backend?: string;
}) => Promise<{ data: Record<string, unknown>; backend: string }>;
