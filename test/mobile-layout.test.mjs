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
const thumbnail = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const videos = [{
  id: "sample-1",
  title: "A very long video title that should fit beautifully on a small mobile phone screen " + "unbroken".repeat(14),
  category: "New",
  duration: 738,
  views: 1234567,
  likes: 1245,
  creator: "CreatorWithAVeryVeryLongUnbrokenNameThatMustStayInsideTheScreen",
  uploadedAt: "7 months ago",
  tags: ["premium", "longtag".repeat(10)],
}];

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

async function mockApi(page) {
  await page.route("**/_api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/_api/api/videos" || url.pathname === "/_api/api/search") {
      return route.fulfill({ json: { ok: true, data: { videos, nextCursor: null } } });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: thumbnail });
    }
    if (url.pathname.endsWith("/stream")) {
      return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) });
    }
    return route.fulfill({ json: { ok: true } });
  });
}

async function assertPageFits(page, label) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dimensions.document <= dimensions.width + 1, `${label}: document overflows ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= dimensions.width + 1, `${label}: body overflows ${JSON.stringify(dimensions)}`);
}

async function assertInViewport(locator, width, height, label) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is not visible`);
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${label} overflows horizontally`);
  assert.ok(box.y >= -1 && box.y + box.height <= height + 1, `${label} cannot be reached vertically`);
}

async function assertTextNotClipped(locator, label) {
  const dimensions = await locator.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `${label}: text overflows horizontally`);
  assert.ok(dimensions.scrollHeight <= dimensions.height + 1, `${label}: text is clipped`);
}

test("phone layouts stay within the viewport while desktop styling is preserved", {
  skip: browserAvailable ? false : "Install Chromium with npx playwright-core install chromium, or set CHROMIUM_PATH",
  timeout: 120_000,
}, async () => {
  const server = await createViteServer({
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({
      viewport: { width: 320, height: 568 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockApi(page);

    const sizes = [
      [280, 568], [320, 480], [320, 568], [360, 640], [375, 667],
      [390, 844], [414, 896], [480, 800], [640, 360], [667, 375],
      [844, 390], [932, 430], [1023, 768],
    ];
    for (const [width, height] of sizes) {
      const label = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => sessionStorage.removeItem("intimora_age_verified"));
      await page.reload({ waitUntil: "domcontentloaded" });

      const enter = page.getByRole("button", { name: /I AM 18/i });
      await enter.waitFor();
      await assertPageFits(page, `${label} age gate`);
      await assertInViewport(enter, width, height, `${label} enter button`);
      await assertInViewport(page.getByRole("button", { name: /under 18/i }), width, height, `${label} exit button`);
      await enter.click();

      const watch = page.getByRole("button", { name: /WATCH NOW/i });
      await watch.waitFor();
      await assertPageFits(page, `${label} home`);
      await assertTextNotClipped(page.locator(".hero-banner__title"), `${label} featured title`);
      await assertTextNotClipped(page.locator(".hero-banner__creator"), `${label} featured creator`);
      const heroContentsFit = await page.locator(".hero-banner").evaluate((hero) => {
        const bounds = hero.getBoundingClientRect();
        return [".hero-banner__title", ".hero-banner__creator", ".hero-banner__cta"].every((selector) => {
          const child = hero.querySelector(selector).getBoundingClientRect();
          return child.top >= bounds.top - 1 && child.bottom <= bounds.bottom + 1;
        });
      });
      assert.ok(heroContentsFit, `${label}: featured content is clipped by the banner`);
      await assertTextNotClipped(page.locator(".video-card__title").first(), `${label} card title`);
      await assertTextNotClipped(page.locator(".video-card__creator-name").first(), `${label} card creator`);
      const menu = page.getByRole("button", { name: "Open navigation menu" });
      await assertInViewport(menu, width, height, `${label} menu button`);
      await assertInViewport(page.getByRole("button", { name: "Search", exact: true }), width, height, `${label} search button`);
      await menu.click();
      const closeMenu = page.getByRole("button", { name: "Close navigation menu" });
      assert.equal(await closeMenu.getAttribute("aria-expanded"), "true");
      await page.getByRole("button", { name: "Notifications", exact: true }).waitFor();
      await page.getByRole("button", { name: "Account", exact: true }).waitFor();
      await assertPageFits(page, `${label} open menu`);
      await closeMenu.click();

      await assertInViewport(watch, width, height, `${label} featured action`);
      const cardShare = page.getByRole("button", { name: "Share video" }).first();
      assert.equal(await cardShare.locator("..").evaluate((element) => getComputedStyle(element).opacity), "1");
      const cardActionsFit = await cardShare.locator("..").evaluate((actions) => {
        const thumbnailBounds = actions.parentElement.getBoundingClientRect();
        return [...actions.querySelectorAll("button")].every((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.top >= thumbnailBounds.top - 1 && bounds.bottom <= thumbnailBounds.bottom + 1;
        });
      });
      assert.ok(cardActionsFit, `${label}: video card actions are clipped`);
      await cardShare.click();
      await page.getByRole("heading", { name: "Share Video" }).waitFor();
      await assertTextNotClipped(page.locator(".share-modal__title"), `${label} shared title`);
      await page.getByRole("button", { name: "Close share dialog" }).click();

      await watch.click();
      const player = page.locator("#player-container");
      await player.waitFor();
      await assertPageFits(page, `${label} player`);
      await assertInViewport(page.getByRole("button", { name: "Close video player" }), width, height, `${label} player close`);
      const share = page.getByRole("button", { name: "Share", exact: true });
      await assertInViewport(share, width, height, `${label} player share`);
      await share.click();
      await page.getByRole("heading", { name: "Share Video" }).waitFor();
      await assertPageFits(page, `${label} share dialog`);
      await assertInViewport(page.getByRole("button", { name: "Copy", exact: true }), width, height, `${label} copy button`);
      await page.getByRole("button", { name: "Close share dialog" }).click();

      const search = page.getByRole("textbox", { name: "Search videos" });
      await search.fill("a".repeat(180));
      await search.press("Enter");
      await page.getByText("Search results for").waitFor();
      await assertPageFits(page, `${label} long search`);
    }
    assert.deepEqual(errors, [], "no uncaught browser errors");

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(desktop);
    await desktop.goto(base, { waitUntil: "domcontentloaded" });
    await desktop.evaluate(() => sessionStorage.setItem("intimora_age_verified", "true"));
    await desktop.reload({ waitUntil: "domcontentloaded" });
    await desktop.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.equal(await desktop.locator(".hero-banner").evaluate((element) => element.getBoundingClientRect().height), 380);
    assert.equal(await desktop.locator(".site-nav__brand-text").evaluate((element) => getComputedStyle(element).display), "block");
    assert.equal(await desktop.locator(".site-nav__menu-toggle").evaluate((element) => getComputedStyle(element).display), "none");
    await assertPageFits(desktop, "desktop home");
  } finally {
    await browser?.close();
    await server.close();
  }
});
