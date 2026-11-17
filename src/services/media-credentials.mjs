// Media from the PHP host needs its session cookie, and that cookie only travels
// when the request is not a CORS one. Asking for `use-credentials` would fail
// outright if that host sends no CORS headers on thumbnails, so the attribute is
// dropped for that origin only: a plain <img>/<video> request still carries the
// cookie, and the poster keeps working either way.
import { PHP_ORIGIN_OVERRIDE } from "../config/php-backend.mjs";

const ANONYMOUS = "anonymous";

export function mediaCrossOrigin(url) {
  try {
    if (!PHP_ORIGIN_OVERRIDE) return ANONYMOUS;
    const base = globalThis.location?.href ?? "https://intimora.new.tg/";
    const target = new URL(String(url), base);
    if (target.origin === new URL(PHP_ORIGIN_OVERRIDE).origin) return undefined;
  } catch {
    // Fall through to the ordinary behaviour.
  }
  return ANONYMOUS;
}
