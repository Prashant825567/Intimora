import "./fixtures/ads-off.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
// The watch route's real answer for the live titles is an HLS playlist, so the
// fixture serves a genuine three-segment one (see test/fixtures/README.md).
const HLS_DIR = path.join(root, "test/fixtures/hls");
const HOLLOW = "https://hls.anime.example/_hls/flv/0807/38331/,default,.mp4.urlset/master.m3u8?validfrom=1&hash=abc%3D";
// The source can also refuse the playlist outright (403 / a CORS rejection).
const REFUSED = "https://refused.anime.example/_hls/flv/0001/11111/master.m3u8?validfrom=1&hash=def";
const SEGMENTS = ["seg0.bin", "seg1.bin", "seg2.bin"];
const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#6b4f8a"/></svg>';

const catalogVideos = [{ id: "own-one", title: "Our own video", views: 10, createdAt: 1_760_000_000, category: "Desi" }];
// What our anime API answers: the source's own rows, recent first. One title
// appears in both rows, which is exactly what the real listings do.
const recent = {
  status: "success",
  data: { provider: "hentaicity", type: "recent", results: [
    { id: "reality-control-6-1JdXN6yeMdN", title: "Reality control 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", duration: "HD07:03" },
    { id: "one-wife-1-OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", duration: "23:36" },
    { id: "refused-title-9Refused01", title: "Refused title", thumbnail: "https://cdn1.images.hentaicity.com/videos/0001/11111/main.jpg", duration: "03:00" },
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
    const hlsRequests = [];
    const refusedRequests = [];
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
          // The first title answers with the playlist the service really sends;
          // the second with a plain file, so both shapes are covered.
          const id = url.pathname.split("/").pop();
          // The route is asked with the whole slug; the id's tail picks the shape.
          const hls = id.endsWith("-1JdXN6yeMdN");
          if (id.endsWith("-9Refused01")) {
            return route.fulfill({ headers, json: { status: "success", data: { id, source: [{ src: REFUSED, formate: "hls" }] } } });
          }
          return route.fulfill({ headers, json: { status: "success", data: {
            id,
            source: hls
              ? [{ src: HOLLOW, formate: "hls", vttThumbnail: "https://www.hentaicity.com/stp/vtt.php?v=x" }]
              : [{ src: STREAM, formate: "hls" }],
          } } });
        }
        return route.fulfill({ status: 404, headers, json: { ok: false } });
      }
      if (url.pathname === "/partner-feed.json") return route.fulfill({ json: { version: 2, items: [] } });
      if (url.hostname === "www.hentaicity.com" && url.pathname.startsWith("/embed/")) {
        frames.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<html><body>partner player</body></html>" });
      }
      if (url.hostname === "cdn1.images.hentaicity.com") return route.fulfill({ contentType: "image/svg+xml", body: poster });
      if (url.hostname === "refused.anime.example") {
        refusedRequests.push(url.pathname);
        return route.fulfill({ status: 403, headers, body: "denied" });
      }
      if (url.hostname === "hls.anime.example") {
        hlsRequests.push(url.pathname);
        if (url.pathname.endsWith(".m3u8")) {
          return route.fulfill({ headers, contentType: "application/vnd.apple.mpegurl", body: readFileSync(path.join(HLS_DIR, "index.m3u8")) });
        }
        const segment = SEGMENTS.find((name) => url.pathname.endsWith(name));
        if (segment) return route.fulfill({ headers, contentType: "video/mp2t", body: readFileSync(path.join(HLS_DIR, segment)) });
        return route.fulfill({ status: 404, headers, body: "" });
      }
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
    assert.equal(await allAnimeRow.locator(".video-card--anime").count(), 3, "the Anime row holds the recent cards");

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
    assert.equal(await page.locator(".video-card--anime").count(), 4, "one title sits in both rows, so four cards for five rows");
    assert.deepEqual(await recentRow.locator(".video-card--anime .video-card__title").allInnerTexts(), ["Reality control 6", "One Wife 1", "Refused title"]);
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
    // The account's own actions sit on the card, but they never claim to be the
    // source's: an external title is stored under a namespaced `anime-…` id.
    assert.equal(await page.locator(".video-card--anime").first().getByRole("button", { name: "Like anime" }).count(), 1);
    assert.equal(await page.locator(".video-card--anime").first().getByRole("button", { name: "Save anime" }).count(), 1);

    // A click asks the service's watch route and plays what it returns. The live
    // titles answer with an HLS playlist, so the click plays the service's own
    // playlist through hls.js — the segments come from the source directly, with
    // no iframe, no proxy and nothing rebuilt.
    await recentRow.locator(".video-card--anime").first().click();
    const dialog = page.getByRole("dialog", { name: "Anime player" });
    await dialog.waitFor();
    await page.waitForFunction((expected) => document.querySelector("[data-anime-src]")?.getAttribute("data-anime-src") === expected, HOLLOW, { timeout: 20_000 })
      .catch(async (error) => {
        throw new Error(`the returned playlist never reached the player; dialog says: ${(await dialog.innerText()).slice(0, 200)} / ${error.message}`);
      });
    // Chromium has no native playlist reader, so hls.js must be the one that
    // drives the element — and the playlist and every segment must load.
    await page.waitForFunction(() => document.querySelector("[data-anime-via]")?.getAttribute("data-anime-via") === "hls", undefined, { timeout: 20_000 });
    await page.waitForFunction(() => {
      const video = document.querySelector("#anime-player-container video");
      return video && video.readyState >= 2;
    }, undefined, { timeout: 30_000 });
    assert.ok(hlsRequests.some((path) => path.endsWith("master.m3u8")), `the playlist came from the source (got ${JSON.stringify(hlsRequests.slice(0, 5))})`);
    assert.ok(SEGMENTS.every((name) => hlsRequests.some((path) => path.endsWith(name))), `every segment came from the source (got ${JSON.stringify(hlsRequests)})`);
    assert.equal(await dialog.getByText(/no playable file/i).count(), 0, "a playlist is a playable file, not a missing one");
    assert.match(await dialog.locator("video").getAttribute("src"), /^blob:/, "the playlist is fed to the element through hls.js (MediaSource), never as a src URL");
    assert.equal(await dialog.locator("iframe").count(), 0, "no embed frame is used any more");
    assert.ok(streamRequests.length >= 1 && streamRequests.every((path) => path === "/api/hen/city/watch/reality-control-6-1JdXN6yeMdN"),
      `the watch route is asked for that id (got ${JSON.stringify(streamRequests)})`);
    assert.deepEqual(frames, [], "no partner/embed page is loaded for a click");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // A title whose answer is a plain file still goes straight into the element.
    await page.locator(".video-card--anime").filter({ hasText: "One Wife 1" }).first().click();
    const fileDialog = page.getByRole("dialog", { name: "Anime player" });
    await fileDialog.waitFor();
    // The stub file host answers 404, so the element cannot decode it; what the
    // player was handed is what is asserted — the returned file, untouched.
    await page.waitForFunction((expected) => document.querySelector("[data-anime-src]")?.getAttribute("data-anime-src") === expected, STREAM, { timeout: 20_000 })
      .catch(async (error) => {
        throw new Error(`the returned file never reached the player; dialog says: ${(await fileDialog.innerText()).slice(0, 200)} / ${error.message}`);
      });
    assert.equal(await page.locator("[data-anime-via]").getAttribute("data-anime-via"), "", "a plain file needs no playlist reader");
    await page.keyboard.press("Escape");
    await fileDialog.waitFor({ state: "detached" });

    // A playlist the source refuses (403 / CORS) is reported instead of leaving a
    // stuck spinner: the link was fetched once to check, and nothing plays.
    await page.locator(".video-card--anime").filter({ hasText: "Refused title" }).first().click();
    const refusedDialog = page.getByRole("dialog", { name: "Anime player" });
    await refusedDialog.waitFor();
    await refusedDialog.getByText(/video source hamari site ko nahi de raha/i).waitFor({ timeout: 20_000 });
    assert.ok(refusedRequests.length >= 1, "the playlist was checked once");
    assert.equal(await refusedDialog.locator("video").count(), 0, "nothing is mounted");
    assert.equal(await page.locator("[data-anime-src]").getAttribute("data-anime-src"), "", "no link was played");
    await page.keyboard.press("Escape");
    await refusedDialog.waitFor({ state: "detached" });

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
