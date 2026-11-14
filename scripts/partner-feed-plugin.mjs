import { rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PARTNER_PREVIEW_LIMIT, parseEmbedPreview, parsePartnerFeedEntries, partnerFeedPayload, partnerPosterCandidates } from "../src/services/partner-feed.mjs";

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
    const items = parsePartnerFeedEntries(text);
    if (!items.length) throw new Error("feed contained no usable embeds");
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Some hosts only publish their tags to a phone browser, others answer a bare
// desktop request with a challenge page. Both are tried before giving up.
const PREVIEW_HEADER_SETS = Object.freeze([
  PREVIEW_HEADERS,
  Object.freeze({
    ...PREVIEW_HEADERS,
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  }),
]);

// The embed page is the canonical source, but it is also the page most likely to
// be bot-protected. The partner's normal video page carries the same tags and is
// usually served to ordinary browsers without a challenge.
export function alternatePreviewUrls(embedUrl) {
  try {
    const url = new URL(embedUrl);
    const id = /\/(?:embed|video|videos)\/(\d{1,12})\/?/.exec(url.pathname)?.[1];
    // TubeCorporate sites publish a video as /video/<id>/<slug>/; a few older
    // templates use the plural, so both are tried before any guessing starts.
    return id ? [`${url.origin}/video/${id}/`, `${url.origin}/videos/${id}/`] : [];
  } catch {
    return [];
  }
}

async function readHtmlPage(fetchImpl, url, timeoutMs) {
  if (typeof fetchImpl !== "function") return null;
  for (const headers of PREVIEW_HEADER_SETS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        credentials: "omit",
        headers,
      });
      // Some hosts answer a challenge page or an image with 200; only HTML can
      // carry a preview, so anything else keeps the generic card.
      const contentType = (response.headers?.get?.("content-type") ?? "").toLowerCase();
      if (response.ok && (!contentType || contentType.includes("html") || contentType.includes("xml"))) {
        const preview = parseEmbedPreview(await response.text(), response.url || url);
        if (preview.thumbnail || preview.title) return { preview, url: response.url || url };
      }
    } catch {
      // Try the next header set; the card still works without a preview.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// A screenshot that answers 200 with an image type is a usable poster even when
// the page that references it could not be read.
async function probePoster(fetchImpl, url, timeoutMs) {
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetchImpl(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      headers: { ...PREVIEW_HEADERS, accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
    });
    const type = (head.headers?.get?.("content-type") ?? "").toLowerCase();
    const usable = head.ok && type.startsWith("image/") && Number(head.headers?.get?.("content-length") ?? 1) > 0;
    if (usable) return url;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Each sponsored card should carry the partner video's own title and poster, so a
// handful of pages are read at build time (bounded in count, time and
// concurrency). Three sources are tried in order: the embed page, the partner's
// ordinary video page, then the predictable screenshot paths. Only when all of
// them fail does the card show its neutral placeholder tile.
export async function enrichPartnerItems(embedUrls, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  concurrency = 6,
  limit = PARTNER_PREVIEW_LIMIT,
  onDiagnostic,
} = {}) {
  const queue = (Array.isArray(embedUrls) ? embedUrls : []).slice(0, Math.max(0, limit));
  const items = new Array(queue.length);
  const report = typeof onDiagnostic === "function" ? onDiagnostic : () => {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const raw = queue[index];
      const entry = typeof raw === "string" ? { embedUrl: raw } : raw;
      const embedUrl = typeof entry?.embedUrl === "string" ? entry.embedUrl : null;
      if (!embedUrl) continue;
      // A richer feed row (title / screenshot columns) already answers everything.
      let preview = {
        title: typeof entry.title === "string" ? entry.title : "",
        thumbnail: typeof entry.thumbnail === "string" ? entry.thumbnail : null,
      };
      let via = preview.title || preview.thumbnail ? "feed" : null;
      if (preview.title && preview.thumbnail) {
        report({ embedUrl, ...preview, via });
        items[index] = { embedUrl, ...preview };
        continue;
      }
      // A partner may redirect the embed to its canonical host, so every later
      // guess is made on the host that answered.
      let effectiveUrl = embedUrl;
      const embedPage = await readHtmlPage(fetchImpl, embedUrl, timeoutMs);
      if (embedPage) {
        preview = embedPage.preview;
        effectiveUrl = embedPage.url;
        via = "embed";
      }
      if (!preview.thumbnail || !preview.title) {
        for (const alternate of alternatePreviewUrls(effectiveUrl)) {
          const altPage = await readHtmlPage(fetchImpl, alternate, timeoutMs);
          if (!altPage) continue;
          effectiveUrl = altPage.url || effectiveUrl;
          preview = {
            title: preview.title || altPage.preview.title,
            thumbnail: preview.thumbnail || altPage.preview.thumbnail,
          };
          via = via ? `${via}+video` : "video";
          if (preview.thumbnail) break;
        }
      }
      if (!preview.thumbnail) {
        const origin = (() => {
          try {
            return new URL(effectiveUrl).origin;
          } catch {
            return undefined;
          }
        })();
        for (const candidate of partnerPosterCandidates(effectiveUrl, { origin })) {
          const poster = await probePoster(fetchImpl, candidate, timeoutMs);
          if (poster) {
            preview.thumbnail = poster;
            via = via ? `${via}+screenshot` : "screenshot";
            break;
          }
        }
      }
      report({ embedUrl, title: preview.title, thumbnail: preview.thumbnail, via });
      items[index] = { embedUrl, ...preview };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return items.filter(Boolean);
}

// One line in the build log says whether sponsored cards will have a title and a
// poster, which is the difference between a real card and a generic tile.
export function describePreviewCoverage(diagnostics) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (!list.length) return "Partner previews: 0 pages resolved.";
  const withPoster = list.filter((entry) => entry?.thumbnail).length;
  const withTitle = list.filter((entry) => entry?.title).length;
  return `Partner previews: ${withPoster}/${list.length} pages resolved (${withTitle} with a title).`;
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
  const read = async ({ log = false } = {}) => {
    if (offline) return [];
    const urls = await generate(feedUrl, { timeoutMs });
    const diagnostics = [];
    const items = await enrich(urls, {
      timeoutMs: Math.min(timeoutMs, 5000),
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    if (log && diagnostics.length) console.info(describePreviewCoverage(diagnostics));
    return items;
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
        const items = await read({ log: true });
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
