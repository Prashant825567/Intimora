import assert from "node:assert/strict";
import { test } from "node:test";
import { interleaveSponsored, sponsoredCards, SPONSORED_EVERY } from "../src/services/partner-cards.mjs";
import { PARTNER_PREVIEW_LIMIT } from "../src/services/partner-feed.mjs";

const embed = (id) => `https://desi-porntube.com/embed/${id}/?source=1849513610`;

test("sponsored cards are validated before they enter a grid", () => {
  const cards = sponsoredCards({
    version: 2,
    items: [
      { embedUrl: embed(764349), title: "  Partner one  ", thumbnail: "https://cdn.example/one.jpg" },
      { embedUrl: embed(764349), title: "duplicate" },
      embed(762647),
      { embedUrl: "https://evil.example/embed/1?source=1849513610", title: "bad host" },
      { embedUrl: embed(1), title: "http poster", thumbnail: "http://cdn.example/a.jpg" },
      { embedUrl: "https://desi-porntube.com/track/?source=1849513610", title: "not a video" },
    ],
  });
  assert.equal(cards.length, 3);
  assert.equal(cards[0].title, "Partner one", "titles are trimmed");
  assert.equal(cards[0].thumbnail, "https://cdn.example/one.jpg");
  assert.equal(cards[1].embedUrl, embed(762647), "a bare URL still becomes a card");
  assert.equal(cards[2].thumbnail, null, "an insecure poster is dropped");
  assert.ok(cards.every((card) => card.id.startsWith("sponsored:")));

  assert.deepEqual(sponsoredCards(null), []);
  assert.deepEqual(sponsoredCards({ items: "nope" }), []);
  assert.equal(sponsoredCards({ items: [embed(1), embed(2), embed(3)] }, { limit: 2 }).length, 2);
  // The grid never asks for a card whose preview the build did not read.
  assert.equal(sponsoredCards({ items: Array.from({ length: 40 }, (_, index) => embed(5000 + index)) }).length, PARTNER_PREVIEW_LIMIT);
});

test("four of ours, then one sponsored, without a trailing sponsored card", () => {
  assert.equal(SPONSORED_EVERY, 4);
  const videos = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const cards = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  const merged = interleaveSponsored(videos, cards);
  assert.deepEqual(merged.map((entry) => entry.kind === "sponsored" ? entry.card.id : entry.video), [
    "a", "b", "c", "d", "s1", "e", "f", "g", "h", "s2", "i",
  ]);
  // The last slot is always one of ours, and the order of the catalogue is kept.
  assert.equal(merged.at(-1).kind, "video");
  assert.deepEqual(merged.filter((entry) => entry.kind === "video").map((entry) => entry.video), videos);

  // Exactly four videos: no room for a sponsored slot after the last card.
  assert.deepEqual(interleaveSponsored(["a", "b", "c", "d"], cards).map((entry) => entry.kind), ["video", "video", "video", "video"]);

  assert.deepEqual(interleaveSponsored(videos, []).map((entry) => entry.kind), videos.map(() => "video"));
  assert.deepEqual(interleaveSponsored([], cards), []);
  assert.deepEqual(interleaveSponsored(videos, cards, { every: 1 }).slice(0, 3).map((entry) => entry.kind), ["video", "sponsored", "video"]);
});
