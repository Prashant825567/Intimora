// A TubeCorporate campaign feed is CSV (or HTML) whose rows each hold a
// ready-made `<iframe src="…">` snippet. Nothing from the feed is trusted: every
// extracted URL is re-validated by partnerEmbedUrl, only https embeds on the
// documented partner hosts survive, duplicates are dropped and the list is
// capped so a sponsored grid can never turn into an unbounded page.
import { partnerEmbedUrl, PARTNER_EMBED_HOSTS } from "./partner-embed.mjs";

export const PARTNER_FEED_LIMIT = 60;

const IFRAME_SRC = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})')/gi;
const ENTITIES = Object.freeze({
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&lt;": "<",
  "&gt;": ">",
});

export function decodeHtmlEntities(value) {
  if (typeof value !== "string" || !value.includes("&")) return typeof value === "string" ? value : "";
  return value.replace(/&(?:amp|quot|#39|#x27|#x2F|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function parsePartnerFeed(text, { limit = PARTNER_FEED_LIMIT, hosts = PARTNER_EMBED_HOSTS } = {}) {
  if (typeof text !== "string" || !text) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, PARTNER_FEED_LIMIT) : PARTNER_FEED_LIMIT;
  const urls = [];
  for (const match of text.matchAll(IFRAME_SRC)) {
    const raw = decodeHtmlEntities(match[1] ?? match[2] ?? "");
    const url = partnerEmbedUrl(raw, { hosts, requireVideoPath: true });
    if (!url || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= cap) break;
  }
  return urls;
}

// A campaign feed can carry more than the iframe: with extra `csv_columns`
// (title, screenshot) the same row also holds the video's name and poster. When
// those columns are present they are used as-is, so a sponsored card needs no
// page scrape at all; when they are absent the build reads the pages instead.
const ROW_SPLIT = /\t|\|/;
const ROW_IMAGE = /(?:https?:)?\/\/[^\s"'|<>]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'|<>]*)?/i;
const ROW_URL = /https?:\/\/[^\s"'|<>]+/gi;

export function parsePartnerFeedEntries(text, { limit = PARTNER_FEED_LIMIT, hosts = PARTNER_EMBED_HOSTS } = {}) {
  if (typeof text !== "string" || !text) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, PARTNER_FEED_LIMIT) : PARTNER_FEED_LIMIT;
  const entries = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("iframe") && !line.includes("http")) continue;
    const values = line.split(ROW_SPLIT).map((value) => value.trim());
    let embedUrl = parsePartnerFeed(line, { limit: 1, hosts })[0] ?? null;
    if (!embedUrl) {
      for (const value of values) {
        for (const candidate of value.match(ROW_URL) ?? []) {
          const url = partnerEmbedUrl(decodeHtmlEntities(candidate), { hosts, requireVideoPath: true });
          if (url) {
            embedUrl = url;
            break;
          }
        }
        if (embedUrl) break;
      }
    }
    if (!embedUrl || seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    let title = "";
    let poster = null;
    for (const value of values) {
      if (!value || value === embedUrl) continue;
      if (value.startsWith("<")) {
        // The iframe snippet itself can carry the poster as a fallback image.
        const inner = ROW_IMAGE.exec(value)?.[0];
        if (inner && !poster) poster = httpsUrl(decodeHtmlEntities(inner), embedUrl);
        continue;
      }
      if (ROW_IMAGE.test(value)) {
        if (!poster) poster = httpsUrl(decodeHtmlEntities(ROW_IMAGE.exec(value)[0]), embedUrl);
        continue;
      }
      if (!title && !/^https?:/i.test(value) && !/^\d+(?::\d+)?$/.test(value)) title = tidyTitle(value);
    }
    entries.push({ embedUrl, title, thumbnail: poster });
    if (entries.length >= cap) break;
  }
  return entries;
}

const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const TITLE_TAG = /<title>([^<]{1,300})<\/title>/i;
const VIDEO_POSTER = /<video\b[^>]*\bposter\s*=\s*["']([^"']{1,2048})["']/i;
const JSON_LD_POSTER = /"thumbnailUrl"\s*:\s*"([^"]{1,2048})"/i;
const TITLE_PROPERTIES = new Set(["og:title", "twitter:title"]);
const IMAGE_PROPERTIES = new Set(["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]);

// How many embed pages the build reads for titles and posters. The client shows
// the same number of sponsored cards, so a card that the grid can display is
// never left without its preview.
export const PARTNER_PREVIEW_LIMIT = 24;

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return pattern.exec(tag)?.[1] ?? "";
}

// Poster URLs are usually absolute, but partners also publish protocol-relative
// ("//cdn/…"), root-relative ("/contents/…") and plain-http URLs, which only
// make sense next to the embed page they came from. A plain-http poster is
// upgraded to https so the page never mixes protocols; if that host cannot serve
// https the card falls back to the generic tile at runtime.
function httpsUrl(value, base) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value.trim(), base || undefined);
    if (url.username || url.password) return null;
    if (url.protocol === "http:") url.protocol = "https:";
    else if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function firstPoster(candidates, base) {
  for (const candidate of candidates) {
    const url = httpsUrl(candidate, base);
    if (url) return url;
  }
  return null;
}

