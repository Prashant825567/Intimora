import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";

test("an old successful response cannot restore a selection cleared by a concurrent failure", async () => {
  let discoveries = 0;
  const fetcher = async (url, init) => {
    const token = init.headers.get("x-intimora-route") ?? `route${++discoveries}`;
    if (url === "/fail") {
      await delay(5);
      return new Response("unavailable", { status: 503 });
    }
    if (url === "/slow") await delay(30);
    return Response.json({ token }, { headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" } });
  };
  const request = createVisitorRequest({ fetcher, storage: null });
  assert.equal((await request("/initial")).token, "route1");
  const outcomes = await Promise.allSettled([request("/fail"), request("/slow")]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal((await request("/after")).token, "route2");
  assert.equal(discoveries, 2);
});

test("a delayed response cannot replace a selection already refreshed by another request", async () => {
  const fetcher = async (url, init) => {
    let token = init.headers.get("x-intimora-route") ?? "route1";
    if (url === "/refresh") { await delay(5); token = "route2"; }
    if (url === "/stale") await delay(30);
    return Response.json({ token }, { headers: { "x-intimora-route": token, "x-intimora-route-ttl": "60000" } });
  };
  const request = createVisitorRequest({ fetcher, storage: null });
  assert.equal((await request("/initial")).token, "route1");
  await Promise.all([request("/refresh"), request("/stale")]);
  assert.equal((await request("/after")).token, "route2");
});
