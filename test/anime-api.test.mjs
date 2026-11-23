import assert from "node:assert/strict";
import { test } from "node:test";
import { ANIME_API_BASE, animeEmbedUrl, animeIdFromSlug, animeSearch, animeStreamFrom, fetchAnimeRows, fetchAnimeStream, hlsPlayable, isHlsLink, parseAnimeResults } from "../src/services/anime-api.mjs";

// The service answers with the source's own list rows. Only metadata is read:
// id, title, poster, duration — never a media URL.
const recent = {
  status: "success",
  data: {
    provider: "hentaicity",
    type: "recent",
    results: [
      { id: "now-that-i-can-control-reality-6-1JdXN6yeMdN", title: "Reality 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", duration: "HD07:03", trailer: "https://cdn1.images.hentaicity.com/videos/0807/38331/preview.webp" },
      { id: "one-wife-1-OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", duration: "23:36" },
    ],
  },
};

test("a list row becomes cards with a derived embed URL, never a copied media link", () => {
  const cards = parseAnimeResults(recent);
  assert.deepEqual(cards, [
    { id: "now-that-i-can-control-reality-6-1JdXN6yeMdN", code: "1JdXN6yeMdN", title: "Reality 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", duration: "07:03", embedUrl: "https://www.hentaicity.com/embed/1JdXN6yeMdN" },
    { id: "one-wife-1-OneWife001x", code: "OneWife001x", title: "One Wife 1", thumbnail: "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg", duration: "23:36", embedUrl: "https://www.hentaicity.com/embed/OneWife001x" },
  ]);
  assert.equal(cards.some((card) => JSON.stringify(card).includes("preview.webp")), false, "the hover trailer is not a card field");
  // A bare id works too; a slug without a usable id does not.
  assert.equal(animeIdFromSlug("1JdXN6yeMdN"), "1JdXN6yeMdN");
  assert.equal(animeIdFromSlug("slug without digits"), null);
  assert.equal(animeIdFromSlug(undefined), null);
  assert.equal(animeEmbedUrl("bad id"), null);
});

test("only a plain https poster is accepted, and a bad card is dropped not repaired", () => {
  const cards = parseAnimeResults({
    data: { results: [
      { id: "good-1Good00001", title: "Good", thumbnail: "https://cdn1.images.hentaicity.com/a/main.jpg" },
      { id: "insecure-1Bad00001x", title: "Insecure", thumbnail: "http://cdn1.images.hentaicity.com/b/main.jpg" },
      { id: "evil-1Bad00002x", title: "Evil", thumbnail: "javascript:alert(1)" },
      { id: "no-title-1Bad00003x", thumbnail: "https://cdn1.images.hentaicity.com/c/main.jpg" },
      { id: "nope", title: "No id", thumbnail: "https://cdn1.images.hentaicity.com/d/main.jpg" },
      { id: "dupe-1Good00001", title: "Duplicate", thumbnail: "https://cdn1.images.hentaicity.com/e/main.jpg" },
      { id: "extra-1Good00003", title: "  Spaced   out  ", thumbnail: "https://cdn1.images.hentaicity.com/f/main.jpg", duration: "nonsense" },
    ] },
  });
  assert.deepEqual(cards.map((card) => card.id), ["good-1Good00001", "extra-1Good00003"], "the id the API sent is kept whole");
  assert.deepEqual(cards.map((card) => card.code), ["1Good00001", "1Good00003"]);
  assert.equal(cards[1].title, "Spaced out");
  assert.equal(cards[1].duration, "");
  for (const broken of [null, undefined, {}, "nope", { data: null }, { data: { results: "x" } }]) {
    assert.deepEqual(parseAnimeResults(broken), []);
  }
});

test("the rows come back recent first, then popular, and a dead row costs only itself", async () => {
  const asked = [];
  const rows = await fetchAnimeRows({
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (String(url).endsWith("/api/hen/city/recent")) return Response.json(recent);
      if (String(url).endsWith("/api/hen/city/popular/1")) return Response.json({ data: { results: [{ id: "trending-1Trend0001x", title: "Trending", thumbnail: "https://cdn1.images.hentaicity.com/g/main.jpg" }] } });
      return new Response("nope", { status: 500 });
    },
  });
  assert.deepEqual(asked, [`${ANIME_API_BASE}/api/hen/city/recent`, `${ANIME_API_BASE}/api/hen/city/popular/1`]);
  assert.deepEqual(rows.map((row) => row.title), ["Recent", "Popular"]);
  assert.deepEqual(rows[1].cards.map((card) => card.id), ["trending-1Trend0001x"]);

  const onlyRecent = await fetchAnimeRows({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/recent")) return Response.json(recent);
      throw new TypeError("Failed to fetch");
    },
  });
  assert.deepEqual(onlyRecent.map((row) => row.id), ["recent"], "the popular row is dropped, the recent row stays");

  const nothing = await fetchAnimeRows({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual(nothing, [], "no rows at all is an empty page, not a crash");
});

