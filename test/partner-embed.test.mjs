import "./fixtures/ads-off.mjs";
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
const campaign = "https://hdzog.com/embed/2168747?source=1849513610";
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

const { DEFAULT_PARTNER_EMBED_URL, PARTNER_EMBED_HOSTS, PARTNER_FEED_HOSTS, partnerEmbedUrl, partnerFeedUrl, partnerSource } = await import("../src/services/partner-embed.mjs");

test("only documented TubeCorporate hosts are accepted and the campaign source is mandatory", () => {
  assert.equal(DEFAULT_PARTNER_EMBED_URL, campaign);
  assert.equal(partnerEmbedUrl(campaign), campaign);
  assert.equal(
    partnerEmbedUrl("https://hdzog.com/embed/2168747?source=1849513610&utm_x=1"),
    "https://hdzog.com/embed/2168747?source=1849513610&utm_x=1",
  );
  // A campaign feed URL may use any safe path; the mandatory source is added.
  assert.equal(partnerEmbedUrl("https://hdzog.com/feed/12345"), "https://hdzog.com/feed/12345?source=1849513610");
  assert.equal(partnerEmbedUrl("https://tubecorporate.com/feed/9?source=555"), "https://tubecorporate.com/feed/9?source=555");
  assert.equal(partnerEmbedUrl("https://www.hdzog.com/embed/2168747"), "https://www.hdzog.com/embed/2168747?source=1849513610");
  assert.equal(partnerEmbedUrl(" https://hdzog.com/embed/2168747?source=1849513610"), null, "no surrounding whitespace");
  assert.equal(partnerEmbedUrl("http://hdzog.com/embed/2168747?source=1849513610"), null, "HTTPS only");
  assert.equal(partnerEmbedUrl("https://user:pass@hdzog.com/embed/2168747?source=1849513610"), null, "no credentials");
  assert.equal(partnerEmbedUrl("https://evil.example/embed/2168747?source=1849513610"), null, "unknown host");
  assert.equal(partnerEmbedUrl("https://hdzog.com.evil.example/embed/2168747?source=1849513610"), null, "suffix look-alike host");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/2168747?source=abc"), null, "numeric source only");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/2168747?source=1849513610#fragment"), null, "no fragment");
  assert.equal(partnerEmbedUrl("https://hdzog.com/embed/2168747?source=1849513610&next=javascript:alert(1)"), null, "unsafe parameter value");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/embed/2168747?source=${"9".repeat(21)}`), null, "bounded source");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/${"a".repeat(220)}`), null, "bounded feed path");
  assert.equal(partnerEmbedUrl(`https://hdzog.com/feed/1?source=${"9".repeat(21)}`), null, "bounded source on a feed");
  assert.equal(partnerEmbedUrl(""), null);
  assert.equal(partnerEmbedUrl(undefined), null);
});

test("a campaign feed is accepted only on the feed host and only in the feed shape", () => {
  const feed = "https://desiporn.tube/admin/feeds/embed/?categories=Indian%2CMILF&source=1849513610&feed_format=csv&tag=girls&csv_separator=%7C";
  assert.equal(partnerFeedUrl(feed), feed);
  assert.deepEqual(partnerSource(feed), { mode: "feed", url: feed });
  // The redirected twin host and the .com embed host are accepted as well.
  assert.equal(partnerFeedUrl(feed.replace("desiporn.tube", "desi-porn.tube")), feed.replace("desiporn.tube", "desi-porn.tube"));
  assert.equal(partnerFeedUrl("https://desi-porntube.com/embed/764349/"), null, "a single video page is not a feed");
  assert.equal(partnerFeedUrl("https://hdzog.com/admin/feeds/embed/?feed_format=csv"), null, "unknown feed host");
  assert.equal(partnerFeedUrl(feed.replace("https://", "http://")), null, "HTTPS only");
  assert.equal(partnerFeedUrl("https://user:pass@desiporn.tube/admin/feeds/embed/?feed_format=csv"), null, "no credentials");
  assert.equal(partnerFeedUrl(`${feed}#fragment`), null, "no fragment");
  assert.equal(partnerFeedUrl("https://desiporn.tube/admin/feeds/embed/"), null, "a feed URL needs its query");
  assert.equal(partnerFeedUrl(`https://desiporn.tube/admin/feeds/embed/?feed_format=csv&x=${"9".repeat(1700)}`), null, "bounded query");
  assert.equal(partnerFeedUrl(""), null);
  assert.equal(partnerSource("https://evil.example/admin/feeds/embed/?feed_format=csv"), null);
  assert.deepEqual(partnerSource(campaign), { mode: "embed", url: campaign });
  assert.deepEqual(PARTNER_FEED_HOSTS, ["desiporn.tube", "desi-porn.tube", "desi-porntube.com"]);
  assert.ok(PARTNER_EMBED_HOSTS.includes("desi-porntube.com"), "the feed embeds point at the .com host");
});

test("the pasted campaign URL in src/config/partner-embed.ts is valid whenever it is set", async () => {
  const configFile = await readFile(path.join(root, "src/config/partner-embed.ts"), "utf8");
  const pasted = configFile.match(/export const PARTNER_EMBED_URL\s*=\s*"([^"]*)"/)?.[1];
  assert.equal(typeof pasted, "string", "the config file keeps a single editable URL string");
  if (pasted) {
    const source = partnerSource(pasted);
    assert.ok(source, `the pasted partner URL is accepted: ${pasted.slice(0, 120)}`);
    if (source.mode === "feed") assert.match(source.url, /feed_format=csv|\/feeds?\//i, "a feed URL keeps its feed shape");
    else assert.match(source.url, /\/embed\//, "an embed URL points at a video page");
  }
  assert.match(configFile, /hdzog\.com/, "the file documents the accepted partner host");
  assert.equal(DEFAULT_PARTNER_EMBED_URL, campaign, "the built-in campaign remains the fallback");
  assert.equal(pasted, "https://desiporn.tube/admin/feeds/embed/?" + pasted.split("?")[1], "the TubeCorporate feed stays pasted in the config file");
});

test("a single embed page pasted through the build variable also receives the campaign source", async () => {
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
    assert.ok(asset.includes(campaign.replace("/embed/2168747", "/feed/12345")), "the embed URL keeps the campaign source");
  } finally {
    delete process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL;
    await rm(output, { recursive: true, force: true });
  }
});

