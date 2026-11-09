import { publicBackendBase } from "./public-url.mjs";

const VIDEO_ACTION = /^\/api\/videos\/[A-Za-z0-9_-]{1,128}\/(?:like|save)$/;
const GET_ROUTES = new Set(["/api/auth/me", "/api/user/referrals"]);
const POST_ROUTES = new Set(["/api/auth/verify", "/api/auth/profile"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UNAVAILABLE = "Account service is temporarily unavailable.";

export class AccountRequestError extends Error {
  constructor(code = "unavailable") {
    super(UNAVAILABLE);
    this.name = "AccountRequestError";
    this.code = code;
  }
}

async function boundedJson(response) {
  const announced = Number(response.headers?.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) throw new AccountRequestError();
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new AccountRequestError();
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new AccountRequestError();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function errorCode(status, error) {
  if (status === 401) return "unauthorized";
  if (status !== 400 || typeof error !== "string") return "unavailable";
  if (error === "Username already exists") return "username_taken";
  if (error === "Invalid referral code") return "invalid_referral";
  if (error === "User already exists") return "already_exists";
  if (error === "Name and username required") return "invalid_profile";
  return "unavailable";
}

// Tokens are sent only to exact configured origins. The Worker is still used to
// select the backend; this allowlist prevents a hostile selection from stealing
// a Firebase token. Video actions may use their original, trusted backend.
export function createAuthenticatedRequest({ selectBackend, allowedBackends, fetcher = fetch }) {
  const allowed = new Set(allowedBackends);
  return async function request(path, { method = "GET", token, body, backend } = {}) {
    const routeAllowed = method === "GET" ? GET_ROUTES.has(path)
      : method === "POST" && (POST_ROUTES.has(path) || VIDEO_ACTION.test(path));
    if (!routeAllowed || typeof token !== "string" || token.length < 1 || token.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(token)) {
      throw new AccountRequestError();
    }
    let timer;
    const controller = new AbortController();
    try {
      const selected = publicBackendBase(backend ?? await selectBackend());
      if (!selected) throw new AccountRequestError();
      const target = new URL(selected);
      if (target.pathname !== "/" || target.port || !allowed.has(target.origin)) throw new AccountRequestError();
      // Refresh an expired visitor selection independently, but keep this
      // video's action pinned to the backend that supplied it.
      if (backend !== undefined) void Promise.resolve().then(selectBackend).catch(() => {});
      const payload = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
      if (payload && payload.length > 8192) throw new AccountRequestError();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetcher(`${target.origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(payload === undefined ? {} : { body: payload }),
        credentials: "omit", mode: "cors", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal,
      });
      const json = await boundedJson(response);
      if (!response.ok || json?.ok !== true || !json.data || typeof json.data !== "object") {
        throw new AccountRequestError(errorCode(response.status, json?.error));
      }
      return { data: json.data, backend: target.origin };
    } catch (error) {
      controller.abort();
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError();
    } finally {
      clearTimeout(timer);
    }
  };
}
