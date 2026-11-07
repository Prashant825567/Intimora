// This is the existing public discovery endpoint. It is intentionally visible
// in the client bundle; credentials must never be placed in this URL.
export const DEFAULT_DISCOVERY_URL = "https://intimora.tmc78lxnu.workers.dev/api/get-server";

// Direct browser requests must not be pointed at credential-bearing URLs or
// obvious local/private network targets. DNS and backend access controls still
// have to be enforced by the backend; a browser cannot validate DNS safely.
export function publicHttpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || value !== value.trim()
    || value.includes("?") || value.includes("#")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || !/^\/[A-Za-z0-9._~/-]*$/.test(url.pathname)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || host.startsWith("[") || host === "localhost"
      || /\.(?:localhost|local|internal)$/.test(host)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 168 || (b === 0 && c === 0)))
        || (a === 198 && (b === 18 || b === 19))) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function publicBackendBase(value) {
  const url = publicHttpsUrl(value);
  return url ? url.replace(/\/+$/, "") : null;
}
