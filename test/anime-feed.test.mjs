import assert from "node:assert/strict";
import { test } from "node:test";
import { animeCards, animeEmbedUrl, animeFeedPayload, animeIdFromSlug, animeLists, animeSearch, enrichAnimePage, parseAnimeListing } from "../src/services/anime-feed.mjs";

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
  assert.equal(payload.version, 3);
  assert.deepEqual(payload.lists, [], "a feed built without rows carries no invented ranking");
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

test("the source's own rows survive a round trip, in their order, without duplicating a card", () => {
  const items = parseAnimeListing(listing);
  const payload = animeFeedPayload(items, {
    generatedAt: "2026-11-19T00:00:00.000Z",
    lists: [
      { id: "new", title: "New Releases", itemIds: ["1JdXN6yeMdN", "OneWife001x"] },
      { id: "popular", title: "Most Popular", itemIds: ["OneWife001x", "gone-forever", "OneWife001x"] },
      { id: "top", title: "Top Rated", itemIds: ["nope"] },
      { id: "bad id", title: "Broken id", itemIds: ["1JdXN6yeMdN"] },
      { id: "", title: "", itemIds: ["1JdXN6yeMdN"] },
      { id: "new", title: "Repeated row", itemIds: ["1JdXN6yeMdN"] },
    ],
  });
  assert.deepEqual(payload.items.length, 2, "a card is stored once, however many rows show it");
  assert.deepEqual(payload.lists, [
    { id: "new", title: "New Releases", itemIds: ["1JdXN6yeMdN", "OneWife001x"] },
    { id: "popular", title: "Most Popular", itemIds: ["OneWife001x"] },
  ], "an empty row, an unknown id, a repeated id and a bad row are all dropped");

  const rows = animeLists(payload);
  assert.deepEqual(rows.map((row) => row.title), ["New Releases", "Most Popular"]);
  assert.deepEqual(rows[0].cards.map((card) => card.id), ["1JdXN6yeMdN", "OneWife001x"]);
  assert.equal(rows[0].cards[0].embedUrl, "https://www.hentaicity.com/embed/1JdXN6yeMdN");
  assert.equal(rows[1].cards[0].id, "OneWife001x");
});

