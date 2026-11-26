// The PHP host sits behind a scripted browser check that only a real page
// navigation can pass: the check sets a cookie from JavaScript. So when a direct
// API call comes back as that HTML page (or cannot be read at all), the browser
// is sent once to `<php>/__unlock?back=<this page>`, the check runs there, and
// that page returns the visitor to where they were — with `?__unlocked=1` so the
// flow is not repeated.
//
// This module holds that logic: the once-per-window guard, the URL builder, the
// splash, and the cleanup when the visitor comes back. It is deliberately free of
// React so it can run before the app mounts.
const STORAGE_KEY = "intimora_unlock_v1";
export const UNLOCK_QUERY = "__unlocked";
// Set for the page load that the host sent back to us: the app uses it to give
// the first request a second chance instead of painting an error immediately.
let returnedThisLoad = false;
// The host's own check page is the only thing that can hand out its cookie, so
// this flow happens in the browser, once, and without any proxy in between.
const MIN_GAP_MS = 4_000;
const MAX_TRIES = 3;
const CLOCK_SLACK_MS = 60_000;
// How long a cookie proven by this page load stays trusted while the page remains
// open. It follows the host's six-hour session: the check runs once per visit, not
// once per request, and a tab that outlives the cookie meets the check again.
const IN_PAGE_PROOF_MS = 5.5 * 60 * 60 * 1000;

function safely(action, fallback = null) {
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function readUnlockState(storage, key = STORAGE_KEY) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  if (!store) return {};
  const raw = safely(() => store.getItem(key));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// `key` lets a second PHP host (the identity host) keep its own budget instead of
// spending the one that belongs to the host serving the catalogue.
function write(storage, state, key = STORAGE_KEY) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  if (!store) return;
  safely(() => store.setItem(key, JSON.stringify(state)));
}

// Remembers that the browser left for the check page. `tries` counts the
// redirects inside one window, so a host that never confirms a session is
// dropped after a few attempts instead of bouncing the visitor forever.
export function markUnlockAttempt(storage, { now = Date.now(), blocked = false, freshMs = 5.5 * 60 * 60 * 1000, key = STORAGE_KEY } = {}) {
  const state = readUnlockState(storage, key);
  const at = Number(state.at);
  const insideWindow = Number.isFinite(at) && at > 0 && now >= at - CLOCK_SLACK_MS && now - at <= freshMs;
  const tries = insideWindow ? (Number(state.tries) || 0) + 1 : 1;
  write(storage, { at: now, tries, ok: false, ...(blocked ? { blocked: true } : {}) }, key);
}

// The first PHP answer that actually arrived proves the cookie works; from then
// on this window is quiet until the host's six-hour session would have expired.
export function confirmUnlockSession(storage, { now = Date.now(), key = STORAGE_KEY } = {}) {
  provenThisLoad = true;
  write(storage, { at: now, tries: 0, ok: true }, key);
}

// Whether the cookie was proven by *this* page load. The cookie itself can live for
// hours, but a new visit to a PHP-backed site is a new visit: the host's check is
// also what registers the visitor there, so it runs once per visit rather than once
// per cookie. This flag is module state, so a reload, a new tab or a return tomorrow
// starts without it — and the stored `ok` from yesterday can never suppress today's
// check.
let provenThisLoad = false;

// Exported for the diagnostic trace only: what the current page load has proven.
export function provenSessionThisLoad() {
  return provenThisLoad;
}

export function hasProvenSession({ storage, now = Date.now(), freshMs = 5.5 * 60 * 60 * 1000, key = STORAGE_KEY } = {}) {
  const state = readUnlockState(storage, key);
  const at = Number(state.at);
  if (state.ok !== true || !Number.isFinite(at) || at <= 0) return false;
  // A session proven on an earlier page load does not carry over: the next visit
  // meets the host's check again (see `provenThisLoad`).
  if (!provenThisLoad) return false;
  if (now < at - CLOCK_SLACK_MS) return true;
  return now - at <= freshMs;
}

export function clearUnlockAttempt(storage, key = STORAGE_KEY) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  safely(() => store?.removeItem(key));
}

