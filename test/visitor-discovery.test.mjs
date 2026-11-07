import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAppServer } from "../server/index.mjs";

const ROUTE_HEADER = "x-intimora-route";
const TTL_HEADER = "x-intimora-route-ttl";
const SECRET = "visitor-routing-test-secret-0123456789";
const PRIVATE = "upstream-private-marker";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", "X-Private": PRIVATE });
  res.end(JSON.stringify(payload));
}

function makeBackend(label, calls) {
  let base;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://internal.invalid");
    calls.push({ backend: label, path: url.pathname, query: url.search, range: req.headers.range, route: req.headers[ROUTE_HEADER] });
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
      if (url.searchParams.get("q") === "fail") return json(res, 500, { secret: PRIVATE });
      return json(res, 200, {
        ok: true,
        data: {
          videos: [{ id: "video-1", title: `Backend ${label}`, category: "New", thumbnailUrl: `${base}/private-image` }],
          nextCursor: `cursor-${label}`,
          privateField: PRIVATE,
        },
      });
    }
    if (url.pathname === "/private-image") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(`image-${label}`);
    }
    if (url.pathname === "/api/videos/video-1/stream") {
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/10", "Accept-Ranges": "bytes" });
      return res.end(`stream-${label}`);
    }
    if (url.pathname === "/api/videos/video-1") return json(res, 200, { ok: true, secret: PRIVATE });
    return json(res, 404, { secret: PRIVATE });
  });
  return { server, setBase(value) { base = value; } };
}

async function sessionRequest(base, path, token, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set(ROUTE_HEADER, token);
  return fetch(`${base}${path}`, { ...options, headers });
}

