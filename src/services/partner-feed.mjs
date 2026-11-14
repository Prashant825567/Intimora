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
// ("//cdn/…") and root-relative ("/contents/…") paths, which only make sense
// next to the embed page they came from.
function httpsUrl(value, base) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value.trim(), base || undefined);
    if (url.protocol !== "https:" || url.username || url.password) return null;
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
      if (!preview.title) preview.title = decodeHtmlEntities(content).trim().slice(0, 120);
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
    if (match) preview.title = decodeHtmlEntities(match[1]).trim().slice(0, 120);
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
