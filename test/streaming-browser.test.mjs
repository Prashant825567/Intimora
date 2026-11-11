import "./fixtures/ads-off.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const browserAvailable = existsSync(browserPath);
const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const options = {
  skip: !browserAvailable ? "Install Chromium or set CHROMIUM_PATH"
    : !opensslAvailable ? "OpenSSL is required to create a temporary test certificate" : false,
  timeout: 120_000,
};
const clips = {
  webm: readFileSync(path.join(root, "test/fixtures/stream-test.webm")),
  mp4: readFileSync(path.join(root, "test/fixtures/stream-test.mp4")),
};
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const fixtureVideo = {
  id: "sample-1", title: "Streaming fixture", creator: "Test", views: 1, likes: 0,
  thumbnailUrl: "/api/videos/sample-1/thumbnail", streamUrl: "/api/videos/sample-1/stream",
};

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createFixture({ holdMedia = false, holdAfter = 0, holdDetail = false, failMedia = 0, format = "webm" } = {}) {
  const clip = clips[format];
  const video = { ...fixtureVideo, duration: format === "mp4" ? 30 : 20 };
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "intimora-stream-test-"));
  const previousDiscovery = process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
  let backendServer;
  let vite;
  let browser;
  const state = { calls: [], pending: [], pendingDetails: [], holdMedia, holdAfter, holdDetail, failMedia };
  try {
    const key = path.join(temporaryDirectory, "test-key.pem");
    const cert = path.join(temporaryDirectory, "test-cert.pem");
    // Only the test browser trusts this throwaway certificate; production code
    // never disables certificate checks or relaxes its HTTPS/backend validation.
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=media-backend.example"], { stdio: "ignore" });
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range, If-Range",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, ETag",
    };
    let backend;
    backendServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const url = new URL(req.url, `https://${req.headers.host}`);
      state.calls.push({ host: req.headers.host, path: url.pathname, search: url.search, method: req.method, headers: req.headers });
      if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
      const json = (body) => {
        res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/get-server") return json({ ok: true, data: { server: backend } });
      if (url.pathname === "/api/videos") return json({ ok: true, data: { videos: [video], nextCursor: null } });
      if (url.pathname === "/api/videos/sample-1") {
        if (state.holdDetail) state.pendingDetails.push(() => { if (!res.destroyed) json({ ok: true, data: { ...video, views: 123 } }); });
        else json({ ok: true, data: { ...video, views: 123 } });
        return;
      }
      if (url.pathname === "/api/videos/sample-1/thumbnail") {
        res.writeHead(200, { ...cors, "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
        res.end(image);
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream") {
        if (state.failMedia > 0) {
          state.failMedia -= 1;
          res.writeHead(503, { ...cors, "Cache-Control": "no-store" });
          res.end("temporary upstream failure");
          return;
        }
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
        if (start > end || start >= clip.length) {
          res.writeHead(416, { ...cors, "Content-Range": `bytes */${clip.length}` });
          res.end();
          return;
        }
        const headers = {
          ...cors, "Content-Type": `video/${format}`, "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1, "Cache-Control": "public, max-age=3600", "ETag": '"synthetic-stream-v1"',
          ...(match ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}),
        };
        res.writeHead(match ? 206 : 200, headers);
        const body = clip.subarray(start, end + 1);
        if (state.holdMedia) {
          res.flushHeaders();
          if (state.holdAfter) res.write(body.subarray(0, state.holdAfter));
          state.pending.push({ res, body: body.subarray(state.holdAfter) });
        } else res.end(body);
        return;
      }
      res.writeHead(404, cors);
      res.end();
    });
    await new Promise((resolve, reject) => { backendServer.once("error", reject); backendServer.listen(0, "127.0.0.1", resolve); });
    const port = backendServer.address().port;
    backend = `https://media-backend.example:${port}`;
    const discovery = `https://media-discovery.example:${port}/api/get-server`;
    process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = discovery;
    vite = await createViteServer({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
    });
    await vite.listen();
    browser = await chromium.launch({
      executablePath: browserPath, headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--ignore-certificate-errors", "--autoplay-policy=user-gesture-required", "--host-resolver-rules=MAP media-backend.example 127.0.0.1, MAP media-discovery.example 127.0.0.1"],
    });
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    return {
      state, browser, base, backend, discovery, clip,
      releaseMedia() {
        state.holdMedia = false;
        for (const { res, body } of state.pending.splice(0)) if (!res.destroyed) res.end(body);
      },
      releaseDetail() {
        state.holdDetail = false;
        for (const release of state.pendingDetails.splice(0)) release();
      },
      async close() {
        await browser.close();
        await vite.close();
        await new Promise((resolve) => backendServer.close(resolve));
        rmSync(temporaryDirectory, { recursive: true, force: true });
        if (previousDiscovery === undefined) delete process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
        else process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = previousDiscovery;
      },
    };
  } catch (error) {
    await browser?.close();
    await vite?.close();
    if (backendServer?.listening) await new Promise((resolve) => backendServer.close(resolve));
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (previousDiscovery === undefined) delete process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
    else process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = previousDiscovery;
    throw error;
  }
}

