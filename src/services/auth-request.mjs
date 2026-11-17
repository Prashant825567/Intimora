import { recordDiagnostic } from "./diagnostics.mjs";
import { publicBackendBase } from "./public-url.mjs";

const VIDEO_ACTION = /^\/api\/videos\/[A-Za-z0-9_-]{1,128}\/(?:like|save)$/;
// Every account route is called with POST and a `text/plain` body, so the browser
// never sends a preflight. A preflight would leave without cookies (the Fetch
// spec forbids them on OPTIONS), which is exactly what a free host's JavaScript
// check answers with an HTML page — and an HTML page has no CORS headers.
const GET_ROUTES = new Set(["/api/auth/me", "/api/user/referrals"]);
const POST_ROUTES = new Set(["/api/auth/verify", "/api/auth/profile"]);
const ACCOUNT_ROUTES = new Set([...GET_ROUTES, ...POST_ROUTES]);
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
export function createAuthenticatedRequest({
  selectBackend,
  allowedBackends,
  fetcher = fetch,
  requestUnlock = null,
  // Resolves the visitor's target (backend + whether it is a PHP host). Without
  // it, the old single-origin behaviour is assumed.
  resolveTarget = null,
  // The backend the load balancer just named. A PHP host discovered at runtime
  // cannot be on a build-time allowlist, so it is trusted explicitly instead.
  trustedPhpBackend = null,
} = {}) {
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
    const action = VIDEO_ACTION.test(path);
    const accountRoute = ACCOUNT_ROUTES.has(path);
    if (typeof token !== "string" || token.length < 1 || token.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(token)) {
      throw new AccountRequestError();
    }
    let timer;
    let php = false;
    const controller = new AbortController();
    try {
      const resolved = resolveTarget
        ? await resolveTarget(backend)
        : { backend: backend ?? await selectBackend(), php: false };
      php = resolved?.php === true;
      const selected = publicBackendBase(resolved?.backend);
      if (!selected) throw new AccountRequestError();
      const target = new URL(selected);
      // A PHP host is behind a cookie-based browser check, so it gets the
      // preflight-free shape: always POST, token in the body. An ordinary backend
      // keeps its documented methods and its `Authorization: Bearer` contract.
      const effectiveMethod = php ? "POST" : (method ?? (action ? "POST" : "GET"));
      const routeAllowed = action
        ? effectiveMethod === "POST"
        : accountRoute
          && (php
            ? effectiveMethod === "POST"
            : (effectiveMethod === "GET" ? GET_ROUTES.has(path) : POST_ROUTES.has(path)));
      const trusted = allowed.has(target.origin)
        || (php && php === true && target.origin === publicBackendBase(trustedPhpBackend?.()));
      if (!routeAllowed || !trusted || target.pathname !== "/" || target.port) throw new AccountRequestError();
      // Refresh an expired visitor selection independently, but keep this
      // video's action pinned to the backend that supplied it.
      if (backend !== undefined) void Promise.resolve().then(selectBackend).catch(() => {});
      const payload = effectiveMethod === "POST"
        ? (php
          // The host reads the token from the body; the action fields travel too.
          ? JSON.stringify({ token, ...(body && typeof body === "object" ? body : {}) })
          : JSON.stringify(body ?? {}))
        : undefined;
      if (payload && payload.length > 8192) throw new AccountRequestError();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetcher(`${target.origin}${path}`, {
        method: effectiveMethod,
        headers: php
          ? { "Content-Type": SIMPLE_CONTENT_TYPE }
          : { Authorization: `Bearer ${token}`, ...(effectiveMethod === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(payload === undefined ? {} : { body: payload }),
        credentials: php ? "include" : "omit",
        mode: "cors", cache: "no-store", referrerPolicy: "no-referrer",
        // The PHP host may redirect to its own check page first; an ordinary
        // backend keeps the stricter behaviour.
        redirect: php ? "follow" : "error", signal: controller.signal,
      });
      const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) {
        // The host answered with its browser check instead of the account API.
        recordDiagnostic("account", { path, php, challenge: true });
        notifyUnlock(path);
        throw new AccountRequestError();
      }
      const json = await boundedJson(response);
      if (!response.ok || json?.ok !== true || !json.data || typeof json.data !== "object") {
        recordDiagnostic("account", { path, php, status: response.status });
        throw new AccountRequestError(errorCode(response.status, json?.error));
      }
      return { data: json.data, backend: target.origin };
    } catch (error) {
      controller.abort();
      // A CORS rejection and a refused connection both look like this; the PHP
      // host's check is the usual cause, so the unlock is offered once.
      if (!(error instanceof AccountRequestError)) {
        recordDiagnostic("account", { path, php, blocked: true });
        notifyUnlock(path);
      }
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError();
    } finally {
      clearTimeout(timer);
    }
  };
}
