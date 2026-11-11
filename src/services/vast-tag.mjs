// The HilltopAds Video VAST tag is a public URL, not a secret. Only HTTPS tags
// on the documented ad domains are accepted so a mistyped or injected value can
// never reach the browser bundle.
export const VAST_TAG_HOSTS = Object.freeze(["surprisedplate.com", "hilltopads.com"]);
const MAX_LENGTH = 1024;

export function vastTagUrl(value, { hosts = VAST_TAG_HOSTS } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_LENGTH || value !== value.trim()) return null;
  if (!Array.isArray(hosts) || !hosts.length) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    if (!/^\/[A-Za-z0-9._~/%+-]{1,900}$/.test(url.pathname)) return null;
    for (const [name, parameter] of url.searchParams) {
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name) || !/^[A-Za-z0-9_.~%+-]{0,128}$/.test(parameter)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
