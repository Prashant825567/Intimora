import path from "node:path";
import { fileURLToPath } from "node:url";

// A deploy hook is a secret. It is used only by the optional scheduled GitHub
// Action, never put in the site bundle, and never included in logs or errors.
export async function requestSitemapRefresh(hook, fetcher = fetch) {
  if (!hook) return "skipped";
  try {
    if (typeof hook !== "string" || hook.length > 2048) throw new Error("Invalid hook");
    const url = new URL(hook);
    const keys = [...url.searchParams.keys()];
    if (url.protocol !== "https:" || url.host !== "api.render.com" || url.username || url.password || url.hash
      || !/^\/deploy\/srv-[A-Za-z0-9]+$/.test(url.pathname)
      || keys.length !== 1 || keys[0] !== "key" || !url.searchParams.get("key")) throw new Error("Invalid hook");
    const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Request failed");
    await response.body?.cancel();
    return "requested";
  } catch {
    throw new Error("Unable to request sitemap refresh. Check the deploy hook configuration.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await requestSitemapRefresh(process.env.INTIMORA_SITEMAP_DEPLOY_HOOK_URL);
    console.log(result === "requested" ? "Scheduled sitemap refresh requested." : "Sitemap refresh is not configured; skipping.");
  } catch {
    console.error("Unable to request sitemap refresh. Check the deploy hook configuration.");
    process.exitCode = 1;
  }
}
