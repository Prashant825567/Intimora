import assert from "node:assert/strict";
import { test } from "node:test";
import { selectExclusive, selectNewReleases, selectTrending } from "../src/services/catalog-views.mjs";

const video = (id, viewCount, createdAt, isExclusive = false) => ({ id, viewCount, createdAt, isExclusive });

test("trending ranks by numeric views across the catalog without mutating it", () => {
  const entries = [video("low", 950, 10), video("old-high", 1200, 20), video("new-high", 1200, 30), video("zero", 0, null)];
  assert.deepEqual(selectTrending(entries).map((item) => item.id), ["new-high", "old-high", "low", "zero"]);
  assert.deepEqual(entries.map((item) => item.id), ["low", "old-high", "new-high", "zero"]);
});

test("new releases include only today's uploads, or yesterday's when today is empty", () => {
  const now = new Date(2026, 10, 7, 15, 0).getTime();
  const todayEarly = new Date(2026, 10, 7, 0, 0).getTime();
  const todayLate = new Date(2026, 10, 7, 14, 59).getTime();
  const yesterdayEarly = new Date(2026, 10, 6, 0, 0).getTime();
  const yesterdayLate = new Date(2026, 10, 6, 23, 59).getTime();
  const older = new Date(2026, 10, 5, 23, 59).getTime();
  const future = new Date(2026, 10, 7, 16, 0).getTime();
  const entries = [video("old", 0, older), video("yesterday-early", 0, yesterdayEarly), video("yesterday-late", 0, yesterdayLate),
    video("today-early", 0, todayEarly), video("today-late", 0, todayLate), video("future", 0, future), video("unknown", 0, null)];
  assert.deepEqual(selectNewReleases(entries, now).map((item) => item.id), ["today-late", "today-early"]);
  assert.deepEqual(selectNewReleases(entries.filter((item) => !item.id.startsWith("today")), now).map((item) => item.id), ["yesterday-late", "yesterday-early"]);
  assert.deepEqual(selectNewReleases([video("old", 0, older), video("unknown", 0, null), video("future", 0, future)], now), []);
});

test("exclusive shows only videos marked exclusive in metadata", () => {
  const entries = [video("yes-old", 8, 100, true), video("no", 9, 200, false), video("yes-new", 1, 300, true)];
  assert.deepEqual(selectExclusive(entries).map((item) => item.id), ["yes-new", "yes-old"]);
});
