import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createAppServer } from "../server/index.mjs";
import { buildSitemap, readPublicJson, renderSitemap, SITE_ORIGIN } from "../scripts/sitemap.mjs";
import { sitemapPlugin } from "../scripts/sitemap-plugin.mjs";
import { requestSitemapRefresh } from "../scripts/request-sitemap-refresh.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const discoveryUrl = "https://discovery.example/api/get-server";
const backend = "https://catalog.example";
const selection = { ok: true, data: { server: backend } };
const locs = (xml) => Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);

function sitemapRequest(pages, calls = []) {
  return async (url, timeoutMs) => {
    calls.push(url.href);
    assert.ok(timeoutMs > 0 && timeoutMs <= 10_000);
    if (url.href === discoveryUrl) return selection;
    assert.equal(url.origin, backend);
    assert.equal(url.pathname, "/api/videos");
    assert.equal(url.searchParams.get("limit"), "50");
    return pages[url.searchParams.get("cursor") ?? "first"];
  };
}

test("robots advertises the valid checked-in sitemap snapshot", async () => {
  const robots = await readFile(path.join(root, "public/robots.txt"), "utf8");
  const fallback = await readFile(path.join(root, "public/sitemap.xml"), "utf8");
  assert.match(robots, /(?:^|\n)Sitemap:\s*https:\/\/intimora\.new\.tg\/sitemap\.xml\s*(?:\n|$)/i);
  assert.match(fallback, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const urls = locs(fallback);
  assert.equal(urls[0], `${SITE_ORIGIN}/`);
  assert.equal(new Set(urls).size, urls.length);
  for (const url of urls.slice(1)) assert.match(url, /^https:\/\/intimora\.new\.tg\/watch\/[A-Za-z0-9_-]{1,128}$/);
  assert.equal(fallback, renderSitemap(urls.slice(1).map((url) => url.split("/").at(-1))));
});

test("a sitemap includes the full public catalog once, safely, across overlapping cursor pages", async () => {
  const calls = [];
  const pages = {
    first: { ok: true, data: { videos: [
      { id: "normal", title: "Don't include title or backend URL" },
      { id: "exclusive-1", exclusive: true },
      { id: "../unsafe" },
      { id: '</loc><loc>https://bad.example/</loc>' },
    ], nextCursor: 777 } },
    777: { ok: true, data: { videos: [{ id: "exclusive-1" }, { id: "third_3" }], nextCursor: 666 } },
    666: { ok: true, data: { videos: [{ id: "third_3" }], nextCursor: 666 } },
  };
  const result = await buildSitemap({ discoveryUrl, requestJson: sitemapRequest(pages, calls) });
  assert.deepEqual({ complete: result.complete, videoCount: result.videoCount, pages: result.pages }, { complete: true, videoCount: 3, pages: 3 });
  assert.deepEqual(locs(result.xml), [
    `${SITE_ORIGIN}/`, `${SITE_ORIGIN}/watch/normal`, `${SITE_ORIGIN}/watch/exclusive-1`, `${SITE_ORIGIN}/watch/third_3`,
  ]);
  assert.equal(calls.filter((url) => url === discoveryUrl).length, 1);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(result.xml, /catalog\.example|bad\.example|title|unsafe/i);
  assert.equal(renderSitemap(["same", "same", "bad/route"]), renderSitemap(["same"]));
});

test("ambiguous, failed, oversized and capped scans collect only known URLs and report incomplete", async () => {
  const full = Array.from({ length: 50 }, (_, index) => ({ id: `item-${index}` }));
  const repeated = { ok: true, data: { videos: full, nextCursor: 2 } };
  const ambiguous = await buildSitemap({ discoveryUrl, requestJson: sitemapRequest({ first: repeated, 2: repeated }) });
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.pages, 2);
  assert.equal(ambiguous.videoCount, 50);

  const calls = [];
  const capped = await buildSitemap({ discoveryUrl, maxPages: 1, requestJson: sitemapRequest({ first: repeated }, calls) });
  assert.equal(capped.complete, false);
  assert.equal(capped.pages, 1);
  assert.equal(calls.length, 2);

  const first = { ok: true, data: { videos: [{ id: "kept" }], nextCursor: 9 } };
  const partial = await buildSitemap({ discoveryUrl, requestJson: async (url) => {
    if (url.href === discoveryUrl) return selection;
    if (!url.searchParams.has("cursor")) return first;
    throw new Error("private network detail secret-marker");
  } });
  assert.equal(partial.complete, false);
  assert.deepEqual(locs(partial.xml), [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/watch/kept`]);
  assert.doesNotMatch(partial.xml, /private|secret-marker/);

  const invalid = await buildSitemap({ discoveryUrl, requestJson: sitemapRequest({
    first: { ok: true, data: { videos: [...full, { id: "too-many" }], nextCursor: null } },
  }) });
  assert.equal(invalid.complete, false);
  assert.equal(invalid.videoCount, 0);
  const empty = await buildSitemap({ discoveryUrl, requestJson: sitemapRequest({
    first: { ok: true, data: { videos: [], nextCursor: null } },
  }) });
  assert.equal(empty.complete, true);
  assert.equal(empty.xml, renderSitemap([]));
});

test("sitemap generation rejects private targets, unsafe selections and expired deadlines without exposing them", async () => {
  for (const selected of [
    "http://public.example", "https://127.0.0.1", "https://10.0.0.1", "https://localhost",
    "https://api.example:8443", "https://user:secret-marker@api.example", "https://api.example/?token=secret-marker",
  ]) {
    const calls = [];
    const result = await buildSitemap({ discoveryUrl, requestJson: async (url) => {
      calls.push(url.href);
      return { ok: true, data: { server: selected } };
    } });
    assert.equal(result.complete, false, "unsafe backend must not yield a complete sitemap");
    assert.equal(calls.length, 1, "unsafe selection must never be requested");
    assert.equal(result.xml, renderSitemap([]));
    assert.doesNotMatch(result.xml, /secret-marker/);
  }
  await assert.rejects(readPublicJson(new URL("https://127.0.0.1/secret-marker")), (error) => {
    assert.equal(error.message, "Sitemap catalog unavailable");
    return true;
  });
  let tick = 0;
  const calls = [];
  const expired = await buildSitemap({ discoveryUrl, now: () => tick++ < 2 ? 0 : 60_001, requestJson: async (url) => {
    calls.push(url.href);
    return selection;
  } });
  assert.equal(expired.complete, false);
  assert.equal(calls.length, 1);
});

test("a real Vite static build publishes generated XML and robots with crawler-friendly content types", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-sitemap-"));
  let server;
  try {
    await mkdir(path.join(directory, "public"));
    await copyFile(path.join(root, "public/robots.txt"), path.join(directory, "public/robots.txt"));
    await copyFile(path.join(root, "public/sitemap.xml"), path.join(directory, "public/sitemap.xml"));
    await writeFile(path.join(directory, "index.html"), "<!doctype html><html><head><title>Test</title></head><body></body></html>");
    const pages = { first: { ok: true, data: { videos: [{ id: "one" }, { id: "two", exclusive: true }], nextCursor: null } } };
    await build({
      configFile: false,
      root: directory,
      logLevel: "silent",
      build: { outDir: "dist" },
      plugins: [sitemapPlugin({ discoveryUrl, generate: (options) => buildSitemap({ ...options, requestJson: sitemapRequest(pages) }) })],
    });
    server = createAppServer({ distDir: path.join(directory, "dist") });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "User-Agent": "Googlebot" };
    const response = await fetch(`${base}/sitemap.xml`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/xml/i);
    assert.deepEqual(locs(await response.text()), [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/watch/one`, `${SITE_ORIGIN}/watch/two`]);
    const head = await fetch(`${base}/sitemap.xml`, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const robots = await fetch(`${base}/robots.txt`, { headers });
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Sitemap:\s*https:\/\/intimora\.new\.tg\/sitemap\.xml/i);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("build plugin preserves the snapshot on incomplete scans and unexpected errors without leaking details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-sitemap-fallback-"));
  try {
    const snapshot = await readFile(path.join(root, "public/sitemap.xml"), "utf8");
    await writeFile(path.join(directory, "sitemap.xml"), snapshot);
    const warnings = [];
    for (const generate of [
      async () => ({ xml: renderSitemap(["partial"]), videoCount: 1, pages: 1, complete: false }),
      async () => { throw new Error("https://private.example/secret-marker"); },
    ]) {
      const plugin = sitemapPlugin({ discoveryUrl, generate });
      await plugin.writeBundle.call({ warn: (message) => warnings.push(message) }, { dir: directory });
      assert.equal(await readFile(path.join(directory, "sitemap.xml"), "utf8"), snapshot);
    }
    assert.equal(warnings.length, 2);
    assert.doesNotMatch(warnings.join(" "), /https?:|secret-marker|private/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional daily refresh skips without a secret and restricts and redacts deploy-hook requests", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/refresh-sitemap.yml"), "utf8");
  assert.match(workflow, /cron:\s*"17 2 \* \* \*"/);
  assert.match(workflow, /secrets\.INTIMORA_SITEMAP_DEPLOY_HOOK_URL/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
  let calls = 0;
  const fetcher = async (url, init) => {
    calls += 1;
    assert.equal(url.hostname, "api.render.com");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    return { ok: true };
  };
  assert.equal(await requestSitemapRefresh("", fetcher), "skipped");
  assert.equal(calls, 0);
  assert.equal(await requestSitemapRefresh("https://api.render.com/deploy/srv-abc123?key=secret-marker", fetcher), "requested");
  assert.equal(calls, 1);
  for (const url of [
    "http://api.render.com/deploy/srv-abc123?key=secret-marker",
    "https://api.render.com.evil.example/deploy/srv-abc123?key=secret-marker",
    "https://user:secret-marker@api.render.com/deploy/srv-abc123?key=x",
    "https://api.render.com/deploy/srv-abc123?key=secret-marker&ref=branch",
  ]) {
    await assert.rejects(requestSitemapRefresh(url, fetcher), (error) => {
      assert.equal(error.message, "Unable to request sitemap refresh. Check the deploy hook configuration.");
      return true;
    });
  }
  assert.equal(calls, 1);
  await assert.rejects(requestSitemapRefresh("https://api.render.com/deploy/srv-abc123?key=secret-marker", async () => {
    throw new Error("https://private.example/secret-marker");
  }), /Unable to request sitemap refresh/);
});