test("each visitor gets an independent 60-second discovery selection and pinned media", async () => {
  const calls = [];
  const backends = ["A", "B", "C"].map((label) => makeBackend(label, calls));
  let discoveryCount = 0;
  let refreshIndex = 1;
  let now = 1_700_000_000_000;
  const addresses = [];
  const discovery = createServer((_req, res) => {
    // The fourth discovery intentionally selects a different backend for A.
    const index = [0, 1, 2, refreshIndex, 0][discoveryCount % 5];
    discoveryCount += 1;
    json(res, 200, { ok: true, data: { server: addresses[index], secret: PRIVATE } });
  });
  let app;
  let secondApp;
  try {
    for (const backend of backends) {
      const address = await listen(backend.server);
      backend.setBase(address);
      addresses.push(address);
    }
    const discoveryUrl = await listen(discovery);
    const options = { discoveryUrl, allowLoopback: true, tokenSecret: SECRET, now: () => now };
    app = createAppServer({ apiOptions: options });
    secondApp = createAppServer({ apiOptions: options });
    const appUrl = await listen(app);
    const secondAppUrl = await listen(secondApp);

    // Concurrent new visitors do not share an in-flight discovery or a cache.
    const [a, b] = await Promise.all([
      sessionRequest(appUrl, "/_api/api/videos"),
      sessionRequest(appUrl, "/_api/api/videos"),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const bodyA = await a.text();
    const bodyB = await b.text();
    const dataA = JSON.parse(bodyA).data;
    const dataB = JSON.parse(bodyB).data;
    assert.deepEqual(new Set([dataA.videos[0].title, dataB.videos[0].title]), new Set(["Backend A", "Backend B"]));
    assert.equal(discoveryCount, 2);
    const tokenA = a.headers.get(ROUTE_HEADER);
    const tokenB = b.headers.get(ROUTE_HEADER);
    assert.ok(tokenA && tokenB && tokenA !== tokenB);
    assert.ok(Number(a.headers.get(TTL_HEADER)) > 0 && Number(a.headers.get(TTL_HEADER)) <= 60_000);
    for (const value of [...addresses, discoveryUrl, PRIVATE]) {
      assert.ok(!bodyA.includes(value) && !bodyB.includes(value));
      assert.ok(!JSON.stringify([...a.headers]).includes(value));
      assert.ok(!JSON.stringify([...b.headers]).includes(value));
      assert.ok(!tokenA.includes(value) && !tokenB.includes(value));
    }

    const labelA = dataA.videos[0].title.at(-1);
    const labelB = dataB.videos[0].title.at(-1);
    refreshIndex = labelA === "A" ? 1 : 0;
    const searchA = await sessionRequest(appUrl, "/_api/api/search?q=hello", tokenA);
    const searchB = await sessionRequest(secondAppUrl, "/_api/api/search?q=hello", tokenB);
    assert.equal((await searchA.json()).data.videos[0].title, `Backend ${labelA}`);
    assert.equal((await searchB.json()).data.videos[0].title, `Backend ${labelB}`);
    assert.equal(discoveryCount, 2, "selection survives requests and another app instance");
    assert.ok(calls.every((call) => call.route === undefined), "visitor tokens are never forwarded upstream");

    // Thumbnail and fallback stream URLs are opaque and remain pinned without headers.
    assert.match(dataA.videos[0].thumbnailUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
    assert.match(dataA.videos[0].streamUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
    assert.equal(await (await fetch(`${secondAppUrl}${dataA.videos[0].thumbnailUrl}`)).text(), `image-${labelA}`);
    const streamB = await fetch(`${appUrl}${dataB.videos[0].streamUrl}`, { headers: { Range: "bytes=0-3" } });
    assert.equal(streamB.status, 206);
    assert.equal(streamB.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(await streamB.text(), `stream-${labelB}`);
    assert.equal(discoveryCount, 2, "media does not trigger a new discovery per thumbnail or range request");

    now += 30_000;
    const c = await sessionRequest(appUrl, "/_api/api/videos");
    const dataC = (await c.json()).data;
    const tokenC = c.headers.get(ROUTE_HEADER);
    assert.equal(dataC.videos[0].title, "Backend C");
    assert.equal(discoveryCount, 3);

    now += 31_000;
    const refreshedA = await sessionRequest(appUrl, "/_api/api/search?q=hello", tokenA);
    const tokenA2 = refreshedA.headers.get(ROUTE_HEADER);
    assert.ok(tokenA2 && tokenA2 !== tokenA);
    assert.equal((await refreshedA.json()).data.videos[0].title, `Backend ${refreshIndex === 0 ? "A" : "B"}`);
    assert.equal(discoveryCount, 4);
    const stillC = await sessionRequest(secondAppUrl, "/_api/api/search?q=hello", tokenC);
    assert.equal((await stillC.json()).data.videos[0].title, "Backend C");
    assert.equal(discoveryCount, 4, "one visitor's expiry does not invalidate another visitor");

    // Previously issued media and page cursors continue on their originating backend.
    assert.equal(await (await fetch(`${appUrl}${dataA.videos[0].thumbnailUrl}`)).text(), `image-${labelA}`);
    const next = await sessionRequest(appUrl, `/_api/api/videos?cursor=${encodeURIComponent(dataA.nextCursor)}`, tokenA2);
    assert.equal(next.status, 200);
    assert.equal((await next.json()).data.videos[0].title, `Backend ${labelA}`);
    assert.ok(calls.some((call) => call.backend === labelA && new URLSearchParams(call.query).get("cursor") === `cursor-${labelA}`));
    assert.equal(discoveryCount, 4);

    const failed = await sessionRequest(appUrl, "/_api/api/search?q=fail", tokenA2);
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes(PRIVATE));
    const cAgain = await sessionRequest(appUrl, "/_api/api/search?q=hello", tokenC);
    assert.equal((await cAgain.json()).data.videos[0].title, "Backend C");
    assert.equal(discoveryCount, 4, "a failed request cannot invalidate another visitor's selection");

    const forged = await sessionRequest(appUrl, "/_api/api/search?q=hello", `${tokenC.slice(0, -1)}${tokenC.endsWith("A") ? "B" : "A"}`);
    assert.equal(forged.status, 200);
    assert.equal(discoveryCount, 5, "tampered tokens cannot select a backend");
    const malformed = await sessionRequest(appUrl, "/_api/api/search?q=hello", "not-a-valid-url:/secret");
    assert.equal(malformed.status, 400);
    assert.equal(discoveryCount, 5);
  } finally {
    await close(secondApp);
    await close(app);
    await close(discovery);
    for (const backend of backends) await close(backend.server);
  }
});

test("visitor TTL excludes time already spent waiting for the backend", async () => {
  let now = 1_700_000_000_000;
  const backend = createServer((_req, res) => {
    now += 45_000;
    json(res, 200, { ok: true, data: { videos: [], nextCursor: null } });
  });
  let discovery;
  let app;
  try {
    const backendUrl = await listen(backend);
    discovery = createServer((_req, res) => json(res, 200, { ok: true, data: { server: backendUrl } }));
    const discoveryUrl = await listen(discovery);
    app = createAppServer({ apiOptions: { discoveryUrl, allowLoopback: true, tokenSecret: SECRET, now: () => now } });
    const response = await fetch(`${await listen(app)}/_api/api/videos`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-intimora-route-ttl"), "15000");
  } finally {
    await Promise.all([close(app), close(discovery), close(backend)]);
  }
});

test("existing media and cursor tokens remain accepted after upgrading", async () => {
  const calls = [];
  const backend = makeBackend("A", calls);
  let app;
  const now = 1_700_000_000_000;
  function legacyToken(purpose, value) {
    const key = createHash("sha256").update(SECRET).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ purpose, value, expires: now + 24 * 60 * 60 * 1000 })),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  try {
    const backendUrl = await listen(backend.server);
    backend.setBase(backendUrl);
    app = createAppServer({ apiOptions: { upstreamUrl: backendUrl, allowLoopback: true, tokenSecret: SECRET, now: () => now } });
    const appUrl = await listen(app);
    const image = legacyToken("thumbnail", `${backendUrl}/private-image`);
    assert.equal(await (await fetch(`${appUrl}/_api/media/${image}`)).text(), "image-A");
    const stream = legacyToken("stream", `${backendUrl}/api/videos/video-1/stream`);
    const video = await fetch(`${appUrl}/_api/media/${stream}`, { headers: { Range: "bytes=0-3" } });
    assert.equal(video.status, 206);
    assert.equal(await video.text(), "stream-A");
    const cursor = legacyToken("cursor", "legacy-cursor");
    const page = await fetch(`${appUrl}/_api/api/videos?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(page.status, 200);
    assert.ok(calls.some((call) => new URLSearchParams(call.query).get("cursor") === "legacy-cursor"));
  } finally {
    await close(app);
    await close(backend.server);
  }
});

test("a revoked visitor selection is replaced without bypassing the new allowlist", async () => {
  const calls = [];
  const first = makeBackend("A", calls);
  const second = makeBackend("B", calls);
  let appA;
  let appB;
  try {
    const addressA = await listen(first.server);
    const addressB = await listen(second.server);
    first.setBase(addressA);
    second.setBase(addressB);
    const baseOptions = { allowLoopback: true, tokenSecret: SECRET };
    appA = createAppServer({ apiOptions: { ...baseOptions, upstreamUrl: addressA, allowedHosts: new URL(addressA).host } });
    appB = createAppServer({ apiOptions: { ...baseOptions, upstreamUrl: addressB, allowedHosts: new URL(addressB).host } });
    const urlA = await listen(appA);
    const urlB = await listen(appB);
    const original = await sessionRequest(urlA, "/_api/api/videos");
    const tokenA = original.headers.get(ROUTE_HEADER);
    const dataA = (await original.json()).data;
    const replacement = await sessionRequest(urlB, "/_api/api/videos", tokenA);
    assert.equal(replacement.status, 200);
    assert.equal((await replacement.json()).data.videos[0].title, "Backend B");
    assert.notEqual(replacement.headers.get(ROUTE_HEADER), tokenA);
    const revokedMedia = await fetch(`${urlB}${dataA.videos[0].thumbnailUrl}`);
    assert.notEqual(revokedMedia.status, 200);
    assert.ok(!(await revokedMedia.text()).includes(addressA));
  } finally {
    await Promise.all([close(appA), close(appB), close(first.server), close(second.server)]);
  }
});
