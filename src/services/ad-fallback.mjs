// A browser can only read a VAST tag when the ad server answers with CORS
// headers. Many tags do not, and some answer too slowly for a pre-roll. The
// build therefore resolves the tag once, on the server, and publishes the result
// as same-origin JSON: the player prefers a live tag (fresh creative, live
// tracking) but falls back to this snapshot instead of showing no ad at all.
const MAX_TEXT = 2048;
const MAX_URLS = 40;
const AD_EVENTS = ["start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "skip", "mute", "unmute", "pause", "resume", "fullscreen", "progress"];

function httpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function urls(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    const url = httpsUrl(item);
    if (url && !list.includes(url)) list.push(url);
    if (list.length >= MAX_URLS) break;
  }
  return list;
}

function seconds(value, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || (!allowZero && value === 0) || value > 24 * 3600) return null;
  return value;
}

// Everything from the snapshot is treated as untrusted: only https media,
// clicks and trackers survive, and every list is bounded.
export function normaliseCachedAd(ad) {
  if (!ad || typeof ad !== "object") return null;
  const mediaUrl = httpsUrl(ad.mediaUrl);
  if (!mediaUrl) return null;
  const durationSeconds = seconds(ad.durationSeconds);
  const skipAfterSeconds = seconds(ad.skipAfterSeconds, { allowZero: true });
  const events = {};
  if (ad.events && typeof ad.events === "object") {
    for (const [event, value] of Object.entries(ad.events)) {
      if (!AD_EVENTS.includes(event)) continue;
      const list = urls(value);
      if (list.length) events[event] = list;
    }
  }
  return {
    id: String(ad.id ?? "").slice(0, 120),
    system: String(ad.system ?? "").slice(0, 120),
    title: String(ad.title ?? "").slice(0, 200),
    mediaUrl,
    mediaType: /^video\/(?:mp4|webm)$/.test(String(ad.mediaType ?? "")) ? ad.mediaType : "video/mp4",
    durationSeconds,
    skipAfterSeconds,
    skippable: skipAfterSeconds !== null,
    clickThrough: httpsUrl(ad.clickThrough),
    clickTracking: urls(ad.clickTracking),
    impressions: urls(ad.impressions),
    errors: urls(ad.errors),
    events,
    tag: String(ad.tag ?? "").slice(0, MAX_TEXT),
    source: "cached",
  };
}

// Never rejects: a missing, broken or off snapshot simply means "no cached ad".
export async function loadCachedAd(url = "/ad-fallback.json", { timeoutMs = 2000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof url !== "string" || !url.startsWith("/") || typeof fetchImpl !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), Math.max(200, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller?.signal ?? undefined,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return normaliseCachedAd(payload?.ad);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
