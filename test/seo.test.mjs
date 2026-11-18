import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPageHead,
  canonicalFor,
  cleanPhrase,
  escapeHtml,
  HOME_TITLE,
  pageMetaFor,
  SITE_ORIGIN,
} from "../scripts/page-head.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (file) => readFile(path.join(root, file), "utf8");
const schemaOf = (html) => {
  const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "structured data is present");
  return JSON.parse(match[1]);
};

test("the static home page tells Google the brand, the site name and the search box", async () => {
  const html = await read("index.html");
  const schema = schemaOf(html);
  assert.equal(schema["@type"], "WebSite");
  assert.equal(schema.name, "Intimora");
  assert.equal(schema.url, `${SITE_ORIGIN}/`);
  assert.deepEqual(schema.alternateName, ["Intimora.new.tg", "Intimora adult videos"]);
  assert.equal(schema.inLanguage, "en");
  assert.equal(schema.publisher["@type"], "Organization");
  assert.match(schema.publisher.logo.url, /^https:\/\/intimora\.new\.tg\/logo\.png$/);
  // A sitelinks searchbox needs the real, working search URL.
  assert.equal(schema.potentialAction["@type"], "SearchAction");
  assert.equal(schema.potentialAction.target.urlTemplate, `${SITE_ORIGIN}/search?q={search_term_string}`);

  assert.match(html, /<title>Intimora\s*\|/);
  assert.match(html, /rel="canonical"\s+href="https:\/\/intimora\.new\.tg\/"/);
  assert.match(html, /property="og:url"\s+content="https:\/\/intimora\.new\.tg\/"/);
  assert.match(html, /property="og:image"\s+content="https:\/\/intimora\.new\.tg\/logo\.png"/);
  assert.match(html, /name="rating"\s+content="adult"/);
  // Exactly one canonical and one WebSite block: duplicates confuse a crawler.
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((html.match(/"@type": "WebSite"/g) || []).length, 1);
});

test("the home page has a brand heading for the crawler and a screen reader", async () => {
  const app = await read("src/App.tsx");
  assert.match(app, /<h1 className="sr-only">Intimora — free 18\+ video streaming<\/h1>/);
});

test("every generated page gets its own title, description and canonical", () => {
  const home = pageMetaFor("/");
  assert.equal(home.title, HOME_TITLE);
  assert.equal(home.canonical, `${SITE_ORIGIN}/`);

  const seen = new Set([home.title]);
  for (const route of ["/trending", "/new", "/exclusive", "/categories", "/search", "/login", "/profile", "/referral", "/dashboard"]) {
    const meta = pageMetaFor(route);
    assert.equal(meta.canonical, `${SITE_ORIGIN}${route}`);
    assert.match(meta.title, /Intimora/);
    assert.ok(!seen.has(meta.title), `${route} shares a title with another page`);
    seen.add(meta.title);
    assert.ok(meta.description.length > 10 && meta.description.length <= 160, `${route} description is usable`);
  }

  const watch = pageMetaFor("/watch/local-1794995532814", { videoTitle: "2025-09-18-00-42-00" });
  assert.equal(watch.title, "2025-09-18-00-42-00 | Intimora");
  assert.equal(watch.canonical, `${SITE_ORIGIN}/watch/local-1794995532814`);
  assert.equal(watch.type, "video.other");
  assert.equal(watch.page["@type"], "WebPage");
  assert.equal(watch.page.contentRating, "18+");
  assert.equal(watch.page.isFamilyFriendly, false);
});

test("a video without a usable title still gets a unique watch page", () => {
  const plain = pageMetaFor("/watch/local-1", { videoTitle: "" });
  assert.equal(plain.title, "Watch on Intimora | 18+ Adult Video Streaming");
  // An id that could not be one of ours falls back to the home head instead of
  // producing a broken canonical.
  assert.equal(pageMetaFor("/watch/../etc/passwd").canonical, `${SITE_ORIGIN}/`);
  assert.equal(canonicalFor("not-a-route"), `${SITE_ORIGIN}/`);
  assert.equal(canonicalFor("/new/"), `${SITE_ORIGIN}/new`);
});

test("catalogue text is escaped and shortened, never injected", () => {
  assert.equal(escapeHtml('<b>"x"&</b>'), "&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;");
  assert.equal(cleanPhrase("  a\t\tb\n c  "), "a b c");
  assert.equal(cleanPhrase("x".repeat(200)).length, 70);
  // The stored title is plain text; escaping happens when it reaches the HTML.
  const evil = pageMetaFor("/watch/local-1", { videoTitle: `</title><script>alert(1)</script>` });
  assert.match(evil.title, /script/, "the words survive");
  const evilHtml = applyPageHead("<html><head><title>old</title></head><body></body></html>", evil);
  assert.doesNotMatch(evilHtml, /<script>alert\(1\)/, "the tag cannot break out of the title");

  const html = applyPageHead("<html><head><title>old</title></head><body></body></html>",
    pageMetaFor("/watch/local-1", { videoTitle: `" onerror="alert(1)` }));
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
  assert.doesNotMatch(title, /"/, "the quote is escaped, so it cannot close an attribute");
  assert.match(html, /rel="canonical" href="https:\/\/intimora\.new\.tg\/watch\/local-1"/);
  assert.equal((html.match(/<title>/g) || []).length, 1);
});

test("applyPageHead rewrites the copy of index.html the build ships", async () => {
  const html = await read("index.html");
  const watch = applyPageHead(html, pageMetaFor("/watch/local-1794995532814", { videoTitle: "A real title" }));
  assert.match(watch, /<title>A real title \| Intimora<\/title>/);
  assert.match(watch, /property="og:title" content="A real title \| Intimora"/);
  assert.match(watch, /property="og:url" content="https:\/\/intimora\.new\.tg\/watch\/local-1794995532814"/);
  assert.match(watch, /property="og:type" content="video\.other"/);
  assert.equal((watch.match(/rel="canonical"/g) || []).length, 1);
  assert.doesNotMatch(watch, /Intimora is an 18\+ adult video streaming platform/, "the home description is replaced");

  const browse = applyPageHead(html, pageMetaFor("/trending"));
  assert.match(browse, /<title>Trending Videos \| Intimora<\/title>/);
  assert.equal((browse.match(/rel="canonical"/g) || []).length, 1);
  assert.match(browse, /rel="canonical" href="https:\/\/intimora\.new\.tg\/trending"/);
  // The site-level WebSite block survives; only the page-level one is added.
  assert.match(browse, /"@type": "WebSite"/);
});

test("the Google Search Console HTML verification file is published unchanged", async () => {
  const file = await read("public/googlee3ab8992ca99a381.html");
  assert.equal(file.trim(), "google-site-verification: googlee3ab8992ca99a381.html");
});

test("the older verification tags are all still in the static head", async () => {
  const html = await read("index.html");
  for (const name of ["6a97888e-site-verification", "juicyads-site-verification", "clckd",
    "67c50a5b22eae3d0d911662d4560abe589cdf595"]) {
    assert.equal((html.match(new RegExp(`name="${name}"`, "g")) || []).length, 1, `${name} is still there once`);
  }
});
