// Media from a PHP host needs its session cookie, and that cookie only travels
// when the request is not a CORS one. Asking for `use-credentials` would fail
// outright if that host sends no CORS headers on thumbnails, so the attribute is
// dropped for that origin only: a plain <img>/<video> request still carries the
// cookie, and the poster keeps working either way.
//
// Which origin that is comes from discovery (`php: true`), so it is remembered
// here whenever a target is selected; no host is hardcoded.
const state = { phpOrigin: null };

const ANONYMOUS = "anonymous";

export function setPhpMediaOrigin(origin) {
  let value = null;
  if (typeof origin === "string" && origin) {
    try {
      value = new URL(origin).origin;
    } catch {
      value = null;
    }
  }
  state.phpOrigin = value;
}

export function activePhpOrigin() {
  return state.phpOrigin;
}

export function mediaCrossOrigin(url) {
  try {
    if (!state.phpOrigin) return ANONYMOUS;
    const base = globalThis.location?.href ?? "https://intimora.net/";
    const target = new URL(String(url), base);
    if (target.origin === state.phpOrigin) return undefined;
  } catch {
    // Fall through to the ordinary behaviour.
  }
  return ANONYMOUS;
}