// Most TubeCorporate sites keep their screenshots on a predictable path. When
// the page itself cannot be read (bot protection, an empty Open Graph block) the
// build probes these in order, and the browser does the same at runtime, so a
// sponsored card still gets the partner's own poster.
export function partnerPosterCandidates(videoUrl, { origin } = {}) {
  if (typeof videoUrl !== "string") return [];
  let url;
  try {
    url = new URL(videoUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "https:") return [];
  const id = /\/(?:embed|video|videos)\/(\d{1,12})\/?/.exec(url.pathname)?.[1];
  if (!id) return [];
  const host = (() => {
    try {
      return origin ? new URL(origin).origin : url.origin;
    } catch {
      return url.origin;
    }
  })();
  const bucket = String(Math.floor(Number(id) / 1000) * 1000);
  const base = `${host}/contents/videos_screenshots/${bucket}/${id}`;
  return [`${base}/320x180/1.jpg`, `${base}/320x180/2.jpg`, `${base}/preview.jpg`, `${base}/400x225/1.jpg`];
}

// Partner pages answer a bot with a challenge page, and that page has a title of
// its own ("Just a moment…", "Content not found"). Such a title must never end up
// on a sponsored card.
const CHALLENGE_TITLE = /^(?:just a moment|attention required|access denied|access to this page|checking your browser|please wait|verify (?:you are|that you are)|ddos-guard|403 forbidden|404 not found|not found|content not found|page not found|error|service unavailable|too many requests)\b/i;
const SITE_SUFFIX = /\s+[|\-–—]\s+([^|\-–—]{1,20})$/;

function tidyTitle(value) {
  if (typeof value !== "string" || !value) return "";
  const title = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  if (!title || CHALLENGE_TITLE.test(title)) return "";
  // "Indian Girls Sweet Sex | DesiPorn" reads better without the site name, but
  // only a single short word is stripped so real titles keep their dash.
  const suffix = SITE_SUFFIX.exec(title);
  const trimmed = suffix && !/\s/.test(suffix[1]) ? title.slice(0, suffix.index).trim() : title;
  return (trimmed || title).slice(0, 120);
}

// A partner embed page carries the video's own title and poster. Reading them at
// build time lets a sponsored card look exactly like one of our cards. Partners
// label the poster inconsistently, so every common spelling is accepted before
// the card falls back to its generic title.
export function parseEmbedPreview(html, base) {
  const preview = { title: "", thumbnail: null };
  if (typeof html !== "string" || !html) return preview;
  const posters = [];
  for (const tag of html.match(META_TAG) ?? []) {
    const property = (attribute(tag, "property") || attribute(tag, "name")).toLowerCase();
    if (!TITLE_PROPERTIES.has(property) && !IMAGE_PROPERTIES.has(property)) continue;
    const content = attribute(tag, "content");
    if (!content) continue;
    if (TITLE_PROPERTIES.has(property)) {
      if (!preview.title) preview.title = tidyTitle(content);
    } else if (IMAGE_PROPERTIES.has(property)) {
      posters.push(content);
    }
    if (preview.title && posters.length) break;
  }
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (attribute(tag, "rel").toLowerCase() !== "image_src") continue;
    posters.push(attribute(tag, "href"));
  }
  const poster = firstPoster(posters, base);
  preview.thumbnail = poster
    ?? firstPoster([VIDEO_POSTER.exec(html)?.[1], JSON_LD_POSTER.exec(html)?.[1]], base);
  if (!preview.title) {
    const match = TITLE_TAG.exec(html);
    if (match) preview.title = tidyTitle(match[1]);
  }
  return preview;
}

// The build (or the dev server) publishes this as /partner-feed.json; the client
// only ever reads same-origin JSON, so the feed host needs no CORS relaxation.
export function partnerFeedPayload(items) {
  const list = Array.isArray(items)
    ? items.map((item) => {
      const value = typeof item === "string" ? { embedUrl: item } : item;
      if (!value || typeof value !== "object") return null;
      const embedUrl = partnerEmbedUrl(value.embedUrl, { requireVideoPath: true });
      if (!embedUrl) return null;
      return {
        embedUrl,
        title: typeof value.title === "string" ? value.title.slice(0, 120) : "",
        thumbnail: typeof value.thumbnail === "string" ? value.thumbnail : null,
      };
    }).filter(Boolean)
    : [];
  return `${JSON.stringify({ version: 2, items: list }, null, 2)}\n`;
}
