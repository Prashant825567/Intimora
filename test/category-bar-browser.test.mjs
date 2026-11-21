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
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#5b7a91"/></svg>';

const videos = [
  { id: "desi-one", title: "Desi one", views: 40, createdAt: 1_760_000_000, category: "Desi" },
  { id: "anime-one", title: "Anime one", views: 30, createdAt: 1_759_900_000, category: "Anime" },
  { id: "anime-two", title: "Anime two", views: 20, createdAt: 1_759_800_000, tags: ["hot anime"] },
  { id: "foreign-one", title: "Foreign one", views: 10, createdAt: 1_759_700_000, category: "Russian" },
  { id: "premium-one", title: "Premium one", views: 5, createdAt: 1_759_600_000, tags: ["Premium"] },
];

const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "category-bar-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0category-bar-test-identity"; },
    load(id) { if (id === "\0category-bar-test-identity") return guestIdentity; },
  };
}

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("home shows All, Desi, Anime and Sponsored under the hero and filters the grid", {
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Kolkata" });
    const handler = async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.hostname === "pacahub-34nd.onrender.com") return route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { ok: true, data: { results: [] } } });
      if (url.pathname === "/partner-feed.json") {
        return route.fulfill({ json: { version: 2, items: [
          { embedUrl: "https://desi-porntube.com/embed/762647/?source=1", title: "Sponsored one", thumbnail: "https://cdn.example/one.jpg" },
          { embedUrl: "https://desi-porntube.com/embed/762648/?source=1", title: "Sponsored two", thumbnail: "https://cdn.example/two.jpg" },
        ] } });
      }
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos, nextCursor: null } } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/svg+xml", body: picture });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    };
    await context.route("**/*", handler);

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();

    const bar = page.locator(".category-bar");
    await bar.waitFor();
    const [heroBox, barBox, headingBox] = await Promise.all([
      page.locator("main section").first().boundingBox(),
      bar.boundingBox(),
      page.getByRole("heading", { name: "All Videos" }).boundingBox(),
    ]);
    assert.ok(heroBox && barBox && headingBox, "the hero, the bar and the heading are laid out");
    assert.ok(barBox.y >= heroBox.y + heroBox.height - 1, "the bar starts below the hero");
    assert.ok(barBox.y + barBox.height <= headingBox.y + 1, "the bar sits above the All Videos heading");

    for (const label of ["All", "Desi", "Anime", "Sponsored", "Premium"]) {
      assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1, `${label} chip exists`);
    }
    assert.deepEqual(await page.locator(".category-bar__chip").allInnerTexts(), ["All", "Desi", "Anime", "Sponsored", "Premium"],
      "Premium sits right beside Sponsored");
    assert.equal(await page.getByRole("button", { name: "All", exact: true }).getAttribute("aria-pressed"), "true");
    const titles = async () => page.locator("main .video-card:not(.video-card--sponsored) .video-card__title").allInnerTexts();
    assert.deepEqual((await titles()).sort(), ["Anime one", "Anime two", "Desi one", "Foreign one", "Premium one"]);

    await page.getByRole("button", { name: "Anime", exact: true }).click();
    await page.getByRole("heading", { name: "Anime", exact: true }).waitFor();
    assert.deepEqual((await titles()).sort(), ["Anime one", "Anime two"]);
    assert.equal(await page.getByRole("button", { name: "Anime", exact: true }).getAttribute("aria-pressed"), "true");

    await page.getByRole("button", { name: "Desi", exact: true }).click();
    await page.getByRole("heading", { name: "Desi", exact: true }).waitFor();
    assert.deepEqual((await titles()).sort(), ["Desi one", "Foreign one"], "other countries' uploads are not dropped");

    await page.getByRole("button", { name: "Sponsored", exact: true }).click();
    await page.getByRole("heading", { name: "Sponsored", exact: true }).waitFor();
    assert.equal(await page.locator("main .video-card:not(.video-card--sponsored)").count(), 0, "no catalogue card in the sponsored view");
    assert.equal(await page.locator("main .video-card--sponsored").count(), 2);

    // Premium is its own filter: only the uploads the catalogue marks premium.
    await page.getByRole("button", { name: "Premium", exact: true }).click();
    await page.getByRole("heading", { name: "Premium", exact: true }).waitFor();
    assert.deepEqual((await titles()).sort(), ["Premium one"]);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();
    assert.equal((await titles()).length, 5);
    assert.deepEqual(errors, []);

    // A phone must not gain a horizontal scrollbar from the bar.
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    await phone.route("**/*", handler);
    const phonePage = await phone.newPage();
    await phonePage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await phonePage.getByRole("button", { name: /I AM 18/i }).click();
    await phonePage.getByRole("heading", { name: "All Videos" }).waitFor();
    const overflow = await phonePage.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
    });
    assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, `the bar does not widen the page (${overflow.scrollWidth} <= ${overflow.innerWidth})`);
    await phone.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});
