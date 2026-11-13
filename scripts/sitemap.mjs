import { readJson, requestUpstream, validateNetworkUrl } from "../server/api-proxy.mjs";
import { BROWSE_PATHS } from "../src/services/page-routes.mjs";
import { DEFAULT_DISCOVERY_URL, publicBackendBase, publicHttpsUrl } from "../src/services/public-url.mjs";

export const SITE_ORIGIN = "https://intimora.new.tg";

// The site's own browsable pages, in the order a visitor meets them. They are
// listed first so a crawler always finds the real Intimora pages even when the
// catalog scan fails and no video page can be enumerated.
export const SITE_PAGES = Object.freeze(Object.values(BROWSE_PATHS));
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_SIZE = 50;
const MAX_PAGES = 120;
const REQUEST_TIMEOUT_MS = 10_000;
const BUILD_DEADLINE_MS = 60_000;

// The site origin is fixed and the only variable part has the exact same
// allowlist as the app's watch routes. No API host, title or description enters
// the sitemap, and duplicate or invalid IDs are omitted.
export function renderSitemap(ids = []) {
  const unique = new Set(ids.filter((id) => typeof id === "string" && VIDEO_ID.test(id)));
  const urls = [
    ...SITE_PAGES.map((path) => `${SITE_ORIGIN}${path}`),
    ...Array.from(unique, (id) => `${SITE_ORIGIN}/watch/${id}`),
  ];
  const lines = urls.map((url) => `  <url><loc>${url}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join("\n")}\n</urlset>\n`;
}

// These are build-time requests only, not a browser proxy. Reuse the server's
// DNS-pinned public-network checks, reject redirects, bound response bodies and
// never surface upstream errors or their URLs in output.
export async function readPublicJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  let incoming;
  let timer;
  const started = Date.now();
  try {
    const target = validateNetworkUrl(url.toString());
    incoming = await requestUpstream(target, { timeoutMs, headers: { Accept: "application/json" } });
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error("Request timed out");
    timer = setTimeout(() => incoming.destroy(new Error("Request timed out")), remaining);
    if (incoming.statusCode !== 200) throw new Error("Request failed");
    return await readJson(incoming, 1024 * 1024);
  } catch {
    throw new Error("Sitemap catalog unavailable");
  } finally {
    clearTimeout(timer);
    incoming?.destroy();
  }
}

function validCursor(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 1024)
    || (typeof value === "number" && Number.isFinite(value));
}

// The backend returns overlapping date-cursor pages and may repeat the final
// cursor. A short duplicate page is its normal end; a full duplicate page is
// ambiguous and must not be described as a complete catalog.
export async function buildSitemap({
  discoveryUrl = DEFAULT_DISCOVERY_URL,
  requestJson = readPublicJson,
  maxPages = MAX_PAGES,
  now = Date.now,
} = {}) {
  const ids = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let pages = 0;
  let complete = false;
  const deadline = now() + BUILD_DEADLINE_MS;
  const read = async (url) => {
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Catalog timed out");
    return requestJson(url, Math.min(REQUEST_TIMEOUT_MS, remaining));
  };

  try {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new Error("Invalid page limit");
    const discovery = publicHttpsUrl(discoveryUrl);
    if (!discovery) throw new Error("Invalid discovery");
    const discoveryTarget = validateNetworkUrl(discovery, { allowQuery: false });
    const selection = await read(discoveryTarget);
    const backend = selection?.ok === true ? publicBackendBase(selection.data?.server) : null;
    if (!backend) throw new Error("Invalid selection");

    let cursor = null;
    while (pages < maxPages) {
      const target = new URL(`${backend}/api/videos`);
      target.searchParams.set("limit", String(PAGE_SIZE));
      if (cursor !== null) target.searchParams.set("cursor", String(cursor));
      const page = await read(validateNetworkUrl(target.href));
      const entries = page?.data?.videos;
      if (page?.ok !== true || !Array.isArray(entries) || entries.length > PAGE_SIZE) throw new Error("Invalid catalog");
      pages += 1;
      let fresh = 0;
      for (const video of entries) {
        const id = video?.id;
        if (typeof id === "string" && VIDEO_ID.test(id) && !seenIds.has(id)) {
          seenIds.add(id);
          ids.push(id);
          fresh += 1;
        }
      }

      const next = page.data.nextCursor;
      if (next === null || next === undefined || entries.length === 0) {
        complete = true;
        break;
      }
      if (!validCursor(next)) throw new Error("Invalid cursor");
      const key = String(next);
      if (seenCursors.has(key)) {
        complete = fresh === 0 && entries.length < PAGE_SIZE;
        break;
      }
      seenCursors.add(key);
      cursor = next;
    }
  } catch {
    // Return the safely collected IDs without disclosing network errors. The
    // build plugin retains its checked-in snapshot unless the scan completes.
  }

  return { xml: renderSitemap(ids), videoCount: ids.length, pages, complete };
}
