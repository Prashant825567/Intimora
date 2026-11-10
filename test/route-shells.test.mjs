import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_SHELL_PATHS, watchIdsFromSitemap, MAX_WATCH_SHELLS } from "../scripts/route-shells-plugin.mjs";
import { isAppPath, watchIdFromPath } from "../src/services/page-routes.mjs";

test("every published route shell is a real app page", () => {
  assert.ok(ROUTE_SHELL_PATHS.length >= 9);
  assert.equal(new Set(ROUTE_SHELL_PATHS).size, ROUTE_SHELL_PATHS.length, "route shells are unique");
  for (const route of ROUTE_SHELL_PATHS) {
    assert.match(route, /^\/[a-z]+$/, `${route} is a single lowercase path segment`);
    assert.ok(isAppPath(route), `${route} is handled by the app router`);
    assert.ok(isAppPath(`${route}/`), `${route}/ is handled by the app router`);
  }
  assert.ok(!ROUTE_SHELL_PATHS.includes("/"), "the root stays index.html");
});

test("video shells come only from site watch URLs with a valid unique ID", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://intimora.new.tg/</loc></url>
  <url><loc>https://intimora.new.tg/watch/abc-123</loc></url>
  <url><loc> https://intimora.new.tg/watch/abc-123 </loc></url>
  <url><loc>https://intimora.new.tg/watch/def_456</loc></url>
  <url><loc>https://intimora.new.tg/watch/../escape</loc></url>
  <url><loc>https://intimora.new.tg/watch/bad%20id</loc></url>
  <url><loc>https://intimora.new.tg/watch/</loc></url>
  <url><loc>https://intimora.new.tg/watch/${"a".repeat(129)}</loc></url>
  <url><loc>https://evil.example/watch/other-host</loc></url>
</urlset>`;
  assert.deepEqual(watchIdsFromSitemap(xml), ["abc-123", "def_456"]);
  assert.deepEqual(watchIdsFromSitemap(xml, 1), ["abc-123"]);
  assert.deepEqual(watchIdsFromSitemap(undefined), []);
  assert.deepEqual(watchIdsFromSitemap("<urlset></urlset>"), []);
  for (const id of watchIdsFromSitemap(xml)) assert.equal(watchIdFromPath(`/watch/${id}`), id);
});

test("the video shell list is bounded so a large catalog cannot flood the build", () => {
  assert.ok(Number.isInteger(MAX_WATCH_SHELLS) && MAX_WATCH_SHELLS > 0 && MAX_WATCH_SHELLS <= 1000);
  const entries = Array.from({ length: MAX_WATCH_SHELLS + 25 }, (_, index) => `<url><loc>https://intimora.new.tg/watch/id-${index}</loc></url>`);
  const ids = watchIdsFromSitemap(`<urlset>${entries.join("")}</urlset>`);
  assert.equal(ids.length, MAX_WATCH_SHELLS);
  assert.equal(ids[0], "id-0");
  assert.equal(ids.at(-1), `id-${MAX_WATCH_SHELLS - 1}`);
  assert.deepEqual(watchIdsFromSitemap("<urlset></urlset>", 0), []);
});
