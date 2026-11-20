// Anime titles come from one third-party source, and only as a *feed*: a small
// same-origin JSON file that the build writes after reading their public listing
// pages. Nothing is proxied at runtime, no media URL is copied, and a click
// opens their own embed player inside our frame — the same idea as the sponsored
// cards. Their robots.txt allows the listing pages (Crawl-Delay: 10) and
// disallows /embed/ and /search/, so this file is built from listings only and
// search runs on the local copy. Three listings are baked, in the source's own
// order — new, most popular and top rated — so the site can show the same rows
// instead of one undifferentiated grid.
export const ANIME_SOURCE = "https://www.hentaicity.com";
export const ANIME_FEED_VERSION = 3;

const MAX_TITLE = 140;
const MAX_ITEMS = 200;
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DURATION = /^\d{1,3}:[0-5]\d$/;
const THUMBNAIL = /^https:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)$/i;
const TAG = /^[\p{L}0-9][\p{L}0-9 '&+._-]{0,23}$/u;
const AUTHOR = /^[\p{L}0-9][\p{L}0-9 ._'&-]{0,39}$/u;
const UPLOAD_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TAGS = 8;
const MAX_DESCRIPTION = 300;
const LIST_ID = /^[a-z0-9-]{1,24}$/;
const MAX_LISTS = 6;
const MAX_LIST_ITEMS = 24;
const MAX_LIST_TITLE = 40;
const MAX_CARDS = 60;

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

// A description is prose, not a title: it keeps its length up to its own cap
// instead of being cut at the title limit.
function cleanText(value, max = MAX_DESCRIPTION) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : "";
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

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function metaContent(html, name) {
  const pattern = new RegExp(`<meta\\b[^>]*?(?:property|name)=["']${name}["'][^>]*?content=["']([^"']*)["']`, "i");
  return decodeEntities(html.match(pattern)?.[1] ?? "") || "";
}

// The page embeds a schema.org record for the video; it is the one place the
// source states its own title, poster, upload date, author and description in a
// machine-readable way, so it is read first and everything else is a fallback.
function readJsonLdRecord(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];
    for (const record of candidates) {
      if (record && typeof record === "object" && (record.uploadDate || record.description || record.author)) return record;
    }
  }
  return null;
}

