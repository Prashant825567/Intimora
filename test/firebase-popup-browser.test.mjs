import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { createAppServer } from "../server/index.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();

// The real Firebase adapter and production CSP are exercised. Google's loader,
// iframe and provider handler are replaced with harmless fixtures; no account
// credentials or external sign-in are involved in this test.
const gapiFixture = `
  const callbackName = new URL(document.currentScript.src).searchParams.get('onload');
  const frame = {
    restyle: async () => {},
    ping: callback => { callback(); return Promise.resolve(); },
    register: () => {},
    send: (_key, _data, callback) => setTimeout(() => { try { callback([{webStorageSupport: true}]); } catch {} }, 0),
  };
  window.gapi = {
    iframes: {
      Iframe: function () {}, CROSS_ORIGIN_IFRAMES_FILTER: () => true,
      getContext: () => ({ open(options, callback) {
        const element = document.createElement('iframe');
        element.style.display = 'none';
        element.src = options.url;
        options.where.appendChild(element);
        return callback(frame);
      } }),
    },
    load: (_name, options) => options.callback(),
  };
  window[callbackName]();
`;

test("production Firebase SDK opens a Google chooser popup under the scoped CSP", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-firebase-popup-"));
  let server;
  let browser;
  try {
    await run("npm", ["run", "build", "--", "--outDir", directory], { cwd: root, timeout: 120_000 });
    server = createAppServer({ distDir: directory });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext();
    const seen = { script: false, iframe: false, handler: false, provider: "", prompt: "" };
    await context.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.__cspViolations.push(event.violatedDirective));
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
      if (url.hostname === "intimora.tmc78lxnu.workers.dev") return route.fulfill({ headers: cors, json: { ok: true, data: { server: "https://api-intimora.vercel.app" } } });
      if (url.hostname === "api-intimora.vercel.app") return route.fulfill({ headers: cors, json: { ok: true, data: { videos: [], nextCursor: null } } });
      if (url.hostname === "apis.google.com" && url.pathname === "/js/api.js") {
        seen.script = true;
        return route.fulfill({ contentType: "application/javascript", body: gapiFixture });
      }
      if (url.hostname === "intimora-app.firebaseapp.com" && url.pathname === "/__/auth/iframe") {
        seen.iframe = true;
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Test auth frame</title>" });
      }
      if (url.hostname === "intimora-app.firebaseapp.com" && url.pathname === "/__/auth/handler") {
        seen.handler = true;
        seen.provider = url.searchParams.get("providerId");
        try { seen.prompt = JSON.parse(url.searchParams.get("customParameters")).prompt; } catch { /* assertion below */ }
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Test sign-in popup</title>" });
      }
      if (url.hostname === "identitytoolkit.googleapis.com") return route.fulfill({ headers: cors, json: { authorizedDomains: ["127.0.0.1"] } });
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.equal(seen.script || seen.iframe || seen.handler, false, "Firebase sign-in helpers are not initialized before the age gate");
    await page.getByRole("button", { name: /I AM 18/i }).click();
    await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
    const opening = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    const popup = await opening;
    await popup.waitForLoadState();
    assert.equal(seen.script, true, "the allowed Google API loader was requested");
    assert.equal(seen.iframe, true, "the allowed Firebase auth frame was requested");
    assert.equal(seen.handler, true, "Firebase opened its auth handler");
    assert.equal(seen.provider, "google.com");
    assert.equal(seen.prompt, "select_account");
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
