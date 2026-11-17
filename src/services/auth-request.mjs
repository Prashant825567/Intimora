import { publicBackendBase } from "./public-url.mjs";

const VIDEO_ACTION = /^\/api\/videos\/[A-Za-z0-9_-]{1,128}\/(?:like|save)$/;
// Every account route is called with POST and a `text/plain` body, so the browser
// never sends a preflight. A preflight would leave without cookies (the Fetch
// spec forbids them on OPTIONS), which is exactly what a free host's JavaScript
// check answers with an HTML page — and an HTML page has no CORS headers.
const ACCOUNT_ROUTES = new Set([
  "/api/auth/me",
  "/api/auth/verify",
  "/api/auth/profile",
  "/api/user/referrals",
]);
// A "simple" content type: no preflight, and the JSON travels as plain text.
const SIMPLE_CONTENT_TYPE = "text/plain";
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
export function createAuthenticatedRequest({ selectBackend, allowedBackends, fetcher = fetch, requestUnlock = null }) {
  const allowed = new Set(allowedBackends);
  // The one-time unlock navigation is only worth asking for once per request, and
  // only when the caller supplied the hook.
  const notifyUnlock = (path) => {
    try {
      requestUnlock?.({ path });
    } catch {
      // A navigation that cannot start must not break the account screen.
    }
  };
  return async function request(path, { method, token, body, backend } = {}) {
    const routeAllowed = VIDEO_ACTION.test(path)
      ? method === "POST"
      : ACCOUNT_ROUTES.has(path) && (method === undefined || method === "POST");
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
      // The token travels in the body instead of an `Authorization` header: no
      // custom header and no JSON content type means no preflight at all.
      const payload = JSON.stringify({ token, ...(body && typeof body === "object" ? body : {}) });
      if (payload.length > 8192) throw new AccountRequestError();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetcher(`${target.origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": SIMPLE_CONTENT_TYPE },
        body: payload,
        // The pinned PHP host only recognises the visitor after its own check has
        // set a session cookie, so it has to be allowed to travel.
        credentials: "include", mode: "cors", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal,
      });
      const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) {
        // The host answered with its browser check instead of the account API.
        notifyUnlock(path);
        throw new AccountRequestError();
      }
      const json = await boundedJson(response);
      if (!response.ok || json?.ok !== true || !json.data || typeof json.data !== "object") {
        throw new AccountRequestError(errorCode(response.status, json?.error));
      }
      return { data: json.data, backend: target.origin };
    } catch (error) {
      controller.abort();
      // A CORS rejection and a refused connection both look like this; the PHP
      // host's check is the usual cause, so the unlock is offered once.
      if (!(error instanceof AccountRequestError)) notifyUnlock(path);
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError();
    } finally {
      clearTimeout(timer);
    }
  };
}
