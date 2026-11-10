// TubeCorporate campaign embeds are third-party iframe pages. Only the
// documented partner host is accepted, the campaign's `source` parameter is
// required, and everything else is rejected before it can reach the bundle.
export const DEFAULT_PARTNER_EMBED_URL = "https://hdzog.com/embed/71011?source=1849513610";
export const PARTNER_EMBED_HOSTS = Object.freeze(["hdzog.com"]);

const VIDEO_PATH = /^\/embed\/[A-Za-z0-9_-]{1,64}$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
const PARAM_VALUE = /^[A-Za-z0-9_.-]{0,64}$/;
const SOURCE = /^[0-9]{1,20}$/;

export function partnerEmbedUrl(value) {
  if (typeof value !== "string" || !value || value.length > 300 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!PARTNER_EMBED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    if (!VIDEO_PATH.test(url.pathname)) return null;
    for (const [name, parameter] of url.searchParams) {
      if (!PARAM_NAME.test(name) || !PARAM_VALUE.test(parameter)) return null;
    }
    const source = url.searchParams.get("source");
    if (!source || !SOURCE.test(source)) return null;
    return url.href;
  } catch {
    return null;
  }
}
