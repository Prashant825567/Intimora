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
const now = Date.parse("2026-11-07T15:00:00+05:30");
const at = (time) => Date.parse(`2026-11-${time}+05:30`);
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#5b7a91"/></svg>';

const todayEarly = { id: "today-early", title: "Today early", createdAt: at("07T09:00:00") / 1000, views: 200, category: "Popular" };
const todayLate = { id: "today-late", title: "Today late", createdAt: "2026-11-07T14:00:00+05:30", views: 700, metadata: { exclusive: true } };
const yesterday = { id: "yesterday", title: "Yesterday", createdAt: at("06T21:00:00"), views: 9999, exclusive: "true" };
const yesterdayTwo = { id: "yesterday-two", title: "Yesterday early", createdAt: at("06T08:00:00") / 1000, views: 10 };
const older = { id: "older", title: "Older most viewed", createdAt: at("03T19:00:00") / 1000, views: 50000, category: "EXCLUSIVE" };
const unknown = { id: "unknown", title: "Unknown date", uploadedAt: "Just now", views: 3, tags: ["#EXCLUSIVE"] };
const normal = { id: "normal", title: "Regular video", createdAt: at("02T12:00:00") / 1000, views: 250, exclusive: false, metadata: { exclusive: true } };

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function makePage(browser, base, scenario, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile, timezoneId: "Asia/Kolkata",
  });
  await context.addInitScript((fixedNow) => {
    const RealDate = Date;
    window.catalogTestNow = fixedNow;
    window.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(window.catalogTestNow); else super(...args); }
      static now() { return window.catalogTestNow; }
    };
  }, now);
  const calls = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
    if (url.hostname === "intimora.tmc78lxnu.workers.dev") return route.fulfill({ headers, json: { ok: true, data: { server: "https://catalog-backend.example" } } });
    if (url.hostname !== "catalog-backend.example") return route.continue();
    calls.push({ path: url.pathname, cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname === "/api/videos") {
      const cursor = url.searchParams.get("cursor");
      if (cursor && scenario.failCursor === cursor) return route.fulfill({ status: 503, headers, json: { ok: false, error: "secret-marker: private upstream details" } });
      const current = scenario.pages[cursor || "first"] || { videos: [], nextCursor: null };
      return route.fulfill({ headers, json: { ok: true, data: current } });
    }
    if (url.pathname === "/api/search") {
      if (scenario.waitForSearch) {
        scenario.searchStarted();
        await scenario.waitForSearch;
      }
      return route.fulfill({ headers, json: { ok: true, data: { videos: [todayEarly], nextCursor: null } } });
    }
    if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers, contentType: "image/svg+xml", body: picture });
    if (url.pathname.endsWith("/stream")) return route.fulfill({ headers, contentType: "video/mp4", body: "" });
    return route.fulfill({ headers, json: { ok: true, data: todayEarly } });
  });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /I AM 18/i }).click();
  return { page, context, calls };
}

const titleList = async (page) => page.locator("main .video-card__title").allTextContents();

