// Browser tests for the HilltopAds pre-roll. The live ad network is never
// contacted: the tag, the creative, the trackers and the landing page are all
// fulfilled locally. No shared "ads off" fixture is imported here.
delete process.env.INTIMORA_PUBLIC_VAST_TAG_URL;

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const backend = "https://api-intimora.vercel.app";
const tagUrl = "https://surprisedplate.com/d.m/FAzwdZGNN/vvZjGEUf/QeLmc9buAZ/U/lnkfP/TecO2pMtTDcX5iN/DpELt/N-ziYax/N/zbk/0yNbQH";
const adMedia = "https://ad-media.example/creative.mp4";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const clip = readFileSync(path.join(root, "test/fixtures/stream-test.mp4"));
const video = { id: "video-1", title: "Direct video", views: 10, likes: 2, createdAt: Math.floor(Date.now() / 1000), exclusive: true };

const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "vast-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0vast-test-identity"; },
    load(id) { if (id === "\0vast-test-identity") return guestIdentity; },
  };
}

function vastXml({ skipOffset = "00:00:02", duration = "00:00:30", media = adMedia } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0" xmlns="http://www.iab.com/VAST">
  <Ad id="test-ad">
    <InLine>
      <AdSystem version="1.0">HilltopAds</AdSystem>
      <AdTitle>Test campaign</AdTitle>
      <Impression><![CDATA[https://track.example/impression]]></Impression>
      <Error>https://track.example/error</Error>
      <Creatives>
        <Creative>
          <Linear skipoffset="${skipOffset}">
            <Duration>${duration}</Duration>
            <TrackingEvents>
              <Tracking event="start">https://track.example/start</Tracking>
              <Tracking event="firstQuartile">https://track.example/q1</Tracking>
              <Tracking event="complete">https://track.example/complete</Tracking>
              <Tracking event="skip">https://track.example/skip</Tracking>
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough>https://advertiser.example/landing</ClickThrough>
              <ClickTracking>https://track.example/click</ClickTracking>
            </VideoClicks>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="640" height="360" bitrate="800">${media}</MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
}

async function withPlayer({ vast, run }) {
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [identityPlugin()],
  });
  let browser;
  const requests = [];
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({
      executablePath: browserPath, headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length" };
      if (url.hostname === "track.example") {
        requests.push({ kind: "track", path: url.pathname });
        return route.fulfill({ status: 204, headers: cors });
      }
      if (url.hostname === "advertiser.example") {
        requests.push({ kind: "advertiser", path: url.pathname });
        return route.fulfill({ headers: { ...cors, "Content-Type": "text/html" }, body: "<!doctype html><title>Advertiser fixture</title>" });
      }
      if (url.hostname === "surprisedplate.com") {
        requests.push({ kind: "tag" });
        const response = typeof vast === "function" ? vast() : vast;
        if (!response) return route.fulfill({ status: 204, headers: cors, body: "" });
        if (response.xml) return route.fulfill({ status: response.status ?? 200, headers: { ...cors, "Content-Type": "text/xml" }, body: response.xml });
        return route.fulfill({ status: response.status ?? 204, headers: cors, body: "" });
      }
      if (url.hostname === "ad-media.example") {
        requests.push({ kind: "creative", path: url.pathname, dest: request.headers()["sec-fetch-dest"] });
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
        return route.fulfill({
          status: range ? 206 : 200,
          headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), ...(range ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}) },
          body: clip.subarray(start, end + 1),
        });
      }
      if (url.hostname === "hdzog.com" || url.hostname.endsWith("hdzog.com")) {
        return route.fulfill({ headers: { ...cors, "Content-Type": "text/html" }, body: "<!doctype html><title>Partner fixture</title>" });
      }
      if (request.url() === discovery) return route.fulfill({ headers: cors, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers: cors, json: { ok: true, data: { videos: [video], nextCursor: null } } });
      if (url.pathname === "/api/videos/video-1") return route.fulfill({ headers: cors, json: { ok: true, data: video } });
      if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers: cors, contentType: "image/png", body: image });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ headers: { ...cors, "Content-Type": "video/mp4" }, body: clip });
      return route.fulfill({ status: 404, headers: cors, json: { ok: false } });
    });
    return await run({ context, base, requests });
  } finally {
    await browser?.close();
    await vite.close();
  }
}

const options = { skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 120_000 };

async function openPlayer(context, base) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /I AM 18/i }).waitFor();
  assert.equal(await page.locator("[data-ad-overlay]").count(), 0, "no ad before the age gate");
  await page.getByRole("button", { name: /I AM 18/i }).click();
  await page.locator(".hero-banner__cta").click();
  await page.locator("#player-container").waitFor();
  return { page, errors };
}

