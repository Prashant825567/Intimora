import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { applySecurityHeaders } from "./server/security.mjs";
import { DEFAULT_DISCOVERY_URL, publicHttpsUrl } from "./src/services/public-url.mjs";
import { DEFAULT_PARTNER_EMBED_URL, partnerEmbedUrl } from "./src/services/partner-embed.mjs";
import { sitemapPlugin } from "./scripts/sitemap-plugin.mjs";
import { routeShellsPlugin } from "./scripts/route-shells-plugin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Only this explicitly public endpoint enters the bundle. Validate before
  // Vite can embed it; server-only variables are never used by the client.
  const env = loadEnv(mode, __dirname, "");
  const discoveryUrl = publicHttpsUrl(env.INTIMORA_PUBLIC_API_DISCOVERY_URL || DEFAULT_DISCOVERY_URL);
  if (!discoveryUrl) throw new Error("Invalid public discovery URL: use HTTPS without credentials, a query, or a fragment.");
  // The sponsored TubeCorporate iframe keeps its campaign `source` parameter and
  // may only point at the documented partner host.
  const partnerEmbed = partnerEmbedUrl(env.INTIMORA_PUBLIC_PARTNER_EMBED_URL || DEFAULT_PARTNER_EMBED_URL);
  if (!partnerEmbed) throw new Error("Invalid partner embed URL: use the documented HTTPS campaign embed with its source parameter.");
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
      // Validated partner campaign iframe, loaded lazily after the age gate.
      __INTIMORA_PARTNER_EMBED__: JSON.stringify(partnerEmbed),
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
    ],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  };
});
