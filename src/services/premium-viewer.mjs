// A premium decision belongs to an account, but the catalogue and detail reads
// are plain GETs: the PHP host refuses the CORS preflight an Authorization
// header would trigger, and a raw Firebase token must never sit in a URL.
//
// So the account exchanges its Firebase token once (a preflight-free POST) for a
// short-lived signed viewer token. The video routes accept it as `?viewer=...`
// and read the uid from its signature, which is enough to shape the answer for
// that account. It carries no identity a browser can use elsewhere and it
// expires on its own.
//
// This module only holds the token and the refresher; it has no React and no
// network code of its own, so both the API layer and the account hook can use it
// without an import cycle.
let token = "";
let expiresAtMs = 0;
// A closure bound to the signed-in user, registered by the account hook.
let refresher = null;
let inflight = null;

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export function setViewerToken(value, expiresAtSeconds) {
  token = typeof value === "string" && value.length <= 4096 ? value : "";
  const until = Number(expiresAtSeconds);
  expiresAtMs = Number.isFinite(until) && until > 0 ? until * 1000 : 0;
}

export function clearViewerToken() {
  token = "";
  expiresAtMs = 0;
  inflight = null;
}

// `refresh` mints a new token for the account that registered it. Called with
// null on sign-out so a stale token can never act for the next visitor.
export function setViewerRefresher(refresh) {
  refresher = typeof refresh === "function" ? refresh : null;
  if (!refresher) clearViewerToken();
}

function valid() {
  return token !== "" && expiresAtMs - Date.now() > REFRESH_MARGIN_MS;
}

// The query fragment for one video read, or "" for a guest.
export function viewerQuery() {
  return valid() ? `viewer=${encodeURIComponent(token)}` : "";
}

// Makes sure the next video read carries a usable token. A tab that has been
// open for hours refreshes here instead of silently falling back to "guest",
// which is what used to turn a premium click into a backend refusal.
export function ensureViewerToken() {
  if (valid()) return Promise.resolve();
  if (!refresher) return Promise.resolve();
  if (inflight) return inflight;
  inflight = Promise.resolve()
    .then(() => refresher())
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}
