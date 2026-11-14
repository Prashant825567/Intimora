import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describePreviewCoverage, enrichPartnerItems, partnerFeedPlugin, requestPartnerFeed } from "../scripts/partner-feed-plugin.mjs";
import { decodeHtmlEntities, PARTNER_PREVIEW_LIMIT, parseEmbedPreview, parsePartnerFeed, parsePartnerFeedEntries, partnerFeedPayload, partnerPosterCandidates } from "../src/services/partner-feed.mjs";

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
  // An http-only poster is upgraded rather than dropped.
  assert.deepEqual(parseEmbedPreview("<meta property=\"og:image\" content=\"http://insecure.example/a.jpg\">"), { title: "", thumbnail: "https://insecure.example/a.jpg" });
  assert.deepEqual(parseEmbedPreview(""), { title: "", thumbnail: null });
  assert.deepEqual(parseEmbedPreview(undefined), { title: "", thumbnail: null });
});

test("partner posters are read from every common meta spelling", () => {
  const base = "https://desi-porntube.com/embed/764349/?source=1849513610";
  // Twitter cards label the same fields with name= instead of property=.
  assert.deepEqual(
    parseEmbedPreview('<meta name="twitter:title" content="T"><meta name="twitter:image" content="//cdn.example/x.jpg">', base),
    { title: "T", thumbnail: "https://cdn.example/x.jpg" },
  );
  // A poster may be a root-relative path on the partner's own host.
  assert.deepEqual(
    parseEmbedPreview('<meta property="og:title" content="Rel"><meta property="og:image" content="contents/videos_screenshots/764000/764349/320x180/1.jpg">', base),
    { title: "Rel", thumbnail: "https://desi-porntube.com/embed/764349/contents/videos_screenshots/764000/764349/320x180/1.jpg" },
  );
  assert.deepEqual(
    parseEmbedPreview('<link rel="image_src" href="https://cdn.example/i.jpg"><title>TT</title>'),
    { title: "TT", thumbnail: "https://cdn.example/i.jpg" },
  );
  assert.deepEqual(
    parseEmbedPreview('<video poster="https://cdn.example/p.jpg"></video>'),
    { title: "", thumbnail: "https://cdn.example/p.jpg" },
  );
  assert.deepEqual(
    parseEmbedPreview('<script type="application/ld+json">{"thumbnailUrl":"https://cdn.example/j.jpg"}</script>'),
    { title: "", thumbnail: "https://cdn.example/j.jpg" },
  );
  // A plain-http poster is upgraded instead of dropped: some partners still
  // publish http: image URLs even on their https pages.
  assert.deepEqual(
    parseEmbedPreview('<meta property="og:image" content="http://cdn.example/a.jpg">'),
    { title: "", thumbnail: "https://cdn.example/a.jpg" },
  );
  // Anything that is not http(s) stays refused.
  assert.deepEqual(parseEmbedPreview('<meta property="og:image" content="javascript:alert(1)">'), { title: "", thumbnail: null });
  assert.deepEqual(parseEmbedPreview('<meta property="og:image" content="ftp://cdn.example/a.jpg">'), { title: "", thumbnail: null });
});

test("previews are fetched like a browser, from the embed page the card links to", async () => {
  const seen = [];
  const [item] = await enrichPartnerItems([embedA], {
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers });
      return {
        ok: true,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => '<meta property="og:title" content="Partner title"><meta property="og:image" content="/contents/1.jpg">',
      };
    },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].headers["user-agent"], /Mozilla\/5\.0/, "the page is asked with a browser user agent");
  assert.match(seen[0].headers.accept, /text\/html/);
  assert.equal(item.thumbnail, "https://desi-porntube.com/contents/1.jpg", "a relative poster is resolved against the embed host");
  assert.equal(item.title, "Partner title");
});

test("the build reads as many pages as the grid can show", async () => {
  const urls = Array.from({ length: 30 }, (_, index) => `https://desi-porntube.com/embed/${1000 + index}/?source=1849513610`);
  const calls = [];
  const items = await enrichPartnerItems(urls, {
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, headers: { get: () => "text/html" }, text: async () => "<title>x</title>" };
    },
  });
  assert.equal(items.length, PARTNER_PREVIEW_LIMIT);
  assert.equal(
    calls.filter((url) => url.includes("/embed/")).length,
    PARTNER_PREVIEW_LIMIT,
    "no more pages are read than the grid can display",
  );
});

