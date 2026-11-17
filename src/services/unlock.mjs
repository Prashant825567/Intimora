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

function safely(action, fallback = null) {
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function readUnlockState(storage) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  if (!store) return {};
  const raw = safely(() => store.getItem(STORAGE_KEY));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function markUnlockAttempt(storage, { now = Date.now(), blocked = false } = {}) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  if (!store) return;
  safely(() => store.setItem(STORAGE_KEY, JSON.stringify({ at: now, blocked })));
}

export function clearUnlockAttempt(storage) {
  const store = storage === undefined ? safely(() => globalThis.localStorage) : storage;
  safely(() => store?.removeItem(STORAGE_KEY));
}

// True when a new unlock is worth asking for: never twice inside the window, and
// never again once the host has refused to let us through.
export function shouldRequestUnlock({ storage, now = Date.now(), freshMs } = {}) {
  const state = readUnlockState(storage);
  if (state.blocked === true) return false;
  const at = Number(state.at);
  if (!Number.isFinite(at) || at <= 0) return true;
  return now - at > freshMs || now < at - 60_000;
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
  const back = typeof href === "string" && href ? href : "https://intimora.new.tg/";
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
  splashMs = 700,
  document: doc = globalThis.document,
  navigate = (url) => { globalThis.location.assign(url); },
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  if (!shouldRequestUnlock({ storage, now, freshMs })) return false;
  const url = unlockUrl(phpOrigin, href);
  if (!url) return false;
  markUnlockAttempt(storage, { now });
  showUnlockSplash({ document: doc });
  // Give the splash a frame or two so the visitor never sees a frozen page.
  setTimeoutImpl(() => navigate(url), Math.max(0, splashMs));
  return true;
}

// On the way back the flag is removed from the address bar and the guard is
// cleared, so the next six hours are normal direct calls.
export function completeUnlockReturn({
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  storage,
  now = Date.now(),
} = {}) {
  if (!loc?.search?.includes(UNLOCK_QUERY)) return false;
  markUnlockAttempt(storage, { now });
  const params = new URLSearchParams(loc.search);
  params.delete(UNLOCK_QUERY);
  const search = params.toString();
  const clean = `${loc.pathname}${search ? `?${search}` : ""}${loc.hash ?? ""}`;
  safely(() => hist.replaceState(hist.state, "", clean));
  removeUnlockSplash({ document: globalThis.document });
  return true;
}
