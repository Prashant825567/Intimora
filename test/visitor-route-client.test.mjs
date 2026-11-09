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
  assert.equal(share.headers["Content-Type"], "application/json");
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