test("previews are enriched within a bounded number of pages", async () => {
  const seen = [];
  const items = await enrichPartnerItems([embedA, embedB, "https://desi-porntube.com/embed/3/?source=1849513610"], {
    limit: 2,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.startsWith(embedB.slice(0, embedB.indexOf("?"))) || url === embedB || url.includes("/video/762647/") || url.includes("/videos/762647/")) throw new Error("page down");
      return { ok: true, text: async () => '<meta property="og:title" content="Preview title"><meta property="og:image" content="https://cdn.example/p.jpg">' };
    },
  });
  assert.equal(items.length, 2, "the limit caps how many pages are read");
  assert.equal(
    new Set(seen.filter((url) => url.includes("/embed/"))).size,
    2,
    "one embed page per sponsored card (a network failure may be retried once)",
  );
  assert.deepEqual(items[0], { embedUrl: embedA, title: "Preview title", thumbnail: "https://cdn.example/p.jpg" });
  assert.deepEqual(items[1], { embedUrl: embedB, title: "", thumbnail: null }, "a failing page still yields a card");
});

test("the feed request is time-boxed and refuses unusable responses", async () => {
  assert.deepEqual(
    (await requestPartnerFeed("https://desiporn.tube/feed", { fetchImpl: async () => ({ ok: true, text: async () => feedFixture }) }))
      .map((entry) => entry.embedUrl),
    [embedA, embedB],
  );
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

test("poster candidates follow the partner's screenshot layout", () => {
  const embed = "https://desi-porntube.com/embed/764349/?source=1849513610";
  const candidates = partnerPosterCandidates(embed);
  assert.deepEqual(candidates, [
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/320x180/1.jpg",
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/320x180/2.jpg",
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/preview.jpg",
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/400x225/1.jpg",
  ]);
  // The video page carries the same id, so a redirected page still works.
  assert.equal(partnerPosterCandidates("https://desi-porn.xyz/video/764349/indian-girls-sweet-sex/").length, 4);
  assert.deepEqual(partnerPosterCandidates("https://desi-porn.xyz/search/1/?s=indian"), [], "pages without a video id have no screenshot path");
  assert.deepEqual(partnerPosterCandidates("not a url"), []);
  assert.deepEqual(partnerPosterCandidates(null), []);
});

test("a challenged embed page is retried with a phone user agent", async () => {
  const agents = [];
  const [item] = await enrichPartnerItems([embedA], {
    fetchImpl: async (url, init) => {
      agents.push(init.headers["user-agent"]);
      const mobile = /iPhone/.test(init.headers["user-agent"]);
      return {
        ok: true,
        headers: { get: () => "text/html" },
        text: async () => (mobile
          ? '<meta property="og:title" content="Mobile title"><meta property="og:image" content="https://cdn.example/m.jpg">'
          : "<html><body>checking your browser</body></html>"),
      };
    },
  });
  assert.equal(item.title, "Mobile title", "the phone user agent sees the real page");
  assert.equal(item.thumbnail, "https://cdn.example/m.jpg");
  assert.equal(agents.length, 2, "the desktop attempt is not repeated once it yields nothing");
  assert.match(agents[1], /iPhone/);
});

test("a blocked embed page falls back to the partner's normal video page", async () => {
  const diagnostics = [];
  const seen = [];
  const [item] = await enrichPartnerItems([embedA], {
    onDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === embedA) {
        return { ok: false, status: 403, headers: { get: () => "text/html" }, text: async () => "<html>forbidden</html>" };
      }
      return {
        ok: true,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => '<meta property="og:title" content="Video page title"><meta property="og:image" content="https://cdn.example/v.jpg">',
      };
    },
  });
  assert.ok(seen.includes("https://desi-porntube.com/video/764349/"), "the video page is the second source");
  assert.ok(!seen.includes("https://desi-porntube.com/videos/764349/"), "the plural template is skipped once the video page answers");
  assert.equal(item.title, "Video page title");
  assert.equal(item.thumbnail, "https://cdn.example/v.jpg");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].via, "video");
  assert.equal(diagnostics[0].title, "Video page title");
});

