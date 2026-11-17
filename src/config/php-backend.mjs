// The server URL comes from the load balancer, and its `php` flag decides the
// transport: `php: true` → session-cookie dance (credentials, one-time unlock,
// proxy fallback); `php: false` → a plain direct call.
//
// Set PHP_ORIGIN_OVERRIDE to an origin to pin one backend for testing; empty
// (the default) means "ask the load balancer", which is the normal mode.
export const PHP_ORIGIN_OVERRIDE = "";

// Optional safety net for the PHP mode. If the direct call fails and the one-time
// unlock does not help, the request is retried through this proxy (see
// workers/php-proxy/). Empty means "no fallback".
export const PHP_PROXY_ORIGIN = "";

// The free host grants a six-hour session; a new unlock is requested a little
// before that, and never more than once per window, so the redirect can never
// turn into a loop.
export const UNLOCK_FRESH_MS = 5.5 * 60 * 60 * 1000;

// How long the splash stays on screen before the browser leaves for the PHP host.
export const UNLOCK_SPLASH_MS = 700;