test("the card keeps the API's whole slug and the watch route asks for it whole", async () => {
  const listed = {
    status: "success",
    data: { results: [
      { id: "now-that-i-can-control-reality-with-a-mouse-cursor-i-m-gonna-click-away-on-the-girls-6-1JdXN6yeMdN", title: "Reality 6", thumbnail: "https://cdn1.images.hentaicity.com/videos/0807/38331/main.jpg", duration: "HD07:03" },
    ] },
  };
  const cards = parseAnimeResults(listed);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "now-that-i-can-control-reality-with-a-mouse-cursor-i-m-gonna-click-away-on-the-girls-6-1JdXN6yeMdN",
    "the whole slug travels onward");
  assert.equal(cards[0].code, "1JdXN6yeMdN", "the short tail is kept only for the embed/poster helpers");
  assert.equal(cards[0].embedUrl, "https://www.hentaicity.com/embed/1JdXN6yeMdN");

  const asked = [];
  const url = await fetchAnimeStream(cards[0].id, {
    fetchImpl: async (target) => {
      asked.push(String(target));
      return Response.json({ status: "success", data: { source: [{ src: "https://hls.hentaicity.com/a/master.m3u8", formate: "hls" }] } });
    },
  });
  assert.deepEqual(asked, [`${ANIME_API_BASE}/api/hen/city/watch/${cards[0].id}`],
    "the watch route is asked with the full slug — the short tail is a 404");
  assert.equal(url, "https://hls.hentaicity.com/a/master.m3u8");

  // A slug that is not a plain slug is refused before any request.
  assert.equal(await fetchAnimeStream("../../etc/passwd", { fetchImpl: async () => { throw new Error("no"); } }), null);
  assert.equal(await fetchAnimeStream("a".repeat(201), { fetchImpl: async () => { throw new Error("no"); } }), null);
});

test("the watch route's own link is the stream, and only a plain https media file qualifies", async () => {
  const asked = [];
  const url = await fetchAnimeStream("AbC123xyz", {
    fetchImpl: async (target) => {
      asked.push(String(target));
      return Response.json({ status: "success", data: { id: "AbC123xyz", sources: [{ label: "720p", url: "https://cdn.anime.example/clip/index-720.mp4" }] } });
    },
  });
  assert.deepEqual(asked, [`${ANIME_API_BASE}/api/hen/city/watch/AbC123xyz`], "the watch route is asked once");
  assert.equal(url, "https://cdn.anime.example/clip/index-720.mp4", "the link is used as it came, not rebuilt");

  // The watch route's real answer is an HLS playlist, which the player can play,
  // so it counts as the link — the playlist URL is kept exactly as sent.
  const hls = animeStreamFrom({ status: "success", data: { source: [{ src: "https://hls.hentaicity.com/_hls/flv/0807/38331/,default,.mp4.urlset/master.m3u8?validfrom=1&hash=abc%3D", formate: "hls" }] } });
  assert.equal(hls, "https://hls.hentaicity.com/_hls/flv/0807/38331/,default,.mp4.urlset/master.m3u8?validfrom=1&hash=abc%3D", "the playlist, token and all");
  assert.equal(isHlsLink(hls), true);
  assert.equal(isHlsLink("https://cdn.anime.example/clip.mp4"), false);

  // Nothing playable: a page, an insecure or script URL, a download page. The
  // player must be told "no link" instead of guessing.
  for (const payload of [
    { data: { url: "https://cdn.anime.example/watch/video-123.html" } },
    { data: { url: "http://cdn.anime.example/clip.mp4" } },
    { data: { url: "javascript:alert(1)" } },
    { data: { url: "https://bestfile.io/abc/file" } },
    { data: null },
    null,
  ]) {
    assert.equal(animeStreamFrom(payload), null, JSON.stringify(payload));
  }
  assert.equal(animeStreamFrom({ data: { file: "https://cdn.anime.example/b.webm" } }), "https://cdn.anime.example/b.webm");
  assert.equal(animeStreamFrom({ data: { source: [{ src: "https://hls.hentaicity.com/a/master.m3u8", formate: "hls" }] } }), "https://hls.hentaicity.com/a/master.m3u8");
  assert.equal(animeStreamFrom({ data: { source: [{ src: "http://hls.hentaicity.com/a/master.m3u8" }] } }), null, "an insecure playlist is refused");
  assert.equal(await fetchAnimeStream("bad id", { fetchImpl: async () => { throw new Error("no"); } }), null, "a bad id never reaches the network");
  assert.equal(await fetchAnimeStream("AbC123xyz", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), null);
});

test("search runs on the cards the page already has", () => {
  const cards = parseAnimeResults(recent);
  assert.deepEqual(animeSearch(cards, "one wife").map((card) => card.code), ["OneWife001x"]);
  assert.deepEqual(animeSearch(cards, "REALITY").map((card) => card.code), ["1JdXN6yeMdN"]);
  assert.deepEqual(animeSearch(cards, "   "), []);
  assert.deepEqual(animeSearch(cards, "reality wife"), [], "every word has to match");
});

test("a playlist whose segments are refused is reported, not played", async () => {
  const url = "https://hls.hentaicity.com/a/master.m3u8?t=1";
  assert.equal(await hlsPlayable(url, { fetchImpl: async () => new Response("#EXTM3U", { status: 200 }) }), true);
  assert.equal(await hlsPlayable(url, { fetchImpl: async () => new Response("denied", { status: 403 }) }), false, "a refused manifest");
  assert.equal(await hlsPlayable(url, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), false, "a CORS refusal");
  assert.equal(await hlsPlayable("https://hls.hentaicity.com/a/clip.mp4", { fetchImpl: async () => new Response("", { status: 200 }) }), false, "a plain file is not a playlist check");
  assert.equal(await hlsPlayable("http://hls.hentaicity.com/a/master.m3u8", { fetchImpl: async () => new Response("", { status: 200 }) }), false);
});
