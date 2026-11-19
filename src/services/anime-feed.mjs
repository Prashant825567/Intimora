// Anime titles come from one third-party source, and only as a *feed*: a small
// same-origin JSON file that the build writes after reading their public listing
// pages. Nothing is proxied at runtime, no media URL is copied, and a click
// opens their own embed player inside our frame — the same idea as the sponsored
// cards. Their robots.txt allows the listing pages (Crawl-Delay: 10) and
// disallows /embed/ and /search/, so this file is built from listings only and
// search runs on the local copy.
export const ANIME_SOURCE = "https://www.hentaicity.com";
export const ANIME_FEED_VERSION = 1;

const MAX_TITLE = 140;
const MAX_ITEMS = 200;
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DURATION = /^\d{1,3}:[0-5]\d$/;
const THUMBNAIL = /^https:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)$/i;

function httpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The last path segment before `.html` ends with the video's own id, which is
// what their embed URL is built from. Nothing else is guessed from the markup.
export function animeIdFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  return VIDEO_ID.test(last) && /[0-9]/.test(last) ? last : null;
}

export function animeEmbedUrl(id) {
  return VIDEO_ID.test(id ?? "") ? `${ANIME_SOURCE}/embed/${id}` : null;
}

function cleanTitle(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/\\+"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const title = text || fallback.trim();
  return title ? title.slice(0, MAX_TITLE) : "";
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

// Reads one listing page. A tube listing repeats the same three facts per card —
// a `/video/<slug>-<id>.html` link, a poster image and a duration — so the
// parser walks the anchors and looks only inside each anchor's own window. That
// keeps it tolerant of markup changes without pulling a card's neighbour in.
export function parseAnimeListing(html, { source = ANIME_SOURCE, limit = MAX_ITEMS } = {}) {
  if (typeof html !== "string" || !html) return [];
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*\/video\/([^"/]+)\.html)"[^>]*>/gi)];
  const items = [];
  const seen = new Set();
  for (let index = 0; index < anchors.length && items.length < limit; index += 1) {
    const anchor = anchors[index];
    const slug = anchor[2];
    const id = animeIdFromSlug(slug);
    if (!id || seen.has(id)) continue;
    const start = anchor.index ?? 0;
    const end = index + 1 < anchors.length ? (anchors[index + 1].index ?? html.length) : Math.min(html.length, start + 4000);
    const window = html.slice(start, end < start ? html.length : end);
    const image = window.match(/<img\b[^>]*?\b(?:src|data-src|data-original|data-lazy-src)="([^"]+)"/i);
    const thumbnail = httpsUrl(image?.[1]?.trim()) ?? null;
    if (!thumbnail || !THUMBNAIL.test(thumbnail)) continue;
    const alt = window.match(/<img\b[^>]*?\balt="([^"]*)"/i)?.[1];
    const titleAttr = window.match(/<a\b[^>]*?\btitle="([^"]*)"/i)?.[1];
    const title = cleanTitle(alt, cleanTitle(titleAttr));
    if (!title) continue;
    // "HD07:03" has no word boundary before the digits, so the lookarounds are
    // on digits only.
    const duration = stripTags(window).match(/(?:^|[^0-9])(\d{1,3}:[0-5]\d)(?![0-9])/)?.[1] ?? "";
    const pageUrl = `${source}/video/${slug}.html`;
    seen.add(id);
    items.push({ id, title, thumbnail, pageUrl, embedUrl: animeEmbedUrl(id), duration });
  }
  return items;
}

export function animeFeedPayload(items, { generatedAt = new Date().toISOString() } = {}) {
  return { version: ANIME_FEED_VERSION, source: ANIME_SOURCE, generatedAt, items: items.slice(0, MAX_ITEMS) };
}

// What the browser reads: the same file, re-validated. A stale or hand-edited
// file can only ever produce cards that point at their own embed player.
export function animeCards(payload, { limit = 60 } = {}) {
  const raw = payload?.items;
  if (!Array.isArray(raw)) return [];
  const cards = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!VIDEO_ID.test(id) || seen.has(id)) continue;
    const title = typeof item.title === "string" ? cleanTitle(item.title) : "";
    const thumbnail = httpsUrl(item.thumbnail);
    const embedUrl = animeEmbedUrl(id);
    if (!title || !thumbnail || !embedUrl) continue;
    const duration = typeof item.duration === "string" && DURATION.test(item.duration) ? item.duration : "";
    seen.add(id);
    cards.push({ id, title, thumbnail, duration, embedUrl });
    if (cards.length >= limit) break;
  }
  return cards;
}