// True when a new unlock is worth asking for: a confirmed session lasts the
// host's window, an unconfirmed one is retried a bounded number of times with a
// minimum gap so the visitor never sees a redirect loop.
export function shouldRequestUnlock({ storage, now = Date.now(), freshMs = 5.5 * 60 * 60 * 1000, retryMs = 2 * 60 * 1000, maxTries = MAX_TRIES, minGapMs = MIN_GAP_MS, key = STORAGE_KEY } = {}) {
  const state = readUnlockState(storage, key);
  const at = Number(state.at);
  // A refusal the browser caused (no CORS header) is not retried in a loop, but
  // it must not leave the tab dead either: the same short window applies.
  if (state.blocked === true && Number.isFinite(at) && now - at > retryMs) return true;
  if (state.blocked === true) return false;
  // No attempt yet, or a clock that jumped backwards: a fresh one is allowed.
  if (!Number.isFinite(at) || at <= 0) return true;
  if (now < at - CLOCK_SLACK_MS) return true;
  // An entry written by an earlier visit is the first thing a new visit hits: it is
  // not this page's proof, so the host's check runs once for the new visit. (Inside
  // this page load the proof is in `provenThisLoad`, and the minutes after it are
  // handled below.)
  if (!provenThisLoad && (state.ok === true || now - at > retryMs)) return true;
  // A session proven by *this* page load is quiet for as long as the page is open
  // (the stored `ok` alone proves nothing about a new visit). An attempt that never
  // produced an answer expires quickly, so a temporary outage heals itself instead
  // of leaving the tab dead.
  if (state.ok === true) return !provenThisLoad || now - at > Math.max(freshMs, IN_PAGE_PROOF_MS);
  if (now - at > retryMs) return true;
  if (minGapMs > 0 && now - at < minGapMs) return false;
  const tries = Number(state.tries);
  return !(Number.isFinite(tries) && tries >= maxTries);
}

export function unlockReturnedThisLoad() {
  return returnedThisLoad;
}

export function isChallengeContentType(contentType) {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}

// The visitor must land back exactly where they were, including a `/watch/<id>`
// path, so the current address travels in the query string.
export function unlockUrl(phpOrigin, href, { query = UNLOCK_QUERY } = {}) {
  if (typeof phpOrigin !== "string" || !phpOrigin) return null;
  let origin;
  try {
    origin = new URL(phpOrigin).origin;
  } catch {
    return null;
  }
  if (!/^https:$/.test(new URL(origin).protocol)) return null;
  const back = typeof href === "string" && href ? href : "https://intimora.net/";
  return `${origin}/__unlock?back=${encodeURIComponent(back)}`;
}

// The splash says what is happening instead of leaving a blank page behind the
// navigation, and it is plain DOM so it also works before React has mounted.
export function showUnlockSplash({ document: doc = globalThis.document, message } = {}) {
  if (!doc?.body) return;
  if (doc.querySelector(".unlock-splash")) return;
  const splash = doc.createElement("div");
  splash.className = "unlock-splash";
  splash.setAttribute("role", "status");
  splash.setAttribute("aria-live", "polite");
  splash.innerHTML = `
    <div class="unlock-splash__card">
      <img class="unlock-splash__logo" src="/logo.png" alt="Intimora" />
      <span class="unlock-splash__ring" aria-hidden="true"></span>
      <p class="unlock-splash__title">${message ?? "Ek second… verifying your connection"}</p>
      <p class="unlock-splash__note">You will be brought back here automatically.</p>
    </div>`;
  doc.body.appendChild(splash);
}

export function removeUnlockSplash({ document: doc = globalThis.document } = {}) {
  safely(() => doc?.querySelector(".unlock-splash")?.remove());
}

// Called by the API layer when a direct PHP request failed. Returns true when the
// browser was sent to the unlock page (the caller should stop waiting), false
// when this window already used its attempt and the caller must fall back.
export function requestUnlockNavigation({
  phpOrigin,
  href = globalThis.location?.href,
  storage,
  now = Date.now(),
  freshMs = 5.5 * 60 * 60 * 1000,
  retryMs = 2 * 60 * 1000,
  blocked = false,
  maxTries = MAX_TRIES,
  minGapMs = MIN_GAP_MS,
  splashMs = 700,
  document: doc = globalThis.document,
  navigate = (url) => { globalThis.location.assign(url); },
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  key = STORAGE_KEY,
} = {}) {
  if (!shouldRequestUnlock({ storage, now, freshMs, retryMs, maxTries, minGapMs, key })) return false;
  const url = unlockUrl(phpOrigin, href);
  if (!url) return false;
  markUnlockAttempt(storage, { now, freshMs, blocked, key });
  showUnlockSplash({ document: doc });
  // Give the splash a frame or two so the visitor never sees a frozen page.
  setTimeoutImpl(() => navigate(url), Math.max(0, splashMs));
  return true;
}

// On the way back the flag is removed from the address bar and the splash goes
// away. The guard is left alone: only a PHP answer that actually arrived marks
// the session as confirmed (see confirmUnlockSession).
export function completeUnlockReturn({
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  storage,
  now = Date.now(),
} = {}) {
  if (!loc?.search?.includes(UNLOCK_QUERY)) return false;
  returnedThisLoad = true;
  const params = new URLSearchParams(loc.search);
  params.delete(UNLOCK_QUERY);
  const search = params.toString();
  const clean = `${loc.pathname}${search ? `?${search}` : ""}${loc.hash ?? ""}`;
  safely(() => hist.replaceState(hist.state, "", clean));
  removeUnlockSplash({ document: globalThis.document });
  return true;
}
