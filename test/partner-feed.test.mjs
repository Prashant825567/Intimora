import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enrichPartnerItems, partnerFeedPlugin, requestPartnerFeed } from "../scripts/partner-feed-plugin.mjs";
import { decodeHtmlEntities, parseEmbedPreview, parsePartnerFeed, partnerFeedPayload } from "../src/services/partner-feed.mjs";

const embedA = "https://desi-porntube.com/embed/764349/?source=1849513610";
const embedB = "https://desi-porntube.com/embed/762647/?source=1849513610";

const feedFixture = `Embed code
<iframe width="640" height="360" src="${embedA}" frameborder="0" allowfullscreen></iframe>
<iframe width="640" height="360" src='${embedB}' frameborder="0" allowfullscreen></iframe>
<iframe width="640" height="360" src="${embedA}" frameborder="0" allowfullscreen></iframe>
<iframe width="640" height="360" src="https://evil.example/embed/1/?source=1849513610"></iframe>
<iframe width="640" height="360" src="http://desi-porntube.com/embed/1/?source=1849513610"></iframe>
<iframe width="640" height="360" src="https://desi-porntube.com/embed/9/?source=abc"></iframe>
<iframe width="640" height="360" src="https://desi-porntube.com/track/?source=1849513610"></iframe>
<iframe width="640" height="360" src="javascript:alert(1)"></iframe>
`;

test("a campaign feed yields only validated, unique partner embeds", () => {
  assert.deepEqual(parsePartnerFeed(feedFixture), [embedA, embedB]);
  assert.deepEqual(parsePartnerFeed(feedFixture, { limit: 1 }), [embedA], "the list is capped");
  assert.deepEqual(parsePartnerFeed(feedFixture, { limit: 500 }), [embedA, embedB], "the cap stays bounded");
  assert.deepEqual(parsePartnerFeed("Embed code\nno iframes here"), []);
  assert.deepEqual(parsePartnerFeed(""), []);
  assert.deepEqual(parsePartnerFeed(undefined), []);
  assert.deepEqual(parsePartnerFeed(null), []);
});

test("feed iframes are decoded before they are validated", () => {
  const encoded = '<iframe src="https://desi-porntube.com/embed/764349/?source=1849513610&amp;utm_x=1"></iframe>';
  assert.deepEqual(parsePartnerFeed(encoded), ["https://desi-porntube.com/embed/764349/?source=1849513610&utm_x=1"]);
  assert.equal(decodeHtmlEntities("a&amp;b&quot;c"), 'a&b"c');
  assert.equal(decodeHtmlEntities("plain"), "plain");
  assert.equal(decodeHtmlEntities(undefined), "");
});

test("the published payload is same-origin JSON with a bounded list", () => {
  const payload = partnerFeedPayload([embedA, embedB, 42, null]);
  assert.deepEqual(JSON.parse(payload), {
    version: 2,
    items: [
      { embedUrl: embedA, title: "", thumbnail: null },
      { embedUrl: embedB, title: "", thumbnail: null },
    ],
  });
  assert.deepEqual(JSON.parse(partnerFeedPayload("nope")), { version: 2, items: [] });
  // Only validated video embeds survive, with a bounded title.
  const withPreview = JSON.parse(partnerFeedPayload([
    { embedUrl: embedA, title: "x".repeat(400), thumbnail: "https://cdn.example/a.jpg" },
    { embedUrl: "https://evil.example/embed/1?source=1849513610", title: "bad" },
  ]));
  assert.equal(withPreview.items.length, 1);
  assert.equal(withPreview.items[0].title.length, 120);
  assert.equal(withPreview.items[0].thumbnail, "https://cdn.example/a.jpg");
});

test("a sponsored card can borrow the partner video's own title and poster", () => {
  const page = `<!doctype html><html><head>
    <meta property="og:title" content="Sunset &amp; Silk" />
    <meta property="og:image" content="https://cdn.partner.example/cover.jpg" />
    <title>fallback</title></head><body></body></html>`;
  assert.deepEqual(parseEmbedPreview(page), { title: "Sunset & Silk", thumbnail: "https://cdn.partner.example/cover.jpg" });
  // A page without Open Graph metadata still yields a usable title.
  assert.deepEqual(parseEmbedPreview("<html><head><title>Only a title</title></head></html>"), { title: "Only a title", thumbnail: null });
  assert.deepEqual(parseEmbedPreview("<meta property=\"og:image\" content=\"http://insecure.example/a.jpg\">"), { title: "", thumbnail: null });
  assert.deepEqual(parseEmbedPreview(""), { title: "", thumbnail: null });
  assert.deepEqual(parseEmbedPreview(undefined), { title: "", thumbnail: null });
});

