import assert from "node:assert/strict";
import { test } from "node:test";
import { animeCards, animeEmbedUrl, animeFeedPayload, animeIdFromSlug, parseAnimeListing } from "../src/services/anime-feed.mjs";

const listing = `
<div class="item">
  <a href="/click/1-1/video/now-that-i-can-control-reality-6-1JdXN6yeMdN.html" title="Reality 6">
    <img class="thumb" src="https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg" alt="Now That I Can Control Reality 6" />
    <span class="duration">HD07:03</span>
  </a>
</div>
<div class="item">
  <a href="/click/1-2/video/one-wife-1-OneWife001x.html">
    <img data-src="https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg" alt="One Wife 1" />
  </a>
</div>
<div class="item">
  <a href="/click/1-3/video/one-wife-1-OneWife001x.html">
    <img src="https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg" alt="One Wife 1 (duplicate)" />
  </a>
</div>
<div class="item">
  <a href="/click/1-4/video/not-a-real-id.html"><img src="https://cdn1.images.hentaicity.com/x/main.jpg" alt="No id" /></a>
</div>
<div class="item">
  <a href="/click/1-5/video/no-poster-Abc123xyz45.html"><img src="http://insecure.example/p.jpg" alt="Insecure poster" /></a>
</div>
<div class="item">
  <a href="/click/1-6/video/no-title-Abc123xyz99.html"><img src="https://cdn1.images.hentaicity.com/x/main.jpg" /></a>
</div>
`;

test("the listing parser takes only the id, title, poster and duration of each card", () => {
  const items = parseAnimeListing(listing);
  assert.deepEqual(items.map((item) => item.id), ["1JdXN6yeMdN", "OneWife001x"]);
  assert.deepEqual(items[0], {
    id: "1JdXN6yeMdN",
    title: "Now That I Can Control Reality 6",
    thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg",
    pageUrl: "https://www.hentaicity.com/video/now-that-i-can-control-reality-6-1JdXN6yeMdN.html",
    embedUrl: "https://www.hentaicity.com/embed/1JdXN6yeMdN",
    duration: "07:03",
  });
  assert.equal(items[1].duration, "", "a card without a duration still has a title and a poster");
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, "a repeated card is dropped");
  assert.ok(items.every((item) => item.embedUrl.startsWith("https://www.hentaicity.com/embed/")), "every card points at the source's own player");
  assert.ok(!items.some((item) => item.title.startsWith("Insecure") || item.title.startsWith("No ")), "an insecure poster and a title-less card are dropped");
  assert.deepEqual(parseAnimeListing(""), []);
  assert.deepEqual(parseAnimeListing(undefined), []);
});

test("ids and embed URLs are derived, never invented", () => {
  assert.equal(animeIdFromSlug("slug-OneWife001x"), "OneWife001x");
  assert.equal(animeIdFromSlug("slug-only-letters"), null, "an id carries a digit");
  assert.equal(animeIdFromSlug("slug-bad id"), null);
  assert.equal(animeIdFromSlug(undefined), null);
  assert.equal(animeEmbedUrl("OneWife001x"), "https://www.hentaicity.com/embed/OneWife001x");
  assert.equal(animeEmbedUrl("bad id"), null);
  assert.equal(animeEmbedUrl(""), null);
});

test("the payload survives a round trip and a tampered file can only point at the source player", () => {
  const items = parseAnimeListing(listing);
  const payload = animeFeedPayload(items, { generatedAt: "2026-11-19T00:00:00.000Z" });
  assert.equal(payload.version, 1);
  assert.equal(payload.items.length, 2);
  const cards = animeCards(payload);
  assert.deepEqual(cards.map((card) => card.id), ["1JdXN6yeMdN", "OneWife001x"]);
  assert.equal(cards[0].embedUrl, "https://www.hentaicity.com/embed/1JdXN6yeMdN");

  const tampered = animeCards({ items: [
    { id: "1JdXN6yeMdN", title: "Fine", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg" },
    { id: "1JdXN6yeMdN", title: "Duplicate id", thumbnail: "https://cdn1.images.hentaicity.com/b/main.jpg" },
    { id: "bad id", title: "Bad id", thumbnail: "https://cdn1.images.hentaicity.com/c/main.jpg" },
    { id: "NoPoster12", title: "No poster", thumbnail: "http://insecure.example/x.jpg" },
    { id: "NoTitle123", thumbnail: "https://cdn1.images.hentaicity.com/d/main.jpg" },
    { id: "OkTitle123", title: "  Spaced   out  ", thumbnail: "https://cdn1.images.hentaicity.com/e/main.jpg", embedUrl: "https://evil.example/embed/OkTitle123" },
  ] });
  assert.deepEqual(tampered.map((card) => card.id), ["1JdXN6yeMdN", "OkTitle123"]);
  assert.equal(tampered[1].title, "Spaced out");
  assert.equal(tampered[1].embedUrl, "https://www.hentaicity.com/embed/OkTitle123", "a tampered embed URL is ignored");
  assert.deepEqual(animeCards({}), []);
  assert.deepEqual(animeCards(null), []);
  assert.deepEqual(animeCards({ items: "nope" }), []);
});
