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

// The backend's documented premium answers, for the fixture only.
// A signed-in premium member. The premium cases below are about the links the
// backend issues, not about the sign-in gate, so they open with an account.
const memberIdentity = `
const current = { uid: "member-1", email: "member@example.com", displayName: "Member", photoURL: null, getIdToken: async () => "member-token" };
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(current)); return () => {}; }
export async function signInWithGoogle() { return current; }
export async function signOutGoogle() {}
`;

// The premium cases are about the links the backend issues, so the account is an
// input: a signed-in member whose profile is already confirmed. No account route
// is contacted, and the playback assertions stay about playback.
const memberAccount = `
const profile = { uid: "member-1", email: "member@example.com", name: "Member", username: "member", referralCode: "REF-MEMBER1", referredBy: "", createdAt: 1760000000, likedIds: [], savedIds: [], premium: true, backendBase: "https://media-backend.example" };
export const AccountRequestError = class extends Error {};
export async function verifyAccount() {
  // The test can hold the check open: the account stays "being checked" until it
  // sets __accountReleased.
  while (globalThis.__accountHold === true && globalThis.__accountReleased !== true) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return { exists: true, backend: profile.backendBase };
}
export async function getMyAccount() { return profile; }
export async function createAccount() { return profile; }
export async function toggleAccountVideo() { return profile; }
export async function getPremiumStatus() { return { status: { active: true, until: 1795400000, remainingSeconds: 9000, referralCode: "REF-MEMBER1", referrals: { total: 0, used: 0, available: 0, availableCodes: [], secondsEach: 9000, hoursEach: 2.5 } }, backend: profile.backendBase }; }
export async function getPremiumHistory() { return { history: { periods: [], total: { seconds: 0, amountPaise: 0, bySource: {} } }, backend: profile.backendBase }; }
export async function redeemReferrals() { return { status: null, entry: null }; }
export async function getReferralTree() { return { direct: [], level2: [] }; }
export const referralsEnabled = false;
export function sanitizeReferralTree() { return { direct: [], level2: [] }; }
`;

function memberIdentityPlugin() {
  return {
    name: "streaming-test-identity", enforce: "pre",
    resolveId(id) {
      if (id === "../services/firebase") return "\0streaming-test-identity";
      if (id === "../services/account-api" || id === "./account-api") return "\0streaming-test-account";
    },
    load(id) {
      if (id === "\0streaming-test-identity") return memberIdentity;
      if (id === "\0streaming-test-account") return memberAccount;
    },
  };
}

