import { rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PARTNER_PREVIEW_LIMIT, parseEmbedPreview, parsePartnerFeed, partnerFeedPayload } from "../src/services/partner-feed.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FEED_TIMEOUT_MS = 10_000;

// Partner pages are regular web pages: they only publish their Open Graph tags
// to a request that looks like a browser. A bare bot user agent is often served
// a challenge page instead, which is why sponsored cards used to arrive without
// a title or a poster.
const PREVIEW_HEADERS = Object.freeze({
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

// Read a campaign feed exactly once per build and turn it into same-origin JSON.
// The feed host is a third party, so the request is time-boxed, size-capped and
// every URL it returns is re-validated before it is written out.
export async function requestPartnerFeed(feedUrl, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_FEED_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(feedUrl, {
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      headers: { accept: "text/csv, text/html;q=0.9, */*;q=0.5", "user-agent": "IntimoraFeed/1.0" },
    });
    if (!response.ok) throw new Error(`feed responded ${response.status}`);
    const text = await response.text();
    if (typeof text !== "string" || text.length > MAX_BODY_BYTES) throw new Error("feed body was too large");
    const items = parsePartnerFeed(text);
    if (!items.length) throw new Error("feed contained no usable embeds");
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Each sponsored card should carry the partner video's own title and poster, so a
// handful of embed pages are read at build time (bounded in count, time and
// concurrency). A page that fails simply yields a card without a preview.
export async function enrichPartnerItems(embedUrls, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  concurrency = 6,
  limit = PARTNER_PREVIEW_LIMIT,
} = {}) {
  const queue = (Array.isArray(embedUrls) ? embedUrls : []).slice(0, Math.max(0, limit));
  const items = new Array(queue.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const embedUrl = queue[index];
      let preview = { title: "", thumbnail: null };
      if (typeof fetchImpl === "function") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(embedUrl, {
            signal: controller.signal,
            redirect: "follow",
            credentials: "omit",
            headers: PREVIEW_HEADERS,
          });
          // Some hosts answer a challenge page or an image with 200; only HTML
          // can carry a preview, so anything else keeps the generic card.
          const contentType = (response.headers?.get?.("content-type") ?? "").toLowerCase();
          if (response.ok && (!contentType || contentType.includes("html") || contentType.includes("xml"))) {
            preview = parseEmbedPreview(await response.text(), embedUrl);
          }
        } catch {
          // No preview: the card still works with its generic title.
        } finally {
          clearTimeout(timer);
        }
      }
      items[index] = { embedUrl, ...preview };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return items.filter(Boolean);
}

export function partnerFeedPlugin({
  feedUrl,
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  generate = requestPartnerFeed,
  // Swappable so tests never contact the partner host.
  enrich = enrichPartnerItems,
  // Test and offline builds must never contact the feed host.
  offline = false,
}) {
  const read = async () => {
    if (offline) return [];
    const urls = await generate(feedUrl, { timeoutMs });
    return enrich(urls, { timeoutMs: Math.min(timeoutMs, 5000) });
  };
  return {
    name: "intimora-partner-feed",
    // Dev has no build output, so the same JSON is generated on demand. This
    // keeps local browsing identical to production without a checked-in copy.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url || "").split("?")[0];
        if (pathname !== "/partner-feed.json") return next();
        try {
          const items = await read();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(partnerFeedPayload(items));
        } catch {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(partnerFeedPayload([]));
        }
      });
    },
    async writeBundle(output) {
      const directory = output.dir;
      if (!directory) {
        this.warn("Sponsored feed skipped; no build directory was reported.");
        return;
      }
      const temp = path.join(directory, `.partner-feed-${process.pid}.tmp`);
      try {
        const items = await read();
        if (!items.length) this.warn("Sponsored feed held no usable videos; the sponsored section is left out.");
        await writeFile(temp, partnerFeedPayload(items), "utf8");
        await rename(temp, path.join(directory, "partner-feed.json"));
        console.info(`Sponsored feed published with ${items.length} video(s).`);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        this.warn(`Sponsored feed could not be read, so the sponsored section is left out (${error?.message ?? "unknown error"}).`);
      }
    },
  };
}
