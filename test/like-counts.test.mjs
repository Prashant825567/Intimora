import assert from "node:assert/strict";
import { test } from "node:test";
import { likeCountKey, mergeLikeCounts, parseLikeCounts, readLikeCount } from "../src/services/like-counts.mjs";

const backendA = "https://api-intimora.vercel.app";
const backendB = "https://intimora-api1.vercel.app";

test("public like counts accept only requested IDs and nonnegative integer values", () => {
  const data = { counts: [{ id: "video-1", likes: 12, version: 4 }, { id: "video-2", likes: 0, version: 0 }] };
  assert.deepEqual(parseLikeCounts(data, ["video-1", "video-2"]), data.counts);
  assert.deepEqual(readLikeCount("video-1", { likes: 12, version: 4 }), data.counts[0]);
  for (const invalid of [
    { counts: [{ id: "other", likes: 1, version: 1 }] },
    { counts: [{ id: "video-1", likes: -1, version: 1 }] },
    { counts: [{ id: "video-1", likes: 1.5, version: 1 }] },
    { counts: [{ id: "video-1", likes: 1, version: -1 }] },
    { counts: [{ id: "video-1", likes: 1, version: Number.MAX_SAFE_INTEGER + 1 }] },
    { counts: [{ id: "video-1", likes: "1", version: 1 }] },
    { counts: [{ id: "video-1", likes: 1, version: 1 }, { id: "video-1", likes: 2, version: 2 }] },
    { counts: "not an array" },
  ]) assert.throws(() => parseLikeCounts(invalid, ["video-1", "video-2"]), /temporarily unavailable/);
  assert.equal(readLikeCount("video-1", { likes: 2 }), null, "an unversioned mutation response cannot overwrite a live count");
});

test("stale or conflicting responses cannot replace a newer per-backend count", () => {
  let counts = new Map();
  counts = mergeLikeCounts(counts, backendA, [{ id: "video-1", likes: 12, version: 4 }]);
  counts = mergeLikeCounts(counts, backendA, [{ id: "video-1", likes: 11, version: 3 }]);
  counts = mergeLikeCounts(counts, backendA, [{ id: "video-1", likes: 99, version: 4 }]);
  assert.deepEqual(counts.get(likeCountKey(backendA, "video-1")), { id: "video-1", likes: 12, version: 4 });
  counts = mergeLikeCounts(counts, backendA, [{ id: "video-1", likes: 11, version: 5 }]);
  counts = mergeLikeCounts(counts, backendB, [{ id: "video-1", likes: 3, version: 1 }]);
  assert.equal(counts.get(likeCountKey(backendA, "video-1")).likes, 11);
  assert.equal(counts.get(likeCountKey(backendB, "video-1")).likes, 3);
});
