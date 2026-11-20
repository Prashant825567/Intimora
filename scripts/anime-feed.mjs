// Build step: read the anime source's public listing pages once and write a
// same-origin feed the browser can use. Their robots.txt allows these listings
// with Crawl-Delay: 10 and disallows /embed/ and /search/, so only listings are
// requested here, one at a time, and nothing is ever proxied at runtime.
//
// Like the sitemap step, a failed read keeps the checked-in snapshot instead of
// breaking the build: no network must never mean no site.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANIME_SOURCE, animeFeedPayload, enrichAnimePage, parseAnimeListing } from "../src/services/anime-feed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FEED_FILE = "anime-feed.json";
const MAX_BODY = 3 * 1024 * 1024;

// The source's own ordering, one page per row. "Most Recent" is their newest
// first, "Most popular" and "Top rated" are their own sorts — this build copies
// the order, it never invents a rank. Every page was checked against the live
// site; a page that fails at build time only costs its own row.
export const FEED_LISTS = Object.freeze([
  { id: "new", title: "New Releases", url: `${ANIME_SOURCE}/videos/straight/all-recent.html` },
  { id: "popular", title: "Most Popular", url: `${ANIME_SOURCE}/videos/straight/all-popular.html` },
  { id: "top", title: "Top Rated", url: `${ANIME_SOURCE}/videos/straight/all-rate.html` },
  // Their own category pages, linked from every listing page and from every
  // video page. Same crawl, same limits, one row each.
  { id: "genre-3d", title: "3D", url: `${ANIME_SOURCE}/videos/straight/3d-popular.html` },
  { id: "genre-cartoon", title: "Cartoon", url: `${ANIME_SOURCE}/videos/straight/cartoon-popular.html` },
  { id: "genre-futanari", title: "Futanari", url: `${ANIME_SOURCE}/videos/straight/futanari-popular.html` },
]);

const HEADERS = Object.freeze({
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.8",
  "user-agent": "IntimoraFeed/1.0 (+https://intimora.net)",
});

async function readPage(url, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow", credentials: "omit", headers: HEADERS });
    if (!response.ok) throw new Error(`listing responded ${response.status}`);
    const text = await response.text();
    if (typeof text !== "string" || !text.length || text.length > MAX_BODY) throw new Error("listing body was unusable");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Their crawl delay is ten seconds, so three pages cost ~20s of build time. A
// row that fails is skipped instead of failing the build, and if every row fails
// the checked-in snapshot is kept.
export async function buildAnimeFeed({
  lists = FEED_LISTS,
  fetchImpl = globalThis.fetch,
  delayMs = 10_000,
  limit = Number(process.env.ANIME_FEED_MAX ?? 120),
  perList = 12,
  // One video page per title costs a crawl delay each, so enrichment is capped.
  // Two is the default: it proves the path on every build for one extra minute,
  // and ANIME_FEED_ENRICH=12 tags the first twelve cards when that wait is worth
  // it. ANIME_FEED_ENRICH=0 turns it off.
  enrich = 2,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const items = [];
  const byId = new Map();
  const built = [];
  const failed = [];
  for (let index = 0; index < lists.length; index += 1) {
    if (index > 0 && delayMs > 0) await wait(delayMs);
    const list = lists[index];
    let parsed;
    try {
      parsed = parseAnimeListing(await readPage(list.url, { fetchImpl }));
    } catch (error) {
      failed.push(`${list.id}: ${error.message}`);
      continue;
    }
    const itemIds = [];
    for (const item of parsed) {
      if (itemIds.length >= perList) break;
      if (!byId.has(item.id)) {
        if (items.length >= limit) continue;
        byId.set(item.id, item);
        items.push(item);
      }
      itemIds.push(item.id);
    }
    if (itemIds.length) built.push({ id: list.id, title: list.title, itemIds });
  }
  if (!items.length) {
    throw new Error(`no anime items were found on ${lists.length} listing pages${failed.length ? ` (${failed.join("; ")})` : ""}`);
  }
  if (failed.length) console.warn(`[anime-feed] kept ${built.length}/${lists.length} rows; ${failed.join("; ")}`);

  let enriched = 0;
  for (const item of items.slice(0, Math.max(0, enrich))) {
    if (delayMs > 0) await wait(delayMs);
    try {
      const extras = enrichAnimePage(await readPage(item.pageUrl, { fetchImpl }));
      if (Object.keys(extras).length) {
        Object.assign(item, extras);
        enriched += 1;
      }
    } catch { /* A page that will not load costs its own tags, nothing else. */ }
  }
  if (enrich > 0) console.log(`[anime-feed] enriched ${enriched}/${Math.min(enrich, items.length)} cards from their video pages`);

  return animeFeedPayload(items, { lists: built });
}

async function main() {
  const target = path.join(root, "public", FEED_FILE);
  // ANIME_FEED_LISTS caps how many rows are baked; ANIME_FEED_PAGES is the old
  // name for the same knob and still works.
  const wanted = Number(process.env.ANIME_FEED_LISTS ?? process.env.ANIME_FEED_PAGES ?? FEED_LISTS.length);
  const lists = FEED_LISTS.slice(0, Math.min(FEED_LISTS.length, Math.max(1, Number.isFinite(wanted) ? wanted : FEED_LISTS.length)));
  try {
    const enrich = Math.max(0, Number(process.env.ANIME_FEED_ENRICH ?? 2) || 0);
    const payload = await buildAnimeFeed({ lists, enrich });
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
    const rows = payload.lists.map((list) => `${list.title} ${list.itemIds.length}`).join(", ");
    const tagged = payload.items.filter((item) => item.tags?.length).length;
    console.log(`[anime-feed] wrote ${payload.items.length} anime cards (${rows})${tagged ? ` — tags on ${tagged}` : ""}`);
  } catch (error) {
    let kept = 0;
    try {
      kept = JSON.parse(await readFile(target, "utf8")).items?.length ?? 0;
    } catch { /* No snapshot to keep. */ }
    console.warn(`[anime-feed] ${error.message}; keeping the checked-in snapshot (${kept} cards)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