function cleanTagsFromHtml(html) {
  const tags = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["'](?:https?:\/\/www\.hentaicity\.com)?\/tags\/video\/([^"'?#]+)["']/gi)) {
    let tag;
    try {
      tag = decodeEntities(decodeURIComponent(match[1].replace(/\+/g, " "))).replace(/\s+/g, " ").trim();
    } catch {
      continue;
    }
    const key = tag.toLowerCase();
    if (!tag || tag.length > 24 || !TAG.test(tag) || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

// What one video page can add to a card. Everything here is optional and
// additive: a page whose markup changed yields fewer fields, never a broken
// card, and nothing here touches a media URL.
export function enrichAnimePage(html) {
  if (typeof html !== "string" || !html) return {};
  const record = readJsonLdRecord(html);
  const extras = {};

  const rawAuthor = record?.author?.name ?? record?.author ?? html.match(/<a\b[^>]*href=["'](?:https?:\/\/www\.hentaicity\.com)?\/profile\/([^"'/]+)\/?["']/i)?.[1];
  const author = decodeEntities(decodeURIComponent(String(rawAuthor ?? "").replace(/\+/g, " "))).replace(/\s+/g, " ").trim();
  if (author && AUTHOR.test(author)) extras.author = author;

  const rawDate = String(record?.uploadDate ?? html.match(/"uploadDate"\s*:\s*"([^"]+)"/i)?.[1] ?? "").trim();
  const date = rawDate.slice(0, 10);
  if (UPLOAD_DATE.test(date) && !Number.isNaN(Date.parse(rawDate))) extras.uploadDate = date;

  const tags = cleanTagsFromHtml(html);
  if (tags.length) extras.tags = tags;

  const description = cleanText(stripTags(decodeEntities(
    String(record?.description ?? "") || metaContent(html, "og:description") || metaContent(html, "description"),
  )));
  if (description) extras.description = description;

  const rating = Number.parseInt(String(record?.aggregateRating?.ratingValue ?? ""), 10);
  if (Number.isFinite(rating) && rating >= 0 && rating <= 100) extras.rating = rating;

  return extras;
}

// One shape for one card, so every reader in the app — the flat grid, the
// ordered rows and the search results — validates a card the same way.
function sanitizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id : "";
  if (!VIDEO_ID.test(id)) return null;
  const title = typeof item.title === "string" ? cleanTitle(item.title) : "";
  const thumbnail = httpsUrl(item.thumbnail);
  const embedUrl = animeEmbedUrl(id);
  if (!title || !thumbnail || !embedUrl) return null;
  const duration = typeof item.duration === "string" && DURATION.test(item.duration) ? item.duration : "";
  const card = { id, title, thumbnail, duration, embedUrl };

  // Optional facts the video page volunteered. A hand-edited file can only ever
  // add a plausible label here — never a URL, an embed target or markup.
  const tags = [];
  const seen = new Set();
  for (const tag of Array.isArray(item.tags) ? item.tags : []) {
    if (tags.length >= MAX_TAGS) break;
    const clean = typeof tag === "string" ? cleanTitle(tag) : "";
    const key = clean.toLowerCase();
    if (!clean || clean.length > 24 || !TAG.test(clean) || seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
  }
  if (tags.length) card.tags = tags;
  const author = typeof item.author === "string" ? cleanTitle(item.author).slice(0, 40) : "";
  if (author && AUTHOR.test(author)) card.author = author;
  const uploadDate = typeof item.uploadDate === "string" ? item.uploadDate.trim() : "";
  if (UPLOAD_DATE.test(uploadDate)) card.uploadDate = uploadDate;
  const rating = Number.parseInt(String(item.rating ?? ""), 10);
  if (Number.isFinite(rating) && rating >= 0 && rating <= 100) card.rating = rating;
  const description = typeof item.description === "string" ? cleanText(item.description) : "";
  if (description) card.description = description;
  return card;
}

function cleanListTitle(value) {
  return typeof value === "string" ? cleanTitle(value).slice(0, MAX_LIST_TITLE) : "";
}

// `lists` keeps the source's own ordering: each row is a list of ids into
// `items`, so a card is never duplicated in the file and a row can never point
// at a card that the same file does not also describe.
export function animeFeedPayload(items, { generatedAt = new Date().toISOString(), lists = [] } = {}) {
  const itemList = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  const known = new Set(itemList.map((item) => item?.id));
  const kept = [];
  for (const list of Array.isArray(lists) ? lists : []) {
    if (kept.length >= MAX_LISTS) break;
    const id = typeof list?.id === "string" ? list.id : "";
    const title = cleanListTitle(list?.title);
    if (!LIST_ID.test(id) || !title || kept.some((entry) => entry.id === id)) continue;
    const seen = new Set();
    const itemIds = [];
    for (const itemId of Array.isArray(list?.itemIds) ? list.itemIds : []) {
      if (itemIds.length >= MAX_LIST_ITEMS) break;
      if (typeof itemId !== "string" || !known.has(itemId) || seen.has(itemId)) continue;
      seen.add(itemId);
      itemIds.push(itemId);
    }
    if (itemIds.length) kept.push({ id, title, itemIds });
  }
  return { version: ANIME_FEED_VERSION, source: ANIME_SOURCE, generatedAt, lists: kept, items: itemList };
}

// What the browser reads: the same file, re-validated. A stale or hand-edited
// file can only ever produce cards that point at their own embed player.
export function animeCards(payload, { limit = MAX_CARDS } = {}) {
  const raw = payload?.items;
  if (!Array.isArray(raw)) return [];
  const cards = [];
  const seen = new Set();
  for (const item of raw) {
    const card = sanitizeItem(item);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
    if (cards.length >= limit) break;
  }
  return cards;
}

// The ordered rows — "New Releases", "Most Popular", "Top Rated" — as the feed
// wrote them. A row is dropped when it is empty or its ids do not resolve, and a
// missing `lists` (an older feed, or a build that could not reach the source)
// simply means no rows: the caller falls back to one grid.
export function animeLists(payload, { perList = 12 } = {}) {
  const lists = payload?.lists;
  if (!Array.isArray(lists)) return [];
  const byId = new Map();
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const card = sanitizeItem(item);
    if (card && !byId.has(card.id)) byId.set(card.id, card);
  }
  const cap = Math.min(Math.max(1, perList), MAX_LIST_ITEMS);
  const rows = [];
  for (const list of lists) {
    if (rows.length >= MAX_LISTS) break;
    const id = typeof list?.id === "string" ? list.id : "";
    const title = cleanListTitle(list?.title);
    if (!LIST_ID.test(id) || !title || rows.some((row) => row.id === id)) continue;
    const seen = new Set();
    const cards = [];
    for (const itemId of Array.isArray(list?.itemIds) ? list.itemIds : []) {
      if (cards.length >= cap) break;
      if (typeof itemId !== "string" || seen.has(itemId)) continue;
      const card = byId.get(itemId);
      if (!card) continue;
      seen.add(itemId);
      cards.push(card);
    }
    if (cards.length) rows.push({ id, title, cards });
  }
  return rows;
}

// Search stays on our own copy of the feed: the source's /search/ is disallowed
// to crawlers, so no query ever leaves our origin. Tags and the author are
// searchable too — "futanari" finds a card whose title never says it.
export function animeSearch(cards, query, { limit = 24 } = {}) {
  const text = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!text || !Array.isArray(cards)) return [];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = [];
  for (const card of cards) {
    if (!card || typeof card.title !== "string") continue;
    const haystack = [card.title, card.author ?? "", ...(Array.isArray(card.tags) ? card.tags : [])].join(" ").toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    matches.push(card);
    if (matches.length >= limit) break;
  }
  return matches;
}