async function openHome(fixture, context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const discovery = page.waitForResponse((response) => response.url() === fixture.discovery);
  await page.goto(fixture.base);
  await discovery;
  return { page, errors };
}

const streamCalls = (state) => state.calls.filter((call) => call.path.endsWith("/stream"));

// This test uses an actual HTTPS server, not Playwright route interception, so
// Chromium's media networking and HTTP cache are enabled during playback.
test("native playback buffers, seeks and keeps the selected backend URL stable", options, async () => {
  const fixture = await createFixture({ holdMedia: true });
  const { browser, state, backend } = fixture;
  try {
    const context = await browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    assert.ok(!state.calls.some((call) => call.path.startsWith("/api/videos")), "no catalog or media before the age gate");
    await page.getByRole("button", { name: /I AM 18/i }).click();
    const watch = page.getByRole("button", { name: /WATCH NOW/i });
    await watch.waitFor();
    assert.equal(streamCalls(state).length, 0, "catalog cards do not preload streams");

    const streamResponse = page.waitForResponse((response) => response.url() === `${backend}/api/videos/sample-1/stream`);
    await watch.click();
    const response = await streamResponse;
    const player = page.locator("#player-container");
    const media = player.locator("video");
    await media.waitFor();
    assert.equal(await media.getAttribute("src"), `${backend}/api/videos/sample-1/stream`);
    assert.equal(await media.getAttribute("poster"), `${backend}/api/videos/sample-1/thumbnail`);
    assert.equal(await media.getAttribute("crossorigin"), "anonymous");
    assert.equal(await media.getAttribute("preload"), "auto");
    assert.notEqual(await media.getAttribute("playsinline"), null);
    assert.equal(response.status(), 206);
    assert.match(response.headers()["content-range"], /^bytes 0-\d+\/\d+$/);
    assert.equal(response.headers()["cache-control"], "public, max-age=3600");
    assert.match(streamCalls(state)[0].headers.range, /^bytes=0-/);
    assert.equal(streamCalls(state)[0].headers["sec-fetch-dest"], "video");
    assert.doesNotMatch(streamCalls(state)[0].headers["cache-control"] || "", /no-store/i);

    await player.getByRole("status").getByText("Buffering…").waitFor();
    // Pausing while play() is still pending can reject it with AbortError; that
    // cancelled attempt must not surface as an error or change the next one.
    await player.getByRole("button", { name: "Pause video" }).click();
    await player.getByRole("button", { name: "Play video" }).first().waitFor();
    assert.equal(await player.getByRole("alert").count(), 0);
    await player.getByRole("button", { name: "Play video" }).first().click();
    await player.getByRole("status").getByText("Buffering…").waitFor();
    fixture.releaseMedia();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.equal(await response.finished(), null);
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video?.buffered.length && video.buffered.end(video.buffered.length - 1) >= video.duration - 0.05;
    });
    await player.getByRole("button", { name: "Pause video" }).click();
    await page.waitForFunction(() => document.querySelector("#player-container video")?.paused);
    assert.equal(await player.getByRole("status").count(), 0, "buffering indicator clears after playback/pause");

    const slider = player.getByRole("slider", { name: "Seek video" });
    const box = await slider.boundingBox();
    assert.ok(box);
    await slider.click({ position: { x: box.width * 0.7, y: box.height / 2 } });
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && Math.abs(video.currentTime - video.duration * 0.7) < 1;
    });
    await slider.focus();
    await slider.press("Home");
    await page.waitForFunction(() => document.querySelector("#player-container video")?.currentTime < 0.5);
    await slider.press("ArrowRight");
    await page.waitForFunction(() => Math.abs(document.querySelector("#player-container video")?.currentTime - 10) < 0.5);
    assert.equal(await slider.getAttribute("aria-disabled"), "false");

    const completedRequests = streamCalls(state).length;
    await page.getByRole("button", { name: "Close video player" }).click();
    await watch.click();
    await page.locator("#player-container video").waitFor();
    await page.waitForFunction(() => document.querySelector("#player-container video")?.readyState >= 2);
    assert.equal(streamCalls(state).length, completedRequests, "Chromium reused the fully received, strongly validated local fixture without another origin request");
    assert.equal(await page.locator("#player-container video").getAttribute("src"), `${backend}/api/videos/sample-1/stream`, "reopening does not add cache-busting query parameters");
    assert.ok(streamCalls(state).every((call) => call.host === new URL(backend).host && call.search === ""));
    assert.ok(streamCalls(state).every((call) => !call.headers.authorization && !call.headers.cookie));
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("seeking beyond the buffered data lets the browser request a later byte range", options, async (t) => {
  // A fast-start MP4 has its seek index at the front; VP8/WebM remains the
  // default for the other tests so they also work in codec-limited Chromium.
  const fixture = await createFixture({ holdMedia: true, holdAfter: 64 * 1024, format: "mp4" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    if (!await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"'))) {
      t.skip("This Chromium build does not support H.264 MP4");
      return;
    }
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).click();
    const player = page.locator("#player-container");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && video.currentTime > 0.05 && video.duration > 20;
    }, undefined, { timeout: 20_000 });
    // Keep the first response incomplete, but allow any later range request to
    // finish. The browser, not the app, chooses the new byte offset.
    fixture.state.holdMedia = false;
    const laterRange = page.waitForResponse((response) => response.url() === `${fixture.backend}/api/videos/sample-1/stream`
      && /^bytes=[1-9]\d*-/.test(response.request().headers().range || ""), { timeout: 15_000 });
    const slider = player.getByRole("slider", { name: "Seek video" });
    const box = await slider.boundingBox();
    assert.ok(box);
    await slider.click({ position: { x: box.width * 0.85, y: box.height / 2 } });
    const response = await laterRange;
    const request = response.request();
    const requestedStart = /^bytes=(\d+)-/.exec(request.headers().range)[1];
    assert.equal(response.status(), 206);
    assert.match(response.headers()["content-range"], new RegExp(`^bytes ${requestedStart}-\\d+/${fixture.clip.length}$`));
    assert.equal(request.method(), "GET");
    assert.equal((await request.allHeaders())["sec-fetch-dest"], "video");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && video.currentTime > 25.7 && !video.paused && !video.seeking;
    }, undefined, { timeout: 20_000 });
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      const bars = [...document.querySelectorAll(".video-player__buffered-range")];
      if (!video || video.buffered.length < 2 || bars.length !== video.buffered.length) return false;
      return bars.every((bar, i) => Math.abs(parseFloat(bar.style.left) - video.buffered.start(i) / video.duration * 100) < 0.1
        && Math.abs(parseFloat(bar.style.width) - (video.buffered.end(i) - video.buffered.start(i)) / video.duration * 100) < 0.1);
    });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("watch-now starts playback without waiting for the view-count request", options, async () => {
  const fixture = await createFixture({ holdDetail: true });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).click();
    const media = page.locator("#player-container video");
    await media.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.equal(fixture.state.pendingDetails.length, 1, "playback is not blocked by a slow detail response");
    const originalElement = await media.elementHandle();
    fixture.releaseDetail();
    await page.locator(".video-player__top-meta").filter({ hasText: /123 views/ }).waitFor();
    assert.equal(await page.evaluate((element) => element === document.querySelector("#player-container video"), originalElement), true, "updating metadata does not replace the playing element");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("a browser-blocked automatic start keeps the manual play button available", options, async () => {
  const fixture = await createFixture();
  try {
    const context = await fixture.browser.newContext();
    await context.addInitScript(() => {
      const realPlay = HTMLMediaElement.prototype.play;
      window.__fixtureBlockPlayback = true;
      window.__fixtureBlockedPlays = 0;
      HTMLMediaElement.prototype.play = function () {
        if (window.__fixtureBlockPlayback) {
          window.__fixtureBlockedPlays += 1;
          return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        }
        return realPlay.call(this);
      };
    });
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).click();
    const player = page.locator("#player-container");
    await player.locator("video").waitFor();
    await page.waitForFunction(() => window.__fixtureBlockedPlays > 0);
    await player.getByRole("button", { name: "Play video" }).first().waitFor();
    assert.equal(await player.locator("video").evaluate((video) => video.paused), true);
    assert.equal(await player.getByRole("alert").count(), 0);
    await page.evaluate(() => { window.__fixtureBlockPlayback = false; });
    await player.getByRole("button", { name: "Play video" }).first().click();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("shared watch links do not request catalog, details or media before the age gate", options, async () => {
  const fixture = await createFixture({ holdMedia: true });
  try {
    const context = await fixture.browser.newContext();
    const page = await context.newPage();
    const discovery = page.waitForResponse((response) => response.url() === fixture.discovery);
    await page.goto(`${fixture.base}/watch/sample-1`);
    await discovery;
    assert.ok(!fixture.state.calls.some((call) => call.path.startsWith("/api/videos")));
    assert.equal(await page.locator("#player-container video").count(), 0);
    const streamResponse = page.waitForResponse((response) => response.url() === `${fixture.backend}/api/videos/sample-1/stream`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await streamResponse;
    const media = page.locator("#player-container video");
    await media.waitFor();
    assert.equal(await media.getAttribute("src"), `${fixture.backend}/api/videos/sample-1/stream`);
    assert.equal(await media.getAttribute("autoplay"), null);
    assert.equal(await media.evaluate((video) => video.paused), true, "opening a shared link does not autoplay");
    await context.close();
  } finally { await fixture.close(); }
});

test("data saver and very slow connections use metadata preload", options, async () => {
  const fixture = await createFixture();
  try {
    for (const connection of [
      { saveData: true, effectiveType: "4g" },
      { saveData: false, effectiveType: "2g" },
      { saveData: false, effectiveType: "slow-2g" },
    ]) {
      const context = await fixture.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript((info) => { Object.defineProperty(navigator, "connection", { configurable: true, value: info }); }, connection);
      const { page, errors } = await openHome(fixture, context);
      await page.getByRole("button", { name: /I AM 18/i }).click();
      await page.getByRole("button", { name: /WATCH NOW/i }).click();
      const media = page.locator("#player-container video");
      await media.waitFor();
      assert.equal(await media.getAttribute("preload"), "metadata");
      assert.notEqual(await media.getAttribute("playsinline"), null);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await fixture.close(); }
});

test("media failure and a rejected play promise remain retryable", options, async () => {
  const fixture = await createFixture({ failMedia: 1 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).click();
    const player = page.locator("#player-container");
    await player.getByRole("alert").getByText("This video could not be loaded. Please try again.").waitFor();
    assert.doesNotMatch(await player.getByRole("alert").innerText(), /upstream|media-backend/);
    await player.getByRole("button", { name: "Try again" }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.ok(streamCalls(fixture.state).length >= 2, "a genuine media failure is reloaded on user retry");
    assert.ok(streamCalls(fixture.state).every((call) => call.search === ""), "retry keeps the stable URL");
    await player.getByRole("button", { name: "Pause video" }).click();
    await page.waitForFunction(() => document.querySelector("#player-container video")?.paused);
    await page.evaluate(() => {
      const realPlay = HTMLMediaElement.prototype.play;
      const realLoad = HTMLMediaElement.prototype.load;
      window.__fixtureLoadCalls = 0;
      let rejectNext = true;
      HTMLMediaElement.prototype.load = function () { window.__fixtureLoadCalls += 1; return realLoad.call(this); };
      HTMLMediaElement.prototype.play = function () {
        if (rejectNext) { rejectNext = false; return Promise.reject(new DOMException("blocked", "NotAllowedError")); }
        return realPlay.call(this);
      };
    });
    await player.getByRole("button", { name: "Play video" }).first().click();
    await player.getByRole("alert").getByText("Playback was blocked. Please try again.").waitFor();
    assert.equal(await player.locator("video").evaluate((video) => video.paused), true);
    await player.getByRole("button", { name: "Try again" }).click();
    await player.getByRole("button", { name: "Pause video" }).waitFor();
    assert.equal(await page.evaluate(() => window.__fixtureLoadCalls), 0, "blocked play does not discard an existing buffer");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});
