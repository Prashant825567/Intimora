// HilltopAds Video VAST zone (publisher site 929597). Paste a new tag here to
// change the ad zone; the previous tag URL is validated at build time, so only
// an HTTPS URL on the HilltopAds domains is accepted.
//
// Leave the string empty to switch pre-roll ads off completely. The public build
// variable INTIMORA_PUBLIC_VAST_TAG_URL overrides this file.
export const VAST_TAG_URL =
  "https://surprisedplate.com/d.m/FAzwdZGNN/vvZjGEUf/QeLmc9buAZ/U/lnkfP/TecO2pMtTDcX5iN/DpELt/N-ziYax/N/zbk/0yNbQH";

// Ads without an explicit VAST skip offset become skippable after this many
// seconds. HilltopAds documents 15 seconds as its default skip time.
export const VAST_SKIP_FALLBACK_SECONDS = 15;

// A tag that has not answered within this window is ignored so playback is
// never blocked by an ad server.
export const VAST_TIMEOUT_MS = 4000;

// How long a play request waits for an in-flight ad decision before the content
// starts instead. Pre-roll never interrupts playback that has already begun.
export const VAST_DECISION_GRACE_MS = 1200;

// The build resolves the tag once and publishes the creative as same-origin
// JSON. A browser only falls back to it when the live tag cannot be read (no
// CORS headers, ad blocker, offline) or answers slower than this budget.
export const VAST_CACHED_AD_URL = "/ad-fallback.json";
export const VAST_LIVE_BUDGET_MS = 800;
