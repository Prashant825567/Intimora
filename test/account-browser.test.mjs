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
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const backendA = "https://api-intimora.vercel.app";
const backendB = "https://intimora-api1.vercel.app";
const evil = "https://evil.example";
const fakeToken = "fixture.header.signature";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const videos = [
  { id: "video-one", title: "First video", creator: "Intimora", views: 100, likes: 8 },
  { id: "video-two", title: "Second video", creator: "Intimora", views: 20, likes: 2 },
];

// Only this test's Vite instance substitutes a deterministic identity provider.
// Production always imports the actual Firebase SDK and opens Google's popup.
const fakeFirebaseModule = `
  const listeners = new Set();
  const key = 'fixture-firebase-user';
  const identity = () => localStorage.getItem(key) ? {
    uid: 'fixture-uid', email: 'viewer@example.com', displayName: 'Viewer Name',
    getIdToken: async () => '${fakeToken}'
  } : null;
  const notify = () => { for (const listener of listeners) listener(identity()); };
  export function watchFirebaseUser(listener) {
    listeners.add(listener);
    const sendInitial = () => { if (listeners.has(listener)) listener(identity()); };
    if (window.__fixtureAuthDelay) setTimeout(sendInitial, window.__fixtureAuthDelay);
    else queueMicrotask(sendInitial);
    return () => listeners.delete(listener);
  }
  export async function signInWithGoogle() {
    window.__fixtureSignInCalls = (window.__fixtureSignInCalls || 0) + 1;
    if (window.__fixtureSignInFailure) throw { code: window.__fixtureSignInFailure };
    localStorage.setItem(key, 'yes');
    notify();
  }
  export async function signOutGoogle() { localStorage.removeItem(key); notify(); }
`;

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function profile(overrides = {}) {
  return { uid: "fixture-uid", email: "viewer@example.com", name: "Viewer Name", username: "viewer", referralCode: "REF-OWN001", likedVideos: [], savedVideos: [], ...overrides };
}

