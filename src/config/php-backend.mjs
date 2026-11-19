// The server URL comes from the load balancer, and its `php` flag decides the
// transport: `php: true` → the PHP host behind its own browser check, called
// directly with its session cookie; `php: false` → a plain direct call.
//
// There is no proxy in this path by design: the browser talks to the PHP host
// itself, so the only moving parts are the cookie, the one-time unlock
// navigation and a bounded retry.
//
// Set PHP_ORIGIN_OVERRIDE to an origin to pin one backend for testing; empty
// (the default) means "ask the load balancer", which is the normal mode.
export const PHP_ORIGIN_OVERRIDE = "";

// The free host grants a six-hour session; a new unlock is requested a little
// before that expires.
export const UNLOCK_FRESH_MS = 5.5 * 60 * 60 * 1000;

// An attempt only proves itself when a real answer arrives. Until then the
// window is short: three failed unlocks (a missing CORS header, a refused
// request) must not leave the visitor locked out for the whole six hours, which
// is what "reload karo, phir bhi data nahi" used to mean. After this window the
// next failure may ask again on its own.
export const UNLOCK_RETRY_MS = 2 * 60 * 1000;

// How long the splash stays on screen before the browser leaves for the PHP host.
export const UNLOCK_SPLASH_MS = 700;

// A window that never confirms a session stops asking after this many unlocks,
// so a host that cannot hand out its cookie can never turn into a redirect loop.
export const UNLOCK_MAX_TRIES = 3;

// Even inside the allowance above, two redirects never follow each other within
// this gap: the visitor sees the splash and the reason instead of a flicker.
export const UNLOCK_MIN_GAP_MS = 4_000;
