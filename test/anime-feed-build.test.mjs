import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnimeFeed, FEED_LISTS } from "../scripts/anime-feed.mjs";

// Two listing pages, one card shared between them — the shape the real "new"
// and "most popular" pages have.
const card = (slug, id, title, dir) => `
<div class="item">
  <a href="/click/1-3/video/${slug}-${id}.html" title="${title}">
    <img src="https://cdn1.images.hentaicity.com/videos/${dir}/main.jpg" alt="${title}" />
    <span class="time">HD05:00</span>
  </a>
</div>`;
const alpha = card("alpha", "Alpha0001x", "Alpha one", "0001");
const beta = card("beta", "Beta0002x", "Beta two", "0002");
const gamma = card("gamma", "Gamma0003x", "Gamma three", "0003");

const lists = [
  { id: "new", title: "New Releases", url: "https://source.example/all-recent.html" },
  { id: "popular", title: "Most Popular", url: "https://source.example/all-popular.html" },
  { id: "top", title: "Top Rated", url: "https://source.example/all-rate.html" },
];

function fakeFetch(pages) {
  return async (url) => {
    const body = pages[url];
    if (!body) return { ok: false, status: 404, text: async () => "" };
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => body };
  };
}

test("the build bakes the source's own rows and shares a card between them", async () => {
  const payload = await buildAnimeFeed({
    lists,
    delayMs: 0,
    fetchImpl: fakeFetch({
      "https://source.example/all-recent.html": alpha + beta,
      "https://source.example/all-popular.html": alpha + gamma,
      "https://source.example/all-rate.html": gamma,
    }),
  });
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.lists, [
    { id: "new", title: "New Releases", itemIds: ["Alpha0001x", "Beta0002x"] },
    { id: "popular", title: "Most Popular", itemIds: ["Alpha0001x", "Gamma0003x"] },
    { id: "top", title: "Top Rated", itemIds: ["Gamma0003x"] },
  ]);
  assert.deepEqual(payload.items.map((item) => item.id), ["Alpha0001x", "Beta0002x", "Gamma0003x"], "a card is stored once");
  assert.ok(payload.items.every((item) => item.embedUrl === `https://www.hentaicity.com/embed/${item.id}`));
});

test("one dead listing costs only its own row", async () => {
  const payload = await buildAnimeFeed({
    lists,
    delayMs: 0,
    fetchImpl: fakeFetch({
      "https://source.example/all-recent.html": alpha,
      "https://source.example/all-popular.html": new Error("listing responded 503"),
      "https://source.example/all-rate.html": gamma,
    }),
  });
  assert.deepEqual(payload.lists, [
    { id: "new", title: "New Releases", itemIds: ["Alpha0001x"] },
    { id: "top", title: "Top Rated", itemIds: ["Gamma0003x"] },
  ]);
  assert.equal(payload.items.length, 2);
});

test("rows are capped, and a build that read nothing throws so the snapshot is kept", async () => {
  const capped = await buildAnimeFeed({
    lists,
    delayMs: 0,
    perList: 1,
    fetchImpl: fakeFetch({
      "https://source.example/all-recent.html": alpha + beta,
      "https://source.example/all-popular.html": gamma,
      "https://source.example/all-rate.html": beta,
    }),
  });
  assert.deepEqual(capped.lists.map((row) => row.itemIds.length), [1, 1, 1]);

  await assert.rejects(
    () => buildAnimeFeed({ lists, delayMs: 0, fetchImpl: fakeFetch({}) }),
    /no anime items were found/,
  );
});

test("every configured page is one of the source's own straight listings", () => {
  assert.deepEqual(FEED_LISTS.map((list) => list.id), ["new", "popular", "top"]);
  assert.deepEqual(FEED_LISTS.map((list) => list.title), ["New Releases", "Most Popular", "Top Rated"]);
  for (const list of FEED_LISTS) {
    assert.match(list.url, /^https:\/\/www\.hentaicity\.com\/videos\/straight\/all-(?:recent|popular|rate)\.html$/);
    assert.doesNotMatch(list.url, /embed|search|playlist/, "a disallowed or unlisted page is never requested");
  }
});