async function createFixture({ exists = false, ownProfile = profile(), safeReferrals = false, liveLikes = false, selected = backendA, authDelay = 0 } = {}) {
  const previous = process.env.INTIMORA_PUBLIC_SAFE_REFERRALS;
  const previousLiveLikes = process.env.INTIMORA_PUBLIC_LIVE_LIKES;
  process.env.INTIMORA_PUBLIC_SAFE_REFERRALS = safeReferrals ? "1" : "0";
  process.env.INTIMORA_PUBLIC_LIVE_LIKES = liveLikes ? "1" : "0";
  let vite;
  try {
    vite = await createViteServer({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: await availablePort(), strictPort: true },
      plugins: [{
        name: "account-test-identity", enforce: "pre",
        resolveId(id) { if (id === "../services/firebase") return "\0account-test-identity"; },
        load(id) { if (id === "\0account-test-identity") return fakeFirebaseModule; },
      }],
    });
  } finally {
    if (previous === undefined) delete process.env.INTIMORA_PUBLIC_SAFE_REFERRALS;
    else process.env.INTIMORA_PUBLIC_SAFE_REFERRALS = previous;
    if (previousLiveLikes === undefined) delete process.env.INTIMORA_PUBLIC_LIVE_LIKES;
    else process.env.INTIMORA_PUBLIC_LIVE_LIKES = previousLiveLikes;
  }
  await vite.listen();
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const state = {
    exists, profile: ownProfile, selected, calls: [], failNext: "", failCatalog: false,
    delayMutation: 0, activeMutations: 0, maxMutations: 0, tree: null,
    created: false, registeredBackend: exists ? selected : null, partitionAccounts: false,
    persistOnCreate: true, staleVerifications: 0, switchAfterCreate: false, switchAfterVerify: false,
    alreadyExistsOnCreate: false, registrationDelay: 0, compactMutations: false,
    publicCounts: Object.fromEntries(videos.map((video) => [video.id, { likes: video.likes, version: 1 }])),
    failCounts: false, delayCounts: 0, holdNextCounts: false, countReleases: [], completedCounts: 0,
    failReferrals: false, holdMutations: false, mutationReleases: [], missingLikes: [],
  };
  const setupContext = async (targetContext) => {
    await targetContext.addInitScript(({ delay, observeCards }) => {
      const originalNow = Date.now;
      window.__fixtureAuthDelay = delay;
      window.__timeOffset = 0;
      Date.now = () => originalNow() + window.__timeOffset;
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); }
        observe(element) {
          this.targets.add(element);
          if (observeCards && element.classList.contains("video-card")) {
            queueMicrotask(() => { if (this.targets.has(element)) this.callback([{ target: element, isIntersecting: true }]); });
          }
        }
        unobserve(element) { this.targets.delete(element); }
        disconnect() { this.targets.clear(); }
      };
    }, { delay: authDelay, observeCards: liveLikes });
    await targetContext.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Range", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length" };
    if (req.url() === discovery) {
      state.calls.push({ origin: "discovery", path: url.pathname, method: req.method(), headers: req.headers() });
      return route.fulfill({ headers: cors, json: { ok: true, data: { server: state.selected } } });
    }
    if (![backendA, backendB, evil].includes(url.origin)) return route.continue();
    const call = { origin: url.origin, path: url.pathname, method: req.method(), headers: req.headers(), body: req.postData() };
    state.calls.push(call);
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
      if (state.failCatalog) return route.fulfill({ status: 500, headers: cors, json: { ok: false, error: "private https://private.example" } });
      const items = videos.map((video) => state.missingLikes.includes(video.id) ? { ...video, likes: undefined } : video);
      return route.fulfill({ headers: cors, json: { ok: true, data: { videos: items, nextCursor: null } } });
    }
    if (url.pathname === "/api/likes/counts") {
      if (!liveLikes || state.failCounts) return route.fulfill({ status: 503, headers: cors, json: { ok: false } });
      const counts = (url.searchParams.get("ids") || "").split(",")
        .filter((id) => state.publicCounts[id]).map((id) => ({ id, ...state.publicCounts[id] }));
      if (state.holdNextCounts) {
        state.holdNextCounts = false;
        await new Promise((resolve) => state.countReleases.push(resolve));
      }
      if (state.delayCounts) await new Promise((resolve) => setTimeout(resolve, state.delayCounts));
      try {
        await route.fulfill({ headers: cors, json: { ok: true, data: { counts } } });
        state.completedCounts += 1;
      } catch { /* Polls can be aborted when a card disappears or a tab hides. */ }
      return;
    }
    if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ headers: cors, contentType: "image/png", body: image });
    if (url.pathname.endsWith("/stream")) return route.fulfill({ headers: cors, contentType: "video/mp4", body: "" });
    if (/^\/api\/videos\/(video-one|video-two)$/.test(url.pathname)) {
      const item = videos.find((v) => url.pathname.endsWith(v.id));
      const result = state.missingLikes.includes(item.id) ? { ...item, likes: undefined } : item;
      return route.fulfill({ headers: cors, json: { ok: true, data: result } });
    }
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/user/") || /\/(like|save)$/.test(url.pathname)) {
      if (req.headers().authorization !== `Bearer ${fakeToken}`) return route.fulfill({ status: 401, headers: cors, json: { ok: false, error: "No auth token" } });
    }
    const accountExistsHere = () => state.exists && (!state.partitionAccounts || state.registeredBackend === url.origin);
    if (url.pathname === "/api/auth/verify") {
      let found = accountExistsHere();
      if (found && state.created && state.staleVerifications > 0) {
        state.staleVerifications -= 1;
        found = false;
      }
      if (found && state.switchAfterVerify) {
        state.switchAfterVerify = false;
        state.selected = backendB;
        await page.evaluate(() => { window.__timeOffset = 61_000; });
      }
      return route.fulfill({ headers: cors, json: { ok: true, data: { exists: found } } });
    }
    if (url.pathname === "/api/auth/me") {
      if (!accountExistsHere()) return route.fulfill({ status: 404, headers: cors, json: { ok: false, error: "User not found" } });
      return route.fulfill({ headers: cors, json: { ok: true, data: { user: state.profile } } });
    }
    if (url.pathname === "/api/auth/profile") {
      const input = req.postDataJSON();
      if (input.username === "taken") return route.fulfill({ status: 400, headers: cors, json: { ok: false, error: "Username already exists" } });
      if (input.referralCode && input.referralCode !== "INVITE-1") return route.fulfill({ status: 400, headers: cors, json: { ok: false, error: "Invalid referral code" } });
      if (state.registrationDelay) await new Promise((resolve) => setTimeout(resolve, state.registrationDelay));
      state.created = true;
      state.exists = state.persistOnCreate;
      state.registeredBackend = url.origin;
      state.profile = profile({ name: input.name, username: input.username });
      if (state.switchAfterCreate) {
        state.selected = backendB;
        await page.evaluate(() => { window.__timeOffset = 61_000; });
      }
      if (state.alreadyExistsOnCreate) return route.fulfill({ status: 400, headers: cors, json: { ok: false, error: "User already exists" } });
      return route.fulfill({ headers: cors, json: { ok: true, data: { user: state.profile } } });
    }
    const mutation = /^\/api\/videos\/(video-one|video-two)\/(like|save)$/.exec(url.pathname);
    if (mutation) {
      state.activeMutations += 1;
      state.maxMutations = Math.max(state.maxMutations, state.activeMutations);
      if (state.holdMutations) await new Promise((resolve) => state.mutationReleases.push(resolve));
      if (state.delayMutation) await new Promise((resolve) => setTimeout(resolve, state.delayMutation));
      state.activeMutations -= 1;
      if (state.failNext === mutation[2]) {
        state.failNext = "";
        return route.fulfill({ status: 500, headers: cors, json: { ok: false, error: "private server details https://private.example" } });
      }
      const field = mutation[2] === "like" ? "likedVideos" : "savedVideos";
      const list = state.profile[field];
      const index = list.indexOf(mutation[1]);
      const active = liveLikes ? req.postDataJSON().active : index < 0;
      if (active && index < 0) list.push(mutation[1]);
      if (!active && index >= 0) list.splice(index, 1);
      if (liveLikes && mutation[2] === "like" && active !== (index >= 0)) {
        const count = state.publicCounts[mutation[1]];
        count.likes = Math.max(0, count.likes + (active ? 1 : -1));
        count.version += 1;
      }
      const data = { [mutation[2] === "like" ? "liked" : "saved"]: active };
      if (!state.compactMutations) data[field] = list;
      if (liveLikes && mutation[2] === "like") Object.assign(data, state.publicCounts[mutation[1]]);
      return route.fulfill({ headers: cors, json: { ok: true, data } });
    }
    if (url.pathname === "/api/user/referrals") {
      if (state.failReferrals || !accountExistsHere()) return route.fulfill({ status: 503, headers: cors, json: { ok: false } });
      return route.fulfill({ headers: cors, json: { ok: true, data: { tree: state.tree } } });
    }
    return route.fulfill({ status: 404, headers: cors, json: { ok: false, error: "private details" } });
    });
  };
  await setupContext(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    base: `http://127.0.0.1:${vite.httpServer.address().port}`, state, page, errors,
    async newVisitor() {
      const extra = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await setupContext(extra);
      const visitorPage = await extra.newPage();
      visitorPage.on("pageerror", (error) => errors.push(error.message));
      return { page: visitorPage, close: () => extra.close() };
    },
    async close() {
      state.holdMutations = false;
      for (const release of state.mutationReleases.splice(0)) release();
      for (const release of state.countReleases.splice(0)) release();
      await browser.close();
      await vite.close();
    },
  };
}