test("a tampered file can only produce rows that point at the source's own player", () => {
  const rows = animeLists({
    version: 2,
    lists: [
      { id: "new", title: "  New   Releases  ", itemIds: ["Safe12345", "Safe12345", "Evil12345", 42] },
      { id: "popular", title: "Most Popular", itemIds: ["Evil12345"] },
    ],
    items: [
      { id: "Safe12345", title: "Safe", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg", embedUrl: "https://evil.example/embed/Safe12345", duration: "07:03" },
      { id: "Evil12345", title: "Bad poster", thumbnail: "http://insecure.example/b.jpg" },
    ],
  }, { perList: 1 });
  assert.deepEqual(rows, [
    { id: "new", title: "New Releases", cards: [{ id: "Safe12345", title: "Safe", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg", duration: "07:03", embedUrl: "https://www.hentaicity.com/embed/Safe12345" }] },
  ], "the cap holds, the repeated id is dropped, the bad-poster card never appears and the embed URL is rebuilt");

  for (const broken of [undefined, null, {}, { lists: "nope" }, { lists: [{ id: "x" }] }, { version: 1, items: [{ id: "Safe12345" }] }]) {
    assert.deepEqual(animeLists(broken), [], "no rows without a real list");
  }
  const old = animeCards({ version: 1, items: [{ id: "Safe12345", title: "Safe", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg" }] });
  assert.equal(old.length, 1, "an older feed still fills the grid");
  assert.deepEqual(animeLists({ version: 1, items: [{ id: "Safe12345", title: "Safe", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg" }] }), []);
});

// The shape of a real video page: a schema.org record, a profile link for the
// author, `/tags/video/<tag>` links (spaces as `+`), and category links that are
// not tags.
const videoPage = `
<h1>Now That I Can Control Reality 6</h1>
<a href="https://www.hentaicity.com/profile/fluffy/">fluffy</a>
<a href="https://www.hentaicity.com/videos/straight/bigtits-popular.html">big tits</a>
<a href="https://www.hentaicity.com/tags/video/mind+control">mind control</a>
<a href="https://www.hentaicity.com/tags/video/weird">weird</a>
<a href="https://www.hentaicity.com/tags/video/public+sex">public sex</a>
<a href="https://www.hentaicity.com/tags/video/weird">weird</a>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"VideoObject","name":"Reality 6",
 "description":"Takumi is an introverted student whose mouse cursor can reach outside the screen.",
 "uploadDate":"2026-11-16T00:00:00+00:00","duration":"PT7M3S",
 "thumbnailUrl":["https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg"],
 "author":{"@type":"Person","name":"fluffy"},
 "aggregateRating":{"@type":"AggregateRating","ratingValue":"73","ratingCount":"506"}}
</script>
<meta property="og:description" content="A fallback that is ignored when the record has one." />
`;

test("a video page adds its tags, author, date, rating and description to the card", () => {
  assert.deepEqual(enrichAnimePage(videoPage), {
    author: "fluffy",
    uploadDate: "2026-11-16",
    tags: ["mind control", "weird", "public sex"],
    description: "Takumi is an introverted student whose mouse cursor can reach outside the screen.",
    rating: 73,
  });
  assert.deepEqual(enrichAnimePage(""), {}, "an empty page adds nothing");
  assert.deepEqual(enrichAnimePage(undefined), {}, "no page adds nothing");
  assert.deepEqual(
    enrichAnimePage('<meta property="og:description" content="Only a meta description here." />'),
    { description: "Only a meta description here." },
    "markup without a schema.org record still yields what it does state",
  );
  assert.deepEqual(
    enrichAnimePage('<script type="application/ld+json">{not json}</script><a href="/tags/video/a b/c?x=1">bad</a>'),
    {},
    "broken JSON and an unusable tag link are skipped, never thrown",
  );
});

test("the feed's optional fields are validated on the way in, so a tampered file cannot slip through", () => {
  const base = { id: "1JdXN6yeMdN", title: "Fine", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg" };
  const [card] = animeCards({ items: [{
    ...base,
    tags: ["futanari", "futanari", "", "<script>", 42, ...Array.from({ length: 12 }, (_, i) => `tag${i}`)],
    author: "<img src=x onerror=alert(1)>",
    uploadDate: "16 Nov 2026",
    rating: "not a number",
    description: "x".repeat(900),
  }] });
  assert.deepEqual(card.tags, ["futanari", "tag0", "tag1", "tag2", "tag3", "tag4", "tag5", "tag6"], "eight clean tags, deduplicated");
  assert.equal(card.author, undefined, "markup is not an author");
  assert.equal(card.uploadDate, undefined, "a loose date is not an upload date");
  assert.equal(card.rating, undefined);
  assert.equal(card.description.length, 300);

  const [clean] = animeCards({ items: [{ ...base, author: "fluffy", uploadDate: "2026-11-16", rating: "73" }] });
  assert.equal(clean.author, "fluffy");
  assert.equal(clean.uploadDate, "2026-11-16");
  assert.equal(clean.rating, 73);
  assert.deepEqual(Object.keys(animeCards({ items: [base] })[0]), ["id", "title", "thumbnail", "duration", "embedUrl"],
    "a card with no extra facts carries no empty keys");
});

test("search matches the title, the tags and the author, and still stays on our own copy", () => {
  const cards = animeCards({ items: [
    { id: "Aaa11111", title: "Metal Futa Solid", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg", tags: ["futanari", "3d"], author: "studio-x" },
    { id: "Bbb22222", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/b/main.jpg", tags: ["teen"] },
    { id: "Ccc33333", title: "Call of Cthulhu 3", thumbnail: "https://cdn1.images.hentaicity.com/c/main.jpg", tags: ["monster"] },
  ] });
  assert.deepEqual(animeSearch(cards, "one wife").map((card) => card.id), ["Bbb22222"]);
  assert.deepEqual(animeSearch(cards, "FUTANARI").map((card) => card.id), ["Aaa11111"], "a tag is searchable");
  assert.deepEqual(animeSearch(cards, "studio").map((card) => card.id), ["Aaa11111"], "the author is searchable");
  assert.deepEqual(animeSearch(cards, "   "), [], "an empty query returns nothing");
  assert.deepEqual(animeSearch(cards, "metal cthulhu"), [], "every word has to match one card");
  assert.deepEqual(animeSearch(cards, "c", { limit: 1 }).length, 1);
  assert.deepEqual(animeSearch(null, "x"), []);
});
