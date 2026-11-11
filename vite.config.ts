import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { applySecurityHeaders } from "./server/security.mjs";
import { DEFAULT_DISCOVERY_URL, publicHttpsUrl } from "./src/services/public-url.mjs";
import { PARTNER_EMBED_URL as configuredPartnerEmbed } from "./src/config/partner-embed";
import { VAST_SKIP_FALLBACK_SECONDS, VAST_TAG_URL as configuredVastTag } from "./src/config/vast";
import { DEFAULT_PARTNER_EMBED_URL, partnerSource } from "./src/services/partner-embed.mjs";
import { vastTagUrl } from "./src/services/vast-tag.mjs";
import { sitemapPlugin } from "./scripts/sitemap-plugin.mjs";
import { routeShellsPlugin } from "./scripts/route-shells-plugin.mjs";
import { DEFAULT_FEED_TIMEOUT_MS, partnerFeedPlugin } from "./scripts/partner-feed-plugin.mjs";
import { adFallbackPlugin } from "./scripts/ad-fallback-plugin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Only this explicitly public endpoint enters the bundle. Validate before
  // Vite can embed it; server-only variables are never used by the client.
  const env = loadEnv(mode, __dirname, "");
  const discoveryUrl = publicHttpsUrl(env.INTIMORA_PUBLIC_API_DISCOVERY_URL || DEFAULT_DISCOVERY_URL);
  if (!discoveryUrl) throw new Error("Invalid public discovery URL: use HTTPS without credentials, a query, or a fragment.");
  // The sponsored TubeCorporate URL keeps its campaign `source` parameter and may
  // only point at the documented partner hosts. A campaign feed is read at build
  // time and published as same-origin JSON; a single embed page is framed as is.
  const partner = partnerSource(env.INTIMORA_PUBLIC_PARTNER_EMBED_URL || configuredPartnerEmbed || DEFAULT_PARTNER_EMBED_URL);
  if (!partner) throw new Error("Invalid partner URL: use an https TubeCorporate embed page or campaign feed URL, or leave src/config/partner-embed.ts empty.");
  const partnerFeedTimeout = Number(env.INTIMORA_PARTNER_FEED_TIMEOUT_MS || DEFAULT_FEED_TIMEOUT_MS);
  // Tests and offline builds set this so the feed host is never contacted.
  const partnerFeedOffline = env.INTIMORA_PARTNER_FEED_OFFLINE === "1";
  if (!Number.isFinite(partnerFeedTimeout) || partnerFeedTimeout < 500 || partnerFeedTimeout > 60_000) {
    throw new Error("Invalid partner feed timeout: use 500-60000 milliseconds.");
  }
  // The HilltopAds pre-roll tag is also public. An empty value turns ads off.
  // An explicitly empty value disables pre-roll even though the config file has a tag.
  const vastTagSource = env.INTIMORA_PUBLIC_VAST_TAG_URL !== undefined
    ? env.INTIMORA_PUBLIC_VAST_TAG_URL
    : configuredVastTag;
  const vastTag = vastTagSource ? vastTagUrl(vastTagSource) : "";
  // Offline builds (and tests) must never contact the ad network at build time.
  const adProbeOffline = env.INTIMORA_AD_PROBE_OFFLINE === "1";
  if (vastTag === null) throw new Error("Invalid VAST tag: use an https HilltopAds tag URL, or leave src/config/vast.ts empty.");
  // Firebase tokens go only to explicitly trusted backend origins, never to an
  // arbitrary host that a compromised discovery response might return.
  const authBackends = (env.INTIMORA_PUBLIC_AUTH_BACKENDS || "https://api-intimora.vercel.app,https://intimora-api1.vercel.app")
    .split(",").map((value) => value.trim()).map((value) => {
      const validated = publicHttpsUrl(value);
      if (!validated) throw new Error("Invalid trusted auth backend configuration.");
      const url = new URL(validated);
      if (url.pathname !== "/" || url.port) throw new Error("Invalid trusted auth backend configuration.");
      return url.origin;
    });
  if (!authBackends.length || new Set(authBackends).size !== authBackends.length) throw new Error("Invalid trusted auth backend configuration.");
  const developmentSecurity: Plugin = {
    name: "development-security",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        applySecurityHeaders(res, { development: true, allowPreviewEmbed: true });
        next();
      });
      // Return a generic response instead of Vite's default 403 page, which
      // includes absolute filesystem paths. The dev server is not a secret store.
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url || "/", "http://internal.invalid").pathname);
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          return res.end("Not found");
        }
        const parts = pathname.split("/").filter(Boolean);
        const privateFile = pathname.startsWith("/@fs/")
          || /^\/(?:server|scripts|test)(?:\/|$)/i.test(pathname)
          || parts.some((part) => /^(?:\.env(?:\..*)?|\.git)$/i.test(part))
          || /\.(?:pem|key|p12|pfx)$/i.test(pathname)
          || /^\/(?:vite\.config\.ts|render\.yaml|package(?:-lock)?\.json|tsconfig\.json)$/i.test(pathname);
        if (!privateFile) return next();
        res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        return res.end("Not found");
      });
    },
  };

  return {
    base: "/",
    define: {
      __INTIMORA_DISCOVERY_URL__: JSON.stringify(discoveryUrl),
      __INTIMORA_AUTH_BACKENDS__: JSON.stringify(authBackends),
      // Enable only after the backend returns privacy-filtered referral users.
      __INTIMORA_SAFE_REFERRALS__: JSON.stringify(env.INTIMORA_PUBLIC_SAFE_REFERRALS === "1"),
      // Poll public counts only after every selected backend implements the
      // versioned, privacy-safe contract documented in the README.
      __INTIMORA_LIVE_LIKES__: JSON.stringify(env.INTIMORA_PUBLIC_LIVE_LIKES === "1"),
      // Validated partner campaign: either one iframe URL or the feed grid that
      // is fetched from /partner-feed.json after the age gate.
      __INTIMORA_PARTNER_MODE__: JSON.stringify(partner.mode),
      __INTIMORA_PARTNER_EMBED__: JSON.stringify(partner.mode === "embed" ? partner.url : ""),
      // Empty disables pre-roll; otherwise the validated HilltopAds VAST tag.
      __INTIMORA_VAST_TAG_URL__: JSON.stringify(vastTag),
    },
    // Vite's default VITE_ prefix can accidentally expose secrets at build time.
    // Only explicitly public variables may be referenced by client code.
    envPrefix: "INTIMORA_PUBLIC_",
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: [".e2b.app"],
      fs: { deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx}", "**/.git/**", "**/server/**", "**/scripts/**"] },
    },
    // Prebundle the auth SDK so a first login visit doesn't trigger a Vite
    // dependency-optimization reload in the middle of the age gate.
    optimizeDeps: { include: ["@firebase/app", "@firebase/auth"] },
    build: { sourcemap: false },
    plugins: [
      developmentSecurity,
      react(),
      tailwindcss(),
      sitemapPlugin({ discoveryUrl }),
      // Direct links must work on a static host that has no SPA rewrite, so
      // publish a real HTML file for every page the app can serve.
      routeShellsPlugin({ snapshotSitemap: path.join(__dirname, "public", "sitemap.xml") }),
      // A campaign feed becomes same-origin JSON at build time, so the client
      // never needs CORS from the feed host.
      ...(partner.mode === "feed" ? [partnerFeedPlugin({ feedUrl: partner.url, timeoutMs: partnerFeedTimeout, offline: partnerFeedOffline })] : []),
      // A browser cannot read every VAST tag (CORS, slow ad server), so the build
      // publishes one resolved creative that the player can fall back to.
      ...(vastTag ? [adFallbackPlugin({ tagUrl: vastTag, skipFallbackSeconds: VAST_SKIP_FALLBACK_SECONDS, offline: adProbeOffline })] : []),
    ],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  };
});
