import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAppServer } from "../server/index.mjs";

const PRIVATE = "TEST_PRIVATE_VALUE_123456789";
const SECRET = "test-only-token-secret-0123456789abcdef";
let upstream;
let other;
let app;
let upstreamUrl;
let otherUrl;
let appUrl;
let distDir;
const seen = [];
let otherRequests = 0;

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

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Set-Cookie": `upstream=${PRIVATE}`,
    "X-Upstream-Secret": PRIVATE,
    "Server": PRIVATE,
  });
  res.end(JSON.stringify(value));
}

before(async () => {
  distDir = await mkdtemp(path.join(os.tmpdir(), "intimora-static-"));
  await writeFile(path.join(distDir, "index.html"), "<!doctype html><title>Intimora</title>");
  await writeFile(path.join(distDir, "logo.png"), "logo");

  other = createServer((_req, res) => {
    otherRequests += 1;
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end("should not be fetched");
  });
  otherUrl = await listen(other);

  upstream = createServer((req, res) => {
    const url = new URL(req.url, upstreamUrl);
    seen.push({ pathname: url.pathname, search: url.search, method: req.method, headers: req.headers });
    if (url.pathname === "/discover") return json(res, 200, { ok: true, data: { server: upstreamUrl, token: PRIVATE } });
    if (url.pathname === "/api/videos" || url.pathname === "/api/search") {
      if (url.searchParams.get("q") === "fail") return json(res, 500, { message: `${upstreamUrl}/${PRIVATE}` });
      return json(res, 200, {
        ok: true,
        data: {
          server: upstreamUrl,
          secret: PRIVATE,
          nextCursor: `${PRIVATE}:${upstreamUrl}/cursor`,
          videos: [
            {
              id: "video-1",
              title: "Example video",
              description: `Watch at ${upstreamUrl}/private?token=${PRIVATE}`,
              duration: 10,
              views: 42,
              category: "New",
              tags: ["example"],
              thumbnailUrl: `${upstreamUrl}/private-image?signature=${PRIVATE}`,
              streamUrl: `${upstreamUrl}/private-video?signature=${PRIVATE}`,
              creatorAvatar: `${upstreamUrl}/private-avatar?token=${PRIVATE}`,
              password: PRIVATE,
              nested: { accessToken: PRIVATE },
            },
            {
              id: "video-2",
              title: "External media",
              thumbnailUrl: `https://unlisted.example/image?token=${PRIVATE}`,
              streamUrl: `https://unlisted.example/video?token=${PRIVATE}`,
            },
            { id: "../admin", title: PRIVATE },
          ],
        },
      });
    }
    if (url.pathname === "/private-image" || url.pathname === "/api/videos/video-2/thumbnail") {
      res.writeHead(200, { "Content-Type": "image/png", "X-Upstream-Secret": PRIVATE, "Set-Cookie": `token=${PRIVATE}` });
      return res.end("image-bytes");
    }
    if (url.pathname === "/api/videos/redirect/stream") {
      res.writeHead(302, { Location: `${upstreamUrl}/private-video?signature=${PRIVATE}` });
      return res.end();
    }
    if (url.pathname === "/api/videos/unsafe/stream") {
      res.writeHead(302, { Location: `${otherUrl}/secret?token=${PRIVATE}` });
      return res.end();
    }
    if (url.pathname === "/private-video" || url.pathname === "/api/videos/video-2/stream") {
      if (req.headers.range) {
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Content-Length": "4",
          "Content-Range": "bytes 2-5/10",
          "Accept-Ranges": "bytes",
          "X-Upstream-Secret": PRIVATE,
        });
        return res.end("2345");
      }
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "10", "Accept-Ranges": "bytes" });
      return res.end(req.method === "HEAD" ? undefined : "0123456789");
    }
    if (url.pathname === "/api/videos/video-1" || url.pathname === "/api/videos/video-1/like" || url.pathname === "/api/videos/video-1/share") {
      return json(res, 200, { ok: true, token: PRIVATE, server: upstreamUrl });
    }
    return json(res, 404, { secret: PRIVATE });
  });
  upstreamUrl = await listen(upstream);

  app = createAppServer({
    distDir,
    apiOptions: { discoveryUrl: `${upstreamUrl}/discover`, allowLoopback: true, tokenSecret: SECRET },
  });
  appUrl = await listen(app);
});

