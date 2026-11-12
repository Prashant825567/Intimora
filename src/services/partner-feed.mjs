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
const TITLE_TAG = /<title>([^<]{1,300})<\/title>/i;

function httpsUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// A partner embed page carries the video's own title and poster. Reading them at
// build time lets a sponsored card look exactly like one of our cards.
export function parseEmbedPreview(html) {
  const preview = { title: "", thumbnail: null };
  if (typeof html !== "string" || !html) return preview;
  for (const tag of html.match(META_TAG) ?? []) {
    const property = (/\bproperty\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
    if (property !== "og:title" && property !== "og:image" && property !== "og:image:secure_url") continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!content) continue;
    if (property === "og:title" && !preview.title) preview.title = decodeHtmlEntities(content).trim().slice(0, 120);
    if (property !== "og:title" && !preview.thumbnail) {
      const url = httpsUrl(content);
      if (url) preview.thumbnail = url;
    }
    if (preview.title && preview.thumbnail) break;
  }
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
