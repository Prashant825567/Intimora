import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build, createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const discovery = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const backend = "https://api-intimora.vercel.app";
const campaign = "https://hdzog.com/embed/71011?source=1849513610";
const guestIdentity = `
export function watchFirebaseUser(listener) { queueMicrotask(() => listener(null)); return () => {}; }
export async function signInWithGoogle() {}
export async function signOutGoogle() {}
`;

function identityPlugin() {
  return {
    name: "partner-embed-test-identity", enforce: "pre",
    resolveId(id) { if (id === "../services/firebase") return "\0partner-embed-test-identity"; },
    load(id) { if (id === "\0partner-embed-test-identity") return guestIdentity; },
  };
}

const { DEFAULT_PARTNER_EMBED_URL, PARTNER_EMBED_HOSTS, partnerEmbedUrl } = await import("../src/services/partner-embed.mjs");

test("only documented TubeCorporate hosts are accepted and the campaign source is mandatory", () => {
  assert.equal(DEFAULT_PARTNER_EMBED_URL, campaign);
  assert.equal(partnerEmbedUrl(campaign), campaign);
  assert.equal(
    partnerEmbedUrl("https://hdzog.com/embed/71011?source=1849513610&utm_x=1"),
    "https://hdzog.com/embed/71011?source=1849513610&utm_x=1",
  );
  // A campaign feed URL may use any safe path; the mandatory source is added.
  assert.equal(partnerEmbedUrl("https://hdzog.com/feed/12345"), "https://hdzog.com/feed/12345?source=1849513610");
  assert.equal(partnerEmbedUrl("https://tubecorporate.com/feed/9?source=555"), "https://tubecorporate.com/feed/9?source=555");
  assert.equal(partnerEmbedUrl("https://www.hdzog.com/embed/71011"), "https://www.hdzog.com/embed/71011?source=1849513610");
  assert.equal(partnerEmbedUrl(" https://hdzog.com/embed/71011?source=1849513610"), null, "no surrounding whitespace");
  assert.equal(partnerEmbedUrl("http://hdzog.com/embed/71011?source=1849513610"), null, "HTTPS only");
  assert.equal(partnerEmbedUrl("https://user:pass@hdzog.com/embed/71011?source=1849513610"), null, "no credentials");
  assert.equal(partnerEmbedUrl("https://evil.example/embed/71011?source=1849513610"), null, "unknown host");
  assert.equal(partnerEmbedUrl("https://hdzog.com.evil.example/embed/71011?source=1849513610"), null, "suffix look-alike host");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/71011?source=abc"), null, "numeric source only");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/71011?source=1849513610#fragment"), null, "no fragment");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/71011?source=1849513610&next=javascript:alert(1)"), null, "unsafe parameter value");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/embed/71011?source=${"9".repeat(21)}`), null, "bounded source");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/${"a".repeat(220)}`), null, "bounded feed path");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/feed/1?source=${"9".repeat(21)}`), null, "bounded source on a feed");
  assert.equal(partnerEmbedUrl(""), null);
  assert.equal(partnerEmbedUrl(undefined), null);
});

test("the pasted campaign URL in src/config/partner-embed.ts is valid whenever it is set", async () => {
  const configFile = await readFile(path.join(root, "src/config/partner-embed.ts"), "utf8");
  const pasted = configFile.match(/export const PARTNER_EMBED_URL\s*=\s*"([^"]*)"/)?.[1];
  assert.equal(typeof pasted, "string", "the config file keeps a single editable URL string");
  if (pasted) {
    assert.ok(partnerEmbedUrl(pasted), `the pasted partner URL is accepted: ${pasted}`);
  }
  assert.match(configFile, /hdzog\.com/, "the file names the accepted partner host");
  assert.equal(DEFAULT_PARTNER_EMBED_URL, campaign, "the built-in campaign remains the fallback");
});

test("a feed URL pasted through the build variable also receives the campaign source", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-partner-feed-"));
  try {
    process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL = "https://hdzog.com/feed/12345";
    await build({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
    });
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundled = html.match(/assets\/(index-[^"]+\.js)/)?.[1];
    const asset = await readFile(path.join(output, "assets", bundled), "utf8");
    assert.ok(asset.includes(campaign.replace("/embed/71011", "/feed/12345")), "the feed URL keeps the campaign source");
  } finally {
    delete process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL;
    await rm(output, { recursive: true, force: true });
  }
});

test("the build embeds the validated campaign URL and rejects an invalid override", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-partner-build-"));
  try {
    await build({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
    });
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundled = html.match(/assets\/(index-[^"]+\.js)/)?.[1];
    assert.ok(bundled, "the build references its JavaScript bundle");
    const assets = await readFile(path.join(output, "assets", bundled), "utf8");
    assert.ok(assets.includes(campaign), "the campaign iframe URL is bundled");

    process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL = "https://evil.example/embed/71011?source=1849513610";
    let error;
    try {
      await build({
        configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
        build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
      });
    } catch (caught) { error = caught; }
    assert.ok(error, "an untrusted embed host fails the build");
    assert.match(`${error.message}`, /Invalid partner embed URL/);
  } finally {
    delete process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL;
    await rm(output, { recursive: true, force: true });
  }
});

test("the sponsored iframe appears only after the age gate and uses the campaign URL", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 90_000,
}, async () => {
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [identityPlugin()],
  });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const response = await fetch(`${base}/`);
    assert.match(response.headers.get("content-security-policy") || "", /frame-src[^;]*https:\/\/hdzog\.com/, "the partner frame is allowed by the CSP");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", "partner frames never receive a referrer");

    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const partnerRequests = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
      if (url.hostname.endsWith("hdzog.com")) {
        partnerRequests.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Partner fixture</title>" });
      }
      if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
      if (url.origin !== backend) return route.continue();
      if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [], nextCursor: null } } });
      return route.fulfill({ status: 404, headers, json: { ok: false } });
    });

    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0, "no third-party frame before age confirmation");
    assert.deepEqual(partnerRequests, [], "the partner is not contacted before age confirmation");

    await page.getByRole("button", { name: /I AM 18/i }).click();
    const frame = page.locator('iframe[title="Sponsored partner videos"]');
    await frame.waitFor();
    assert.equal(await frame.getAttribute("src"), campaign);
    assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(await frame.getAttribute("loading"), "lazy");
    assert.match(await page.locator("section[aria-label='Sponsored partner videos']").innerText(), /SPONSORED/i);
    await page.locator("section[aria-label='Sponsored partner videos']").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("iframe[title='Sponsored partner videos']") !== null);
    assert.ok(partnerRequests.every((href) => href.startsWith("https://hdzog.com/embed/")), "only the campaign embed is requested");

    // The embed stays on browse pages but not inside account pages or search results.
    await page.goto(`${base}/trending`, { waitUntil: "domcontentloaded" });
    await frame.waitFor();
    await page.goto(`${base}/search?q=test`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Search results for/ }).waitFor();
    assert.equal(await page.locator("iframe[title='Sponsored partner videos']").count(), 0, "no partner frame over search results");
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.equal(await page.locator("iframe[title='Sponsored partner videos']").count(), 0, "no partner frame on account pages");
    await context.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});
