import { childrenNamed, descendantsNamed, firstChild, parseXml, textOf } from "./vast-xml.mjs";

// The site only renders ordinary linear pre-roll creatives. VPAID or companion
// content is ignored, so no third-party script or nested frame is ever loaded.
const SKIPPABLE_EVENTS = ["start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "skip", "mute", "unmute", "pause", "resume", "fullscreen", "progress"];
const MAX_TRACKING_URLS = 40;
const MAX_TEXT = 2048;

function httpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function urlsFrom(nodes) {
  const urls = [];
  for (const node of nodes) {
    const url = httpsUrl(textOf(node));
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= MAX_TRACKING_URLS) break;
  }
  return urls;
}

// "00:00:28", "28" and "00:28" are all accepted by real tags.
export function parseVastDuration(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":").map((part) => part.trim());
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const seconds = parts.length === 3
    ? Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
    : parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 3600 ? seconds : null;
}

// A VAST skip offset is a timecode, a plain number of seconds, or a percentage
// of the creative. An unclear value means the ad is not skippable.
export function parseSkipOffset(value, durationSeconds) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !durationSeconds) return null;
    return durationSeconds * percent / 100;
  }
  return parseVastDuration(text);
}

function pickMedia(linear) {
  const candidates = [];
  for (const node of descendantsNamed(linear, "MediaFile", 32)) {
    const url = httpsUrl(textOf(node));
    if (!url) continue;
    const type = (node.attrs.type ?? "").toLowerCase();
    if (!/^video\/(?:mp4|webm)$/.test(type)) continue;
    const height = Number(node.attrs.height);
    const bitrate = Number(node.attrs.bitrate);
    candidates.push({
      url,
      type,
      height: Number.isFinite(height) && height > 0 ? height : 0,
      bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0,
    });
  }
  if (!candidates.length) return null;
  // Prefer MP4, then a comfortably sized rendition, then the best bitrate. A 4K
  // creative is capped in the ranking so a small player never downloads it.
  const rank = (candidate) => [
    candidate.type === "video/mp4" ? 1 : 0,
    Math.min(candidate.height, 1080),
    candidate.bitrate,
  ];
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; left.length > index; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
  });
  return candidates[0];
}

function parseTrackingEvents(node) {
  const events = {};
  for (const tracking of descendantsNamed(node, "Tracking", 120)) {
    const event = (tracking.attrs.event ?? "").trim();
    if (!SKIPPABLE_EVENTS.includes(event)) continue;
    const url = httpsUrl(textOf(tracking));
    if (!url) continue;
    events[event] ??= [];
    if (events[event].length < MAX_TRACKING_URLS && !events[event].includes(url)) events[event].push(url);
  }
  return events;
}

function mergeEvents(base, extra) {
  const merged = { ...base };
  for (const [event, urls] of Object.entries(extra)) {
    merged[event] = [...new Set([...(merged[event] ?? []), ...urls])].slice(0, MAX_TRACKING_URLS);
  }
  return merged;
}

function parseInline(inline, ad) {
  const linear = descendantsNamed(inline, "Linear", 1)[0] ?? null;
  if (!linear) return null;
  const media = pickMedia(linear);
  if (!media) return null;
  const duration = parseVastDuration(textOf(firstChild(linear, "Duration")));
  const skipAfterSeconds = parseSkipOffset(linear.attrs.skipoffset ?? "", duration);
  const clicks = firstChild(linear, "VideoClicks");
  return {
    id: String(ad?.attrs?.id ?? "").slice(0, 120),
    system: textOf(firstChild(inline, "AdSystem")).slice(0, 120),
    title: textOf(firstChild(inline, "AdTitle")).slice(0, 200),
    mediaUrl: media.url,
    mediaType: media.type,
    durationSeconds: duration,
    skipAfterSeconds,
    skippable: skipAfterSeconds !== null,
    clickThrough: clicks ? httpsUrl(textOf(firstChild(clicks, "ClickThrough"))) : null,
    clickTracking: clicks ? urlsFrom(childrenNamed(clicks, "ClickTracking")) : [],
    impressions: urlsFrom(descendantsNamed(inline, "Impression", MAX_TRACKING_URLS)),
    errors: urlsFrom(descendantsNamed(inline, "Error", MAX_TRACKING_URLS)),
    events: parseTrackingEvents(linear),
  };
}

