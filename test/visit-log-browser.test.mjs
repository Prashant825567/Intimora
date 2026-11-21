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

const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "visit-log-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0visit-log-test-identity"; },
    load(id) { if (id === "\0visit-log-test-identity") return guestIdentity; },
  };
}

async function availablePort() {
  const socket = createNetServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("the visitor log posts once per session, only after the age gate, and survives a reload", {
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
    const visits = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // The anime API is a real host; tests never call it.
      if (url.hostname === "pacahub-34nd.onrender.com") return route.abort();
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (url.pathname === "/api/visit") {
        visits.push({ method: request.method(), contentType: request.headers()["content-type"], body: request.postData() });
        return route.fulfill({ headers, json: { ok: true, data: { logged: true } } });
      }
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [], nextCursor: null } } });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.equal(visits.length, 0, "nothing is logged before the 18+ gate");

    const logged = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/visit"));
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await logged;
    await page.locator(".site-nav").waitFor();
    await page.waitForTimeout(300);

    assert.equal(visits.length, 1, "exactly one visit row for the session");
    assert.equal(visits[0].method, "POST");
    assert.match(visits[0].contentType, /^text\/plain/i, "a simple content type keeps it out of the preflight path");
    const payload = JSON.parse(visits[0].body);
    assert.ok(payload.ua && payload.ua.length > 10, "the user agent travels with the row");
    assert.equal(payload.path, "/", "the page path travels with the row");
    assert.match(payload.screen, /^\d+x\d+$/);
    assert.equal(typeof payload.lang, "string");
    assert.equal(typeof payload.tz, "string");
    assert.ok(!("password" in payload), "no credentials are collected");

    const response = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.locator(".site-nav").waitFor();
    await page.waitForTimeout(1_500);
    assert.equal(visits.length, 1, "a reload in the same tab is the same session");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
  }
});
