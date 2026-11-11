import { rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePartnerFeed, partnerFeedPayload } from "../src/services/partner-feed.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FEED_TIMEOUT_MS = 10_000;

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

export function partnerFeedPlugin({
  feedUrl,
  timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
  generate = requestPartnerFeed,
  // Test and offline builds must never contact the feed host.
  offline = false,
}) {
  const read = () => (offline ? Promise.resolve([]) : generate(feedUrl, { timeoutMs }));
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
