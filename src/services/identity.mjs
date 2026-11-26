// The visitor's first step on every page load is the PHP identity host: it hands
// out the cookie its API needs and it is what writes the visitor row (IP, geo,
// browser, device). It runs before the load balancer is asked, so the server named
// afterwards can never change who was registered or where the cookie came from.
//
// The host hides its API behind a scripted browser check, so a cookieless POST
// comes back as an HTML page. That page only helps when the host is actually up,
// so the browser is sent through it once (with its own bounded guard) instead of
// looping on a host that is gone.
import {
  IDENTITY_UNLOCK_KEY,
  UNLOCK_FRESH_MS,
  UNLOCK_MAX_TRIES,
  UNLOCK_MIN_GAP_MS,
  UNLOCK_RETRY_MS,
  UNLOCK_SPLASH_MS,
} from "../config/php-backend.mjs";
import { clearUnlockAttempt, requestUnlockNavigation } from "./unlock.mjs";
import { publicHttpsUrl } from "./public-url.mjs";

const TIMEOUT_MS = 8_000;

// The configured identity origin, or null when the direct step is turned off.
export function identityOrigin(configured = typeof __INTIMORA_IDENTITY_URL__ === "string" ? __INTIMORA_IDENTITY_URL__ : "") {
  const url = publicHttpsUrl(typeof configured === "string" ? configured : "");
  return url ? url.replace(/\/+$/, "") : null;
}

async function answeredAtAll(fetcher, origin) {
  try {
    await fetcher(origin, { mode: "no-cors", credentials: "omit", redirect: "follow", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

function unlock(origin, options, challenge) {
  const requested = requestUnlockNavigation({
    phpOrigin: origin,
    href: options.href,
    storage: options.storage,
    now: options.now,
    key: IDENTITY_UNLOCK_KEY,
    freshMs: UNLOCK_FRESH_MS,
    retryMs: UNLOCK_RETRY_MS,
    maxTries: UNLOCK_MAX_TRIES,
    minGapMs: UNLOCK_MIN_GAP_MS,
    splashMs: options.splashMs ?? UNLOCK_SPLASH_MS,
    blocked: !challenge,
    navigate: options.navigate,
    setTimeoutImpl: options.setTimeoutImpl,
    document: options.document,
  });
  return { ok: false, challenge, unlocking: requested };
}

// Unlocks the identity host (when it asks) and writes one visitor row for this
// page load. Never throws: an identity step that fails must not hide the site.
export async function registerEntry(options = {}) {
  const origin = identityOrigin(options.origin);
  if (!origin) return { ok: false, skipped: true };
  const payload = typeof options.payload === "string" ? options.payload : "{}";
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response = null;
  try {
    response = await fetcher(`${origin}/api/visit`, {
      method: "POST",
      // A "simple" content type: the POST travels without a preflight, which is
      // the only kind a cookie-less free host answers with its check page.
      headers: { "Content-Type": "text/plain" },
      body: payload.slice(0, 2048),
      mode: "cors",
      // The cookie is the identity: it travels with the row, and the row's IP is
      // the one the host sees for this browser.
      credentials: "include",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    response = null;
  } finally {
    clearTimeout(timer);
  }

  if (response) {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) return unlock(origin, options, true);
    if (!response.ok) return { ok: false, status: response.status };
    try {
      const body = await response.json();
      if (body?.ok === true) {
        // The row is written; the guard window starts clean for the next visit.
        clearUnlockAttempt(options.storage, IDENTITY_UNLOCK_KEY);
        return { ok: true };
      }
    } catch { /* An answer this app cannot read proves nothing. */ }
    return { ok: false };
  }

  // Nothing came back. Only a host that answered at all can be helped by its own
  // check page; an unreachable host is reported instead of starting a loop.
  if (await answeredAtAll(fetcher, origin)) return unlock(origin, options, false);
  return { ok: false, down: true };
}
