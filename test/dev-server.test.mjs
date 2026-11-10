import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("development preview blocks private files without disclosing filesystem paths", async () => {
  const server = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    for (const pathname of ["/server/api-proxy.mjs", "/scripts/sitemap.mjs", "/scripts/request-sitemap-refresh.mjs", "/.env", "/@fs/etc/passwd", "/vite.config.ts", "/render.yaml"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 404);
      const body = await response.text();
      assert.equal(body, "Not found");
      assert.ok(!body.includes(root));
    }
    for (const pathname of ["/", "/src/main.tsx", "/@vite/client", "/@react-refresh", "/node_modules/vite/dist/client/env.mjs"]) {
      assert.equal((await fetch(`${base}${pathname}`)).status, 200, pathname);
    }
    for (const pathname of ["/login", "/profile", "/referral", "/dashboard", "/login/", "/profile/", "/referral/", "/dashboard/", "/trending", "/new/", "/exclusive", "/categories/", "/search?q=hello", "/watch/video-1"]) {
      const response = await fetch(`${base}${pathname}`, { headers: { Accept: "text/html" } });
      assert.equal(response.status, 200, pathname);
      assert.match(await response.text(), /<div id="root"><\/div>/);
    }
  } finally {
    await server.close();
  }
});
