import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const browserAvailable = existsSync(browserPath);
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function availablePort() {
  const server = createNetServer();
  const address = await listen(server);
  const port = new URL(address).port;
  await new Promise((resolve) => server.close(resolve));
  return Number(port);
}

async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function sendJson(res, value) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("real browser sessions discover independently and reuse only their own backend", {
  skip: browserAvailable ? false : "Install Chromium with npx playwright-core install chromium, or set CHROMIUM_PATH",
  timeout: 120_000,
}, async () => {
  const calls = [];
  const backends = ["A", "B"].map((label) => {
    let base;
    const server = createHttpServer((req, res) => {
      const url = new URL(req.url, "http://internal.invalid");
      calls.push({ backend: label, path: url.pathname, route: req.headers["x-intimora-route"] });
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
        return sendJson(res, {
          ok: true,
          data: {
            videos: [{ id: "video-1", title: `Session ${label} sample`, category: "New", creator: "Test", thumbnailUrl: `${base}/image`, tags: ["demo"] }],
            nextCursor: null,
          },
        });
      }
      if (url.pathname === "/image") {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(image);
      }
      if (url.pathname === "/api/videos/video-1/stream") {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "0" });
        return res.end();
      }
      if (url.pathname === "/api/videos/video-1") return sendJson(res, { ok: true });
      res.writeHead(404);
      res.end();
    });
    return { server, setBase(value) { base = value; } };
  });
  const addresses = [];
  let discoveries = 0;
  const discovery = createHttpServer((_req, res) => {
    const address = addresses[discoveries % addresses.length];
    discoveries += 1;
    return sendJson(res, { ok: true, data: { server: address } });
  });
  const names = ["API_DISCOVERY_URL", "API_PROXY_UPSTREAM", "API_ALLOWED_HOSTS", "API_MEDIA_ALLOWED_HOSTS", "API_ALLOW_LOOPBACK", "PROXY_TOKEN_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let vite;
  let browser;
  try {
    for (const backend of backends) {
      const address = await listen(backend.server);
      backend.setBase(address);
      addresses.push(address);
    }
    process.env.API_DISCOVERY_URL = await listen(discovery);
    process.env.API_PROXY_UPSTREAM = "";
    process.env.API_ALLOWED_HOSTS = "";
    process.env.API_MEDIA_ALLOWED_HOSTS = "";
    process.env.API_ALLOW_LOOPBACK = "1";
    process.env.PROXY_TOKEN_SECRET = "browser-routing-test-secret-0123456789";
    vite = await createViteServer({
      configFile: path.join(root, "vite.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
    });
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const contextA = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const contextB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const browserRequests = [];
    for (const page of [pageA, pageB]) page.on("request", (request) => browserRequests.push(request.url()));
    await Promise.all([pageA.goto(base), pageB.goto(base)]);
    await Promise.all([
      pageA.getByRole("button", { name: /I AM 18/i }).click(),
      pageB.getByRole("button", { name: /I AM 18/i }).click(),
    ]);
    await Promise.all([
      pageA.getByRole("button", { name: /WATCH NOW/i }).waitFor(),
      pageB.getByRole("button", { name: /WATCH NOW/i }).waitFor(),
    ]);
    const labels = await Promise.all([pageA, pageB].map((page) => page.locator(".hero-banner__title").textContent()));
    assert.deepEqual(new Set(labels), new Set(["Session A sample", "Session B sample"]));
    assert.equal(discoveries, 2, "each visitor contacts discovery once, even with React's concurrent initial requests");
    const stored = await Promise.all([pageA, pageB].map((page) => page.evaluate(() => sessionStorage.getItem("intimora_visitor_route_v1"))));
    assert.ok(stored.every(Boolean));
    assert.notEqual(JSON.parse(stored[0]).token, JSON.parse(stored[1]).token);
    for (const entry of stored) {
      for (const address of addresses) assert.ok(!entry.includes(address), "session storage must not contain a backend address");
    }

    for (const [index, page] of [pageA, pageB].entries()) {
      const label = labels[index].includes(" A ") ? "A" : "B";
      const detail = page.waitForResponse((response) => response.url().endsWith("/_api/api/videos/video-1"));
      await page.getByRole("button", { name: /WATCH NOW/i }).click();
      await detail;
      await page.getByRole("button", { name: "Close video player" }).click();
      const search = page.getByRole("textbox", { name: "Search videos" });
      await search.fill("demo");
      await search.press("Enter");
      await page.getByText("Search results for").waitFor();
      assert.ok(calls.some((call) => call.backend === label && call.path === "/api/search"));
      assert.ok(calls.some((call) => call.backend === label && call.path === "/api/videos/video-1"));
    }
    assert.equal(discoveries, 2, "search, detail and media reuse the session selection");
    assert.ok(calls.every((call) => call.route === undefined), "selection tokens never reach the backend");
    assert.ok(browserRequests.every((url) => !addresses.some((address) => url.startsWith(address))), "the browser never contacts an upstream directly");
    assert.ok(browserRequests.every((url) => !url.startsWith(process.env.API_DISCOVERY_URL)), "the browser never contacts discovery directly");
    await pageA.reload();
    await pageA.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.equal(discoveries, 2, "reloading the same tab reuses its unexpired selection");

    const restricted = await browser.newContext();
    await restricted.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("storage disabled"); } });
    });
    const restrictedPage = await restricted.newPage();
    await restrictedPage.goto(base);
    await restrictedPage.getByRole("button", { name: /I AM 18/i }).click();
    await restrictedPage.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.equal(discoveries, 3, "a new visitor still works when session storage is blocked");
  } finally {
    await browser?.close();
    await vite?.close();
    await close(discovery);
    for (const backend of backends) await close(backend.server);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
