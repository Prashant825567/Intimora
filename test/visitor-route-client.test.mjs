import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";

function memoryStorage() {
  const entries = new Map();
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
  };
}

test("separate tabs initialize independently and reuse only their own short-lived route", async () => {
  const calls = [];
  let discoveries = 0;
  let now = 1_700_000_000_000;
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, "error", "routing tokens must not follow redirects");
    const sent = init.headers.get("x-intimora-route");
    calls.push({ url, token: sent });
    if (url === "/fail") return new Response("unavailable", { status: 503 });
    let token = sent;
    if (!token) {
      token = `selection${++discoveries}`;
      await delay(15);
    }
    return Response.json({ selected: token }, {
      headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" },
    });
  };
  const storageA = memoryStorage();
  const storageB = memoryStorage();
  const visitorA = createVisitorRequest({ fetcher, storage: storageA, now: () => now });
  const visitorB = createVisitorRequest({ fetcher, storage: storageB, now: () => now });

  const [a1, a2, b1, b2] = await Promise.all([
    visitorA("/catalog"), visitorA("/search"), visitorB("/catalog"), visitorB("/detail"),
  ]);
  assert.equal(discoveries, 2, "each visitor starts one independent discovery");
  assert.equal(a1.selected, a2.selected);
  assert.equal(b1.selected, b2.selected);
  assert.notEqual(a1.selected, b1.selected);
  assert.equal(calls.filter((call) => call.token === null).length, 2);

  // Reloading the same tab reuses its own unexpired encrypted selection.
  const reloadedA = createVisitorRequest({ fetcher, storage: storageA, now: () => now });
  assert.equal((await reloadedA("/search")).selected, a1.selected);
  assert.equal(discoveries, 2);

  now += 30_000;
  const visitorC = createVisitorRequest({ fetcher, storage: memoryStorage(), now: () => now });
  const c = await visitorC("/catalog");
  assert.equal(discoveries, 3);
  now += 31_000;
  const renewedA = await visitorA("/catalog");
  assert.notEqual(renewedA.selected, a1.selected);
  assert.equal(discoveries, 4);
  assert.equal((await visitorC("/search")).selected, c.selected);
  assert.equal(discoveries, 4, "one visitor expiring cannot erase another's cache");

  await assert.rejects(visitorA("/fail"), { message: "Content is temporarily unavailable" });
  assert.equal((await visitorC("/search")).selected, c.selected);
  await visitorA("/catalog");
  assert.equal(discoveries, 5, "a failed backend is rediscovered for the affected visitor");
});

test("storage denial keeps an in-memory per-tab selection and errors stay generic", async () => {
  const storage = {
    getItem() { throw new Error("storage denied"); },
    setItem() { throw new Error("storage denied"); },
    removeItem() { throw new Error("storage denied"); },
  };
  let discoveries = 0;
  const fetcher = async (url, init) => {
    if (url === "/network-failure") throw new Error("private connection details");
    const token = init.headers.get("x-intimora-route") ?? `selection${++discoveries}`;
    return Response.json({ selected: token }, {
      headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" },
    });
  };
  const visitor = createVisitorRequest({ fetcher, storage });
  const a = await visitor("/catalog");
  const b = await visitor("/search");
  assert.equal(a.selected, b.selected);
  assert.equal(discoveries, 1);
  await assert.rejects(visitor("/network-failure"), { message: "Content is temporarily unavailable" });
  await visitor("/catalog");
  assert.equal(discoveries, 2);
});

test("a slow response body cannot extend the visitor selection's lifetime", async () => {
  let now = 1_700_000_000_000;
  let discoveries = 0;
  const fetcher = async (_url, init) => {
    const token = init.headers.get("x-intimora-route") ?? `selection${++discoveries}`;
    const response = Response.json({ selected: token }, { headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" } });
    const parse = response.json.bind(response);
    if (discoveries === 1) response.json = async () => { now += 10_000; return parse(); };
    return response;
  };
  const visitor = createVisitorRequest({ fetcher, storage: null, now: () => now });
  assert.equal((await visitor("/catalog")).selected, "selection1");
  now += 49_100;
  assert.equal((await visitor("/search")).selected, "selection2");
  assert.equal(discoveries, 2);
});

test("subsequent responses cannot extend the same selection beyond its original deadline", async () => {
  let now = 1_700_000_000_000;
  let discoveries = 0;
  const fetcher = async (_url, init) => {
    const token = init.headers.get("x-intimora-route") ?? `selection${++discoveries}`;
    return Response.json({ selected: token }, { headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" } });
  };
  const visitor = createVisitorRequest({ fetcher, storage: null, now: () => now });
  assert.equal((await visitor("/catalog")).selected, "selection1");
  now += 30_000;
  assert.equal((await visitor("/search")).selected, "selection1");
  now += 30_000;
  assert.equal((await visitor("/search")).selected, "selection2");
  assert.equal(discoveries, 2);
});
