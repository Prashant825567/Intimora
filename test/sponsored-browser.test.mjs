import "./fixtures/ads-off.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const backend = "https://sponsored-backend.example";
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#6b5b91"/></svg>';

const embed = (id) => `https://desi-porntube.com/embed/${id}/?source=1849513610`;

const sponsoredPayload = {
  version: 2,
  items: [
    { embedUrl: embed(764349), title: "Partner one", thumbnail: "https://cdn.partner.example/one.jpg" },
    { embedUrl: embed(762647), title: "Partner two", thumbnail: "https://cdn.partner.example/two.jpg" },
    { embedUrl: embed(762419), title: "Partner three", thumbnail: null },
    { embedUrl: embed(760001), title: "Partner four", thumbnail: "https://cdn.partner.example/missing.jpg" },
  ],
};

const videos = Array.from({ length: 21 }, (_, index) => ({
  id: `video-${index + 1}`,
  title: `Ours ${index + 1}`,
  createdAt: Date.parse("2026-11-07T12:00:00Z") / 1000 - index * 60,
  views: 100 + index,
  category: "Popular",
}));

const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "sponsored-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0sponsored-test-identity"; },
    load(id) { if (id === "\0sponsored-test-identity") return guestIdentity; },
  };
}

test("sponsored partner videos sit between ours and open in our own player", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 120_000,
}, async () => {
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [identityPlugin()],
  });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const requests = { feed: 0, frames: [] };
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
      if (url.pathname === "/partner-feed.json") {
        requests.feed += 1;
        return route.fulfill({ headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(sponsoredPayload) });
      }
      if (url.hostname.endsWith("desi-porntube.com") || url.hostname.endsWith("cdn.partner.example")) {
        if (url.hostname.endsWith("desi-porntube.com")) requests.frames.push(url.href);
        if (url.pathname.endsWith(".jpg")) {
          if (url.pathname.includes("missing")) return route.fulfill({ status: 404, headers });
          return route.fulfill({ headers, contentType: "image/svg+xml", body: picture });
        }
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Partner fixture</title>" });
      }
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos, nextCursor: null } } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/svg+xml", body: picture });
      return route.fulfill({ headers, json: { ok: true, data: videos[0] } });
    });

    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.equal(await page.locator(".video-card--sponsored").count(), 0, "no sponsored card before the age gate");
    assert.equal(requests.feed, 0, "the partner feed is not read before the age gate");

    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();
    const sponsored = page.locator(".video-card--sponsored");
    await sponsored.first().waitFor();
    assert.equal(requests.feed, 1, "the feed is read once, from our own origin");

    // Four of ours, then one of theirs.
    const order = await page.locator("section[aria-label='All Videos'] .video-card").evaluateAll((cards) =>
      cards.slice(0, 6).map((card) => ({
        sponsored: card.classList.contains("video-card--sponsored"),
        title: card.querySelector(".video-card__title")?.textContent ?? "",
      })));
    assert.deepEqual(order.map((item) => item.sponsored), [false, false, false, false, true, false], "every fifth card is sponsored");
    assert.equal(order[4].title, "Partner one");
    assert.equal(order[4].title, (await sponsored.first().locator(".video-card__title").textContent()), "the partner title is used");
    assert.equal(await sponsored.first().locator(".video-card__badge").textContent(), "SPONSORED", "the badge sits where EXCLUSIVE does on our cards");
    assert.equal(await page.locator("section[aria-label='All Videos'] .video-card:not(.video-card--sponsored) .video-card__badge").count(), 0, "ordinary categories stay off the artwork");
    assert.match(await sponsored.first().locator(".video-card__image").getAttribute("src"), /cdn\.partner\.example\/one\.jpg/);
    // Same card anatomy as ours: bare thumbnail (no box/frame), then title and
    // one metadata line underneath.
    const firstCardClasses = await page.locator("section[aria-label='All Videos'] .video-card").first().getAttribute("class");
    const sponsoredClasses = await sponsored.first().getAttribute("class");
    for (const token of ["video-card", "group"]) {
      assert.ok(firstCardClasses.includes(token), `our card keeps ${token}`);
      assert.ok(sponsoredClasses.includes(token), `the sponsored card keeps our structure (${token})`);
    }
    assert.equal(await sponsored.first().locator(".video-card__media").evaluate((node) => getComputedStyle(node).borderTopWidth), "0px", "the sponsored thumbnail is not boxed");
    assert.equal(await sponsored.first().locator(".video-card__image").evaluate((node) => getComputedStyle(node).objectFit), "contain", "the sponsored thumbnail is never cropped");
    assert.equal(await page.locator("section[aria-label='All Videos'] .video-card__media").first().evaluate((node) => getComputedStyle(node).borderTopWidth), "0px", "our cards are unboxed too");

    // Clicking it opens the site's own player, not the partner's page.
    await sponsored.first().getByRole("button", { name: /Play Partner one/ }).click();
    const player = page.locator("#partner-player-container");
    await player.waitFor();
    await page.getByRole("dialog", { name: "Sponsored video player" }).waitFor();
    const frame = player.locator("iframe");
    assert.equal(await frame.getAttribute("src"), embed(764349));
    assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
    const sandbox = await frame.getAttribute("sandbox");
    assert.ok(sandbox && sandbox.includes("allow-scripts"), "the partner player still runs its scripts");
    assert.ok(!sandbox.includes("allow-modals"), "partner alert()/confirm() pop-ups (the Telegram dialog) are suppressed");
    assert.equal(await page.getByRole("button", { name: "Close video player" }).count(), 1);
    await page.getByRole("button", { name: "Close video player" }).click();
    await player.waitFor({ state: "detached" });

    // A partner page without a poster still renders a tidy tile, never a broken image.
    const withoutPoster = page.locator(".video-card--sponsored").nth(2);
    await withoutPoster.getByText("Partner video").waitFor();
    assert.equal(await withoutPoster.locator("img.video-card__image").count(), 0, "no broken image element is left behind");
    // A poster that exists but fails to load (hotlink block, expired link) is
    // swapped for the same tile as soon as the error fires.
    const brokenPoster = page.locator(".video-card--sponsored").nth(3);
    await brokenPoster.getByText("Partner video").waitFor({ timeout: 15_000 });
    assert.equal(await brokenPoster.locator("img.video-card__image").count(), 0);

    // No sponsored cards over search results.
    await page.goto(`${base}/search?q=test`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Search results for/ }).waitFor();
    assert.equal(await page.locator(".video-card--sponsored").count(), 0, "no sponsored cards in search results");
    assert.deepEqual(requests.frames, [embed(764349)], "only the opened sponsored video is requested");

    // The feeds keep the same rhythm.
    await page.goto(`${base}/trending`, { waitUntil: "domcontentloaded" });
    await page.locator(".video-card--sponsored").first().waitFor();
    const feedOrder = await page.locator("main .video-card").evaluateAll((cards) =>
      cards.slice(0, 5).map((card) => card.classList.contains("video-card--sponsored")));
    assert.deepEqual(feedOrder, [false, false, false, false, true]);
    await context.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});