test("previews are enriched within a bounded number of pages", async () => {
  const seen = [];
  const items = await enrichPartnerItems([embedA, embedB, "https://desi-porntube.com/embed/3/?source=1849513610"], {
    limit: 2,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === embedB) throw new Error("page down");
      return { ok: true, text: async () => '<meta property="og:title" content="Preview title"><meta property="og:image" content="https://cdn.example/p.jpg">' };
    },
  });
  assert.equal(items.length, 2, "the limit caps how many pages are read");
  assert.equal(seen.length, 2);
  assert.deepEqual(items[0], { embedUrl: embedA, title: "Preview title", thumbnail: "https://cdn.example/p.jpg" });
  assert.deepEqual(items[1], { embedUrl: embedB, title: "", thumbnail: null }, "a failing page still yields a card");
});

test("the feed request is time-boxed and refuses unusable responses", async () => {
  assert.deepEqual(await requestPartnerFeed("https://desiporn.tube/feed", { fetchImpl: async () => ({ ok: true, text: async () => feedFixture }) }), [embedA, embedB]);
  await assert.rejects(
    requestPartnerFeed("https://desiporn.tube/feed", { fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }) }),
    /500/,
  );
  await assert.rejects(
    requestPartnerFeed("https://desiporn.tube/feed", { fetchImpl: async () => ({ ok: true, text: async () => "<html>no embeds</html>" }) }),
    /no usable embeds/,
  );
  // An unresponsive host must never hold the build open.
  const hanging = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(requestPartnerFeed("https://desiporn.tube/feed", { fetchImpl: hanging, timeoutMs: 50 }));
});

test("the build publishes the feed as partner-feed.json and survives a failed fetch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-feed-plugin-"));
  const warnings = [];
  const context = { warn: (message) => warnings.push(message) };
  try {
    const noPreview = async (urls) => urls.map((embedUrl) => ({ embedUrl, title: "", thumbnail: null }));
    await partnerFeedPlugin({ feedUrl: "https://desiporn.tube/feed", generate: async () => [embedA, embedB], enrich: noPreview })
      .writeBundle.call(context, { dir: directory });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "partner-feed.json"), "utf8")).items.map((item) => item.embedUrl), [embedA, embedB]);
    assert.deepEqual(warnings, []);

    await partnerFeedPlugin({ feedUrl: "https://desiporn.tube/feed", generate: async () => { throw new Error("host down"); }, enrich: noPreview })
      .writeBundle.call(context, { dir: directory });
    assert.equal(warnings.length, 1, "the build warns instead of failing");
    assert.match(warnings[0], /left out/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "partner-feed.json"), "utf8")).items.map((item) => item.embedUrl), [embedA, embedB], "the previous list is untouched");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline builds and the dev endpoint never contact the feed host", async () => {
  const plugin = partnerFeedPlugin({ feedUrl: "https://desiporn.tube/feed", offline: true, generate: async () => { throw new Error("must not be called"); } });
  const warnings = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-feed-offline-"));
  try {
    await plugin.writeBundle.call({ warn: (message) => warnings.push(message) }, { dir: directory });
    assert.equal(warnings.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "partner-feed.json"), "utf8")), { version: 2, items: [] }, "an offline build publishes an empty grid");

    let middleware;
    plugin.configureServer({ middlewares: { use: (handler) => { middleware = handler; } } });
    const answer = await new Promise((resolve) => {
      let status = 0;
      const res = {
        writeHead: (code) => { status = code; return res; },
        end: (body) => resolve({ status, body }),
      };
      middleware({ url: "/partner-feed.json" }, res, () => resolve({ status: "next", body: null }));
    });
    assert.deepEqual(JSON.parse(answer.body), { version: 2, items: [] });
    assert.equal(answer.status, 200, "an offline dev server answers with an empty grid");

    let failing;
    partnerFeedPlugin({ feedUrl: "https://desiporn.tube/feed", generate: async () => { throw new Error("host down"); } })
      .configureServer({ middlewares: { use: (handler) => { failing = handler; } } });
    const broken = await new Promise((resolve) => {
      let status = 0;
      const res = { writeHead: (code) => { status = code; return res; }, end: (body) => resolve({ status, body }) };
      failing({ url: "/partner-feed.json" }, res, () => resolve({ status: "next", body: null }));
    });
    assert.equal(broken.status, 503, "an unavailable feed reports itself as unavailable");
    assert.deepEqual(JSON.parse(broken.body), { version: 2, items: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
