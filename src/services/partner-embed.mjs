// TubeCorporate campaign embeds are third-party iframe pages. Only the
// documented partner hosts are accepted, the campaign's `source` parameter is
// mandatory (it is added when the pasted URL omits it), and anything unsafe is
// rejected before it can reach the bundle.
export const PARTNER_CAMPAIGN_SOURCE = "1849513610";
export const DEFAULT_PARTNER_EMBED_URL = `https://hdzog.com/embed/71011?source=${PARTNER_CAMPAIGN_SOURCE}`;
export const PARTNER_EMBED_HOSTS = Object.freeze(["hdzog.com", "tubecorporate.com", "tube-corporate.com"]);

const VIDEO_PATH = /^\/embed\/[A-Za-z0-9_-]{1,64}$/;
const OTHER_PATH = /^\/(?:[A-Za-z0-9._~/-]{0,200})$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
const PARAM_VALUE = /^[A-Za-z0-9_.-]{0,64}$/;
const SOURCE = /^[0-9]{1,20}$/;
const MAX_LENGTH = 500;

export function partnerEmbedUrl(value, { source = PARTNER_CAMPAIGN_SOURCE, hosts = PARTNER_EMBED_HOSTS } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_LENGTH || value !== value.trim()) return null;
  if (!SOURCE.test(source ?? "") || !Array.isArray(hosts) || !hosts.length) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    // Either a single video embed (`/embed/<id>`) or a campaign feed path.
    if (!VIDEO_PATH.test(url.pathname) && !OTHER_PATH.test(url.pathname)) return null;
    for (const [name, parameter] of url.searchParams) {
      if (!PARAM_NAME.test(name) || !PARAM_VALUE.test(parameter)) return null;
    }
    const existing = url.searchParams.get("source");
    if (existing === null || existing === "") url.searchParams.set("source", source);
    else if (!SOURCE.test(existing)) return null;
    return url.href;
  } catch {
    return null;
  }
}