test("a pre-roll plays before the content, tracks impressions and can be skipped", options, async () => {
  await withPlayer({ vast: () => ({ xml: vastXml() }), run: async ({ context, base, requests }) => {
    const { page, errors } = await openPlayer(context, base);
    const ad = page.locator("[data-ad-video]");
    await ad.waitFor({ timeout: 20_000 });
    assert.equal(await page.locator("[data-ad-overlay]").getAttribute("aria-label"), "Advertisement");
    assert.equal(await page.locator("#player-container video").count(), 2, "the creative and the content are separate elements");
    // The content itself has not started while the pre-roll runs.
    assert.equal(await page.evaluate(() => document.querySelector("#player-container video")?.paused), true);
    assert.ok(requests.some((item) => item.kind === "track" && item.path === "/impression"), "the impression fired");
    assert.ok(requests.some((item) => item.kind === "creative"), "the creative was requested in a media element");
    assert.ok(requests.some((item) => item.kind === "track" && item.path === "/start"), "the start event fired");

    const link = page.getByRole("link", { name: /Visit Test campaign/ });
    assert.equal(await link.getAttribute("href"), "https://advertiser.example/landing");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.match(await link.getAttribute("rel"), /noopener/);

    const skip = page.getByRole("button", { name: "Skip advertisement" });
    await skip.waitFor({ timeout: 30_000 });
    await skip.click();
    await page.locator("[data-ad-overlay]").waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const element = document.querySelector("#player-container video");
      return element && !element.paused && element.currentTime > 0;
    });
    assert.equal(await page.locator("#player-container video").count(), 1, "the ad element is removed after the skip");
    assert.ok(requests.some((item) => item.kind === "track" && item.path === "/skip"), "the skip event fired");

    // Closing and reopening the player requests the ad once more, not twice.
    await page.getByRole("button", { name: "Close video player" }).click();
    const before = requests.filter((item) => item.kind === "tag").length;
    await page.locator(".hero-banner__cta").click();
    await page.locator("[data-ad-video]").waitFor({ timeout: 20_000 });
    assert.equal(requests.filter((item) => item.kind === "tag").length, before + 1, "one tag request per player");
    assert.deepEqual(errors, []);
    await page.close();
  } });
});

test("an empty, failing or skipped-looking tag never blocks the video", options, async () => {
  for (const vast of [() => ({ status: 204 }), () => ({ status: 500 }), () => ({ xml: "<html>not an ad</html>" }), () => ({ xml: vastXml({ media: "https://ad-media.example/missing.mp4" }) })]) {
    await withPlayer({ vast, run: async ({ context, base, requests }) => {
      const { page, errors } = await openPlayer(context, base);
      // Content starts either straight away or after the ad element fails.
      await page.waitForFunction(() => {
        const element = document.querySelector("#player-container video");
        return element && !element.paused;
      }, undefined, { timeout: 20_000 });
      await page.locator("[data-ad-overlay]").waitFor({ state: "detached" }).catch(() => {});
      assert.equal(await page.locator("[data-ad-video]").count(), 0, "no creative is left on screen");
      assert.ok(requests.filter((item) => item.kind === "tag").length >= 1, "the tag was attempted once");
      assert.equal(await page.locator("#player-container video").count(), 1);
      assert.deepEqual(errors, []);
      await page.close();
    } });
  }
});

test("the configured tag is bundled and an invalid one fails the build", async () => {
  const { build } = await import("vite");
  const config = await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "src/config/vast.ts"), "utf8"));
  assert.ok(config.includes(tagUrl), "the reviewed HilltopAds tag is the configured default");

  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-vast-build-"));
  try {
    process.env.INTIMORA_PUBLIC_VAST_TAG_URL = "https://evil.example/ad.xml";
    let error;
    try {
      await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()] });
    } catch (caught) { error = caught; }
    assert.ok(error, "an untrusted ad host cannot ship");
    assert.match(String(error.message), /Invalid VAST tag/);

    delete process.env.INTIMORA_PUBLIC_VAST_TAG_URL;
    await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()] });
    const html = await import("node:fs/promises").then((fs) => fs.readFile(path.join(output, "index.html"), "utf8"));
    const asset = html.match(/assets\/(index-[^"]+\.js)/)?.[1];
    const js = await import("node:fs/promises").then((fs) => fs.readFile(path.join(output, "assets", asset), "utf8"));
    assert.ok(js.includes("surprisedplate.com"), "the tag is bundled for the browser");
  } finally {
    delete process.env.INTIMORA_PUBLIC_VAST_TAG_URL;
    await rm(output, { recursive: true, force: true });
  }
});
