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
}, {
  id: "sample-2",
  title: "Catalog item remains available",
  category: " pReMiUm ",
  duration: 900,
  views: 250,
  likes: 42,
  creator: "Intimora",
  tags: [" PREMIUM ", "#Premium", "recent", "hd"],
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
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
    if (url.hostname === "intimora.tmc78lxnu.workers.dev" && url.pathname === "/api/get-server") {
      return route.fulfill({ headers, json: { ok: true, data: { server: "https://mobile-backend.example" } } });
    }
    if (url.hostname !== "mobile-backend.example") return route.continue();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
      return route.fulfill({ headers, json: { ok: true, data: { videos, nextCursor: null } } });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({ status: 200, headers, contentType: "image/png", body: thumbnail });
    }
    if (url.pathname.endsWith("/stream")) {
      return route.fulfill({ status: 200, headers, contentType: "video/mp4", body: Buffer.alloc(0) });
    }
    return route.fulfill({ headers, json: { ok: true } });
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

async function assertHeroImagesFit(page, label) {
  await page.locator(".hero-banner__image").evaluate((image) => image.decode());
  const layout = await page.locator(".hero-banner").evaluate((hero) => {
    const media = hero.querySelector(".hero-banner__media").getBoundingClientRect();
    const image = hero.querySelector(".hero-banner__image");
    const title = hero.querySelector(".hero-banner__title").getBoundingClientRect();
    const navigation = document.querySelector(".site-nav").getBoundingClientRect();
    return {
      fit: getComputedStyle(image).objectFit,
      transform: getComputedStyle(image).transform,
      naturalWidth: image.naturalWidth,
      separate: title.right <= media.left + 1 || title.left >= media.right - 1 || title.top >= media.bottom - 1 || title.bottom <= media.top + 1,
      belowNav: hero.getBoundingClientRect().top >= navigation.bottom - 1,
    };
  });
  assert.equal(layout.fit, "contain", `${label}: hero image must not crop`);
  assert.equal(layout.transform, "none", `${label}: hero image must not zoom`);
  assert.ok(layout.naturalWidth > 0, `${label}: hero image loads`);
  assert.ok(layout.separate, `${label}: title must be outside the image panel`);
  assert.ok(layout.belowNav, `${label}: navigation must not cover the hero`);
  assert.equal(await page.locator(".video-card__image").first().evaluate((image) => getComputedStyle(image).objectFit), "contain", `${label}: card image must not crop`);
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
      assert.doesNotMatch(await page.locator(".age-gate__card").innerText(), /premium/i, `${label}: no premium branding on age gate`);
      await assertPageFits(page, `${label} age gate`);
      await assertInViewport(enter, width, height, `${label} enter button`);
      await assertInViewport(page.getByRole("button", { name: /under 18/i }), width, height, `${label} exit button`);
      await enter.click();

      const watch = page.getByRole("button", { name: /WATCH NOW/i });
      await watch.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const brand = page.getByRole("link", { name: "Intimora home" });
      await assertInViewport(brand, width, height, `${label} brand`);
      await assertTextNotClipped(brand.locator(".site-nav__brand-text"), `${label} wordmark`);
      assert.equal(await brand.locator(".site-nav__brand-mark").evaluate((image) => image.complete && image.naturalWidth > 0), true, `${label}: brand image loaded`);
      assert.equal(await page.evaluate(() => [...document.fonts].some((font) => font.family === "Dancing Script" && font.status === "loaded")), true, `${label}: local wordmark font loaded`);
      await assertPageFits(page, `${label} home`);
      await assertHeroImagesFit(page, label);
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
      assert.doesNotMatch(await page.locator("#mobile-navigation").innerText(), /premium/i, `${label}: no premium mobile-menu item`);
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
      const trafficPeak = page.locator("footer").getByRole("link", { name: "Boost Your Website Traffic with TrafficPeak" });
      assert.equal(await trafficPeak.getAttribute("href"), "https://trafficpeak.io");
      await assertInViewport(trafficPeak, width, height, `${label} footer link`);
    }
    assert.deepEqual(errors, [], "no uncaught browser errors");

    const markAudit = await page.evaluate(async () => {
      const pixels = async (source, size = 32) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, size, size);
        return context.getImageData(0, 0, size, size).data;
      };
      const svg = await pixels("/logo.svg");
      const favicon = await pixels("/favicon-192.png");
      const tabIcon = await pixels("/favicon-16.png", 16);
      let bright = 0;
      let dark = 0;
      let tabBright = 0;
      let tabDark = 0;
      let difference = 0;
      for (let index = 0; index < svg.length; index += 4) {
        const [red, green, blue, alpha] = svg.slice(index, index + 4);
        if (alpha > 200 && red > 160 && green > 120 && blue < 225) bright += 1;
        if (alpha > 200 && red < 80 && green < 70 && blue < 60) dark += 1;
        for (let channel = 0; channel < 4; channel += 1) difference += Math.abs(svg[index + channel] - favicon[index + channel]);
      }
      for (let index = 0; index < tabIcon.length; index += 4) {
        const [red, green, blue, alpha] = tabIcon.slice(index, index + 4);
        if (alpha > 200 && red > 160 && green > 120 && blue < 225) tabBright += 1;
        if (alpha > 200 && red < 80 && green < 70 && blue < 60) tabDark += 1;
      }
      return { bright, dark, tabBright, tabDark, averageDifference: difference / svg.length };
    });
    assert.ok(markAudit.bright > 100 && markAudit.dark > 250, "the small logo has a prominent gold mark against a dark background");
    assert.ok(markAudit.tabBright > 35 && markAudit.tabDark > 75, "the 16px tab icon remains high-contrast and recognizable");
    assert.ok(markAudit.averageDifference < 20, "the Google PNG favicon matches the on-site SVG mark");

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockApi(desktop);
    await desktop.goto(base, { waitUntil: "domcontentloaded" });
    await desktop.evaluate(() => sessionStorage.setItem("intimora_age_verified", "true"));
    await desktop.reload({ waitUntil: "domcontentloaded" });
    await desktop.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    assert.ok(await desktop.locator(".hero-banner").evaluate((element) => element.getBoundingClientRect().height >= 380));
    await assertHeroImagesFit(desktop, "desktop");
    assert.equal(await desktop.locator(".site-nav__brand-text").evaluate((element) => getComputedStyle(element).display), "block");
    assert.equal(await desktop.locator(".site-nav__menu-toggle").evaluate((element) => getComputedStyle(element).display), "none");
    await assertPageFits(desktop, "desktop home");
    await desktop.locator(".video-card__play").first().hover();
    assert.equal(await desktop.locator(".video-card__image").first().evaluate((image) => getComputedStyle(image).transform), "none", "hover does not zoom or crop card images");
    assert.doesNotMatch(await desktop.locator("body").innerText(), /premium/i, "no premium controls, badges, tags, or footer links");

    // A video previously tagged with the retired tier remains visible and playable.
    const retiredCard = desktop.locator('section[aria-label="All Videos"] .video-card__title').filter({ hasText: "Catalog item remains available" }).locator("../..");
    assert.equal(await retiredCard.count(), 1);
    assert.equal(await retiredCard.locator(".video-card__badge").count(), 0);
    assert.deepEqual(await retiredCard.locator(".video-card__tag").allTextContents(), ["#recent", "#hd"]);
    await desktop.getByRole("button", { name: "Next featured video" }).click();
    await desktop.locator(".hero-banner__title").filter({ hasText: "Catalog item remains available" }).waitFor();
    assert.doesNotMatch(await desktop.locator(".hero-banner__meta").innerText(), /premium/i);
    await desktop.getByRole("button", { name: /WATCH NOW/i }).click();
    await desktop.locator("#player-container").waitFor();
    assert.match(await desktop.locator("#player-container video").getAttribute("src"), /\/api\/videos\/sample-2\/stream$/);
    assert.deepEqual(await desktop.locator(".video-player__tag").allTextContents(), ["#recent", "#hd"]);
    await desktop.getByRole("button", { name: "Close video player" }).click();
    await desktop.getByRole("textbox", { name: "Search videos" }).fill("Catalog item");
    await desktop.getByRole("textbox", { name: "Search videos" }).press("Enter");
    await desktop.getByText("Search results for").waitFor();
    const searchResult = desktop.locator(".video-card__title").filter({ hasText: "Catalog item remains available" });
    await searchResult.waitFor();
    assert.equal(await searchResult.count(), 1);
  } finally {
    await browser?.close();
    await server.close();
  }
});
