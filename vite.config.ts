import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createApiHandler } from "./server/api-proxy.mjs";
import { applySecurityHeaders } from "./server/security.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // These values are used only inside the Node process, never in client code.
  const env = loadEnv(mode, __dirname, "");
  const privateApi: Plugin = {
    name: "private-api",
    configureServer(server) {
      const handler = createApiHandler({
        discoveryUrl: env.API_DISCOVERY_URL,
        upstreamUrl: env.API_PROXY_UPSTREAM,
        allowedHosts: env.API_ALLOWED_HOSTS,
        mediaAllowedHosts: env.API_MEDIA_ALLOWED_HOSTS,
        tokenSecret: env.PROXY_TOKEN_SECRET,
        allowLoopback: env.API_ALLOW_LOOPBACK === "1",
      });
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
      server.middlewares.use(handler);
    },
  };

  return {
    base: "/",
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
    plugins: [privateApi, react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  };
});
