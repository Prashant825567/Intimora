// Premium is a time window, not a badge: the backend says whether it is open
// right now and for how long, and the app only shows that answer. Nothing here
// decides entitlement on its own — every field is read from /api/premium/*.
const MAX_SECONDS = 10 * 365 * 24 * 3600;

function seconds(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), MAX_SECONDS) : 0;
}

// An absolute epoch second (a start or an end), which is far past the duration cap.
function epoch(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function codes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((code) => typeof code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(code.trim())).map((code) => code.trim()))].slice(0, 200);
}

// `{ ok, data: {...} }` is what the service answers; a bare object is accepted
// for the same reason everywhere else in this app.
function dataOf(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const inner = payload.data;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : payload;
}

export function parsePremiumStatus(payload) {
  const data = dataOf(payload);
  if (!data) return null;
  const referrals = data.referrals && typeof data.referrals === "object" ? data.referrals : {};
  const total = Number(referrals.total);
  const used = Number(referrals.used);
  const available = Number(referrals.available);
  const active = data.active === true;
  return {
    active,
    // An inactive window has no end date worth showing.
    until: active ? epoch(data.until) : 0,
    remainingSeconds: active ? seconds(data.remainingSeconds) : 0,
    referralCode: text(data.referralCode, 80),
    referrals: {
      total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
      used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0,
      available: Number.isFinite(available) && available > 0 ? Math.floor(available) : 0,
      availableCodes: codes(referrals.availableCodes),
      secondsEach: seconds(referrals.secondsEach),
      hoursEach: Number.isFinite(Number(referrals.hoursEach)) && Number(referrals.hoursEach) > 0 ? Number(referrals.hoursEach) : 0,
    },
  };
}

// How long a redemption of `count` referrals buys. The backend computes the real
// period; this is the same arithmetic it documents, used only for the button's
// label before the request is sent.
export function redemptionSeconds(status, count) {
  const each = status?.referrals?.secondsEach ?? 0;
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return each > 0 && n > 0 ? each * n : 0;
}

export function parsePremiumEntry(payload) {
  const data = dataOf(payload);
  if (!data) return null;
  const entry = data.entry && typeof data.entry === "object" ? data.entry : data;
  const secs = seconds(entry.seconds);
  if (!secs) return null;
  return {
    id: text(entry.id, 64),
    seconds: secs,
    refsUsed: codes(entry.refsUsed),
    startedAt: epoch(entry.startedAt),
    endsAt: epoch(entry.endsAt),
    status: parsePremiumStatus(data.status ? { data: data.status } : null),
  };
}

// One row of the history. Every field is optional in the answer, so a row that
// carries nothing readable is dropped instead of drawn empty.
export function parsePremiumPeriods(payload) {
  const empty = { periods: [], total: { seconds: 0, amountPaise: 0, bySource: {} }, status: null };
  const data = dataOf(payload);
  if (!data) return empty;
  const list = Array.isArray(data.periods) ? data.periods : Array.isArray(data.data) ? data.data : [];
  const periods = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const secs = seconds(item.seconds);
    if (!secs) continue;
    const amountPaise = Number(item.amountPaise);
    periods.push({
      id: text(item.id, 64),
      source: text(item.source, 40) || "premium",
      seconds: secs,
      refsUsed: codes(item.refsUsed),
      amountPaise: Number.isFinite(amountPaise) && amountPaise > 0 ? Math.floor(amountPaise) : 0,
      startedAt: epoch(item.startedAt),
      endsAt: epoch(item.endsAt),
      at: epoch(item.at),
    });
    if (periods.length >= 200) break;
  }
  const total = data.total && typeof data.total === "object" ? data.total : {};
  const bySource = {};
  if (total.bySource && typeof total.bySource === "object") {
    for (const [source, value] of Object.entries(total.bySource).slice(0, 20)) {
      if (!value || typeof value !== "object") continue;
      bySource[text(source, 40)] = {
        periods: Math.max(0, Math.floor(Number(value.periods) || 0)),
        seconds: seconds(value.seconds),
        amountPaise: Math.max(0, Math.floor(Number(value.amountPaise) || 0)),
      };
    }
  }
  const amountPaise = Number(total.amountPaise);
  return {
    periods,
    total: {
      seconds: seconds(total.seconds),
      amountPaise: Number.isFinite(amountPaise) && amountPaise > 0 ? Math.floor(amountPaise) : 0,
      bySource,
    },
    status: parsePremiumStatus(data.status ? { data: data.status } : null),
  };
}

// The app's own wording. The host's sentence is never rendered, so a reflection or
// an unescaped banner from a free host cannot reach the page.
const MESSAGES = {
  none_available: "Abhi koi referral available nahi. Naya referral aane par redeem karein.",
  not_enough: "Itne referrals available nahi. Chhota number chunein.",
  too_few: "Kam se kam 1 referral chahiye.",
};

// The backend's own refusal sentences are mapped to stable codes; the app shows
// its own wording so an unknown banner from a host is never rendered as-is.
export function redeemErrorCode(message) {
  const value = typeof message === "string" ? message : "";
  if (/available nahi/i.test(value)) return "none_available";
  if (/^sirf\b/i.test(value)) return "not_enough";
  if (/kam se kam/i.test(value)) return "too_few";
  return "unavailable";
}

export function redeemErrorMessage(code) {
  return MESSAGES[code] ?? "Premium redeem nahi ho paya. Thodi der baad try karein.";
}

export const PREMIUM_CODES = ["none_available", "not_enough", "too_few", "unavailable"];

// `5h 12m`, `12m 30s`, `45s` — a window, never a date, because the server owns
// the clock and a phone's own clock can be wrong by minutes.
export function formatPremiumWindow(totalSeconds) {
  const secs = seconds(totalSeconds);
  if (!secs) return "0m";
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs % 60}s`;
  return `${secs}s`;
}
