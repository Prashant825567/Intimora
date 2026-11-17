// Which backend the visitor is on, and whether it is the kind that hides data
// behind its own browser check.
//
// The load balancer answers `{ ok: true, data: { server, php } }`. `php: true`
// means the server answers cookie-less requests with an HTML check, so it is
// called directly with its session cookie, and (only) that host may send the
// browser through its own unlock page once. `php: false` (or a missing flag)
// means an ordinary API: no cookies, no redirect — just the direct call.
//
// There is no proxy anywhere in this path: the visitor's browser is the only
// client of the PHP host.
import {
  PHP_ORIGIN_OVERRIDE,
  UNLOCK_FRESH_MS,
  UNLOCK_MAX_TRIES,
  UNLOCK_MIN_GAP_MS,
  UNLOCK_SPLASH_MS,
} from "../config/php-backend.mjs";
import { setPhpMediaOrigin } from "./media-credentials.mjs";
import {
  clearUnlockAttempt,
  confirmUnlockSession,
  requestUnlockNavigation,
  shouldRequestUnlock,
} from "./unlock.mjs";

const state = { backend: null, php: false };
// One navigation per page: parallel requests that all hit the check must not
// each ask for a redirect.
let leaving = false;

export function setActiveTarget(target) {
  const backend = typeof target?.backend === "string" ? target.backend : null;
  const php = target?.php === true || Boolean(PHP_ORIGIN_OVERRIDE);
  state.backend = backend;
  state.php = php && Boolean(backend);
  // Media from a PHP host must drop its CORS attribute, or the cookie never goes.
  setPhpMediaOrigin(state.php ? backend : null);
}

export function activeTarget() {
  return { backend: state.backend, php: state.php };
}

export function isPhpBackend(origin) {
  return state.php && Boolean(origin) && origin === state.backend;
}

// True while the host's session is missing or unproven. The result drives the
// message on screen, never a redirect by itself.
export function phpSessionPending({ storage, now, freshMs = UNLOCK_FRESH_MS } = {}) {
  if (!state.php || !state.backend) return false;
  return shouldRequestUnlock({
    storage,
    now,
    freshMs,
    maxTries: UNLOCK_MAX_TRIES,
    minGapMs: UNLOCK_MIN_GAP_MS,
  });
}

// Returns true when the browser was sent to the host's own unlock page. Only a
// PHP backend ever gets here, and the attempt budget is bounded, so the redirect
// can never loop.
export function requestPhpUnlock(navigation = {}) {
  if (!state.php || !state.backend || leaving) return false;
  const requested = requestUnlockNavigation({
    phpOrigin: state.backend,
    freshMs: UNLOCK_FRESH_MS,
    maxTries: UNLOCK_MAX_TRIES,
    minGapMs: UNLOCK_MIN_GAP_MS,
    splashMs: UNLOCK_SPLASH_MS,
    ...navigation,
  });
  if (requested) leaving = true;
  return requested;
}

// A PHP answer that actually arrived is proof the cookie works: the window is
// quiet until the host's session would have expired.
export function confirmPhpSession({ storage, now } = {}) {
  if (!state.php) return;
  confirmUnlockSession(storage, now === undefined ? {} : { now });
  leaving = false;
}

// The visitor asked to try again ("Retry Connection"): give the unlock its full
// budget back instead of leaving the page dead for six hours.
export function resetPhpSession(storage) {
  clearUnlockAttempt(storage);
  leaving = false;
}
