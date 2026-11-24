import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";

const discoveryUrl = "https://discovery.example/api/get-server";
const backendA = "https://a.example";
const backendB = "https://b.example";

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    snapshot() { return Object.fromEntries(entries); },
  };
}

function client(options) {
  return createVisitorRequest({ discoveryUrl, ...options });
}

test("tabs discover independently, deduplicate concurrency, and expire within 60 seconds", async () => {
  const calls = [];
  let discoveries = 0;
  let now = 1_700_000_000_000;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    if (url === discoveryUrl) {
      const selected = ++discoveries % 2 ? backendA : backendB;
      await delay(10);
      return Response.json({ ok: true, data: { server: selected } });
    }
    return Response.json({ ok: true, data: { origin: new URL(url).origin } });
  };
  const storageA = memoryStorage();
  const storageB = memoryStorage();
  const common = { fetcher, now: () => now, monotonicNow: () => now };
  const a = client({ ...common, storage: storageA });
  const b = client({ ...common, storage: storageB });
  const [a1, a2, b1, b2] = await Promise.all([
    a.requestJson("/api/videos"), a.requestJson("/api/search?q=one"),
    b.requestJson("/api/videos"), b.requestJson("/api/search?q=two"),
  ]);
  assert.equal(discoveries, 2);
  assert.equal(a1.backend, a2.backend);
  assert.equal(b1.backend, b2.backend);
  assert.notEqual(a1.backend, b1.backend);
  assert.equal(calls.filter((call) => call.url === discoveryUrl).length, 2);
  assert.ok(calls.some((call) => call.url === `${a1.backend}/api/videos`));

  const reloaded = client({ ...common, storage: storageA, reuseStoredSelection: true });
  assert.equal((await reloaded.requestJson("/api/videos")).backend, a1.backend);
  assert.equal(discoveries, 2, "the same tab may reuse its unexpired selection on reload");

  const copiedStorage = memoryStorage(storageA.snapshot());
  const newTab = client({ ...common, storage: copiedStorage, reuseStoredSelection: false });
  await newTab.requestJson("/api/videos");
  assert.equal(discoveries, 3, "a new navigation must not reuse a copied sessionStorage entry");

  now += 59_999;
  assert.equal((await a.requestJson("/api/videos")).backend, a1.backend);
  assert.equal(discoveries, 3);
  now += 1;
  await a.requestJson("/api/videos");
  assert.equal(discoveries, 4, "the selection expires at 60 seconds, not after a later response");
  assert.ok(JSON.parse(storageA.getItem("intimora_direct_backend_v1")).expiresAt <= now + 60_000);
});

test("storage denial uses a per-tab memory cache and backend failures remain generic", async () => {
  const storage = {
    getItem() { throw new Error("storage denied"); },
    setItem() { throw new Error("storage denied"); },
    removeItem() { throw new Error("storage denied"); },
  };
  let discoveries = 0;
  const fetcher = async (url) => {
    if (url === discoveryUrl) return Response.json({ ok: true, data: { server: ++discoveries % 2 ? backendA : backendB } });
    if (url.includes("q=fail")) return Response.json({ error: `${backendA}/private?token=secret-marker` }, { status: 503 });
    if (url.includes("q=network")) throw new Error(`network failure at ${backendA}/secret-marker`);
    return Response.json({ ok: true });
  };
  const visitor = client({ fetcher, storage });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  assert.equal((await visitor.requestJson("/api/search?q=ok")).backend, backendA);
  assert.equal(discoveries, 1);
  await assert.rejects(visitor.requestJson("/api/search?q=fail"), { message: "Content is temporarily unavailable" });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendB);
  assert.equal(discoveries, 2);
  await assert.rejects(visitor.requestJson("/api/search?q=network"), { message: "Content is temporarily unavailable" });
  await visitor.requestJson("/api/videos");
  assert.equal(discoveries, 3);
});

