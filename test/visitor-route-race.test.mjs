import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";

const discoveryUrl = "https://discovery.example/api/get-server";
const backendA = "https://a.example";
const backendB = "https://b.example";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a delayed failure from an old backend cannot clear a refreshed selection", async () => {
  let discoveries = 0;
  const slow = deferred();
  const started = deferred();
  const fetcher = async (url) => {
    if (url === discoveryUrl) return Response.json({ ok: true, data: { server: ++discoveries === 1 ? backendA : backendB } });
    if (url.endsWith("q=slow")) { started.resolve(); await slow.promise; return new Response("old failure", { status: 503 }); }
    if (url.endsWith("q=fail")) return new Response("failed", { status: 503 });
    return Response.json({ ok: true });
  };
  const visitor = createVisitorRequest({ discoveryUrl, fetcher, storage: null });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  const oldRequest = visitor.requestJson("/api/search?q=slow");
  await started.promise;
  await assert.rejects(visitor.requestJson("/api/search?q=fail"), { message: "Content is temporarily unavailable" });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendB);
  slow.resolve();
  await assert.rejects(oldRequest, { message: "Content is temporarily unavailable" });
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendB);
  assert.equal(discoveries, 2);
});

test("a failing pinned request never erases a newer backend selection", async () => {
  let discoveries = 0;
  let now = 100_000;
  const slow = deferred();
  const started = deferred();
  const fetcher = async (url) => {
    if (url === discoveryUrl) return Response.json({ ok: true, data: { server: ++discoveries === 1 ? backendA : backendB } });
    if (url.startsWith(backendA) && url.includes("cursor=")) {
      started.resolve();
      await slow.promise;
      throw new Error("private upstream error");
    }
    return Response.json({ ok: true });
  };
  const visitor = createVisitorRequest({ discoveryUrl, fetcher, storage: null, now: () => now, monotonicNow: () => now });
  await visitor.requestJson("/api/videos");
  now += 60_001;
  const oldPage = visitor.requestJson("/api/videos?cursor=old", undefined, backendA);
  await started.promise;
  assert.equal(await visitor.selectBackend(), backendB);
  slow.resolve();
  await assert.rejects(oldPage, { message: "Content is temporarily unavailable" });
  assert.equal((await visitor.requestJson("/api/search?q=next")).backend, backendB);
  assert.equal(discoveries, 2);
});

test("concurrent discovery failures are deduplicated and the next request may retry", async () => {
  let discoveries = 0;
  const blocked = deferred();
  const started = deferred();
  const fetcher = async (url) => {
    if (url === discoveryUrl) {
      discoveries += 1;
      if (discoveries === 1) { started.resolve(); await blocked.promise; throw new Error("https://private.invalid/secret"); }
      return Response.json({ ok: true, data: { server: backendA } });
    }
    return Response.json({ ok: true });
  };
  const visitor = createVisitorRequest({ discoveryUrl, fetcher, storage: null });
  const first = Promise.allSettled([visitor.requestJson("/api/videos"), visitor.requestJson("/api/search?q=demo")]);
  await started.promise;
  blocked.resolve();
  const results = await first;
  assert.equal(discoveries, 1);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.message === "Content is temporarily unavailable"));
  assert.equal((await visitor.requestJson("/api/videos")).backend, backendA);
  assert.equal(discoveries, 2);
});