test("a predictable screenshot is used when no page carries any tag", async () => {
  const staged = [];
  const [item] = await enrichPartnerItems([embedA], {
    fetchImpl: async (url, init) => {
      staged.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "HEAD") {
        const usable = url.endsWith("/320x180/2.jpg");
        return {
          ok: usable,
          headers: { get: (name) => (name === "content-type" ? (usable ? "image/jpeg" : "text/html") : "1234") },
        };
      }
      return { ok: true, headers: { get: () => "text/html" }, text: async () => "<html><head><title></title></head></html>" };
    },
  });
  assert.equal(item.thumbnail, "https://desi-porntube.com/contents/videos_screenshots/764000/764349/320x180/2.jpg");
  assert.equal(item.title, "");
  // The first screenshot was rejected because it was not an image.
  assert.deepEqual(staged.filter((entry) => entry.method === "HEAD").map((entry) => entry.url), [
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/320x180/1.jpg",
    "https://desi-porntube.com/contents/videos_screenshots/764000/764349/320x180/2.jpg",
  ]);
});

test("an unresolvable preview leaves the card on its neutral placeholder", async () => {
  const [item] = await enrichPartnerItems([embedA], {
    fetchImpl: async () => {
      throw new Error("host down");
    },
  });
  assert.deepEqual(item, { embedUrl: embedA, title: "", thumbnail: null });
});

test("the build log says how many sponsored cards got a real preview", () => {
  assert.equal(describePreviewCoverage([]), "Partner previews: 0 pages resolved.");
  assert.equal(
    describePreviewCoverage([
      { thumbnail: "https://cdn.example/a.jpg", title: "A" },
      { thumbnail: null, title: "B" },
      { thumbnail: null, title: "" },
      { thumbnail: "https://cdn.example/d.jpg", title: "D" },
    ]),
    "Partner previews: 2/4 pages resolved (3 with a title).",
  );
});

test("the build logs the preview coverage instead of failing silently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-feed-coverage-"));
  const lines = [];
  const original = console.info;
  console.info = (message) => lines.push(String(message));
  try {
    const enrich = async (urls, options) => urls.map((embedUrl, index) => {
      const preview = index === 0
        ? { title: "Real title", thumbnail: "https://cdn.example/a.jpg" }
        : { title: "Only a title", thumbnail: null };
      options?.onDiagnostic?.({ embedUrl, ...preview });
      return { embedUrl, ...preview };
    });
    await partnerFeedPlugin({ feedUrl: "https://desiporn.tube/feed", generate: async () => [embedA, embedB], enrich })
      .writeBundle.call({ warn: () => {} }, { dir: directory });
    assert.ok(lines.includes("Partner previews: 1/2 pages resolved (2 with a title)."), `unexpected log: ${lines.join(" | ")}`);
    assert.ok(lines.includes("Sponsored feed published with 2 video(s)."));
  } finally {
    console.info = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a feed row with extra columns skips the scrape entirely", async () => {
  const feed = [
    "Embed|Title|Screenshot",
    `<iframe src="${embedA}" width="640" height="360" frameborder="0"></iframe>|Indian Girls Sweet Sex|https://desi-porn.xyz/contents/764000/764349/preview.jpg`,
    `<iframe src="${embedB}" width="640" height="360" frameborder="0"></iframe>|Just a moment...|`,
  ].join("\n");
  const entries = parsePartnerFeedEntries(feed);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    embedUrl: embedA,
    title: "Indian Girls Sweet Sex",
    thumbnail: "https://desi-porn.xyz/contents/764000/764349/preview.jpg",
  });
  assert.equal(entries[1].title, "", "a challenge-page title never reaches a card");
  assert.equal(entries[1].thumbnail, null);

  let calls = 0;
  const items = await enrichPartnerItems([entries[0]], {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be read");
    },
  });
  assert.equal(calls, 0, "a complete feed row needs no page read");
  assert.deepEqual(items[0], entries[0]);
});

test("a feed title is kept while the poster is still fetched", async () => {
  const [item] = await enrichPartnerItems(
    [{ embedUrl: embedA, title: "Feed title", thumbnail: null }],
    {
      fetchImpl: async (url) => ({
        ok: true,
        headers: { get: () => "text/html" },
        text: async () => (url.includes("/embed/") ? "<title></title>" : '<meta property="og:image" content="https://cdn.example/only.jpg">'),
      }),
    },
  );
  assert.equal(item.title, "Feed title");
  assert.equal(item.thumbnail, "https://cdn.example/only.jpg");
});
