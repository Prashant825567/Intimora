// Which backend the visitor is on, and whether it is the kind that hides data
// behind its own browser check.
//
// The load balancer answers `{ ok: true, data: { server, php } }`. `php: true`
// means the server answers cookie-less requests with an HTML check, so it needs
// the session-cookie dance: requests carry credentials, a check page triggers the
// one-time unlock navigation, and the proxy is kept as a fallback. `php: false`
// (or a missing flag) means an ordinary API: no cookies, no redirect, no proxy —
// just the direct call, exactly like before.
import { UNLOCK_FRESH_MS, UNLOCK_SPLASH_MS } from "../config/php-backend.mjs";
import { setPhpMediaOrigin } from "./media-credentials.mjs";
import { requestUnlockNavigation } from "./unlock.mjs";

const state = { backend: null, php: false };

export function setActiveTarget(target) {
  const backend = typeof target?.backend === "string" ? target.backend : null;
  const php = target?.php === true;
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

// Returns true when the browser was sent to the host's unlock page. Only a PHP
// backend ever gets here, and only once per session window.
export function requestPhpUnlock() {
  if (!state.php || !state.backend) return false;
  return requestUnlockNavigation({
    phpOrigin: state.backend,
    freshMs: UNLOCK_FRESH_MS,
    splashMs: UNLOCK_SPLASH_MS,
  });
}