after(async () => {
  await close(app);
  await close(upstream);
  await close(other);
  if (distDir) await rm(distDir, { recursive: true, force: true });
});

test("production pages have security headers and cannot serve private files", async () => {
  const response = await fetch(`${appUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self';/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`${appUrl}/.env`)).status, 404);
  assert.equal((await fetch(`${appUrl}/server/api-proxy.mjs`)).status, 404);
  assert.equal((await fetch(`${appUrl}/assets/app.js.map`)).status, 404);
});

test("catalog responses contain only public fields and opaque same-origin media and cursors", async () => {
  const response = await fetch(`${appUrl}/_api/api/videos`, {
    headers: { Authorization: `Bearer ${PRIVATE}`, Cookie: `session=${PRIVATE}`, Referer: `https://example.test/${PRIVATE}` },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(PRIVATE));
  assert.ok(!text.includes(upstreamUrl));
  assert.ok(!JSON.stringify([...response.headers]).includes(PRIVATE));
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-upstream-secret"), null);
  assert.equal(response.headers.get("server"), null);

  const data = JSON.parse(text).data;
  assert.equal(data.videos.length, 2);
  assert.equal(data.videos[0].title, "Example video");
  assert.equal(data.videos[0].description, "Watch at [link removed]");
  assert.match(data.videos[0].thumbnailUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
  assert.match(data.videos[0].streamUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
  assert.equal(data.videos[0].creatorAvatar, undefined);
  assert.equal(data.videos[0].password, undefined);
  assert.match(data.videos[1].thumbnailUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
  assert.match(data.videos[1].streamUrl, /^\/_api\/media\/[A-Za-z0-9_-]+$/);
  assert.ok(!data.nextCursor.includes(PRIVATE));
  const forwarded = seen.filter((item) => item.pathname === "/api/videos").at(-1);
  assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers.referer, undefined);

  const next = await fetch(`${appUrl}/_api/api/videos?cursor=${encodeURIComponent(data.nextCursor)}`);
  assert.equal(next.status, 200);
  const nextRequest = seen.filter((item) => item.pathname === "/api/videos").at(-1);
  assert.equal(new URLSearchParams(nextRequest.search).get("cursor"), `${PRIVATE}:${upstreamUrl}/cursor`);
  assert.equal((await fetch(`${appUrl}/_api/api/videos?cursor=not-a-valid-token`)).status, 400);
  assert.equal((await fetch(`${appUrl}/_api/api/videos?url=https%3A%2F%2Fevil.test`)).status, 400);
});

test("opaque media tokens hide URLs, preserve range requests, and reject tampering", async () => {
  const data = (await (await fetch(`${appUrl}/_api/api/videos`)).json()).data;
  const image = await fetch(`${appUrl}${data.videos[0].thumbnailUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("set-cookie"), null);
  assert.equal(await image.text(), "image-bytes");

  const stream = await fetch(`${appUrl}${data.videos[0].streamUrl}`, { headers: { Range: "bytes=2-5" } });
  assert.equal(stream.status, 206);
  assert.equal(stream.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(stream.headers.get("accept-ranges"), "bytes");
  assert.equal(stream.headers.get("x-upstream-secret"), null);
  assert.equal(await stream.text(), "2345");
  assert.equal(seen.filter((item) => item.pathname === "/private-video").at(-1).headers.range, "bytes=2-5");

  const head = await fetch(`${appUrl}${data.videos[0].streamUrl}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  const token = data.videos[0].streamUrl;
  const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.equal((await fetch(`${appUrl}${changed}`)).status, 404);
  assert.equal((await fetch(`${appUrl}${data.videos[0].streamUrl}`, { headers: { Range: "bytes=1-2,5-6" } })).status, 416);
  assert.equal((await fetch(`${appUrl}${data.videos[1].thumbnailUrl}`)).status, 200);
});

test("redirects are followed privately only to allowed hosts", async () => {
  const safe = await fetch(`${appUrl}/_api/api/videos/redirect/stream`, { redirect: "manual" });
  assert.equal(safe.status, 200);
  assert.equal(safe.headers.get("location"), null);
  assert.equal(await safe.text(), "0123456789");
  const unsafe = await fetch(`${appUrl}/_api/api/videos/unsafe/stream`, { redirect: "manual" });
  assert.equal(unsafe.status, 503);
  assert.equal(unsafe.headers.get("location"), null);
  assert.ok(!(await unsafe.text()).includes(PRIVATE));
  assert.equal(otherRequests, 0);
});

test("explicit allowlists constrain discovery and permit approved media redirects", async () => {
  const restricted = createAppServer({
    distDir,
    apiOptions: { discoveryUrl: `${upstreamUrl}/discover`, allowedHosts: "different.example", allowLoopback: true, tokenSecret: SECRET },
  });
  const approved = createAppServer({
    distDir,
    apiOptions: { upstreamUrl, mediaAllowedHosts: new URL(otherUrl).host, allowLoopback: true, tokenSecret: SECRET },
  });
  const restrictedUrl = await listen(restricted);
  const approvedUrl = await listen(approved);
  try {
    assert.equal((await fetch(`${restrictedUrl}/_api/api/videos`)).status, 503);
    const media = await fetch(`${approvedUrl}/_api/api/videos/unsafe/stream`, { redirect: "manual" });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("location"), null);
    assert.equal(await media.text(), "should not be fetched");
  } finally {
    await close(restricted);
    await close(approved);
  }
});

test("failures and non-catalog responses do not expose upstream data", async () => {
  const failed = await fetch(`${appUrl}/_api/api/search?q=fail`);
  assert.equal(failed.status, 503);
  const body = await failed.text();
  assert.ok(!body.includes(PRIVATE));
  assert.ok(!body.includes(upstreamUrl));
  assert.ok(!JSON.stringify([...failed.headers]).includes(PRIVATE));
  const detail = await fetch(`${appUrl}/_api/api/videos/video-1`);
  assert.deepEqual(await detail.json(), { ok: true });
  assert.equal(detail.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${appUrl}/_api/admin`)).status, 404);
  assert.equal((await fetch(`${appUrl}/_api/api/videos/%2e%2e%2fadmin`)).status, 404);
  assert.equal((await fetch(`${appUrl}/_api/api/videos/video-1/like`)).status, 405);
});

test("mutations reject cross-origin requests and never forward upstream bodies", async () => {
  const count = () => seen.filter((item) => item.pathname === "/api/videos/video-1/like").length;
  const previous = count();
  const rejected = await fetch(`${appUrl}/_api/api/videos/video-1/like`, {
    method: "POST", headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(rejected.status, 403);
  assert.equal(count(), previous);
  const accepted = await fetch(`${appUrl}/_api/api/videos/video-1/like`, {
    method: "POST", headers: { Origin: appUrl, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.equal(count(), previous + 1);
  assert.equal(accepted.headers.get("set-cookie"), null);
});

test("production rejects private network destinations", async () => {
  const restricted = createAppServer({
    distDir,
    apiOptions: { upstreamUrl: "https://169.254.169.254", discoveryUrl: "", tokenSecret: SECRET },
  });
  const url = await listen(restricted);
  try {
    const response = await fetch(`${url}/_api/api/videos`);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("169.254.169.254"));
  } finally {
    await close(restricted);
  }
});