// Read only the first ad of a response. HilltopAds returns the creatives of one
// zone; playing a single pre-roll keeps the experience short and predictable.
export function parseVastResponse(xml) {
  const document = parseXml(xml);
  if (!document) return null;
  const vast = descendantsNamed(document, "VAST", 1)[0] ?? null;
  if (!vast) return null;
  const ad = childrenNamed(vast, "Ad")[0] ?? null;
  if (!ad) return { inline: null, wrapper: null };

  const inline = firstChild(ad, "InLine");
  if (inline) return { inline: parseInline(inline, ad), wrapper: null };

  const wrapperNode = firstChild(ad, "Wrapper");
  if (!wrapperNode) return { inline: null, wrapper: null };
  const uri = httpsUrl(textOf(firstChild(wrapperNode, "VASTAdTagURI")));
  if (!uri) return { inline: null, wrapper: null };
  const linearWrapper = descendantsNamed(wrapperNode, "Linear", 1)[0] ?? null;
  return {
    inline: null,
    wrapper: {
      tagUri: uri,
      impressions: urlsFrom(descendantsNamed(wrapperNode, "Impression", MAX_TRACKING_URLS)),
      errors: urlsFrom(descendantsNamed(wrapperNode, "Error", MAX_TRACKING_URLS)),
      events: parseTrackingEvents(linearWrapper ?? wrapperNode),
      skipAfterSeconds: (() => {
        const value = linearWrapper?.attrs?.skipoffset;
        return value ? parseSkipOffset(value, null) : null;
      })(),
    },
  };
}

function mergeWrapper(ad, wrappers, { skipFallbackSeconds }) {
  let impressions = ad.impressions;
  let errors = ad.errors;
  let events = ad.events;
  let skipAfterSeconds = ad.skipAfterSeconds;
  for (const wrapper of wrappers) {
    impressions = [...new Set([...impressions, ...wrapper.impressions])].slice(0, MAX_TRACKING_URLS);
    errors = [...new Set([...errors, ...wrapper.errors])].slice(0, MAX_TRACKING_URLS);
    events = mergeEvents(events, wrapper.events);
    // The inline creative's own offset wins; otherwise the outer wrapper decides.
    if (skipAfterSeconds === null) skipAfterSeconds = wrapper.skipAfterSeconds;
  }
  // HilltopAds documents a 15-second skip by default, so a tag that omits the
  // offset is still skippable.
  if (skipAfterSeconds === null && Number.isFinite(skipFallbackSeconds) && skipFallbackSeconds > 0) {
    skipAfterSeconds = skipFallbackSeconds;
  }
  return { ...ad, impressions, errors, events, skipAfterSeconds, skippable: skipAfterSeconds !== null };
}

export const MAX_WRAPPERS = 3;

// Resolve every VAST wrapper in the chain, then merge their tracking. Any
// failure resolves to null so the caller can start the content instead.
export async function resolveVastAd(tagUrl, { fetchText, maxWrappers = MAX_WRAPPERS, timeoutMs = 4000, skipFallbackSeconds = 15 } = {}) {
  if (typeof fetchText !== "function" || !httpsUrl(tagUrl)) return null;
  const chain = [];
  const seen = new Set();
  let url = httpsUrl(tagUrl);
  for (let depth = 0; depth <= maxWrappers; depth += 1) {
    if (!url || seen.has(url)) return null;
    seen.add(url);
    let xml;
    try { xml = await fetchText(url, timeoutMs); } catch { return null; }
    if (typeof xml !== "string" || xml.length < 40 || xml.length > 1024 * 1024) return null;
    const response = parseVastResponse(xml);
    if (!response) return null;
    if (response.inline) {
      const inline = response.inline;
      if (!inline?.mediaUrl) return null;
      return { ...mergeWrapper(inline, chain, { skipFallbackSeconds }), tag: tagUrl };
    }
    if (!response.wrapper) return null;
    chain.push(response.wrapper);
    url = response.wrapper.tagUri;
  }
  return null;
}