async function assertFits(page) {
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, `account layout overflows: ${JSON.stringify(sizes)}`);
}

const browserOptions = { skip: browserAvailable ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 90_000 };

test("a guest action heads to login even while initial auth state is still loading", browserOptions, async () => {
  const fixture = await createFixture({ authDelay: 10_000 });
  const { page, state, base } = fixture;
  try {
    await page.goto(base);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    await page.getByRole("button", { name: "Save video" }).first().click();
    assert.equal(new URL(page.url()).pathname, "/login");
    assert.ok(!state.calls.some((call) => call.path.endsWith("/save")));
  } finally { await fixture.close(); }
});

test("guest deep link, Google login, returning account, libraries and logout", browserOptions, async () => {
  const fixture = await createFixture({ exists: true, ownProfile: profile({ likedVideos: ["video-one", "missing-id"], savedVideos: ["video-two"] }) });
  const { page, state, base } = fixture;
  try {
    await page.goto(`${base}/dashboard`);
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.ok(!state.calls.some((call) => call.path.startsWith("/api/auth/")), "age gate precedes account requests");
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login");
    await assertFits(page);
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    assert.equal(await page.getByText("REF-OWN001").count(), 1);
    await page.getByRole("region", { name: "Liked videos" }).getByText("First video").waitFor();
    await page.getByRole("region", { name: "Saved videos" }).getByText("Second video").waitFor();
    await page.getByText("Some liked videos are currently unavailable.").waitFor();
    await page.getByText(/Referral details are temporarily unavailable/).waitFor();
    assert.ok(!state.calls.some((call) => ["/api/user/liked", "/api/user/saved", "/api/user/referrals"].includes(call.path)), "unsafe endpoints are not requested");
    assert.ok(!state.calls.some((call) => /^\/api\/videos\/video-/.test(call.path) && !/\/(thumbnail|stream)$/.test(call.path)), "libraries do not inflate video views");
    await page.getByRole("region", { name: "Liked videos" }).getByRole("button", { name: "Play First video" }).click();
    await page.getByRole("button", { name: "Unlike video" }).waitFor();
    await page.getByRole("button", { name: "Close video player" }).click();
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } }); });
    await page.getByRole("button", { name: "Copy referral code" }).click();
    assert.equal(await page.evaluate(() => window.__copied), "REF-OWN001");
    for (const width of [280, 320, 390, 900]) {
      await page.setViewportSize({ width, height: 844 });
      await assertFits(page);
    }
    assert.equal((await page.reload()).status(), 200);
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/dashboard", "refresh keeps a signed-in user on the dashboard");
    assert.equal(await page.evaluate(() => window.__fixtureSignInCalls || 0), 0, "Firebase state restores without another popup");
    assert.equal(await page.getByText("REF-OWN001").count(), 1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("new users complete name, unique username and optional referral; actions use authenticated pinned backend", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state, base } = fixture;
  try {
    await page.goto(base);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    await page.getByRole("button", { name: "Save video" }).first().click();
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.ok(!state.calls.some((call) => call.path.endsWith("/save")));
    await page.evaluate(() => { window.__fixtureSignInFailure = "auth/popup-blocked"; });
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("alert").getByText(/allow pop-ups/i).waitFor();
    await page.evaluate(() => { window.__fixtureSignInFailure = ""; });
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("heading", { name: "Complete your profile" }).waitFor();
    for (const width of [280, 320, 390]) { await page.setViewportSize({ width, height: 844 }); await assertFits(page); }
    await page.getByLabel("Name", { exact: true }).fill("Ava");
    await page.getByLabel("Username", { exact: true }).fill("taken");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Have a referral code?" }).waitFor();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByText(/username is already taken/i).waitFor();
    await page.getByLabel("Username", { exact: true }).fill("ava_123");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Referral code").fill("NOT-VALID");
    await page.getByRole("button", { name: "Finish profile" }).click();
    await page.getByText(/referral code is invalid/i).waitFor();
    await page.getByLabel("Referral code").fill("INVITE-1");
    await page.getByRole("button", { name: "Finish profile" }).click();
    await page.getByRole("heading", { name: "Ava" }).waitFor();
    assert.equal(state.profile.username, "ava_123");
    const registration = state.calls.filter((call) => call.path === "/api/auth/profile").at(-1);
    assert.deepEqual(JSON.parse(registration.body), { name: "Ava", username: "ava_123", referralCode: "INVITE-1" });
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).waitFor();
    state.selected = backendB;
    await page.evaluate(() => { window.__timeOffset = 61_000; });
    const search = page.getByRole("textbox", { name: "Search videos" });
    await search.fill("First");
    const searched = page.waitForResponse((response) => response.url().startsWith(`${backendB}/api/search?`));
    await search.press("Enter");
    await searched;
    await page.getByText("Search results for").waitFor();
    assert.ok(state.calls.some((call) => call.origin === backendB && call.path === "/api/search"));
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.getByRole("button", { name: /WATCH NOW/i }).click();
    const player = page.locator(".video-player__content");
    state.delayMutation = 80;
    await player.getByRole("button", { name: "Like video" }).click();
    await player.getByRole("button", { name: "Save video", exact: true }).click();
    await player.getByRole("button", { name: "Unlike video" }).click({ trial: true });
    await player.getByRole("button", { name: "Remove saved video" }).click({ trial: true });
    assert.equal(state.maxMutations, 1, "this tab serializes mutations to avoid overwriting its own user record");
    const mutations = state.calls.filter((call) => /\/(like|save)$/.test(call.path));
    assert.ok(mutations.length >= 2 && mutations.every((call) => call.origin === backendA && call.headers.authorization === `Bearer ${fakeToken}`));
    state.failNext = "save";
    await player.getByRole("button", { name: "Remove saved video" }).click();
    await player.getByRole("alert").getByText(/Could not confirm save/).waitFor();
    assert.equal(await player.getByRole("button", { name: "Remove saved video" }).getAttribute("aria-pressed"), "true");
    assert.ok(!(await page.locator("body").innerText()).includes("private.example"));
    await player.getByRole("button", { name: "Remove saved video" }).click();
    await player.getByRole("button", { name: "Save video", exact: true }).waitFor();
    await player.getByRole("button", { name: "Save video", exact: true }).click();
    await player.getByRole("button", { name: "Remove saved video" }).waitFor();
    await page.getByRole("button", { name: "Close video player" }).click();
    await page.getByRole("button", { name: "Account dashboard" }).click();
    await page.getByRole("region", { name: "Liked videos" }).getByText("First video").waitFor();
    await page.getByRole("region", { name: "Saved videos" }).getByText("First video").waitFor();
    assert.equal(await page.getByText("REF-OWN001").count(), 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("dashboard reports a failed public catalog without falsely claiming the library is empty, and can retry", browserOptions, async () => {
  const fixture = await createFixture({ exists: true, ownProfile: profile({ likedVideos: ["video-one"], savedVideos: ["video-two"] }) });
  const { page, state, base } = fixture;
  state.failCatalog = true;
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByText("Liked videos are currently unavailable.").waitFor();
    await page.getByText("Saved videos are currently unavailable.").waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("private.example"));
    state.failCatalog = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("region", { name: "Liked videos" }).getByText("First video").waitFor();
    await page.getByRole("region", { name: "Saved videos" }).getByText("Second video").waitFor();
  } finally { await fixture.close(); }
});