test("a slow discovery body cannot extend the original deadline", async () => {
  let now = 1_700_000_000_000;
  let discoveries = 0;
  const fetcher = async (url) => {
    if (url !== discoveryUrl) return Response.json({ ok: true });
    const selected = ++discoveries === 1 ? backendA : backendB;
    const response = Response.json({ ok: true, data: { server: selected } });
    if (discoveries === 1) {
      const parse = response.json.bind(response);
      response.json = async () => { now += 10_000; return parse(); };
    }
    return response;
  };
  const visitor = client({ fetcher, storage: null, now: () => now, monotonicNow: () => now });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  now += 49_999;
  assert.equal((await visitor.requestJson("/api/search?q=x")).backend, backendA);
  now += 1;
  assert.equal((await visitor.requestJson("/api/search?q=x")).backend, backendB);
  assert.equal(discoveries, 2);
});

test("pinned requests use their original backend while a new selection is discovered", async () => {
  let now = 1_700_000_000_000;
  let discoveries = 0;
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (url === discoveryUrl) {
      const selected = ++discoveries === 1 ? backendA : backendB;
      await delay(5);
      return Response.json({ ok: true, data: { server: `${selected}/` } });
    }
    return Response.json({ ok: true });
  };
  const visitor = client({ fetcher, storage: null, now: () => now, monotonicNow: () => now });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  now += 60_001;
  assert.equal((await visitor.requestJson("/api/videos?cursor=next%20page", undefined, backendA)).backend, backendA);
  assert.equal(await visitor.selectBackend(), backendB);
  assert.equal((await visitor.requestJson("/api/search?q=new")).backend, backendB);
  // Likes now require Firebase auth; the public client cannot send them.
  await assert.rejects(visitor.requestJson("/api/videos/video-1/like", { method: "POST" }, backendA), { message: "Content is temporarily unavailable" });
  assert.equal((await visitor.requestJson("/api/videos/video-1/share", { method: "POST" }, backendA)).backend, backendA);
  const share = calls.find((call) => call.url === `${backendA}/api/videos/video-1/share`);
  assert.equal(share.method, "POST");
  assert.equal(share.body, "{}");
  // A simple content type keeps this POST out of the preflight path, which is the
  // only kind a cookie-less host check can answer.
  assert.equal(share.headers["Content-Type"], "text/plain");
  assert.ok(calls.some((call) => call.url === `${backendA}/api/videos?cursor=next%20page`));
});

test("invalid or credential-bearing targets, malformed routes, and bad discovery fail generically", async () => {
  const badTargets = [
    "http://a.example", "https://a.example/?token=secret-marker", "https://user:secret-marker@a.example",
    "https://a.example/#secret-marker", "https://localhost", "https://127.0.0.1", "https://10.0.0.1",
    "https://192.168.1.1", "https://[::1]", "javascript:alert(1)",
  ];
  for (const server of badTargets) {
    let calls = 0;
    const visitor = client({ storage: null, fetcher: async () => {
      calls += 1;
      return Response.json({ ok: true, data: { server } });
    } });
    await assert.rejects(visitor.requestJson("/api/videos"), { message: "Content is temporarily unavailable" });
    assert.equal(calls, 1, "an unsafe discovery result must never be contacted");
  }
  const urls = [];
  const visitor = client({ storage: null, fetcher: async (url) => {
    urls.push(url);
    return url === discoveryUrl ? Response.json({ ok: true, data: { server: `${backendA}/base/` } }) : Response.json({ ok: true });
  } });
  await visitor.requestJson("/api/videos");
  assert.equal(urls.at(-1), `${backendA}/base/api/videos`);
  await visitor.requestJson("/api/videos?cursor=next&limit=50");
  assert.equal(urls.at(-1), `${backendA}/base/api/videos?cursor=next&limit=50`);
  const before = urls.length;
  for (const route of ["/api/admin", "/api/videos/../admin", "//evil.example/api/videos", "/api/videos?unexpected=1", "/api/videos?limit=0", "/api/videos?limit=51", "/api/videos?limit=1&limit=2", "/api/videos?limit=secret-marker"]) {
    await assert.rejects(visitor.requestJson(route), { message: "Content is temporarily unavailable" });
  }
  assert.equal(urls.length, before);
  await assert.rejects(visitor.requestJson("/api/videos/video-1/like"), { message: "Content is temporarily unavailable" });
  await assert.rejects(visitor.requestJson("/api/videos", { method: "POST" }), { message: "Content is temporarily unavailable" });
});