test("browser feeds use the full paginated catalog and Categories shows only Coming Soon", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 120_000,
}, async () => {
  const vite = await createViteServer({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: await availablePort(), strictPort: true } });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const scenario = { pages: {
      first: { videos: [todayEarly, yesterday, unknown], nextCursor: "next-1" },
      "next-1": { videos: [unknown, todayLate, older, normal], nextCursor: "next-2" },
      "next-2": { videos: [normal], nextCursor: "next-2" },
    } };
    const { page, context, calls } = await makePage(browser, base, scenario);
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.deepEqual(calls.filter((call) => call.path === "/api/videos").map((call) => [call.cursor, call.limit]), [[null, "50"], ["next-1", "50"], ["next-2", "50"]]);
    const nav = page.locator(".site-nav__desktop-links");

    await nav.getByRole("link", { name: "Trending", exact: true }).click();
    await page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.deepEqual(await titleList(page), ["Older most viewed", "Yesterday", "Today late", "Regular video", "Today early", "Unknown date"]);

    await nav.getByRole("link", { name: "New", exact: true }).click();
    await page.getByRole("heading", { name: "New Releases" }).waitFor();
    assert.deepEqual(await titleList(page), ["Today late", "Today early"]);

    await nav.getByRole("link", { name: "Exclusive", exact: true }).click();
    await page.getByRole("heading", { name: "Exclusive" }).waitFor();
    assert.deepEqual(await titleList(page), ["Today late", "Yesterday", "Older most viewed", "Unknown date"]);

    await nav.getByRole("link", { name: "Categories", exact: true }).click();
    await page.getByRole("heading", { name: "Coming Soon" }).waitFor();
    assert.equal(await page.locator("main .video-card, main .hero-banner").count(), 0);
    await page.getByRole("button", { name: "Back to Home" }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    await page.locator('[aria-label="Explore videos"]').getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("heading", { name: "New Releases" }).waitFor();
    assert.deepEqual(await titleList(page), ["Today late", "Today early"]);

    await page.evaluate(() => { window.catalogTestNow += 61_000; });
    await nav.getByRole("link", { name: "Trending", exact: true }).click();
    await page.locator("main .video-card__title").filter({ hasText: "Older most viewed" }).waitFor();
    assert.equal(calls.filter((call) => call.path === "/api/videos").length, 6, "revisiting a feed refreshes catalog data after a minute");

    let releaseSearch;
    let signalSearch;
    scenario.waitForSearch = new Promise((resolve) => { releaseSearch = resolve; });
    const searchStarted = new Promise((resolve) => { signalSearch = resolve; });
    scenario.searchStarted = signalSearch;
    const search = page.getByRole("textbox", { name: "Search videos" });
    await search.fill("slow query");
    await search.press("Enter");
    await searchStarted;
    await nav.getByRole("link", { name: "Categories", exact: true }).click();
    const delayedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/search");
    releaseSearch();
    await delayedResponse;
    await page.getByRole("heading", { name: "Coming Soon" }).waitFor();
    assert.equal(await page.locator("main .video-card").count(), 0, "a stale search response cannot replace Categories");
    await context.close();

    // The real public API uses boolean exclusive flags and Unix-second dates;
    // its two newest uploads can be exclusive without hiding ordinary uploads.
    const liveShapeVideos = [
      { id: "latest-one", title: "Latest exclusive one", exclusive: true, createdAt: at("06T23:00:00") / 1000, views: 5 },
      { id: "latest-two", title: "Latest exclusive two", exclusive: true, createdAt: at("06T22:00:00") / 1000, views: 3 },
      { id: "regular-one", title: "Regular upload one", exclusive: false, createdAt: at("05T12:00:00") / 1000, views: 12 },
      { id: "regular-two", title: "Regular upload two", exclusive: false, createdAt: at("04T12:00:00") / 1000, views: 8 },
    ];
    const liveShape = await makePage(browser, base, { pages: {
      first: { videos: liveShapeVideos, nextCursor: "end" },
      end: { videos: [liveShapeVideos.at(-1)], nextCursor: "end" },
    } });
    await liveShape.page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.deepEqual(await liveShape.page.locator('section[aria-label="All Videos"] .video-card__title').allTextContents(),
      ["Latest exclusive one", "Latest exclusive two", "Regular upload one", "Regular upload two"]);
    assert.deepEqual(await liveShape.page.locator('section[aria-label="Exclusive"] .video-card__title').allTextContents(),
      ["Latest exclusive one", "Latest exclusive two"]);
    assert.equal(await liveShape.page.locator(".hero-banner__title").textContent(), "Latest exclusive one");
    const liveNav = liveShape.page.locator(".site-nav__desktop-links");
    await liveNav.getByRole("link", { name: "Exclusive", exact: true }).click();
    await liveShape.page.getByRole("heading", { name: "Exclusive", exact: true }).waitFor();
    assert.deepEqual(await titleList(liveShape.page), ["Latest exclusive one", "Latest exclusive two"]);
    await liveNav.getByRole("link", { name: "New", exact: true }).click();
    await liveShape.page.getByRole("heading", { name: "New Releases" }).waitFor();
    assert.deepEqual(await titleList(liveShape.page), ["Latest exclusive one", "Latest exclusive two"]);
    await liveShape.context.close();

    const yesterdayScenario = { pages: { first: { videos: [yesterday, yesterdayTwo, older], nextCursor: null } } };
    const mobile = await makePage(browser, base, yesterdayScenario, true);
    await mobile.page.getByRole("button", { name: "Open navigation menu" }).click();
    await mobile.page.locator("#mobile-navigation").getByRole("link", { name: "New", exact: true }).click();
    await mobile.page.getByRole("heading", { name: "New Releases" }).waitFor();
    assert.deepEqual(await titleList(mobile.page), ["Yesterday", "Yesterday early"]);
    await mobile.page.getByRole("button", { name: "Open navigation menu" }).click();
    await mobile.page.locator("#mobile-navigation").getByRole("link", { name: "Categories", exact: true }).click();
    await mobile.page.getByRole("heading", { name: "Coming Soon" }).waitFor();
    assert.equal(await mobile.page.locator("main .video-card, main .hero-banner").count(), 0);
    assert.equal(await mobile.page.getByRole("button", { name: "Open navigation menu" }).getAttribute("aria-expanded"), "false");
    await mobile.context.close();

    const none = await makePage(browser, base, { pages: { first: { videos: [older, unknown], nextCursor: null } } });
    await none.page.locator(".site-nav__desktop-links").getByRole("link", { name: "New", exact: true }).click();
    await none.page.getByText("No videos were uploaded today or yesterday.").waitFor();
    assert.equal(await none.page.locator("main .video-card").count(), 0);
    await none.context.close();

    const manyVideos = Array.from({ length: 16 }, (_, index) => ({ id: `many-${index}`, title: `Video ${index}`, createdAt: (now - index * 60_000) / 1000, views: index }));
    const paged = await makePage(browser, base, { pages: {
      first: { videos: manyVideos.slice(0, 10), nextCursor: "more" },
      more: { videos: manyVideos.slice(9), nextCursor: null },
    } });
    await paged.page.getByRole("heading", { name: "Trending Now" }).waitFor();
    const allSection = paged.page.locator('section[aria-label="All Videos"]');
    assert.equal(await allSection.locator(".video-card").count(), 12, "the full catalog is not rendered all at once");
    await allSection.locator('[aria-live="polite"]').scrollIntoViewIfNeeded();
    await paged.page.waitForFunction(() => document.querySelectorAll('section[aria-label="All Videos"] .video-card').length === 16);
    await paged.page.locator(".site-nav__desktop-links").getByRole("link", { name: "Trending", exact: true }).click();
    await paged.page.getByRole("heading", { name: "Trending Now" }).waitFor();
    assert.ok(await paged.page.locator("main .video-card").count() >= 12);
    await paged.page.locator('main [aria-live="polite"]').scrollIntoViewIfNeeded();
    await paged.page.waitForFunction(() => document.querySelectorAll("main .video-card").length === 16);
    await paged.context.close();

    const failureScenario = { ...scenario, waitForSearch: null, failCursor: "next-1" };
    const failure = await makePage(browser, base, failureScenario);
    await failure.page.getByRole("alert").waitFor();
    await failure.page.locator(".site-nav__desktop-links").getByRole("link", { name: "Trending", exact: true }).click();
    assert.equal(await failure.page.locator("main .video-card").count(), 0, "incomplete results are not presented as a full ranking");
    assert.doesNotMatch(await failure.page.locator("body").innerText(), /secret-marker|catalog-backend\.example/i);
    failureScenario.failCursor = null;
    await failure.page.getByRole("button", { name: "Retry", exact: true }).click();
    await failure.page.locator("main .video-card__title").first().waitFor();
    assert.equal((await titleList(failure.page))[0], "Older most viewed");
    await failure.context.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});
