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
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#6b4f8a"/></svg>';

const catalogVideos = [{ id: "own-one", title: "Our own video", views: 10, createdAt: 1_760_000_000, category: "Desi" }];
const feed = {
  version: 2,
  source: "https://www.hentaicity.com",
  generatedAt: "2026-11-19T00:00:00.000Z",
  // The source's own rows, in its own order. One title appears in both, which is
  // exactly what the real listings do.
  lists: [
    { id: "new", title: "New Releases", itemIds: ["1JdXN6yeMdN", "OneWife001x"] },
    { id: "popular", title: "Most Popular", itemIds: ["OneWife001x"] },
  ],
  items: [
    { id: "1JdXN6yeMdN", title: "Reality control 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", pageUrl: "https://www.hentaicity.com/video/x-1JdXN6yeMdN.html", embedUrl: "https://www.hentaicity.com/embed/1JdXN6yeMdN", duration: "07:03", tags: ["mind control", "futanari"], author: "fluffy", uploadDate: "2026-11-16", rating: 73 },
    { id: "OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", pageUrl: "https://www.hentaicity.com/video/y-OneWife001x.html", embedUrl: "https://www.hentaicity.com/embed/OneWife001x", duration: "23:36" },
  ],
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

test("anime cards come from the baked feed and open the source's own player inside our frame", {
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
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/anime-feed.json") return route.fulfill({ json: feed });
      if (url.pathname === "/partner-feed.json") return route.fulfill({ json: { version: 2, items: [] } });
      if (url.hostname === "www.hentaicity.com" && url.pathname.startsWith("/embed/")) {
        frames.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<html><body>partner player</body></html>" });
      }
      if (url.hostname === "cdn1.images.hentaicity.com") return route.fulfill({ contentType: "image/svg+xml", body: poster });
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

    // All still shows only our own catalogue: the feed never leaks into it.
    assert.equal(await page.locator(".video-card--anime").count(), 0, "no anime card outside the anime filter");

    await page.getByRole("button", { name: "Anime", exact: true }).click();
    await page.getByRole("heading", { name: "Anime", exact: true }).waitFor();
    await page.locator(".video-card--anime").first().waitFor();

    // The feed's own rows are shown as rows, in the feed's order — New Releases
    // and Most Popular, not one undifferentiated wall of cards.
    const newRow = page.getByRole("region", { name: "New Releases" });
    const popularRow = page.getByRole("region", { name: "Most Popular" });
    await newRow.waitFor();
    assert.equal(await page.locator(".video-card--anime").count(), 3, "one title sits in both rows");
    assert.deepEqual(await newRow.locator(".video-card--anime .video-card__title").allInnerTexts(), ["Reality control 6", "One Wife 1"]);
    assert.deepEqual(await popularRow.locator(".video-card--anime .video-card__title").allInnerTexts(), ["One Wife 1"]);
    assert.equal(await page.locator("h3", { hasText: "Top Rated" }).count(), 0, "a row the feed did not send is never invented");
    assert.equal(await page.locator(".video-card--anime .video-card__badge").first().innerText(), "ANIME");

    // The facts their own video page volunteered are shown; the card without them
    // stays as clean as before.
    const firstCard = newRow.locator(".video-card--anime").first();
    assert.match((await firstCard.innerText()).toLowerCase(), /anime · fluffy · 73%/);
    assert.deepEqual((await firstCard.locator(".anime-card__tags span").allInnerTexts()).map((tag) => tag.toLowerCase()), ["mind control", "futanari"]);
    assert.equal(await newRow.locator(".video-card--anime").nth(1).locator(".anime-card__tags").count(), 0, "no tags, no empty row");
    assert.match(await newRow.locator(".video-card--anime").nth(1).innerText(), /Anime · Hentai City/, "the credit line falls back to the source");
    assert.match(await page.locator(".video-card--anime img").first().getAttribute("src"), /cdn1\.images\.hentaicity\.com/);
    assert.equal(await page.locator(".video-card--anime .duration, .video-card--anime").first().innerText().then((text) => text.includes("07:03")), true);
    assert.equal(await page.locator(".video-card--anime").first().getByRole("button", { name: /save|like/i }).count(), 0, "an external title has no backend id, so it offers no like/save");

    // A click opens the source's own player inside our overlay — never a copied media URL.
    await newRow.locator(".video-card--anime").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const frame = dialog.locator("iframe");
    assert.equal(await frame.getAttribute("src"), "https://www.hentaicity.com/embed/1JdXN6yeMdN");
    assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(frames, ["https://www.hentaicity.com/embed/1JdXN6yeMdN"]);

    // Search matches the local feed too, in its own section.
    const search = page.getByRole("textbox", { name: "Search videos" });
    await search.fill("one wife");
    await search.press("Enter");
    await page.getByRole("region", { name: "Anime results" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Anime results" }).locator(".video-card--anime").count(), 1, "search still matches the flat feed, not the rows");

    // A tag is searchable too, so "futanari" finds a title that never says it.
    await search.fill("futanari");
    await search.press("Enter");
    await page.getByRole("region", { name: "Anime results" }).waitFor();
    assert.deepEqual(await page.getByRole("region", { name: "Anime results" }).locator(".video-card__title").allInnerTexts(), ["Reality control 6"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
  }
});
