import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCatalog } from "../src/services/catalog-pages.mjs";

const backend = "https://catalog.example";
const page = (ids, cursor) => ({ data: { backend, videos: ids.map((id) => ({ id })), nextCursor: cursor === null ? null : { backend, value: cursor } } });

test("collects and deduplicates overlapping pages and stops at the legacy end cursor", async () => {
  const calls = [];
  const received = [];
  const result = await collectCatalog({
    firstPage: page(["a", "b", "c"], 30), pageSize: 3, pauseMs: 0,
    fetchPage: async (cursor) => { calls.push(cursor); return cursor.value === 30 ? page(["c", "d"], 20) : page(["d"], 20); },
    onPage: (videos) => received.push(...videos.map((video) => video.id)),
  });
  assert.deepEqual(received, ["a", "b", "c", "d"]);
  assert.deepEqual(calls.map((cursor) => cursor.value), [30, 20]);
  assert.deepEqual(result, { complete: true, cancelled: false, pages: 3 });
});

test("reports an ambiguous repeated full page or a safety limit as incomplete", async () => {
  let calls = 0;
  const repeated = await collectCatalog({
    firstPage: page(["a", "b"], 30), pageSize: 2, pauseMs: 0,
    fetchPage: async () => { calls += 1; return page(["a", "b"], 30); },
    onPage: () => {},
  });
  assert.equal(repeated.complete, false);
  assert.equal(calls, 1);
  const capped = await collectCatalog({
    firstPage: page(["a"], 1), maxPages: 2, pauseMs: 0,
    fetchPage: async () => page(["b"], 2), onPage: () => {},
  });
  assert.deepEqual(capped, { complete: false, cancelled: false, pages: 2 });
});

test("does not fetch another page after cancellation and rejects a changed backend", async () => {
  let cancelled = false;
  let calls = 0;
  const stopped = await collectCatalog({
    firstPage: page(["a"], 1), pauseMs: 0,
    fetchPage: async () => { calls += 1; return page([], null); },
    onPage: () => { cancelled = true; }, isCancelled: () => cancelled,
  });
  assert.equal(stopped.cancelled, true);
  assert.equal(calls, 0);
  await assert.rejects(collectCatalog({
    firstPage: page(["a"], 1), pauseMs: 0,
    fetchPage: async () => ({ data: { backend: "https://different.example", videos: [], nextCursor: null } }),
    onPage: () => {},
  }), { message: "Content is temporarily unavailable" });
});