test("untrusted stored timestamps cannot extend a route and backward clocks expire it", async () => {
  let now = 100_000;
  let discoveries = 0;
  const storage = memoryStorage({
    intimora_direct_backend_v1: JSON.stringify({ backend: backendA, selectedAt: now, expiresAt: now + 600_000 }),
  });
  const fetcher = async (url) => url === discoveryUrl
    ? Response.json({ ok: true, data: { server: ++discoveries % 2 ? backendB : backendA } })
    : Response.json({ ok: true });
  const visitor = client({ storage, fetcher, now: () => now, monotonicNow: () => now, reuseStoredSelection: true });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendB);
  assert.equal(discoveries, 1);
  now -= 1;
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  assert.equal(discoveries, 2);
});

test("optional public like-count requests are bounded, read-only, pinned, and do not disrupt routing", async () => {
  const calls = [];
  let discoveries = 0;
  let failCounts = false;
  let oversized = false;
  const visitor = client({ storage: null, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url === discoveryUrl) {
      discoveries += 1;
      return Response.json({ ok: true, data: { server: backendA } });
    }
    if (url.includes("/api/likes/counts")) {
      if (failCounts) return Response.json({ ok: false }, { status: 503 });
      if (oversized) return new Response(JSON.stringify({ ok: true, data: { padding: "x".repeat(33_000) } }));
      return Response.json({ ok: true, data: { counts: [{ id: "video-1", likes: 4, version: 2 }] } });
    }
    return Response.json({ ok: true });
  } });
  await visitor.requestJson("/api/videos");
  const result = await visitor.requestJson("/api/likes/counts?ids=video-1%2Cvideo-2", undefined, backendA);
  assert.equal(result.body.data.counts[0].likes, 4);
  const request = calls.at(-1);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers, undefined, "public counts never carry an auth token");
  const before = calls.length;
  const tooMany = Array.from({ length: 21 }, (_, index) => `video-${index}`).join(",");
  for (const route of [
    "/api/likes/counts", "/api/likes/counts?ids=", "/api/likes/counts?ids=one,one",
    "/api/likes/counts?ids=../private", "/api/likes/counts?ids=one&ids=two",
    "/api/likes/counts?ids=one&token=secret", `/api/likes/counts?ids=${tooMany}`,
  ]) await assert.rejects(visitor.requestJson(route, undefined, backendA), { message: "Content is temporarily unavailable" });
  await assert.rejects(visitor.requestJson("/api/likes/counts?ids=one", { method: "POST" }, backendA), { message: "Content is temporarily unavailable" });
  assert.equal(calls.length, before);
  failCounts = true;
  await assert.rejects(visitor.requestJson("/api/likes/counts?ids=video-1", undefined, backendA), { message: "Content is temporarily unavailable" });
  failCounts = false;
  oversized = true;
  await assert.rejects(visitor.requestJson("/api/likes/counts?ids=video-1", undefined, backendA), { message: "Content is temporarily unavailable" });
  await visitor.requestJson("/api/videos");
  assert.equal(discoveries, 1, "an unavailable optional endpoint does not evict the active backend");
});

test("aborting an optional like poll cancels its request without changing the backend", async () => {
  let discoveries = 0;
  let aborted = false;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const visitor = client({ storage: null, fetcher: async (url, init) => {
    if (url === discoveryUrl) {
      discoveries += 1;
      return Response.json({ ok: true, data: { server: backendA } });
    }
    if (url.includes("/api/likes/counts")) {
      started();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
    }
    return Response.json({ ok: true });
  } });
  await visitor.requestJson("/api/videos");
  const controller = new AbortController();
  const pending = visitor.requestJson("/api/likes/counts?ids=one", { signal: controller.signal }, backendA);
  await requestStarted;
  controller.abort();
  await assert.rejects(pending, { message: "Content is temporarily unavailable" });
  assert.equal(aborted, true);
  await visitor.requestJson("/api/videos");
  assert.equal(discoveries, 1);
});

