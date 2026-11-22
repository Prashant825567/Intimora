import "./fixtures/ads-off.mjs";
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
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const backend = "https://api-intimora.vercel.app";
const STREAM = "https://cdn.anime.example/clip/index-720.mp4";
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#6b4f8a"/></svg>';

const catalogVideos = [{ id: "own-one", title: "Our own video", views: 10, createdAt: 1_760_000_000, category: "Desi" }];
// What our anime API answers: the source's own rows, recent first. One title
// appears in both rows, which is exactly what the real listings do.
const recent = {
  status: "success",
  data: { provider: "hentaicity", type: "recent", results: [
    { id: "reality-control-6-1JdXN6yeMdN", title: "Reality control 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", duration: "HD07:03" },
    { id: "one-wife-1-OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", duration: "23:36" },
  ] },
};
const popular = {
  status: "success",
  data: { provider: "hentaicity", type: "popular", results: [
    { id: "one-wife-1-OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", duration: "23:36" },
  ] },
};

const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "anime-cards-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0anime-cards-test-identity"; },
    load(id) { if (id === "\0anime-cards-test-identity") return guestIdentity; },
  };
}

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("anime cards come from the live anime API, recent before popular, and play the link the watch route returns", {
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
    const frames = [];
    const animeRequests = [];
    const streamRequests = [];
    // What the player itself asks the source for, recorded at the network layer.
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.hostname === "pacahub-34nd.onrender.com") {
        // Only the list routes are counted as rows; the click asks the watch
        // route, which is recorded separately below.
        if (url.pathname === "/api/hen/city/recent" || url.pathname === "/api/hen/city/popular/1") animeRequests.push(url.pathname);
        if (url.pathname === "/api/hen/city/recent") return route.fulfill({ headers, json: recent });
        if (url.pathname === "/api/hen/city/popular/1") return route.fulfill({ headers, json: popular });
        if (url.pathname.startsWith("/api/hen/city/watch/")) {
          streamRequests.push(url.pathname);
          return route.fulfill({ headers, json: { status: "success", data: { id: url.pathname.split("/").pop(), sources: [{ label: "720p", url: STREAM }] } } });
        }
        return route.fulfill({ status: 404, headers, json: { ok: false } });
      }
      if (url.pathname === "/partner-feed.json") return route.fulfill({ json: { version: 2, items: [] } });
      if (url.hostname === "www.hentaicity.com" && url.pathname.startsWith("/embed/")) {
        frames.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<html><body>partner player</body></html>" });
      }
      if (url.hostname === "cdn1.images.hentaicity.com") return route.fulfill({ contentType: "image/svg+xml", body: poster });
      if (url.hostname === "cdn.anime.example") return route.fulfill({ status: 404, headers, body: "" });
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: catalogVideos, nextCursor: null } } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/svg+xml", body: poster });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();

    // All Videos is Desi, then Anime: the live anime cards sit in the Anime row,
    // never mixed into the Desi grid.
    const desiRow = page.getByRole("region", { name: "Desi videos" });
    await desiRow.waitFor();
    assert.equal(await desiRow.locator(".video-card--anime").count(), 0, "no anime card in the Desi row");
    const allAnimeRow = page.getByRole("region", { name: "Anime videos" });
    await allAnimeRow.waitFor();
    assert.equal(await allAnimeRow.locator(".video-card--anime").count(), 2, "the Anime row holds the recent cards");

    await page.getByRole("button", { name: "Anime", exact: true }).click();
    await page.getByRole("heading", { name: "Anime", exact: true }).waitFor();
    await page.locator(".video-card--anime").first().waitFor();

    // The rows are drawn in the order the anime page promises: Recent, then
    // Popular — and only those two, nothing invented.
    const recentRow = page.getByRole("region", { name: "Recent" });
    const popularRow = page.getByRole("region", { name: "Popular" });
    await recentRow.waitFor();
    await popularRow.waitFor();
    assert.deepEqual(animeRequests, ["/api/hen/city/recent", "/api/hen/city/popular/1"], "recent is asked for first");
    assert.equal(await page.locator(".video-card--anime").count(), 3, "one title sits in both rows");
    assert.deepEqual(await recentRow.locator(".video-card--anime .video-card__title").allInnerTexts(), ["Reality control 6", "One Wife 1"]);
    assert.deepEqual(await popularRow.locator(".video-card--anime .video-card__title").allInnerTexts(), ["One Wife 1"]);
    assert.equal(await page.locator("h3", { hasText: "Top Rated" }).count(), 0, "a row the API did not send is never invented");
    assert.equal(await page.locator(".video-card--anime .video-card__badge").first().innerText(), "ANIME");

    // A list row promises a poster, a title and a duration — nothing else is
    // invented for it.
    const firstCard = recentRow.locator(".video-card--anime").first();
    assert.doesNotMatch(await firstCard.innerText(), /%/);
    assert.match(await firstCard.innerText(), /Anime · Hentai City/);
    assert.equal(await page.locator(".anime-card__tags").count(), 0, "no tags are invented");
    assert.match(await page.locator(".video-card--anime img").first().getAttribute("src"), /cdn1\.images\.hentaicity\.com/);
    assert.equal(await page.locator(".video-card--anime").first().innerText().then((text) => text.includes("07:03")), true);
    assert.equal(await page.locator(".video-card--anime").first().getByRole("button", { name: /save|like/i }).count(), 0, "an external title has no backend id, so it offers no like/save");

    // A click asks the service's watch route for the file and plays that exact
    // link in our own <video>: no iframe, no proxy, nothing rebuilt. The src the
    // player mounts is recorded, so the stub file's decodability is irrelevant.
    await recentRow.locator(".video-card--anime").first().click();
    const dialog = page.getByRole("dialog", { name: "Anime player" });
    await dialog.waitFor();
    await page.waitForFunction((expected) => document.querySelector("[data-anime-src]")?.getAttribute("data-anime-src") === expected, STREAM, { timeout: 20_000 })
      .catch(async (error) => {
        throw new Error(`player src never became the returned link; dialog says: ${(await dialog.innerText()).slice(0, 200)} / ${error.message}`);
      });
    assert.equal(await dialog.locator("iframe").count(), 0, "no embed frame is used any more");
    assert.ok(streamRequests.length >= 1 && streamRequests.every((path) => path === "/api/hen/city/watch/1JdXN6yeMdN"),
      `the watch route is asked for that id (got ${JSON.stringify(streamRequests)})`);
    assert.deepEqual(frames, [], "no partner/embed page is loaded for a click");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // Search matches the cards this page already loaded, in its own section —
    // no query leaves our origin.
    const search = page.getByRole("textbox", { name: "Search videos" });
    await search.fill("one wife");
    await search.press("Enter");
    await page.getByRole("region", { name: "Anime results" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Anime results" }).locator(".video-card--anime").count(), 1, "search still matches the flat list, not the rows");
    await search.fill("reality");
    await search.press("Enter");
    await page.getByRole("region", { name: "Anime results" }).waitFor();
    assert.deepEqual(await page.getByRole("region", { name: "Anime results" }).locator(".video-card__title").allInnerTexts(), ["Reality control 6"]);
    assert.deepEqual(animeRequests, ["/api/hen/city/recent", "/api/hen/city/popular/1"], "search never calls the source");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
  }
});
