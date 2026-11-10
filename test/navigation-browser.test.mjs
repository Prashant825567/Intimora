import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createStaticHost } from "./fixtures/static-host.mjs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build, createServer as createViteServer } from "vite";
import { createAppServer } from "../server/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const backend = "https://api-intimora.vercel.app";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const video = { id: "video-1", title: "Direct video", views: 10, likes: 2, createdAt: Math.floor(Date.now() / 1000), exclusive: true };
const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "navigation-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0navigation-test-identity"; },
    load(id) { if (id === "\0navigation-test-identity") return guestIdentity; },
  };
}

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("browse, search, and watch URLs work on direct entry, reload, and browser history", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 90_000,
}, async () => {
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
    server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
    plugins: [identityPlugin()],
  });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const calls = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      calls.push({ pathname: url.pathname, query: url.searchParams.get("q") });
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [video], nextCursor: null } } });
      if (url.pathname === "/api/videos/video-1") return route.fulfill({ headers, json: { ok: true, data: video } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/png", body: image });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ headers, contentType: "video/mp4", body: "" });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(`${base}/trending`, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.ok(!calls.some((call) => call.pathname.startsWith("/api/videos") || call.pathname === "/api/search"), "no catalog is requested before the age gate");
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/trending");
    const nav = page.locator(".site-nav__desktop-links");
    for (const [label, href] of [["Home", "/"], ["Trending", "/trending"], ["New", "/new"], ["Exclusive", "/exclusive"], ["Categories", "/categories"]]) {
      assert.equal(await nav.getByRole("link", { name: label, exact: true }).getAttribute("href"), href);
    }
    assert.equal(await nav.getByRole("link", { name: "Trending", exact: true }).getAttribute("aria-current"), "page");
    assert.equal((await page.reload()).status(), 200);
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/trending");

    await nav.getByRole("link", { name: "New", exact: true }).click();
    await page.getByRole("heading", { name: "New Releases" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/new");
    await nav.getByRole("link", { name: "Exclusive", exact: true }).click();
    await page.getByRole("heading", { name: "Exclusive", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/exclusive");
    await nav.getByRole("link", { name: "Categories", exact: true }).click();
    await page.getByRole("heading", { name: "Coming Soon" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/categories");
    await page.goBack();
    await page.getByRole("heading", { name: "Exclusive", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/exclusive");
    await page.goForward();
    await page.getByRole("heading", { name: "Coming Soon" }).waitFor();

    const direct = await context.newPage();
    assert.equal((await direct.goto(`${base}/exclusive/`)).status(), 200);
    await direct.getByRole("button", { name: /I AM 18/i }).click();
    await direct.getByRole("heading", { name: "Exclusive", exact: true }).waitFor();
    assert.equal(new URL(direct.url()).pathname, "/exclusive/");
    await direct.close();

    const directSearch = await context.newPage();
    assert.equal((await directSearch.goto(`${base}/search?q=fresh%20%26%20direct`)).status(), 200);
    await directSearch.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.ok(!calls.some((call) => call.pathname === "/api/search" && call.query === "fresh & direct"), "direct searches also wait for age confirmation");
    await directSearch.getByRole("button", { name: /I AM 18/i }).click();
    await directSearch.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.equal(await directSearch.getByRole("textbox", { name: "Search videos" }).inputValue(), "fresh & direct");
    await directSearch.close();

    await nav.getByRole("link", { name: "Trending", exact: true }).click();
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    const search = page.getByRole("textbox", { name: "Search videos" });
    await search.fill("cats & dogs");
    await search.press("Enter");
    await page.getByText("Search results for").waitFor();
    let url = new URL(page.url());
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("q"), "cats & dogs");
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.ok(calls.some((call) => call.pathname === "/api/search" && call.query === "cats & dogs"));
    assert.equal((await page.reload()).status(), 200);
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.equal(await search.inputValue(), "cats & dogs");
    await page.goBack();
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    await page.goForward();
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    url = new URL(page.url());
    assert.equal(url.searchParams.get("q"), "cats & dogs");

    const detailCount = () => calls.filter((call) => call.pathname === "/api/videos/video-1").length;
    const before = detailCount();
    const detailResponse = page.waitForResponse((item) => item.url() === `${backend}/api/videos/video-1`);
    await page.getByRole("button", { name: "Play Direct video" }).click();
    await detailResponse;
    await page.locator("#player-container").waitFor();
    assert.equal(new URL(page.url()).pathname, "/watch/video-1");
    assert.equal(detailCount(), before + 1, "opening a video makes only one view-counting request");
    const closeSearch = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/search");
    await page.getByRole("button", { name: "Close video player" }).click();
    await closeSearch;
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/search");
    // Closing replaced the watch entry with the original search, leaving two
    // neighboring history entries with the same URL. Back must still restore it.
    const backSearch = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/search");
    await page.goBack();
    await backSearch;
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    const reopened = page.waitForResponse((item) => item.url() === `${backend}/api/videos/video-1`);
    await page.getByRole("button", { name: "Play Direct video" }).click();
    await reopened;
    assert.equal(detailCount(), before + 2);
    assert.equal((await page.reload()).status(), 200);
    const player = page.locator("#player-container");
    await player.locator("video").waitFor();
    assert.equal(new URL(page.url()).pathname, "/watch/video-1");
    assert.equal(await player.locator("video").getAttribute("autoplay"), null, "direct visits do not autoplay");
    assert.equal(await player.locator("video").evaluate((element) => element.paused), true);
    await page.getByRole("button", { name: "Close video player" }).click();
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("production bundle serves each real route on direct entry and refresh", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 90_000,
}, async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-navigation-build-"));
  let server;
  let browser;
  try {
    await build({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
    });
    server = createAppServer({ distDir: output });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [video], nextCursor: null } } });
      if (url.pathname === "/api/videos/video-1") return route.fulfill({ headers, json: { ok: true, data: video } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/png", body: image });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ headers, contentType: "video/mp4", body: "" });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const footerLink = () => page.locator("footer").getByRole("link", { name: "Boost Your Website Traffic with TrafficPeak" });
    const assertFooterLink = async () => {
      const link = footerLink();
      await link.waitFor();
      assert.equal(await link.count(), 1);
      assert.equal(await link.getAttribute("href"), "https://trafficpeak.io");
    };
    assert.equal((await page.goto(`${base}/dashboard`)).status(), 200);
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.equal(await page.locator("footer").count(), 0, "the age gate still precedes the app");
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login", "a guest is sent to sign-in instead of seeing private account data");
    await assertFooterLink();

    for (const pathname of ["/login", "/profile", "/referral", "/dashboard"]) {
      assert.equal((await page.goto(`${base}${pathname}`)).status(), 200, pathname);
      await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/login");
      await assertFooterLink();
    }
    assert.equal((await page.goto(`${base}/`)).status(), 200);
    await page.getByRole("heading", { name: "All Videos" }).waitFor();
    await assertFooterLink();
    for (const [pathname, title] of [["/trending", "Trending Now"], ["/new/", "New Releases"], ["/exclusive", "Exclusive"], ["/categories/", "Coming Soon"]]) {
      assert.equal((await page.goto(`${base}${pathname}`)).status(), 200, pathname);
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.equal((await page.reload()).status(), 200, pathname);
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, pathname);
      await assertFooterLink();
    }
    assert.equal((await page.goto(`${base}/search?q=direct%20test`)).status(), 200);
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.equal((await page.reload()).status(), 200);
    await page.getByRole("button", { name: "Play Direct video" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Search videos" }).inputValue(), "direct test");
    await assertFooterLink();
    assert.equal((await page.goto(`${base}/watch/video-1`)).status(), 200);
    await page.locator("#player-container video").waitFor();
    assert.equal((await page.reload()).status(), 200);
    await page.locator("#player-container video").waitFor();
    assert.equal(new URL(page.url()).pathname, "/watch/video-1");
    assert.equal(await footerLink().getAttribute("href"), "https://trafficpeak.io", "the footer remains in the page under the watch player");
    await page.getByRole("button", { name: "Close video player" }).click();
    await page.route("https://trafficpeak.io/", (route) => route.fulfill({ contentType: "text/html", body: "TrafficPeak fixture" }));
    await footerLink().click();
    await page.waitForURL("https://trafficpeak.io/");
    assert.deepEqual(errors, []);
    await context.close();

    const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
    const noScriptPage = await noScriptContext.newPage();
    for (const pathname of ["/", "/trending", "/search?q=test", "/dashboard", "/watch/video-1"]) {
      assert.equal((await noScriptPage.goto(`${base}${pathname}`)).status(), 200);
      const link = noScriptPage.getByRole("link", { name: "Boost Your Website Traffic with TrafficPeak" });
      await link.waitFor({ state: "visible" });
      assert.equal(await link.count(), 1);
      assert.equal(await link.getAttribute("href"), "https://trafficpeak.io");
    }
    await noScriptContext.close();

    // The deployed host currently has no rewrite configuration. Every page is
    // still reachable directly because the build publishes a real HTML file for
    // it, so this serves `dist` with no rewrite rules at all.
    const staticHost = createStaticHost(output);
    await new Promise((resolve) => staticHost.listen(0, "127.0.0.1", resolve));
    try {
      const staticBase = `http://127.0.0.1:${staticHost.address().port}`;
      const staticContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await staticContext.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
        if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
        if (url.origin !== backend) return route.continue();
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [video], nextCursor: null } } });
        if (url.pathname === "/api/videos/video-1") return route.fulfill({ headers, json: { ok: true, data: video } });
        if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/png", body: image });
        if (url.pathname.endsWith("/stream")) return route.fulfill({ headers, contentType: "video/mp4", body: "" });
        return route.fulfill({ status: 404, headers, json: { ok: false } });
      });
      const staticPage = await staticContext.newPage();
      const staticErrors = [];
      staticPage.on("pageerror", (error) => staticErrors.push(error.message));
      assert.equal((await staticPage.goto(`${staticBase}/`)).status(), 200);
      await staticPage.getByRole("button", { name: /I AM 18/i }).click();
      await staticPage.getByRole("heading", { name: "All Videos" }).waitFor();
      for (const [pathname, heading] of [["/trending", "Trending Now"], ["/new/", "New Releases"], ["/exclusive", "Exclusive"], ["/categories/", "Coming Soon"]]) {
        assert.equal((await staticPage.goto(`${staticBase}${pathname}`)).status(), 200, `${pathname} needs no rewrite rule`);
        await staticPage.getByRole("heading", { name: heading, exact: true }).waitFor();
        assert.equal(new URL(staticPage.url()).pathname, pathname, `${pathname} keeps its URL`);
      }
      assert.equal((await staticPage.goto(`${staticBase}/search?q=direct%20test`)).status(), 200);
      await staticPage.getByRole("button", { name: "Play Direct video" }).waitFor();
      assert.equal(await staticPage.getByRole("textbox", { name: "Search videos" }).inputValue(), "direct test");
      assert.equal((await staticPage.goto(`${staticBase}/dashboard`)).status(), 200);
      await staticPage.getByRole("heading", { name: "Sign in to your account" }).waitFor();
      assert.equal(new URL(staticPage.url()).pathname, "/login");
      // Video pages that exist only in the sitemap still load through the
      // published 404 page, so an un-rebuilt watch link is not a dead end.
      const watchResponse = await staticPage.goto(`${staticBase}/watch/video-1`);
      assert.equal(watchResponse.status(), 404, "an unlisted video ID uses the custom 404 page");
      await staticPage.locator("#player-container video").waitFor();
      assert.equal(new URL(staticPage.url()).pathname, "/watch/video-1");
      assert.deepEqual(staticErrors, []);
      await staticContext.close();
    } finally {
      await new Promise((resolve) => staticHost.close(resolve));
    }
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(output, { recursive: true, force: true });
  }
});
