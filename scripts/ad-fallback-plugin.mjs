import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveVastAd } from "../src/services/vast.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_AD_TIMEOUT_MS = 8000;

// The build reads the tag the way a server can: no CORS, no cookies, no
// referrer. The resolved creative is published as same-origin JSON so the player
// still has an ad when a browser is not allowed to read the tag itself.
export async function requestTagText(url, timeoutMs = DEFAULT_AD_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      credentials: "omit",
      headers: { accept: "text/xml, application/xml;q=0.9, */*;q=0.5", "user-agent": "IntimoraAdProbe/1.0" },
    });
    if (!response.ok) throw new Error(`tag responded ${response.status}`);
    const text = await response.text();
    if (typeof text !== "string" || text.length > MAX_BODY_BYTES) throw new Error("tag body was too large");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildAdSnapshot({ tagUrl, timeoutMs = DEFAULT_AD_TIMEOUT_MS, skipFallbackSeconds = 15, fetchImpl = globalThis.fetch, resolve = resolveVastAd }) {
  const ad = await resolve(tagUrl, {
    fetchText: (url, limit) => requestTagText(url, limit ?? timeoutMs, fetchImpl),
    timeoutMs,
    skipFallbackSeconds,
  });
  return ad ?? null;
}

export function adFallbackPlugin({
  tagUrl,
  timeoutMs = DEFAULT_AD_TIMEOUT_MS,
  skipFallbackSeconds = 15,
  generate = buildAdSnapshot,
  // Tests and offline builds must never contact the ad network.
  offline = false,
}) {
  return {
    name: "intimora-ad-fallback",
    async writeBundle(output) {
      const directory = output.dir;
      if (!directory) {
        this.warn("Ad snapshot skipped; no build directory was reported.");
        return;
      }
      const file = path.join(directory, "ad-fallback.json");
      const temp = path.join(directory, `.ad-fallback-${process.pid}.tmp`);
      try {
        const ad = offline ? null : await generate({ tagUrl, timeoutMs, skipFallbackSeconds });
        if (!ad) {
          // No usable creative: publish an explicit "off" snapshot so the live
          // site can be checked without the browser console.
          await writeFile(temp, `${JSON.stringify({ enabled: false, ad: null }, null, 2)}\n`, "utf8");
          await rename(temp, file);
          this.warn("Ad snapshot is empty; a pre-roll only plays when the browser can read the tag itself.");
          return;
        }
        await writeFile(temp, `${JSON.stringify({ enabled: true, ad }, null, 2)}\n`, "utf8");
        await rename(temp, file);
        console.info(`Ad snapshot published: ${ad.mediaUrl.replace(/\?.*$/, "")}`);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        this.warn(`Ad snapshot could not be built (${error?.message ?? "unknown error"}).`);
      }
    },
  };
}