test("new account can skip the referral step", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state, base } = fixture;
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByLabel("Username").fill("skip_user");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Referral code").fill("IGNORED-IF-SKIPPED");
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    assert.equal(JSON.parse(state.calls.find((call) => call.path === "/api/auth/profile").body).referralCode, "");
    await page.reload();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
  } finally { await fixture.close(); }
});

async function openNewReferral(fixture, username = "new_user") {
  const { page, base } = fixture;
  await page.goto(`${base}/login`);
  await page.getByRole("button", { name: /I AM 18/i }).click();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Have a referral code?" }).waitFor();
}

test("finishing with an empty or whitespace referral creates an account just like Skip", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state } = fixture;
  try {
    await openNewReferral(fixture);
    await page.getByLabel("Referral code").fill("   ");
    await page.getByRole("button", { name: "Finish profile" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    const submissions = state.calls.filter((call) => call.path === "/api/auth/profile");
    assert.equal(submissions.length, 1);
    assert.equal(JSON.parse(submissions[0].body).referralCode, "");
    await page.reload();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
  } finally { await fixture.close(); }
});

test("an invalid referral can be skipped without sending it again", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state } = fixture;
  try {
    await openNewReferral(fixture);
    await page.getByLabel("Referral code").fill("NOT-VALID");
    await page.getByRole("button", { name: "Finish profile" }).click();
    await page.getByRole("alert").getByText(/referral code is invalid/i).waitFor();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    const attempts = state.calls.filter((call) => call.path === "/api/auth/profile");
    assert.deepEqual(attempts.map((call) => JSON.parse(call.body).referralCode), ["NOT-VALID", ""]);
  } finally { await fixture.close(); }
});