test("the build embeds the validated campaign URL and rejects an invalid override", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-partner-build-"));
  try {
    process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL = campaign;
    await build({
      configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
    });
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundled = html.match(/assets\/(index-[^"]+\.js)/)?.[1];
    assert.ok(bundled, "the build references its JavaScript bundle");
    const assets = await readFile(path.join(output, "assets", bundled), "utf8");
    assert.ok(assets.includes(campaign), "the campaign iframe URL is bundled");

    process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL = "https://evil.example/embed/2168747?source=1849513610";
    let error;
    try {
      await build({
        configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
        build: { outDir: output, emptyOutDir: true }, plugins: [identityPlugin()],
      });
    } catch (caught) { error = caught; }
    assert.ok(error, "an untrusted embed host fails the build");
    assert.match(`${error.message}`, /Invalid partner URL/);
  } finally {
    delete process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL;
    await rm(output, { recursive: true, force: true });
  }
});

const feedEmbeds = [
  "https://desi-porntube.com/embed/764349/?source=1849513610",
  "https://desi-porntube.com/embed/762647/?source=1849513610",
  "https://desi-porntube.com/embed/762419/?source=1849513610",
];

// Every request the page makes, so the test can prove the feed is read only
// after the age gate and that no third party is contacted before it.
async function stubNetwork(context, { feed = false } = {}) {
  const calls = { feed: [], frames: [] };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
    if (url.pathname === "/partner-feed.json") {
      calls.feed.push(url.href);
      if (!feed) return route.fulfill({ status: 404, headers, json: { items: [] } });
      return route.fulfill({ headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ items: feedEmbeds }) });
    }
    if (url.hostname.endsWith("desi-porntube.com") || url.hostname.endsWith("hdzog.com")) {
      calls.frames.push(url.href);
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Partner fixture</title>" });
    }
    if (request.url() === discovery) return route.fulfill({ headers, json: { ok: true, data: { server: backend } } });
    if (url.origin !== backend) return route.continue();
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") return route.fulfill({ headers, json: { ok: true, data: { videos: [], nextCursor: null } } });
    return route.fulfill({ status: 404, headers, json: { ok: false } });
  });
  return calls;
}

test("the campaign feed becomes sponsored cards in the grid, only after the age gate", {
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
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-src[^;]*https:\/\/desi-porntube\.com/, "the sponsored player frames are allowed by the CSP");
    assert.match(csp, /frame-src[^;]*https:\/\/hdzog\.com/, "a single embed page stays allowed");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", "partner frames never receive a referrer");

    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const calls = { feed: [], frames: [] };
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Range" };
      if (url.pathname === "/partner-feed.json") {
        calls.feed.push(url.href);
        return route.fulfill({ headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 2, items: feedEmbeds.map((embedUrl, index) => ({ embedUrl, title: `Partner ${index + 1}`, thumbnail: null })) }) });
      }
      if (url.hostname.endsWith("desi-porntube.com") || url.hostname.endsWith("hdzog.com")) {
        calls.frames.push(url.href);
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
    assert.equal(await page.locator(".video-card--sponsored").count(), 0, "no sponsored card before age confirmation");
    assert.deepEqual(calls, { feed: [], frames: [] }, "the campaign is not contacted before age confirmation");

    await page.getByRole("button", { name: /I AM 18/i }).click();
    // The feed now feeds cards inside the grids, not a panel under the page.
    await page.waitForFunction(() => fetch("/partner-feed.json").then(() => true), undefined, { timeout: 10_000 });
    assert.ok(calls.feed.length >= 1, "the feed is read from our own origin after the age gate");
    assert.equal(await page.locator("section[aria-label='Sponsored partner videos']").count(), 0, "the old bottom panel is gone");
    assert.deepEqual(calls.frames, [], "no partner player is opened until a sponsored card is clicked");

    // Nothing sponsored inside account pages or search results.
    await page.goto(`${base}/search?q=test`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Search results for/ }).waitFor();
    assert.equal(await page.locator(".video-card--sponsored").count(), 0, "no sponsored cards over search results");
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Sign in to your account" }).waitFor();
    assert.equal(await page.locator(".video-card--sponsored").count(), 0, "no sponsored cards on account pages");
    await context.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});

test("a single embed page pasted into the config is framed directly", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 90_000,
}, async () => {
  process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL = campaign;
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [identityPlugin()],
  });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const calls = await stubNetwork(context);
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /I AM 18/i }).click();
    const frame = page.locator('iframe[title="Sponsored partner videos"]');
    await frame.waitFor();
    assert.equal(await frame.getAttribute("src"), campaign);
    assert.equal(await frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(await frame.getAttribute("loading"), "lazy");
    assert.deepEqual(calls.feed, [], "an embed page never asks for the feed");
    await context.close();
  } finally {
    delete process.env.INTIMORA_PUBLIC_PARTNER_EMBED_URL;
    await browser?.close();
    await vite.close();
  }
});
