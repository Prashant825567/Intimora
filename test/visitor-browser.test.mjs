import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const browserAvailable = existsSync(browserPath);
const discovery = "https://discovery.example/api/get-server";
const backends = { A: "https://backend-a.example", B: "https://backend-b.example" };
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function video(label, id = "video-1") {
  return {
    id, title: `Session ${label} sample`, category: "New", creator: "Test", likes: 2,
    thumbnailUrl: `/api/videos/${id}/thumbnail`, streamUrl: `/api/videos/${id}/stream`, tags: ["demo"],
    description: "A description with https://private.invalid/?token=secret-marker", password: "secret-marker",
  };
}

async function installMocks(context, state, { invalidDiscovery = false } = {}) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    };
    if (request.url() === discovery) {
      state.discoveries += 1;
      const label = state.forcedNext || (state.discoveries % 2 ? "A" : "B");
      state.forcedNext = null;
      state.calls.push({ label: "discovery", url: request.url(), method: request.method(), headers: request.headers() });
      const server = invalidDiscovery ? "https://private.example/?token=secret-marker" : backends[label];
      return route.fulfill({ headers: cors, json: { ok: true, data: { server } } });
    }
    const label = Object.entries(backends).find(([, base]) => url.origin === base)?.[0];
    if (!label) return route.continue();
    state.calls.push({ label, url: request.url(), path: url.pathname, search: url.search, method: request.method(), headers: request.headers(), body: request.postData() });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
      const isNext = url.searchParams.has("cursor");
      const item = video(label, isNext ? "video-2" : "video-1");
      if (isNext) {
        item.thumbnailUrl = "https://tracker.example/image?token=secret-marker";
        item.streamUrl = "https://tracker.example/stream?token=secret-marker";
      }
      return route.fulfill({ headers: cors, json: { ok: true, data: { videos: [item], nextCursor: isNext ? null : `next-${label}` } } });
    }
    if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ status: 200, headers: cors, contentType: "image/png", body: image });
    if (url.pathname.endsWith("/stream")) {
      const content = "0123456789";
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : content.length - 1, content.length - 1);
        return route.fulfill({ status: 206, headers: { ...cors, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${content.length}` }, contentType: "video/mp4", body: content.slice(start, end + 1) });
      }
      return route.fulfill({ status: 200, headers: { ...cors, "Accept-Ranges": "bytes" }, contentType: "video/mp4", body: content });
    }
    if (/\/api\/videos\/video-1(?:\/(?:like|share))?$/.test(url.pathname)) {
      return route.fulfill({ headers: cors, json: { ok: true, data: video(label) } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { ok: false, error: "private details" } });
  });
}

test("browser calls public discovery and backends directly, with per-tab routing and pinned actions", {
  skip: browserAvailable ? false : "Install Chromium with npx playwright-core install chromium, or set CHROMIUM_PATH",
  timeout: 120_000,
}, async () => {
  const previous = process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
  process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = discovery;
  const state = { discoveries: 0, forcedNext: null, calls: [] };
  let vite;
  let browser;
  try {
    vite = await createViteServer({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
    });
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const contexts = await Promise.all(["A", "B"].map(async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await installMocks(context, state);
      await context.addInitScript(() => {
        const originalNow = Date.now;
        window.__timeOffset = 0;
        Date.now = () => originalNow() + window.__timeOffset;
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      });
      return context;
    }));
    const [pageA, pageB] = await Promise.all(contexts.map((context) => context.newPage()));
    const browserRequests = [];
    const pageErrors = [];
    for (const page of [pageA, pageB]) {
      page.on("request", (request) => browserRequests.push(request.url()));
      page.on("pageerror", (error) => pageErrors.push(error.message));
    }
    const discoveryResponses = [pageA, pageB].map((page) => page.waitForResponse((response) => response.url() === discovery));
    await Promise.all([pageA.goto(base), pageB.goto(base), ...discoveryResponses]);
    assert.equal(state.discoveries, 2, "discovery starts once for each arriving tab, before age confirmation");
    assert.ok(!state.calls.some((call) => call.path === "/api/videos"), "catalog is not loaded before age confirmation");
    await Promise.all([pageA, pageB].map((page) => page.getByRole("button", { name: /I AM 18/i }).click()));
    await Promise.all([pageA, pageB].map((page) => page.getByRole("button", { name: /WATCH NOW/i }).waitFor()));
    const labels = await Promise.all([pageA, pageB].map(async (page) => (await page.locator(".hero-banner__title").textContent()).includes(" A ") ? "A" : "B"));
    assert.deepEqual(new Set(labels), new Set(["A", "B"]));
    assert.equal(state.discoveries, 2);
    const stored = await Promise.all([pageA, pageB].map((page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("intimora_direct_backend_v1")))));
    assert.equal(stored[0].backend, backends[labels[0]]);
    assert.equal(stored[1].backend, backends[labels[1]]);
    await pageA.waitForFunction(() => document.querySelector(".hero-banner img")?.naturalWidth > 0);
    assert.equal(await pageA.locator(".hero-banner img").first().getAttribute("src"), `${backends[labels[0]]}/api/videos/video-1/thumbnail`);
    assert.ok(browserRequests.some((url) => url === discovery));
    assert.ok(browserRequests.some((url) => url.startsWith(backends.A)));
    assert.ok(browserRequests.some((url) => url.startsWith(backends.B)));
    assert.ok(browserRequests.every((url) => !url.includes("/_api/")), "the frontend does not call the old proxy");

    await pageA.reload();
    await pageA.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.equal(state.discoveries, 2, "reload reuses this tab's unexpired selection");

    const popupPromise = pageA.waitForEvent("popup");
    await pageA.evaluate(() => window.open("/", "_blank"));
    const popup = await popupPromise;
    await popup.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.equal(state.discoveries, 3, "a new tab discovers independently even if sessionStorage was copied");
    await popup.close();

    const original = labels[0];
    const renewed = original === "A" ? "B" : "A";
    const cursor = await pageA.evaluate(async () => {
      const api = await import("/src/services/api.ts");
      return (await api.fetchVideos()).data.nextCursor;
    });
    assert.equal(cursor.backend, backends[original]);
    await pageA.evaluate(() => { window.__timeOffset = 61_000; });
    state.forcedNext = renewed;
    const search = pageA.getByRole("textbox", { name: "Search videos" });
    await search.fill("demo");
    await search.press("Enter");
    await pageA.getByText("Search results for").waitFor();
    assert.equal(state.discoveries, 4);
    assert.ok(state.calls.some((call) => call.label === renewed && call.path === "/api/search"));
    const paged = await pageA.evaluate(async (savedCursor) => {
      const api = await import("/src/services/api.ts");
      const result = await api.fetchVideos(savedCursor);
      return { result, mapped: api.mapApiVideoToVideo(result.data.videos[0], result.data.backend) };
    }, cursor);
    assert.equal(paged.result.data.backend, backends[original]);
    assert.equal(paged.mapped.thumbnail, `${backends[original]}/api/videos/video-2/thumbnail`);
    assert.equal(paged.mapped.videoUrl, `${backends[original]}/api/videos/video-2/stream`);
    assert.ok(!JSON.stringify(paged.mapped).includes("secret-marker"));
    assert.ok(!Object.hasOwn(paged.result.data.videos[0], "password"));
    assert.ok(state.calls.some((call) => call.label === original && call.path === "/api/videos" && call.search.includes(`cursor=next-${original}`)));

    await search.fill("");
    const detailResponse = pageA.waitForResponse((response) => response.url() === `${backends[original]}/api/videos/video-1`);
    await pageA.getByRole("button", { name: /WATCH NOW/i }).click();
    await detailResponse;
    const player = pageA.locator("#player-container");
    await player.waitFor();
    assert.equal(await player.locator("video").getAttribute("src"), `${backends[original]}/api/videos/video-1/stream`);
    const range = await pageA.evaluate(async () => {
      const response = await fetch(document.querySelector("video").src, { credentials: "omit", headers: { Range: "bytes=2-5" } });
      return { status: response.status, contentRange: response.headers.get("content-range"), body: await response.text() };
    });
    assert.deepEqual(range, { status: 206, contentRange: "bytes 2-5/10", body: "2345" });
    const likeResponse = pageA.waitForResponse((response) => response.url() === `${backends[original]}/api/videos/video-1/like` && response.request().method() === "POST");
    await pageA.getByRole("button", { name: "Like video" }).click();
    await likeResponse;
    const unlikeResponse = pageA.waitForResponse((response) => response.url() === `${backends[original]}/api/videos/video-1/like` && response.request().method() === "POST");
    await pageA.getByRole("button", { name: "Unlike video" }).click();
    await unlikeResponse;
    assert.ok(state.calls.some((call) => call.label === original && call.path.endsWith("/like") && call.method === "POST" && call.body === "{}"));

    await pageA.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
    });
    await pageA.getByRole("button", { name: "Share", exact: true }).click();
    const shareResponse = pageA.waitForResponse((response) => response.url() === `${backends[original]}/api/videos/video-1/share` && response.request().method() === "POST");
    await pageA.getByRole("button", { name: "Copy", exact: true }).click();
    await shareResponse;
    const sharedUrl = await pageA.evaluate(() => window.__copied);
    assert.equal(sharedUrl, `${base}/watch/video-1`);
    assert.ok(!sharedUrl.includes(backends[original]));
    assert.ok(state.calls.some((call) => call.label === original && call.path.endsWith("/share") && call.method === "POST"));
    assert.ok(state.calls.filter((call) => call.label !== "discovery").every((call) => !call.headers.cookie && !call.headers.authorization));
    assert.deepEqual(pageErrors, []);

    const recipient = await browser.newContext();
    await installMocks(recipient, state);
    const sharedPage = await recipient.newPage();
    await sharedPage.goto(sharedUrl);
    await sharedPage.getByRole("button", { name: /I AM 18/i }).click();
    await sharedPage.locator("#player-container").waitFor();
    assert.match(await sharedPage.locator("#player-container video").getAttribute("src"), /^https:\/\/backend-[ab]\.example\/api\/videos\/video-1\/stream$/);
    await recipient.close();

    const denied = await browser.newContext();
    await installMocks(denied, state);
    await denied.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("storage denied"); } });
    });
    const deniedPage = await denied.newPage();
    await deniedPage.goto(base);
    await deniedPage.getByRole("button", { name: /I AM 18/i }).click();
    await deniedPage.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    await denied.close();

    const bad = await browser.newContext();
    await installMocks(bad, state, { invalidDiscovery: true });
    const badPage = await bad.newPage();
    await badPage.goto(base);
    await badPage.getByRole("button", { name: /I AM 18/i }).click();
    await badPage.getByRole("heading", { name: "Content Unavailable" }).waitFor();
    const errorText = await badPage.locator("body").innerText();
    assert.ok(!errorText.includes("private.example") && !errorText.includes("secret-marker"));
    await bad.close();
  } finally {
    await browser?.close();
    await vite?.close();
    if (previous === undefined) delete process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
    else process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = previous;
  }
});
