// TEMPORARY: the PHP backend is pinned here while the "unlock" flow is being
// tested against the free host. The load balancer is not asked for a server in
// this mode.
//
// To go back to the load balancer, empty PHP_ORIGIN_OVERRIDE (set it to "").
// Nothing else has to change: discovery takes over again automatically.
export const PHP_ORIGIN_OVERRIDE = "https://intimora-api3.site.je";

// Optional safety net. If the direct call fails and the one-time unlock does not
// help, the same request is retried through this proxy (see workers/php-proxy/).
// Empty means "no fallback": the site reports the ordinary error instead.
export const PHP_PROXY_ORIGIN = "";

// The free host grants a six-hour session; a new unlock is requested a little
// before that, and never more than once per window, so the redirect can never
// turn into a loop.
export const UNLOCK_FRESH_MS = 5.5 * 60 * 60 * 1000;

// How long the splash stays on screen before the browser leaves for the PHP host.
export const UNLOCK_SPLASH_MS = 700;
