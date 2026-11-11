// TubeCorporate campaign URLs are third-party content. Two shapes are accepted:
// a single video embed page (rendered as one iframe) and a campaign CSV feed
// (read at build time and rendered as a grid of sponsored videos). Only the
// documented partner hosts are accepted, the campaign's `source` parameter is
// mandatory (it is added when the pasted URL omits it), and anything unsafe is
// rejected before it can reach the bundle.
export const PARTNER_CAMPAIGN_SOURCE = "1849513610";
export const DEFAULT_PARTNER_EMBED_URL = `https://hdzog.com/embed/2168747?source=${PARTNER_CAMPAIGN_SOURCE}`;
export const PARTNER_EMBED_HOSTS = Object.freeze([
  "hdzog.com",
  "tubecorporate.com",
  "tube-corporate.com",
  "desi-porntube.com",
  "desiporn.tube",
  "desi-porn.tube",
]);
// Only these hosts may be read as a campaign feed. The TubeCorporate dashboard
// hands out `<host>/admin/feeds/embed/?...` links on the .tube host; the feed
// itself lists iframes on the matching .com host.
export const PARTNER_FEED_HOSTS = Object.freeze(["desiporn.tube", "desi-porn.tube", "desi-porntube.com"]);

const VIDEO_PATH = /^\/embed\/[A-Za-z0-9_-]{1,64}\/?$/;
const OTHER_PATH = /^\/[A-Za-z0-9._~%/-]{0,200}$/;
const FEED_PATH = /^\/(?:[A-Za-z0-9._~%-]{1,80}\/)*feeds?\/[A-Za-z0-9._~%/-]{0,120}$/i;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
const PARAM_VALUE = /^[A-Za-z0-9_.-]{0,64}$/;
// Feed queries are long and hold encoded category lists, so they get a wider
// (still bounded) alphabet instead of the strict single-value rules above.
const FEED_SEARCH = /^[A-Za-z0-9_.~%&=()!*,;:+-]{1,1600}$/;
const SOURCE = /^[0-9]{1,20}$/;
const MAX_LENGTH = 500;
const MAX_FEED_LENGTH = 2000;

function hostAllowed(host, hosts) {
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function normaliseSource(url, source) {
  const existing = url.searchParams.get("source");
  if (existing === null || existing === "") {
    url.searchParams.set("source", source);
    return url.href;
  }
  return SOURCE.test(existing) ? url.href : null;
}

export function partnerEmbedUrl(value, { source = PARTNER_CAMPAIGN_SOURCE, hosts = PARTNER_EMBED_HOSTS, requireVideoPath = false } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_LENGTH || value !== value.trim()) return null;
  if (!SOURCE.test(source ?? "") || !Array.isArray(hosts) || !hosts.length) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostAllowed(host, hosts)) return null;
    // Either a single video embed (`/embed/<id>`) or a campaign feed path. Feed
    // rows are always video embeds, so the parser asks for the stricter shape.
    if (!VIDEO_PATH.test(url.pathname) && (requireVideoPath || !OTHER_PATH.test(url.pathname))) return null;
    for (const [name, parameter] of url.searchParams) {
      if (!PARAM_NAME.test(name) || !PARAM_VALUE.test(parameter)) return null;
    }
    return normaliseSource(url, source);
  } catch {
    return null;
  }
}

// A campaign feed is a CSV/HTML listing of ready-made iframe snippets. It is
// read at build time (or by the dev server) and never framed directly.
export function partnerFeedUrl(value, { source = PARTNER_CAMPAIGN_SOURCE } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_FEED_LENGTH || value !== value.trim()) return null;
  if (!SOURCE.test(source ?? "")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostAllowed(host, PARTNER_FEED_HOSTS)) return null;
    if (!FEED_PATH.test(url.pathname)) return null;
    if (!url.search || !FEED_SEARCH.test(url.search.slice(1))) return null;
    const serialised = normaliseSource(url, source);
    if (!serialised || serialised.length > MAX_FEED_LENGTH) return null;
    return serialised;
  } catch {
    return null;
  }
}

// One place decides how a pasted partner URL is used: a feed is read and turned
// into a sponsored grid, anything else must be a single embed page.
export function partnerSource(value, options = {}) {
  const feedUrl = partnerFeedUrl(value, options);
  if (feedUrl) return { mode: "feed", url: feedUrl };
  const embedUrl = partnerEmbedUrl(value, options);
  if (embedUrl) return { mode: "embed", url: embedUrl };
  return null;
}
