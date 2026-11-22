// Premium refusals arrive as the host's own sentence; the code keeps its shape so
// the caller can render its own wording instead.
type AccountErrorCode = "unavailable" | "unauthorized" | "username_taken" | "invalid_referral" | "already_exists" | "invalid_profile" | "unconfirmed"
  | "none_available" | "not_enough" | "too_few";
export class AccountRequestError extends Error {
  constructor(code?: AccountErrorCode);
  code: AccountErrorCode;
}
export function createAuthenticatedRequest(options: {
  selectBackend: () => Promise<string>;
  allowedBackends: string[];
  fetcher?: typeof fetch;
  requestUnlock?: (context: { path: string }) => void;
  resolveTarget?: (pinnedBackend?: string) => Promise<{ backend: string; php: boolean }>;
  trustedPhpBackend?: () => string | null;
}): (path: string, options: {
  method?: "GET" | "POST";
  token: string;
  body?: unknown;
  backend?: string;
}) => Promise<{ data: Record<string, unknown>; backend: string }>;
