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
import { ANIME_SOURCE, animeFeedPayload, parseAnimeListing } from "../src/services/anime-feed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FEED_FILE = "anime-feed.json";
const MAX_BODY = 3 * 1024 * 1024;

export const SEED_PAGES = Object.freeze([
  `${ANIME_SOURCE}/videos/straight/hentai-popular.html`,
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

// One page by default: their crawl delay is ten seconds, so more pages cost more
// build time than they return. Raise ANIME_FEED_PAGES when a bigger catalogue is
// worth the wait.
export async function buildAnimeFeed({
  pages = SEED_PAGES,
  fetchImpl = globalThis.fetch,
  delayMs = 10_000,
  limit = Number(process.env.ANIME_FEED_MAX ?? 120),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const items = [];
  const seen = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0 && delayMs > 0) await wait(delayMs);
    const html = await readPage(pages[index], { fetchImpl });
    for (const item of parseAnimeListing(html)) {
      if (seen.has(item.id) || items.length >= limit) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (items.length >= limit) break;
  }
  if (!items.length) throw new Error("no anime items were found on the listing pages");
  return animeFeedPayload(items);
}

async function main() {
  const target = path.join(root, "public", FEED_FILE);
  const pages = SEED_PAGES.slice(0, Math.max(1, Number(process.env.ANIME_FEED_PAGES ?? 1)));
  try {
    const payload = await buildAnimeFeed({ pages });
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[anime-feed] wrote ${payload.items.length} anime cards`);
  } catch (error) {
    let kept = 0;
    try {
      kept = JSON.parse(await readFile(target, "utf8")).items?.length ?? 0;
    } catch { /* No snapshot to keep. */ }
    console.warn(`[anime-feed] ${error.message}; keeping the checked-in snapshot (${kept} cards)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
