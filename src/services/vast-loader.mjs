import { loadCachedAd } from "./ad-fallback.mjs";
import { resolveVastAd } from "./vast.mjs";

// The tag is read as a cross-origin document. No cookies or referrer are sent,
// and a slow or unreachable ad server can never block the video behind it.
export async function requestVastText(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Ad tag unavailable");
    const text = await response.text();
    if (!text || text.length > 1024 * 1024) throw new Error("Ad tag unavailable");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Always resolves; an empty or broken response simply means "no pre-roll".
export function loadVastAd(tagUrl, { timeoutMs = 4000, skipFallbackSeconds = 15, maxWrappers = 3, fetchText = requestVastText } = {}) {
  return resolveVastAd(tagUrl, { fetchText, timeoutMs, skipFallbackSeconds, maxWrappers }).catch(() => null);
}

// A pre-roll decision: prefer the live tag, but stop waiting for it after a
// short budget and use the creative the build resolved instead (or, when the
// browser cannot read the tag at all — CORS, ad blocker, offline — use it
// straight away). Always resolves; null means "no pre-roll, play the content".
export async function loadPreRoll(tagUrl, {
  timeoutMs = 4000,
  skipFallbackSeconds = 15,
  maxWrappers = 3,
  cachedUrl = "/ad-fallback.json",
  liveBudgetMs = 1200,
  fetchText = requestVastText,
  fetchCached = loadCachedAd,
} = {}) {
  const live = tagUrl
    ? loadVastAd(tagUrl, { timeoutMs, skipFallbackSeconds, maxWrappers, fetchText })
    : Promise.resolve(null);
  const cached = typeof fetchCached === "function"
    ? Promise.resolve(fetchCached(cachedUrl)).catch(() => null)
    : Promise.resolve(null);

  let timer;
  const answeredInTime = await Promise.race([
    live.then((ad) => ad ?? null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(200, liveBudgetMs)); }),
  ]);
  if (timer) clearTimeout(timer);
  if (answeredInTime) return answeredInTime;

  const fallback = await cached;
  if (fallback) return fallback;
  // The tag may still answer within its own timeout; otherwise play content.
  return (await live) ?? null;
}
