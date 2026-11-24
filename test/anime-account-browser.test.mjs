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
const fakeToken = "fixture.header.signature";
const catalogVideos = [{ id: "own-one", title: "Our own video", views: 10, createdAt: 1_760_000_000, category: "Desi" }];
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const A_ANIME = "anime-one-wife-1-OneWife001x";
const A_ANIME_TITLE = "One Wife 1";
const A_ANIME_POSTER = "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg";

// The anime source's own rows, in the shape it really answers with.
const recent = {
  status: "success",
  data: { provider: "hentaicity", type: "recent", results: [
    { id: "one-wife-1-OneWife001x", title: A_ANIME_TITLE, thumbnail: A_ANIME_POSTER, duration: "23:36" },
  ] },
};

// Only this test's Vite instance substitutes a deterministic identity provider.
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
    queueMicrotask(() => { if (listeners.has(listener)) listener(identity()); });
    return () => listeners.delete(listener);
  }
  export async function signInWithGoogle() { localStorage.setItem(key, 'yes'); notify(); }
  export async function signOutGoogle() { localStorage.removeItem(key); notify(); }
`;

function identityPlugin() {
  return {
    name: "anime-account-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0anime-account-test-identity"; },
    load(id) { if (id === "\0anime-account-test-identity") return fakeFirebaseModule; },
  };
}

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// An external title has no catalogue record, so a like/save on its card is kept by
// the account itself: the same `/api/videos/:id/like|save` route, the same
// `likedVideos`/`savedVideos` list, with a namespaced `anime-…` id and the title
// and poster stored beside it. This test drives that end to end.
test("an anime card is liked and saved into the account's own lists, and drawn back on the dashboard", {
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
    const user = {
      uid: "fixture-uid", email: "viewer@example.com", name: "Viewer Name", username: "viewer",
      referralCode: "REF-OWN001", likedVideos: [], savedVideos: [],
    };
    const mutations = [];
    const calls = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range, Authorization" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      // The app itself is served by Vite; only the outside world is faked here.
      if (url.origin === base) return route.continue();
      if (url.hostname === "pacahub-34nd.onrender.com") {
        if (url.pathname === "/api/hen/city/recent") return route.fulfill({ headers, json: recent });
        if (url.pathname === "/api/hen/city/popular/1") return route.fulfill({ headers, json: { status: "success", data: { results: [] } } });
        return route.fulfill({ status: 404, headers, json: { ok: false } });
      }
      if (url.hostname === "cdn1.images.hentaicity.com") return route.fulfill({ contentType: "image/png", body: image });
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.hostname !== new URL(backend).hostname) return route.abort();
      calls.push({ path: url.pathname, method: request.method(), body: request.postData(), authorization: request.headers().authorization });

      // A guest is offered a sign-in; the account routes themselves always need the
      // bearer token, exactly as the live backend demands.
      if (url.pathname === "/api/auth/verify") return route.fulfill({ headers, json: { ok: true, data: { exists: Boolean(user.created) } } });
      if (url.pathname === "/api/auth/me") {
        if (!user.created || request.headers().authorization !== `Bearer ${fakeToken}`) return route.fulfill({ status: 404, headers, json: { ok: false } });
        return route.fulfill({ headers, json: { ok: true, data: { user } } });
      }
      if (url.pathname === "/api/auth/profile") {
        Object.assign(user, { created: true, name: "Viewer Name", username: "viewer", referralCode: "REF-OWN001" });
        return route.fulfill({ headers, json: { ok: true, data: { user } } });
      }
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
        return route.fulfill({ headers, json: { ok: true, data: { videos: catalogVideos, nextCursor: null } } });
      }
      if (url.pathname === "/api/likes/counts") return route.fulfill({ headers, json: { ok: true, data: { counts: [] } } });
      if (url.pathname === "/api/premium/status") {
        return route.fulfill({ headers, json: { ok: true, data: { active: false, until: 0, remainingSeconds: 0, serverNow: 0, referralCode: "REF-OWN001", referrals: { total: 0, used: 0, available: 0, availableCodes: [], secondsEach: 9000, hoursEach: 2.5 } } } });
      }
      if (url.pathname === "/api/premium/history") {
        return route.fulfill({ headers, json: { ok: true, data: { periods: [], total: { seconds: 0, amountPaise: 0, bySource: {} }, status: null } } });
      }
      if (url.pathname === "/api/user/referrals") return route.fulfill({ headers, json: { ok: true, data: { tree: { code: "REF-OWN001", direct: [], level2: [] } } } });

      const mutation = /^\/api\/videos\/([A-Za-z0-9_-]{1,128})\/(like|save)$/.exec(url.pathname);
      if (mutation) {
        if (request.headers().authorization !== `Bearer ${fakeToken}`) return route.fulfill({ status: 401, headers, json: { ok: false, error: "No auth token" } });
        const body = request.postDataJSON();
        mutations.push({ id: mutation[1], action: mutation[2], body });
        const field = mutation[2] === "like" ? "likedVideos" : "savedVideos";
        const list = user[field];
        const index = list.findIndex((entry) => (typeof entry === "string" ? entry : entry?.id) === mutation[1]);
        if (body.active && index < 0) list.push({ id: mutation[1], "anime-title": body["anime-title"], "anime-thumbnail": body["anime-thumbnail"] });
        if (!body.active && index >= 0) list.splice(index, 1);
        return route.fulfill({ headers, json: { ok: true, data: {
          [mutation[2] === "like" ? "liked" : "saved"]: body.active,
          [field]: list,
        } } });
      }
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();

    const animeCard = page.locator(".video-card--anime").filter({ hasText: A_ANIME_TITLE }).first();
    await animeCard.waitFor();
    const like = animeCard.getByRole("button", { name: "Like anime" });
    const save = animeCard.getByRole("button", { name: "Save anime" });
    await like.waitFor();
    await save.waitFor();
    assert.equal(await like.getAttribute("aria-pressed"), "false");

    // A guest gets the account screen, not a silent failure.
    await like.click();
    await page.getByRole("heading", { name: /Sign in|Continue with|Welcome/i }).first().waitFor();
    assert.equal(mutations.length, 0, "nothing is written without an account");
    await page.goBack();
    await page.getByRole("heading", { name: "All Videos" }).waitFor();

    // Sign in and finish the profile the way the site does.
    await page.evaluate(() => localStorage.setItem("fixture-firebase-user", "yes"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "All Videos" }).waitFor();
    await page.goto(`${base}/profile`);
    await page.getByLabel("Name", { exact: true }).fill("Viewer Name");
    await page.getByLabel("Username").fill("viewer");
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.getByRole("button", { name: /Skip for now/ }).click();
    await page.getByRole("region", { name: "Your dashboard" }).waitFor();

    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "All Videos" }).waitFor();
    const card = page.locator(".video-card--anime").filter({ hasText: A_ANIME_TITLE }).first();
    await card.getByRole("button", { name: "Like anime" }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Unlike anime"]') !== null);

    // One write, on the documented route, with the account's own id and metadata.
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0], { id: A_ANIME, action: "like", body: {
      active: true, "anime-title": A_ANIME_TITLE, "anime-thumbnail": A_ANIME_POSTER,
    } });
    assert.equal(user.likedVideos.length, 1, "the title is stored in the account's own list");

    // Saved the same way, and both cards read as pressed.
    await card.getByRole("button", { name: "Save anime" }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Remove saved anime"]') !== null);
    assert.deepEqual(mutations.map((mutation) => mutation.action), ["like", "save"]);
    assert.equal(mutations[1].id, A_ANIME);
    assert.equal(user.savedVideos.length, 1);

    // The dashboard draws both lists from the stored entries: the title, its
    // poster, and no request to the anime source for them.
    const before = calls.filter((call) => call.path.startsWith("/api/hen/")).length;
    await page.goto(`${base}/dashboard`);
    const liked = page.getByRole("region", { name: "Liked videos" });
    const saved = page.getByRole("region", { name: "Saved videos" });
    await liked.waitFor();
    await liked.getByText(A_ANIME_TITLE).waitFor();
    await saved.getByText(A_ANIME_TITLE).waitFor();
    assert.match(await liked.locator(".video-card--anime img").first().getAttribute("src"), /cdn1\.images\.hentaicity\.com/);
    assert.equal(await liked.getByText(/Liked videos are currently unavailable/).count(), 0, "an anime entry is not a missing catalogue video");
    assert.equal(calls.filter((call) => call.path.startsWith("/api/hen/")).length, before, "the dashboard draws the stored entry, it does not ask the source");

    // Un-liking removes it again, through the same route.
    await liked.getByRole("button", { name: "Unlike anime" }).click();
    await liked.getByText("No liked videos yet.").waitFor();
    assert.equal(user.likedVideos.length, 0);
    assert.deepEqual(fixtureErrors(errors), []);
  } finally {
    await browser?.close();
    await vite.close();
  }
});

function fixtureErrors(errors) {
  // A blocked poster on the anime source is not a page error; only real script
  // failures count.
  return errors.filter((message) => !/favicon|ERR_BLOCKED_BY_CLIENT/i.test(message));
}