test("registration waits for a temporarily stale account lookup instead of returning to referral", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state } = fixture;
  state.staleVerifications = 2;
  try {
    await openNewReferral(fixture);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor({ timeout: 8_000 });
    assert.equal(state.calls.filter((call) => call.path === "/api/auth/profile").length, 1);
    assert.equal(state.calls.filter((call) => call.path === "/api/auth/verify").length, 4);
  } finally { await fixture.close(); }
});

test("an unpersisted account reports a confirmation error instead of silently looping or faking login", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state } = fixture;
  state.persistOnCreate = false;
  try {
    await openNewReferral(fixture);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("alert").getByText(/couldn.t confirm.*account/i).waitFor({ timeout: 8_000 });
    assert.equal(await page.getByRole("heading", { name: "Have a referral code?" }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Viewer Name" }).count(), 0);
    assert.equal(state.calls.filter((call) => call.path === "/api/auth/profile").length, 1);
    assert.equal(JSON.parse(state.calls.find((call) => call.path === "/api/auth/profile").body).referralCode, "");
    // Once storage is fixed, the same form can be retried without retyping a code.
    state.persistOnCreate = true;
    await page.getByRole("button", { name: "Finish profile" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    assert.equal(state.calls.filter((call) => call.path === "/api/auth/profile").length, 2);
  } finally { await fixture.close(); }
});

test("returning users load the profile from the backend that verified them", browserOptions, async () => {
  const fixture = await createFixture({ exists: true });
  const { page, state, base } = fixture;
  state.partitionAccounts = true;
  state.switchAfterVerify = true;
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor({ timeout: 8_000 });
    assert.equal(state.calls.find((call) => call.path === "/api/auth/verify").origin, backendA);
    assert.equal(state.calls.find((call) => call.path === "/api/auth/me").origin, backendA);
  } finally { await fixture.close(); }
});

for (const alreadyExists of [false, true]) {
  test(`registration ${alreadyExists ? "recovers an existing account" : "confirms its write"} on the original backend after discovery changes`, browserOptions, async () => {
    const fixture = await createFixture();
    const { page, state } = fixture;
    state.partitionAccounts = true;
    state.switchAfterCreate = true;
    state.alreadyExistsOnCreate = alreadyExists;
    try {
      await openNewReferral(fixture);
      await page.getByRole("button", { name: "Skip for now" }).click();
      await page.getByRole("heading", { name: "Viewer Name" }).waitFor({ timeout: 8_000 });
      const createIndex = state.calls.findIndex((call) => call.path === "/api/auth/profile");
      assert.equal(state.calls[createIndex].origin, backendA);
      const confirmation = state.calls.slice(createIndex + 1).filter((call) => ["/api/auth/verify", "/api/auth/me"].includes(call.path));
      assert.ok(confirmation.some((call) => call.path === "/api/auth/verify"));
      assert.ok(confirmation.some((call) => call.path === "/api/auth/me"));
      assert.ok(confirmation.every((call) => call.origin === backendA));
    } finally { await fixture.close(); }
  });
}

test("two immediate Skip clicks submit only one registration", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state } = fixture;
  state.registrationDelay = 200;
  try {
    await openNewReferral(fixture);
    await page.getByRole("button", { name: "Skip for now" }).evaluate((button) => { button.click(); button.click(); });
    await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
    assert.equal(state.calls.filter((call) => call.path === "/api/auth/profile").length, 1);
  } finally { await fixture.close(); }
});

