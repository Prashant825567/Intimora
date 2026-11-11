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
