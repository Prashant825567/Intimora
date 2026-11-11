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

// The build (or the dev server) publishes this as /partner-feed.json; the client
// only ever reads same-origin JSON, so the feed host needs no CORS relaxation.
export function partnerFeedPayload(urls) {
  const items = Array.isArray(urls) ? urls.filter((url) => typeof url === "string") : [];
  return `${JSON.stringify({ items }, null, 2)}\n`;
}