test("sanitized referral fixture renders only two descendant levels, grouped by their direct parent", browserOptions, async () => {
  // This flag is only safe against a backend which strips other users' private fields.
  const fixture = await createFixture({ exists: true, safeReferrals: true });
  const { page, state, base } = fixture;
  state.tree = {
    code: "REF-OWN001",
    direct: [
      { name: "Direct Alice", username: "alice", referralCode: "REF-ALICE", referredBy: "REF-OWN001" },
      { name: "Ancestor Eve", username: "ancestor", referralCode: "REF-EVE", referredBy: "REF-OTHER" },
      { name: "Self", username: "self", referralCode: "REF-OWN001", referredBy: "REF-OWN001" },
    ],
    level2: [
      { name: "Second Bob", username: "bob", referralCode: "REF-BOB", referredBy: "REF-ALICE" },
      { name: "Unrelated", username: "unrelated", referralCode: "REF-NOT", referredBy: "REF-EVE" },
    ],
  };
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    const network = page.getByRole("region", { name: "Referral network" });
    await network.getByText("Direct Alice").waitFor();
    await network.getByText("Second Bob").waitFor();
    const tree = network.locator(".referral-tree > div").first();
    assert.match(await tree.innerText(), /Direct Alice[\s\S]*Second Bob/);
    assert.doesNotMatch(await network.innerText(), /Ancestor Eve|Unrelated|\bSelf\b/);
    state.tree.direct.push({ name: "New Carol", username: "carol", referralCode: "REF-CAROL", referredBy: "REF-OWN001" });
    await network.getByRole("button", { name: "Refresh referrals" }).click();
    await network.getByText("New Carol").waitFor();
    assert.ok(state.calls.filter((call) => call.path === "/api/user/referrals").length >= 2);
  } finally { await fixture.close(); }
});

test("a malicious discovery selection cannot receive a Firebase token", browserOptions, async () => {
  const fixture = await createFixture({ selected: evil });
  const { page, state, base } = fixture;
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("heading", { name: "Account unavailable" }).waitFor();
    assert.ok(state.calls.filter((call) => call.origin === evil).every((call) => !call.headers.authorization));
    assert.ok(!state.calls.some((call) => call.origin === evil && call.path.startsWith("/api/auth/")));
    assert.ok(!(await page.locator("body").innerText()).includes(evil));
    state.selected = backendA;
    await page.evaluate(() => { window.__timeOffset = 61_000; });
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("heading", { name: "Complete your profile" }).waitFor();
  } finally { await fixture.close(); }
});

