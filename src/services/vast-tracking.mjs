// VAST tracking endpoints are plain pixels. An Image request works without
// CORS, keeps the page's no-referrer policy, and never delays the player.
export function firePixels(urls) {
  if (!Array.isArray(urls) || !urls.length || typeof Image === "undefined") return 0;
  let fired = 0;
  for (const url of urls.slice(0, 40)) {
    if (typeof url !== "string" || !url.startsWith("https://")) continue;
    try {
      const pixel = new Image();
      pixel.referrerPolicy = "no-referrer";
      pixel.src = url;
      fired += 1;
    } catch { /* A blocked pixel must never break playback. */ }
  }
  return fired;
}

// Quartile events are keyed by the fraction of the creative that has played.
export const QUARTILE_EVENTS = Object.freeze([
  { event: "firstQuartile", fraction: 0.25 },
  { event: "midpoint", fraction: 0.5 },
  { event: "thirdQuartile", fraction: 0.75 },
]);