test("the visitor log posts once per page load as a simple text/plain request through the visitor route", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === discoveryUrl) return Response.json({ ok: true, data: { server: backendA } });
    return Response.json({ ok: true, data: { logged: true } });
  };
  const route = client({ fetcher, storage: memoryStorage() });
  const payload = JSON.stringify({ ua: "agent", path: "/", screen: "390x844" });

  const result = await route.requestJson("/api/visit", { method: "POST", body: payload });
  assert.equal(result.backend, backendA);
  const posted = calls.find((call) => call.url === `${backendA}/api/visit`);
  assert.ok(posted, "the log reaches the backend");
  assert.equal(posted.init.method, "POST");
  assert.equal(posted.init.headers["Content-Type"], "text/plain", "no preflight on a free host");
  assert.equal(posted.init.body, payload);
  assert.equal(posted.init.credentials, "omit", "an ordinary backend stays credential-free");
  assert.equal(posted.init.referrerPolicy, "no-referrer");
  assert.equal(posted.init.cache, "no-store");

  const before = calls.length;
  await assert.rejects(() => route.requestJson("/api/visit"), /unavailable/i);
  await assert.rejects(() => route.requestJson("/api/visit?ua=x", { method: "POST", body: payload }), /unavailable/i);
  await assert.rejects(() => route.requestJson("/api/visit", { method: "POST", body: "x".repeat(2049) }), /unavailable/i);
  assert.equal(calls.length, before, "a wrong shape never reaches the backend");
});

test("the visitor log uses the PHP cookie and hands over to the unlock page instead of failing silently", async () => {
  const calls = [];
  const unlocks = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === discoveryUrl) return Response.json({ ok: true, data: { server: backendA, php: true } });
    return new Response("<html>check</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  };
  const route = createVisitorRequest({
    discoveryUrl,
    fetcher,
    storage: memoryStorage(),
    requestUnlock: ({ path, challenge }) => { unlocks.push({ path, challenge }); return true; },
  });

  await assert.rejects(() => route.requestJson("/api/visit", { method: "POST", body: "{}" }), /unavailable/i);
  const posted = calls.find((call) => call.url === `${backendA}/api/visit`);
  assert.ok(posted, "the log reached the PHP host");
  assert.equal(posted.init.credentials, "include", "the PHP cookie travels with the log");
  assert.equal(posted.init.redirect, "follow");
  assert.deepEqual(unlocks, [{ path: "/api/visit", challenge: true }], "the visitor is sent to the host's own unlock page");
});

// A Vercel deployment can refuse a call on its own: a WAF rule, a rate limit, or a
// host that answers the browser only from one region. Retrying the same call on the
// same host cannot help, and a visitor must not be sent through a lock page for it —
// so the refusal is reported as such, with the host's own status.
test("a call the host itself refuses is reported as refused, not retried forever", async () => {
  const refused = [];
  const cases = [
    { status: 403, body: { error: "Forbidden" }, contentType: "application/json" },
    { status: 401, body: { error: "Unauthorized" }, contentType: "application/json" },
    { status: 404, body: { ok: false }, contentType: "application/json" },
    // Vercel's own HTML error page, which is not this backend's JSON contract.
    { status: 403, body: "<html>Access denied</html>", contentType: "text/html" },
  ];
  for (const item of cases) {
    const unlocks = [];
    const request = client({
      fetcher: async (url) => url === discoveryUrl
        ? Response.json({ ok: true, data: { server: backendA } })
        : new Response(typeof item.body === "string" ? item.body : JSON.stringify(item.body), {
          status: item.status, headers: { "Content-Type": item.contentType },
        }),
      requestUnlock: (info) => { unlocks.push(info); return false; },
    });
    await assert.rejects(
      () => request.requestJson("/api/videos/local-1"),
      (error) => {
        assert.equal(error.refused, true, `a ${item.status} is a refusal`);
        assert.equal(error.detailFailed, true, "the caller can tell it apart from a missing video");
        assert.equal(error.status, item.status, "the host's own status is kept");
        return true;
      },
    );
    refused.push(item.status);
    assert.deepEqual(unlocks, [], "a refused answer never triggers a lock-page navigation");
  }
  assert.deepEqual(refused, [403, 401, 404, 403]);
});