async function openFirstVideoSignedIn(fixture) {
  const { page, base } = fixture;
  await page.goto(`${base}/login`);
  await page.getByRole("button", { name: /I AM 18/i }).click();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByRole("heading", { name: "Viewer Name" }).waitFor();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const first = page.getByRole("region", { name: "All Videos" }).getByRole("button", { name: "Play First video" });
  await first.click();
  return page.locator(".video-player__content");
}

async function waitForFixtureCondition(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("slow like and save show immediate pending intent, serialize writes, and roll back failures", browserOptions, async () => {
  const fixture = await createFixture({ exists: true });
  const { page, state } = fixture;
  try {
    const player = await openFirstVideoSignedIn(fixture);
    state.holdMutations = true;
    const started = Date.now();
    await player.getByRole("button", { name: "Like video" }).click();
    const liked = player.getByRole("button", { name: "Unlike video" });
    assert.equal(await liked.getAttribute("aria-pressed"), "true");
    assert.equal(await liked.getAttribute("aria-busy"), "true");
    assert.ok(Date.now() - started < 1_500, "the UI must not wait for the held server response");
    assert.equal((await liked.innerText()).trim(), "8", "the legacy backend does not supply an authoritative new public count");
    await player.getByRole("status").getByText("Saving like…").waitFor();
    await player.getByRole("button", { name: "Save video", exact: true }).click();
    assert.equal(await player.getByRole("button", { name: "Remove saved video" }).getAttribute("aria-busy"), "true");
    await player.getByRole("status").getByText("Saving like and video…").waitFor();
    await waitForFixtureCondition(() => state.mutationReleases.length === 1);
    assert.equal(state.calls.filter((call) => /\/(like|save)$/.test(call.path)).length, 1, "the second legacy write waits instead of racing the user record");
    state.holdMutations = false;
    state.mutationReleases.shift()();
    await liked.click({ trial: true });
    await player.getByRole("button", { name: "Remove saved video" }).click({ trial: true });
    assert.equal(state.maxMutations, 1);
    assert.deepEqual(state.profile.likedVideos, ["video-one"]);
    assert.deepEqual(state.profile.savedVideos, ["video-one"]);
    const mutations = state.calls.filter((call) => /\/(like|save)$/.test(call.path));
    assert.deepEqual(mutations.map((call) => JSON.parse(call.body)), [{ active: true }, { active: true }]);
    assert.ok(!state.calls.some((call) => call.path === "/api/likes/counts"), "polling stays off until the server supports it");

    state.failNext = "like";
    state.holdMutations = true;
    await liked.click();
    assert.equal(await player.getByRole("button", { name: "Like video" }).getAttribute("aria-pressed"), "false");
    await waitForFixtureCondition(() => state.mutationReleases.length === 1);
    state.holdMutations = false;
    state.mutationReleases.shift()();
    await player.getByRole("alert").getByText(/Could not confirm like/).waitFor();
    assert.equal(await player.getByRole("button", { name: "Unlike video" }).getAttribute("aria-pressed"), "true");
    assert.deepEqual(state.profile.likedVideos, ["video-one"]);
    assert.ok(!(await page.locator("body").innerText()).includes("private.example"));
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("versioned public counts update the player and an independent guest without a page reload", browserOptions, async () => {
  const fixture = await createFixture({ exists: true, liveLikes: true });
  const { page, state, base } = fixture;
  const guest = await fixture.newVisitor();
  try {
    await guest.page.goto(base);
    assert.ok(!state.calls.some((call) => call.path === "/api/likes/counts"), "no stats are requested before age confirmation");
    await guest.page.getByRole("button", { name: /I AM 18/i }).click();
    const guestCard = guest.page.getByRole("region", { name: "All Videos" }).locator(".video-card").filter({ hasText: "First video" });
    const secondCard = guest.page.getByRole("region", { name: "All Videos" }).locator(".video-card").filter({ hasText: "Second video" });
    await guestCard.locator('[aria-label="8 likes"]').waitFor();
    await secondCard.locator('[aria-label="2 likes"]').waitFor();
    await waitForFixtureCondition(() => state.calls.some((call) => call.path === "/api/likes/counts"));

    const player = await openFirstVideoSignedIn(fixture);
    state.compactMutations = true;
    await page.bringToFront();
    await player.getByRole("button", { name: "Like video" }).click();
    const liked = player.getByRole("button", { name: "Unlike video" });
    await liked.click({ trial: true });
    assert.equal(await liked.getAttribute("title"), "9 likes");
    assert.equal((await liked.innerText()).trim(), "9");
    assert.deepEqual(state.profile.likedVideos, ["video-one"]);
    assert.deepEqual(JSON.parse(state.calls.filter((call) => call.path.endsWith("/like")).at(-1).body), { active: true });

    await guest.page.bringToFront();
    await guestCard.locator('[aria-label="9 likes"]').waitFor({ timeout: 8_000 });
    await secondCard.locator('[aria-label="2 likes"]').waitFor();
    assert.ok(state.calls.filter((call) => call.path === "/api/likes/counts").every((call) => !call.headers.authorization), "public counts never send a Firebase token");

    await page.bringToFront();
    await liked.click();
    const unliked = player.getByRole("button", { name: "Like video" });
    await unliked.click({ trial: true });
    assert.equal(await unliked.getAttribute("title"), "8 likes");
    assert.deepEqual(state.profile.likedVideos, []);
    await guest.page.bringToFront();
    await guestCard.locator('[aria-label="8 likes"]').waitFor({ timeout: 8_000 });
    assert.equal(state.calls.filter((call) => call.path === "/api/videos/video-one" && call.method === "GET").length, 1, "polling must not inflate video views");
    assert.deepEqual(fixture.errors, []);
  } finally { await guest.close(); await fixture.close(); }
});

test("a missing public like count is shown as unavailable, not a fabricated zero", browserOptions, async () => {
  const fixture = await createFixture();
  const { page, state, base } = fixture;
  state.missingLikes = ["video-one"];
  try {
    await page.goto(base);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    const card = page.getByRole("region", { name: "All Videos" }).locator(".video-card").filter({ hasText: "First video" });
    await card.locator('[aria-label="Like count unavailable"]').waitFor();
    await card.getByRole("button", { name: "Play First video" }).click();
    const like = page.locator(".video-player__content").getByRole("button", { name: "Like video" });
    assert.equal(await like.getAttribute("title"), "Like count unavailable");
    assert.equal((await like.innerText()).trim(), "—");
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("a slow older count response cannot undo a confirmed like count", browserOptions, async () => {
  const fixture = await createFixture({ exists: true, liveLikes: true });
  const { page, state } = fixture;
  try {
    const player = await openFirstVideoSignedIn(fixture);
    await waitForFixtureCondition(() => state.completedCounts > 0);
    state.holdNextCounts = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitForFixtureCondition(() => state.countReleases.length === 1);
    await player.getByRole("button", { name: "Like video" }).click();
    const liked = player.getByRole("button", { name: "Unlike video" });
    await liked.click({ trial: true });
    assert.equal(await liked.getAttribute("title"), "9 likes");
    const completed = state.completedCounts;
    state.countReleases.shift()();
    await waitForFixtureCondition(() => state.completedCounts > completed);
    assert.equal(await liked.getAttribute("title"), "9 likes", "version one cannot replace the confirmed version two");
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test("privacy-safe referrals use the verified backend and retry a temporary failure", browserOptions, async () => {
  const fixture = await createFixture({ exists: true, safeReferrals: true });
  const { page, state, base } = fixture;
  state.partitionAccounts = true;
  state.switchAfterVerify = true;
  state.failReferrals = true;
  state.tree = { code: "REF-OWN001", direct: [{ name: "Direct Alice", username: "alice", referralCode: "REF-ALICE", referredBy: "REF-OWN001" }], level2: [] };
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    const network = page.getByRole("region", { name: "Referral network" });
    await network.getByRole("alert").getByText(/Could not load referrals/).waitFor();
    state.failReferrals = false;
    await network.getByRole("button", { name: "Retry referrals" }).click();
    await network.getByText("Direct Alice").waitFor();
    const calls = state.calls.filter((call) => call.path === "/api/user/referrals");
    assert.ok(calls.length >= 2 && calls.every((call) => call.origin === backendA && call.headers.authorization === `Bearer ${fakeToken}`));
    assert.equal(state.selected, backendB, "discovery switched after the account was verified");
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
