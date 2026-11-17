import assert from "node:assert/strict";
import { test } from "node:test";
import { PHP_ORIGIN_OVERRIDE, UNLOCK_FRESH_MS } from "../src/config/php-backend.mjs";
import { mediaCrossOrigin } from "../src/services/media-credentials.mjs";
import {
  completeUnlockReturn,
  isChallengeContentType,
  markUnlockAttempt,
  readUnlockState,
  requestUnlockNavigation,
  shouldRequestUnlock,
  unlockUrl,
} from "../src/services/unlock.mjs";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";

const discoveryUrl = "https://discovery.example/api/get-server";
const php = PHP_ORIGIN_OVERRIDE;
const proxy = "https://proxy.example";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeDocument() {
  const nodes = [];
  return {
    nodes,
    body: { appendChild: (node) => nodes.push(node) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {} }),
    querySelector: (selector) => nodes.find((node) => `.${node.className}` === selector) ?? null,
  };
}

test("the unlock is requested at most once per session window", () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  assert.equal(shouldRequestUnlock({ storage, now, freshMs: UNLOCK_FRESH_MS }), true, "first visit may ask");
  markUnlockAttempt(storage, { now });
  assert.equal(shouldRequestUnlock({ storage, now: now + 60_000, freshMs: UNLOCK_FRESH_MS }), false, "not twice in a row");
  assert.equal(
    shouldRequestUnlock({ storage, now: now + UNLOCK_FRESH_MS + 1, freshMs: UNLOCK_FRESH_MS }),
    true,
    "a new attempt is allowed after the host's session would have expired",
  );
  markUnlockAttempt(storage, { now, blocked: true });
  assert.equal(shouldRequestUnlock({ storage, now: now + UNLOCK_FRESH_MS * 3, freshMs: UNLOCK_FRESH_MS }), false, "a refused host is not retried forever");
  assert.deepEqual(readUnlockState(storage), { at: now, blocked: true });
});

test("the unlock URL carries the visitor back to the exact page", () => {
  const href = "https://intimora.new.tg/watch/local-1?x=1#t=30";
  assert.equal(
    unlockUrl(php, href),
    `${new URL(php).origin}/__unlock?back=${encodeURIComponent(href)}`,
  );
  assert.equal(unlockUrl("http://insecure.example", href), null, "https is required");
  assert.equal(unlockUrl("not a url", href), null);
  assert.equal(unlockUrl(php, ""), `${new URL(php).origin}/__unlock?back=${encodeURIComponent("https://intimora.new.tg/")}`);
});

test("requesting the unlock shows a splash and only then navigates", () => {
  const storage = memoryStorage();
  const doc = fakeDocument();
  const navigations = [];
  const timers = [];
  const first = requestUnlockNavigation({
    phpOrigin: php,
    href: "https://intimora.new.tg/trending",
    storage,
    now: 1_700_000_000_000,
    splashMs: 700,
    document: doc,
    navigate: (url) => navigations.push(url),
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return 1; },
  });
  assert.equal(first, true);
  assert.equal(doc.nodes.length, 1, "the splash is on screen before the browser leaves");
  assert.match(doc.nodes[0].innerHTML, /logo\.png/);
  assert.equal(navigations.length, 0, "nothing leaves until the splash has been shown");
  assert.equal(timers[0].ms, 700);
  timers[0].fn();
  assert.equal(navigations.length, 1);
  assert.match(navigations[0], /\/__unlock\?back=https%3A%2F%2Fintimora\.new\.tg%2Ftrending$/);

  const second = requestUnlockNavigation({
    phpOrigin: php,
    storage,
    now: 1_700_000_000_000 + 1_000,
    document: doc,
    navigate: (url) => navigations.push(url),
    setTimeoutImpl: (fn) => { fn(); return 1; },
  });
  assert.equal(second, false, "a second redirect cannot happen in the same window");
  assert.equal(navigations.length, 1);
});

test("coming back from the unlock page cleans the address bar", () => {
  const replaced = [];
  const returned = completeUnlockReturn({
    location: { pathname: "/watch/local-1", search: "?__unlocked=1&x=2", hash: "#t=10" },
    history: { state: { a: 1 }, replaceState: (...args) => replaced.push(args) },
    storage: memoryStorage(),
  });
  assert.equal(returned, true);
  assert.deepEqual(replaced[0], [{ a: 1 }, "", "/watch/local-1?x=2#t=10"]);
  assert.equal(
    completeUnlockReturn({ location: { pathname: "/", search: "", hash: "" }, history: { replaceState() {} }, storage: null }),
    false,
    "an ordinary visit is untouched",
  );
});

test("an HTML answer is the host's check, not an error to hide", () => {
  assert.equal(isChallengeContentType("text/html; charset=UTF-8"), true);
  assert.equal(isChallengeContentType("application/json"), false);
  assert.equal(isChallengeContentType(null), false);
});

test("the pinned PHP host is called directly, with cookies, and no discovery", async () => {
  const calls = [];
  const visitor = createVisitorRequest({
    discoveryUrl,
    backendOverride: php,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, data: { videos: [] } });
    },
    storage: null,
    reuseStoredSelection: false,
  });
  const result = await visitor.requestJson("/api/videos?limit=5");
  assert.equal(result.backend, new URL(php).origin);
  assert.equal(calls.length, 1, "discovery is not asked for a server");
  assert.ok(calls[0].url.startsWith(new URL(php).origin), "the browser talks to the PHP host itself");
  assert.equal(calls[0].init.credentials, "include", "the session cookie must be allowed to travel");
});

test("a direct call that hits the check triggers one unlock instead of an error page", async () => {
  const unlocks = [];
  const visitor = createVisitorRequest({
    discoveryUrl,
    backendOverride: php,
    fetcher: async () => new Response("<html><script>toNumbers('00')</script></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    requestUnlock: (context) => { unlocks.push(context); return true; },
    storage: null,
    reuseStoredSelection: false,
  });
  await assert.rejects(visitor.requestJson("/api/videos?limit=5"), { message: "Content is temporarily unavailable" });
  assert.equal(unlocks.length, 1);
  assert.equal(unlocks[0].challenge, true);
  assert.equal(unlocks[0].path, "/api/videos?limit=5");
});

test("when the unlock window is spent, the proxy answers instead", async () => {
  const seen = [];
  const visitor = createVisitorRequest({
    discoveryUrl,
    backendOverride: php,
    proxyBackend: proxy,
    fetcher: async (url) => {
      seen.push(url);
      if (url.startsWith(new URL(php).origin)) throw new Error("CORS");
      return Response.json({ ok: true, data: { videos: [{ id: "via-proxy" }] } });
    },
    requestUnlock: () => false,
    storage: null,
    reuseStoredSelection: false,
  });
  const result = await visitor.requestJson("/api/videos?limit=5");
  assert.equal(result.backend, proxy);
  assert.equal(result.body.data.videos[0].id, "via-proxy");
  assert.equal(seen.length, 2, "the direct call was tried first");
});

test("media from the PHP host drops the CORS attribute so the cookie still goes", () => {
  assert.equal(mediaCrossOrigin(`${new URL(php).origin}/api/videos/local-1/thumbnail`), undefined);
  assert.equal(mediaCrossOrigin("https://api-intimora.vercel.app/api/videos/local-1/thumbnail"), "anonymous");
  assert.equal(mediaCrossOrigin(undefined), "anonymous");
  assert.equal(mediaCrossOrigin("not a url"), "anonymous");
});
