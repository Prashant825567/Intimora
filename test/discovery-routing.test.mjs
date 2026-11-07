import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAppServer } from "../server/index.mjs";

const privateMarker = "private-upstream-marker";
const tokenSecret = "discovery-routing-test-secret-0123456789";

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

function json(res, value) {
  res.writeHead(200, { "Content-Type": "application/json", "X-Private": privateMarker });
  res.end(JSON.stringify(value));
}

test("discovery stays private and catalog, search and media routes use the discovered server", async () => {
  const calls = [];
  let upstreamUrl;
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, "http://internal.invalid");
    calls.push({ path: url.pathname, query: url.searchParams, method: req.method, range: req.headers.range });
    if (url.pathname === "/get-server") {
      return json(res, { ok: true, data: { server: `${upstreamUrl}/backend/`, token: privateMarker } });
    }
    if (url.pathname === "/backend/api/videos" || url.pathname === "/backend/api/search") {
      return json(res, {
        ok: true,
        data: {
          videos: [{ id: "video-1", title: "Routing test", category: "New" }],
          nextCursor: "next cursor & 2",
          privateField: `${upstreamUrl}/${privateMarker}`,
        },
      });
    }
    if (url.pathname === "/backend/api/videos/video-1/thumbnail") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end("test image");
    }
    if (url.pathname === "/backend/api/videos/video-1/stream") {
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 2-5/10", "Accept-Ranges": "bytes" });
      return res.end("2345");
    }
    if (["/backend/api/videos/video-1", "/backend/api/videos/video-1/like", "/backend/api/videos/video-1/share"].includes(url.pathname)) {
      return json(res, { ok: true, secret: privateMarker });
    }
    res.writeHead(404);
    res.end();
  });

  let app;
  try {
    upstreamUrl = await listen(upstream);
    app = createAppServer({
      apiOptions: {
        discoveryUrl: `${upstreamUrl}/get-server`,
        allowLoopback: true,
        tokenSecret,
      },
    });
    const appUrl = await listen(app);

    const catalog = await fetch(`${appUrl}/_api/api/videos`);
    assert.equal(catalog.status, 200);
    const body = await catalog.text();
    assert.ok(!body.includes(upstreamUrl));
    assert.ok(!body.includes(privateMarker));
    assert.ok(!JSON.stringify([...catalog.headers]).includes(privateMarker));
    const { videos, nextCursor } = JSON.parse(body).data;
    assert.equal(videos[0].thumbnailUrl, "/_api/api/videos/video-1/thumbnail");
    assert.equal(videos[0].streamUrl, "/_api/api/videos/video-1/stream");
    assert.ok(!nextCursor.includes("next cursor"));

    assert.equal((await fetch(`${appUrl}/_api/api/videos?cursor=${encodeURIComponent(nextCursor)}`)).status, 200);
    const query = "mobile search & सुरक्षित";
    assert.equal((await fetch(`${appUrl}/_api/api/search?q=${encodeURIComponent(query)}`)).status, 200);
    assert.deepEqual(await (await fetch(`${appUrl}/_api/api/videos/video-1`)).json(), { ok: true });
    assert.equal((await fetch(`${appUrl}${videos[0].thumbnailUrl}`)).status, 200);
    const stream = await fetch(`${appUrl}${videos[0].streamUrl}`, { headers: { Range: "bytes=2-5" } });
    assert.equal(stream.status, 206);
    assert.equal(stream.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await stream.text(), "2345");
    for (const action of ["like", "share"]) {
      const response = await fetch(`${appUrl}/_api/api/videos/video-1/${action}`, {
        method: "POST",
        headers: { Origin: appUrl, "Sec-Fetch-Site": "same-origin" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }

    assert.equal(calls.filter((call) => call.path === "/get-server").length, 1);
    assert.ok(calls.some((call) => call.path === "/backend/api/videos" && call.query.get("cursor") === "next cursor & 2"));
    assert.ok(calls.some((call) => call.path === "/backend/api/search" && call.query.get("q") === query));
    assert.ok(calls.some((call) => call.path === "/backend/api/videos/video-1/stream" && call.range === "bytes=2-5"));
    assert.ok(calls.some((call) => call.path === "/backend/api/videos/video-1/like" && call.method === "POST"));
    assert.ok(calls.some((call) => call.path === "/backend/api/videos/video-1/share" && call.method === "POST"));
  } finally {
    await close(app);
    await close(upstream);
  }
});
