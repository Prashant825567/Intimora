import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DISCOVERY_URL = "https://intimora.tmc78lxnu.workers.dev/api/get-server";

async function discoverApiProxyTarget() {
  const override = process.env.API_PROXY_UPSTREAM?.trim();
  if (override) return override.replace(/\/+$/, "");

  const discoveryUrl = process.env.VITE_API_DISCOVERY_URL || DEFAULT_DISCOVERY_URL;
  const response = await fetch(discoveryUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`API discovery returned HTTP ${response.status}`);
  const payload = await response.json();
  const server = payload?.ok && typeof payload?.data?.server === "string"
    ? payload.data.server
    : "";
  if (!server) throw new Error("API discovery response did not include a server URL");
  return server.replace(/\/+$/, "");
}

export default defineConfig(async ({ command }: ConfigEnv): Promise<UserConfig> => {
  // The proxy is only for local development. Render's static production build
  // calls the server returned by the Worker directly from the browser.
  const proxyTarget = command === "serve" ? await discoverApiProxyTarget() : undefined;

  return {
    base: "/",
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      // Arena exposes the dev server under a dynamic preview host.
      allowedHosts: true,
      ...(proxyTarget
        ? {
            proxy: {
              "/_api": {
                target: proxyTarget,
                changeOrigin: true,
                secure: true,
                rewrite: (requestPath: string) => requestPath.replace(/^\/_api(?=\/|$)/, ""),
              },
            },
          }
        : {}),
    },
    plugins: [react(), tailwindcss(), viteSingleFile()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
  };
});
