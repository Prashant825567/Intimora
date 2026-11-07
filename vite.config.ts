import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { applySecurityHeaders } from "./server/security.mjs";
import { DEFAULT_DISCOVERY_URL, publicHttpsUrl } from "./src/services/public-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Only this explicitly public endpoint enters the bundle. Validate before
  // Vite can embed it; server-only variables are never used by the client.
  const env = loadEnv(mode, __dirname, "");
  const discoveryUrl = publicHttpsUrl(env.INTIMORA_PUBLIC_API_DISCOVERY_URL || DEFAULT_DISCOVERY_URL);
  if (!discoveryUrl) throw new Error("Invalid public discovery URL: use HTTPS without credentials, a query, or a fragment.");
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
          || /^\/(?:server|test)(?:\/|$)/i.test(pathname)
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
    define: { __INTIMORA_DISCOVERY_URL__: JSON.stringify(discoveryUrl) },
    // Vite's default VITE_ prefix can accidentally expose secrets at build time.
    // Only explicitly public variables may be referenced by client code.
    envPrefix: "INTIMORA_PUBLIC_",
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: [".e2b.app"],
      fs: { deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx}", "**/.git/**", "**/server/**"] },
    },
    build: { sourcemap: false },
    plugins: [developmentSecurity, react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  };
});
