import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiProxyUpstream = process.env.API_PROXY_UPSTREAM || "https://api-intimora.vercel.app";

export default defineConfig({
  // Render serves this app from the domain root.
  base: "/",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Arena exposes the dev server under a dynamic preview host.
    allowedHosts: true,
    // Same-origin API proxy for local preview; avoids browser CORS checks.
    proxy: {
      "/_api": {
        target: apiProxyUpstream,
        changeOrigin: true,
        secure: true,
        rewrite: (requestPath) => requestPath.replace(/^\/_api(?=\/|$)/, ""),
      },
    },
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
