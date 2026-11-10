import assert from "node:assert/strict";
import { test } from "node:test";
import { accountPageFromPath, BROWSE_PATHS, browseViewFromPath, isAppPath, isSearchPath, searchPathFor, searchTermFromLocation, watchIdFromPath, watchPathFor } from "../src/services/page-routes.mjs";

test("browse and account routes are stable, direct-linkable, and accept a trailing slash", () => {
  assert.deepEqual(BROWSE_PATHS, { Home: "/", Trending: "/trending", New: "/new", Exclusive: "/exclusive", Categories: "/categories" });
  for (const [view, pathname] of Object.entries(BROWSE_PATHS)) {
    assert.equal(browseViewFromPath(pathname), view);
    assert.ok(isAppPath(pathname));
    if (pathname !== "/") assert.equal(browseViewFromPath(`${pathname}/`), view);
  }
  for (const page of ["login", "profile", "referral", "dashboard"]) {
    assert.equal(accountPageFromPath(`/${page}`), page);
    assert.equal(accountPageFromPath(`/${page}/`), page);
    assert.ok(isAppPath(`/${page}`));
  }
  for (const pathname of ["/dashboard/private", "/assets/missing.js", "/.env", "/not-a-page", "/trending//"]) {
    assert.equal(isAppPath(pathname), false, pathname);
  }
});

test("watch routes validate IDs and search queries are URL-encoded and bounded", () => {
  assert.equal(watchIdFromPath("/watch/video_1-2/"), "video_1-2");
  assert.equal(watchPathFor("video_1-2"), "/watch/video_1-2");
  for (const bad of ["", "../private", "a/b", "x".repeat(129)]) {
    assert.equal(watchPathFor(bad), null);
    assert.equal(watchIdFromPath(`/watch/${bad}`), null);
  }
  assert.ok(isAppPath("/watch/video_1-2"));
  assert.equal(isSearchPath("/search/"), true);
  const path = searchPathFor("  cats & dogs  ");
  const url = new URL(path, "https://example.test");
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "cats & dogs");
  assert.equal(searchTermFromLocation(url.pathname, url.search), "cats & dogs");
  assert.equal(searchTermFromLocation("/", "?q=ignored"), null);
  assert.equal(searchTermFromLocation("/search", `?q=${"a".repeat(220)}`).length, 200);
  assert.ok(isAppPath("/search"));
});