function premiumVideo(premiumMode, format, tokens = {}) {
  // The links are the backend's own, and the token in them rotates: an expired
  // link is only fixable if the next answer carries a different one.
  const streamToken = tokens.streamToken ?? "stream-token";
  const trailerToken = tokens.trailerToken ?? "trailer-token";
  const base = { ...fixtureVideo, duration: format === "mp4" ? 30 : 20 };
  if (premiumMode === "active") {
    return {
      ...base, premium: true, hasTrailer: true,
      // Both links carry the backend's own token; the player must use them as-is.
      streamUrl: `/api/videos/sample-1/stream?t=${streamToken}`,
      trailerUrl: `/api/videos/sample-1/stream?kind=trailer&t=${trailerToken}`,
    };
  }
  if (premiumMode === "locked") {
    return {
      ...base, premium: true, locked: true, hasTrailer: true, streamUrl: null,
      trailerUrl: `/api/videos/sample-1/stream?kind=trailer&t=${trailerToken}`,
    };
  }
  if (premiumMode === "locked-noTrailer") {
    return { ...base, premium: true, locked: true, hasTrailer: false, streamUrl: null, trailerUrl: null };
  }
  return base;
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createFixture({ holdMedia = false, holdAfter = 0, holdDetail = false, failMedia = 0, failCatalog = 0, format = "webm", cdn = null, premiumMode = null, signedIn = false, holdAccount = false, expireStream = 0, expireTrailer = 0, unlockOnRefresh = false } = {}) {
  const clip = clips[format];
  // `premiumMode` is the backend's own premium contract:
  //   "locked"        — premium video, no active window, a trailer exists
  //   "locked-noTrailer" — premium video, no active window, no trailer
  //   "active"        — premium window open: a tokenised stream and a trailer
  const video = { ...fixtureVideo, duration: format === "mp4" ? 30 : 20 };
  // The catalog and detail answers carry the premium shape and, when the test
  // asks for one, the CDN link.
  const catalogVideo = () => {
    const item = premiumVideo(premiumMode, format, { streamToken: state.streamToken, trailerToken: state.trailerToken });
    if (video.cdnUrl) item.cdnUrl = video.cdnUrl;
    return item;
  };
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "intimora-stream-test-"));
  const previousDiscovery = process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL;
  let backendServer;
  let vite;
  let browser;
  const state = { calls: [], pending: [], pendingDetails: [], holdMedia, holdAfter, holdDetail, failMedia, failCatalog,
    streamToken: "stream-token", trailerToken: "trailer-token",
    // The number of first media requests to refuse as expired: the token rotates
    // and the next detail answer carries the new one, which is what a link that
    // ran out looks like from the player's side.
    expireStream, expireTrailer,
    // `unlockOnRefresh` is the premium window being confirmed for this member: the
    // first detail answer is the locked shape, the next one carries a full stream.
    unlockOnRefresh, detailAnswers: 0 };
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
      if (url.pathname === "/api/auth/verify") return json({ ok: true, data: { exists: true } });
      if (url.pathname === "/api/auth/me") return json({ ok: true, data: { user: { uid: "member-1", email: "member@example.com", name: "Member", username: "member", referralCode: "REF-MEMBER1", likedVideos: [], savedVideos: [] } } });
      if (url.pathname === "/api/premium/status") return json({ ok: true, data: { active: true, until: 1_795_400_000, remainingSeconds: 9000, referralCode: "REF-MEMBER1", referrals: { total: 0, used: 0, available: 0, availableCodes: [], secondsEach: 9000, hoursEach: 2.5 } } });
      if (url.pathname === "/api/premium/history") return json({ ok: true, data: { periods: [], total: { seconds: 0, amountPaise: 0, bySource: {} } } });
      if (url.pathname === "/api/user/referrals") return json({ ok: true, data: { tree: { code: "REF-MEMBER1", direct: [], level2: [] } } });
      if (url.pathname === "/api/videos") {
        if (state.failCatalog > 0) {
          state.failCatalog -= 1;
          res.writeHead(503, { ...cors, "Cache-Control": "no-store" });
          res.end("temporary catalog failure");
          return;
        }
        return json({ ok: true, data: { videos: [catalogVideo()], nextCursor: null } });
      }
      if (url.pathname === "/api/videos/sample-1/stream" && url.searchParams.get("kind") === "trailer" && state.expireTrailer > 0) {
        state.expireTrailer -= 1;
        state.trailerToken = "trailer-token-2";
        res.writeHead(403, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Link expired — reload the page" }));
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream" && url.searchParams.get("kind") === "trailer" && url.searchParams.get("t") && url.searchParams.get("t") !== state.trailerToken) {
        // An expired trailer token is refused exactly as the backend documents it.
        res.writeHead(403, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Link expired — reload the page" }));
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream" && url.searchParams.get("kind") === "trailer") {
        // The trailer is public: it plays without any premium window.
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
        const start = match ? Number(match[1]) : 0;
        res.writeHead(200, { ...cors, "Content-Type": `video/${format}`, "Accept-Ranges": "bytes", "Content-Length": clip.length - start });
        res.end(clip.subarray(start));
        return;
      }
      if (url.pathname === "/api/videos/sample-1") {
        // The detail answer is what the player opens with; a stale token here is
        // exactly a link that ran out before the visitor pressed play.
        state.detailAnswers += 1;
        const detail = state.unlockOnRefresh && state.detailAnswers > 1
          ? premiumVideo("active", format, { streamToken: state.streamToken, trailerToken: state.trailerToken })
          : catalogVideo();
        if (state.holdDetail) state.pendingDetails.push(() => { if (!res.destroyed) json({ ok: true, data: { ...detail, views: 123 } }); });
        else json({ ok: true, data: { ...detail, views: 123 } });
        return;
      }
      if (url.pathname === "/api/videos/sample-1/thumbnail") {
        res.writeHead(200, { ...cors, "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
        res.end(image);
        return;
      }
      if (url.pathname === "/cdn-clip.mp4") {
        // "broken" is a file host answering with a download page instead of a
        // video (what an unresolved bestfile link returns); "playable" is a CDN
        // that really serves the file.
        if (cdn === "broken") {
          res.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end("<html><body>Please wait 24 seconds</body></html>");
          return;
        }
        res.writeHead(200, { ...cors, "Content-Type": `video/${format}`, "Accept-Ranges": "bytes", "Content-Length": clip.length });
        res.end(clip);
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream" && url.searchParams.get("kind") !== "trailer" && state.expireStream > 0) {
        state.expireStream -= 1;
        state.streamToken = "stream-token-2";
        res.writeHead(403, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Link expired — reload the page" }));
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream" && url.searchParams.get("kind") !== "trailer" && url.searchParams.get("t") && url.searchParams.get("t") !== state.streamToken) {
        // An old token is refused; the next detail answer carries a new one.
        res.writeHead(403, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Link expired — reload the page" }));
        return;
      }
      if (url.pathname === "/api/videos/sample-1/stream") {
        // A premium stream without its own token is refused exactly as the
        // backend documents it.
        if (premiumMode && premiumMode !== "active" && !url.searchParams.get("t")) {
          res.writeHead(403, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Premium required" }));
          return;
        }
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
    if (cdn) video.cdnUrl = `https://cdn-media.example:${port}/cdn-clip.mp4`;
    const discovery = `https://media-discovery.example:${port}/api/get-server`;
    process.env.INTIMORA_PUBLIC_API_DISCOVERY_URL = discovery;
    vite = await createViteServer({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
      // The signed-in fixture replaces the identity module outright; without it the
      // player is a guest, which is the other case the tests cover.
      ...(signedIn ? { plugins: [memberIdentityPlugin()] } : {}),
    });
    await vite.listen();

    browser = await chromium.launch({
      executablePath: browserPath, headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--ignore-certificate-errors", "--autoplay-policy=user-gesture-required", "--host-resolver-rules=MAP media-backend.example 127.0.0.1, MAP media-discovery.example 127.0.0.1, MAP cdn-media.example 127.0.0.1"],
    });
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    return {
      state, browser, base, backend, discovery, clip,
      cdnUrl: video.cdnUrl, bytesUrl: `${backend}/api/videos/sample-1/stream`,
      holdAccount,
      // The member's account check is held open (see the stub above) until this.
      async releaseAccount(page) { await page.evaluate(() => { globalThis.__accountReleased = true; }); },
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
    const watch = page.locator(".video-card__play").first();
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
    await page.locator(".video-card__play").first().click();
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
    await page.locator(".video-card__play").first().click();
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
    await page.locator(".video-card__play").first().click();
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

test("a shared watch link opens without the front-door gate and does not autoplay", options, async () => {
  const fixture = await createFixture({ holdMedia: true });
  try {
    const context = await fixture.browser.newContext();
    const page = await context.newPage();
    const discovery = page.waitForResponse((response) => response.url() === fixture.discovery);
    await page.goto(`${fixture.base}/watch/sample-1`);
    await discovery;
    assert.equal(await page.getByRole("button", { name: /I AM 18/i }).count(), 0, "a shared link never asks for the age again");
    const streamResponse = page.waitForResponse((response) => response.url() === `${fixture.backend}/api/videos/sample-1/stream`);
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
      await page.locator(".video-card__play").first().click();
      const media = page.locator("#player-container video");
      await media.waitFor();
      assert.equal(await media.getAttribute("preload"), "metadata");
      assert.notEqual(await media.getAttribute("playsinline"), null);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await fixture.close(); }
});

test("a cut media request recovers without asking the visitor to press Try again", options, async () => {
  // The exact shape of the pre-roll bug: the content request is aborted while
  // something else is on screen, the element lands in its error state, and the
  // visitor used to get "This video could not be played" plus a button for a
  // reload the player can do itself.
  const fixture = await createFixture({ failMedia: 1 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.equal(await player.getByRole("alert").count(), 0, "no error is shown for a failure that repairs itself");
    assert.ok(streamCalls(fixture.state).length >= 2, "the element was reloaded on its own");
    assert.ok(streamCalls(fixture.state).every((call) => call.search === ""), "the reload keeps the stable URL");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("a media failure that survives the silent retries still offers Try again", options, async () => {
  const fixture = await createFixture({ failMedia: 2 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.getByRole("alert").getByText("This video could not be loaded. Please try again.").waitFor();
    assert.doesNotMatch(await player.getByRole("alert").innerText(), /upstream|media-backend/);
    await player.getByRole("button", { name: "Try again" }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.ok(streamCalls(fixture.state).length >= 3, "a genuine media failure is reloaded on user retry");
    assert.ok(streamCalls(fixture.state).every((call) => call.search === ""), "retry keeps the stable URL");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("a rejected play promise stays retryable and keeps the buffer", options, async () => {
  const fixture = await createFixture();
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
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

test("a transient catalog failure is retried before the visitor is told", options, async () => {
  const fixture = await createFixture({ failCatalog: 1 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    // The first /api/videos answers 503; the retry must fill the grid without
    // ever painting "Content Unavailable".
    await page.locator(".video-card__play").first().waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText("Content Unavailable").count(), 0, "no error screen for a retried request");
    const catalogCalls = fixture.state.calls.filter((call) => call.path === "/api/videos");
    assert.ok(catalogCalls.length >= 2, "the catalog request was repeated");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("clicking the picture toggles the controls and never pauses", options, async () => {
  const fixture = await createFixture();
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    const media = player.locator("video");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });

    const controls = player.locator("[data-controls]").first();
    assert.equal(await controls.getAttribute("data-controls"), "visible");

    await media.click({ position: { x: 260, y: 170 } });
    assert.equal(await controls.getAttribute("data-controls"), "hidden", "a click hides the timeline");
    assert.equal(await media.evaluate((video) => video.paused), false, "and the video keeps playing");

    await media.click({ position: { x: 260, y: 170 } });
    assert.equal(await controls.getAttribute("data-controls"), "visible", "a second click brings it back");
    assert.equal(await media.evaluate((video) => video.paused), false);

    // Only the pause button pauses.
    await player.getByRole("button", { name: "Pause video" }).click();
    await page.waitForFunction(() => document.querySelector("#player-container video")?.paused);
    assert.equal(await controls.getAttribute("data-controls"), "visible", "a paused video shows its controls");
    // While paused the large play button covers the picture, so a tap there is
    // the play action; the timeline is only paused by its own button.
    assert.equal(await media.evaluate((video) => video.paused), true);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// Newer uploads are stored on a CDN host; the backend keeps streaming the bytes
// of the older ones. A CDN link that cannot play (expired, hotlink-blocked, or a
// download page instead of a file) must not stop the video: the player switches
// to the backend's own stream and keeps playing.
test("a CDN source that cannot play falls back to the byte stream", options, async () => {
  const fixture = await createFixture({ cdn: "broken" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    const watch = page.locator(".video-card__play").first();
    await watch.waitFor();
    await watch.click();
    const media = page.locator("#player-container video");
    await media.waitFor();
    // Playback starts on the click (this build has no pre-roll), so the media
    // element is running by the time the URL switch is asserted.
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && video.getAttribute("src");
    }, undefined, { timeout: 20_000 });

    // The catalog's CDN URL is what the media element asks for first; this file
    // host answers with a download page, so it fails and the byte stream takes
    // over. The switch can happen before the first poll, so the request log is
    // the evidence that the CDN link was tried.
    const until = async (check, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("timed out waiting for the condition");
    };
    await until(() => fixture.state.calls.some((call) => call.path === "/cdn-clip.mp4"));
    await page.waitForFunction(
      (bytes) => document.querySelector("#player-container video")?.getAttribute("src") === bytes,
      fixture.bytesUrl, { timeout: 20_000 },
    );
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.ok(fixture.state.calls.some((call) => call.path === "/api/videos/sample-1/stream"), "the bytes were used");
    assert.equal(await page.getByText(/could not be played|could not be loaded/i).count(), 0, "no error is shown to the visitor");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("a playable CDN source is used and the byte stream stays untouched", options, async () => {
  const fixture = await createFixture({ cdn: "playable" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    const watch = page.locator(".video-card__play").first();
    await watch.waitFor();
    await watch.click();
    const media = page.locator("#player-container video");
    await media.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    assert.equal(await media.getAttribute("src"), fixture.cdnUrl, "the CDN file is what plays");
    assert.equal(await media.getAttribute("crossorigin"), null, "a CDN source is not asked for CORS");
    assert.ok(fixture.state.calls.some((call) => call.path === "/cdn-clip.mp4"));
    assert.ok(!fixture.state.calls.some((call) => call.path === "/api/videos/sample-1/stream"), "no bytes are downloaded");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// A visitor who is not signed in is asked to sign in before a premium video
// plays at all — trailer or no trailer — and the button opens the sign-in page.
test("a premium video asks a guest to sign in before anything plays", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await player.getByText("Sign in first to watch this premium video").waitFor();
    assert.equal(await player.locator("video").count(), 0, "nothing is loaded for a guest");
    // The message is the whole player: no play button over it, no transport UI.
    assert.equal(await player.getByRole("button", { name: "Play video" }).count(), 0, "no play button over the message");
    assert.equal(await player.locator('[data-controls]').count(), 0, "no timeline or volume for a video that cannot play");
    assert.equal(await player.getByRole("slider", { name: "Seek video" }).count(), 0);
    assert.equal(await player.locator(".video-player__signin").innerText(), "Sign in to watch");
    assert.deepEqual(streamCalls(fixture.state), [], "not even the trailer is requested");
    assert.deepEqual(errors, []);
    await player.getByRole("button", { name: "Sign in to watch" }).click();
    // The page with the Google button, not a dead end.
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login");
    await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
    assert.equal(await page.locator("#player-container").count(), 0, "the player is closed");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// A premium video without a trailer is no different for a guest: the metadata the
// catalogue sent (poster, title) still arrives and is drawn, and the player shows
// the sign-in message with nothing loaded behind it.
test("a guest still sees a premium video's metadata, then the sign-in message", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked-noTrailer" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    // The card itself is drawn from the catalogue's metadata.
    const card = page.locator(".video-card").first();
    await card.waitFor();
    assert.match(await card.innerText(), /Streaming fixture/, "the title comes from the catalogue");
    assert.equal(await card.locator(".video-card__image").getAttribute("src"), `${fixture.backend}/api/videos/sample-1/thumbnail`);
    assert.ok(fixture.state.calls.some((call) => call.path === "/api/videos/sample-1/thumbnail"), "the poster was fetched");

    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await player.getByText("Sign in first to watch this premium video").waitFor();
    // The player keeps the metadata visible, and there is no trailer note because
    // there is no trailer to describe.
    assert.equal(await player.getByText("Streaming fixture").count() >= 1, true, "the title is still on screen");
    assert.match(await player.locator("img").first().getAttribute("src"), /thumbnail/, "the poster is the backdrop");
    assert.equal(await player.locator("video").count(), 0, "no media element at all");
    assert.equal(await player.getByRole("button", { name: "Play video" }).count(), 0, "no play button over the message");
    assert.equal(await player.locator('[data-controls]').count(), 0, "no transport UI");
    assert.equal(await player.locator(".video-player__trailer-note").count(), 0);
    assert.deepEqual(streamCalls(fixture.state), [], "nothing is requested");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// The account check is asynchronous, and a premium video is gated until it ends:
// the sign-in notice is on screen from the first frame, no play button appears in
// the meantime, and nothing is requested. A signed-in member is never shown it.
test("a premium video shows the sign-in notice while the account is still being checked", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked", signedIn: true, holdAccount: true });
  try {
    const context = await fixture.browser.newContext();
    // Installed before any app module loads, so the very first account check is
    // the one that stays open.
    await context.addInitScript(() => { globalThis.__accountHold = true; globalThis.__accountReleased = false; });
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await player.getByText("Sign in first to watch this premium video").waitFor();
    // While the check runs: no transport UI, nothing requested, and the button is
    // not yet a trap for a member who is in fact signed in.
    const button = player.locator(".video-player__signin");
    assert.equal(await button.getAttribute("aria-busy"), "true");
    assert.equal(await button.innerText(), "Checking your account…");
    assert.equal(await player.getByRole("button", { name: "Play video" }).count(), 0);
    assert.equal(await player.locator("video").count(), 0);
    assert.deepEqual(streamCalls(fixture.state), []);
    // The check finishes: the member's trailer plays, and the notice is gone.
    await fixture.releaseAccount(page);
    // The gate lifts on its own: the notice is replaced by the member's player,
    // with the trailer the backend issued.
    await page.waitForFunction(() => !document.querySelector(".video-player__signin"), undefined, { timeout: 20_000 });
    assert.equal(await page.locator(".video-player__signin").count(), 0, "no sign-in notice for a member");
    assert.match(await player.locator("video").getAttribute("src"), /kind=trailer/);
    // A browser may not allow the deferred start without a fresh gesture (the
    // click happened before the check answered); the play button is right there.
    await player.getByRole("button", { name: "Play video" }).first().click();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused;
    }, undefined, { timeout: 20_000 });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// The backend's premium contract, seen from the browser: a locked video only ever
// offers its trailer, and an active window plays the tokenised stream it was
// given — the app never rebuilds either link.
test("a locked premium video plays its trailer and never asks for the stream", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked", signedIn: true });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    const source = await player.locator("video").getAttribute("src");
    assert.match(source, /kind=trailer/, "the trailer link the backend sent is the source");
    assert.match(source, /t=trailer-token/, "its token is kept exactly");
    assert.equal(await player.locator(".video-player__trailer-note").count(), 1, "the viewer is told it is a trailer");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    const streams = streamCalls(fixture.state);
    assert.ok(streams.length > 0 && streams.every((call) => call.search.includes("kind=trailer")),
      `only trailers were requested (got ${JSON.stringify(streams.map((call) => call.search))})`);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("a locked premium video without a trailer explains itself instead of loading anything", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked-noTrailer", signedIn: true });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    assert.equal(await player.locator("video").count(), 0, "nothing is played");
    assert.match(await player.innerText(), /Premium video · sirf premium members ke liye/);
    assert.match(await player.innerText(), /Sign in karke premium activate karo/);
    assert.match(await player.innerText(), /trailer bhi available nahi hai/i);
    assert.deepEqual(streamCalls(fixture.state), [], "the stream is never requested");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("an active premium window plays the tokenised stream the backend issued", options, async () => {
  const fixture = await createFixture({ premiumMode: "active", signedIn: true });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    const source = await player.locator("video").getAttribute("src");
    assert.match(source, /\/api\/videos\/sample-1\/stream\?t=stream-token$/, "the issued stream link, not a rebuilt one");
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 20_000 });
    const streams = streamCalls(fixture.state);
    assert.ok(streams.some((call) => call.search === "?t=stream-token"), "the browser asked with that token");
    assert.equal(await player.locator(".video-player__trailer-note").count(), 0, "a full video is not labelled a trailer");
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// A member's stream link carries a short-lived token. The very first link the
// backend hands out has already expired, which is the case the visitor hit: the
// player must ask for a fresh one by itself, with nothing on screen about it.
// A member's stream link carries a short-lived token. If the backend refuses the
// link the player was opened with, the player must fetch a fresh one by itself and
// keep playing — no reload prompt, nothing on screen at all.
// A member's premium window is confirmed after the page was opened with the locked
// answer. The trailer link is refused (expired), the fresh answer carries the full
// stream, and the player continues with the full video instead of the trailer.
test("a premium member gets the full video once the fresh answer carries it", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked", signedIn: true, expireTrailer: 1, unlockOnRefresh: true, format: "mp4" });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 25_000 }).catch(async (error) => {
      throw new Error(`the member never reached the full video; player says: ${(await player.innerText()).slice(0, 200)} / ${error.message}`);
    });
    const src = await player.locator("video").getAttribute("src");
    assert.doesNotMatch(src, /kind=trailer/, "the full stream is playing, not the trailer");
    assert.equal(await player.getByText(/sirf trailer/i).count(), 0, "the premium notice is gone");
    assert.equal(await player.getByRole("alert").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

test("an expired stream link is re-issued and playback continues by itself", options, async () => {
  const fixture = await createFixture({ premiumMode: "active", signedIn: true, format: "mp4", expireStream: 1 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 25_000 }).catch(async (error) => {
      throw new Error(`the expired link never recovered; player says: ${(await player.innerText()).slice(0, 160)} / ${error.message}`);
    });
    assert.match(await player.locator("video").getAttribute("src"), /t=stream-token-2$/, "the player swapped to the freshly issued link");
    assert.equal(await player.getByRole("alert").count(), 0, "no error is shown for a link that renews itself");
    assert.equal(await player.getByText(/Reload the page|validity khatam/i).count(), 0);
    const detailCalls = fixture.state.calls.filter((call) => call.path === "/api/videos/sample-1").length;
    assert.ok(detailCalls >= 2, `the video was fetched again for a fresh link (got ${detailCalls} detail calls)`);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// The same for a locked premium video's trailer: the refused trailer token is
// replaced from the server, and the visitor is never told to reload the page.
test("an expired trailer link is re-issued instead of asking for a reload", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked", signedIn: true, expireTrailer: 1 });
  try {
    const context = await fixture.browser.newContext();
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 25_000 }).catch(async (error) => {
      throw new Error(`the trailer never recovered; player says: ${(await player.innerText()).slice(0, 160)} / ${error.message}`);
    });
    assert.match(await player.locator("video").getAttribute("src"), /t=trailer-token-2$/);
    assert.equal(await player.getByText(/Reload the page/i).count(), 0, "the visitor is not told to reload");
    assert.equal(await player.getByRole("alert").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});

// The visitor's premium window is confirmed only after the page opened, so the
// first answer was the locked shape. As soon as the member is confirmed, the player
// asks for the video again by itself and plays the full stream — the trailer is a
// stand-in until the backend says otherwise, never the ending.
test("a member confirmed after opening is moved from the trailer to the full video", options, async () => {
  const fixture = await createFixture({ premiumMode: "locked", signedIn: true, holdAccount: true, unlockOnRefresh: true, format: "mp4" });
  try {
    const context = await fixture.browser.newContext();
    await context.addInitScript(() => { globalThis.__accountHold = true; globalThis.__accountReleased = false; });
    const { page, errors } = await openHome(fixture, context);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.locator(".video-card__play").first().click();
    const player = page.locator("#player-container");
    await player.waitFor();
    assert.equal(await player.getByRole("button", { name: "Checking your account…" }).count(), 1, "the gate is on screen while the account is checked");
    await fixture.releaseAccount(page);
    // The member is confirmed, so the player asks for the video again by itself and
    // the trailer source is replaced without a click.
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      const src = video?.getAttribute("src") ?? "";
      return src.length > 0 && !src.includes("kind=trailer");
    }, undefined, { timeout: 25_000 }).catch(async (error) => {
      throw new Error(`the member never reached the full video; player says: ${(await player.innerText()).slice(0, 200)} / ${error.message}`);
    });
    const src = await player.locator("video").getAttribute("src");
    // Starting playback still needs the visitor's own gesture in this browser.
    await page.evaluate(() => document.querySelector('#player-container button[aria-label="Play video"]')?.click());
    await page.waitForFunction(() => {
      const video = document.querySelector("#player-container video");
      return video && !video.paused && video.currentTime > 0.05;
    }, undefined, { timeout: 25_000 });
    assert.doesNotMatch(src, /kind=trailer/, "the full stream is what plays for a confirmed member");
    assert.equal(await player.getByText(/sirf trailer/i).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await fixture.close(); }
});
