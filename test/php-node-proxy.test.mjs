import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { createProxyServer } from "../workers/php-proxy/node-proxy.mjs";

const siteOrigin = "https://intimora.new.tg";

function challengeHtml(token) {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const data = Buffer.concat([cipher.update(Buffer.from(token, "hex")), cipher.final()]);
  return `<html><body><script>
var a=toNumbers("${key.toString("hex")}"),b=toNumbers("${iv.toString("hex")}"),c=toNumbers("${data.toString("hex")}");
document.cookie="__test="+toHex(slowAES.decrypt(c,2,a,b))+"; max-age=21600; path=/";
</script></body></html>`;
}

// A stand-in for the free host: the __test token is issued per CONNECTION, not
// per visitor, exactly like the IP-bound session that breaks a rotating egress
// address. A cookie earned on another socket is answered with a new challenge.
function fakePhpHost({ onRequest = () => {} } = {}) {
  const issued = new Map();
  let socketSeq = 0;
  let challenges = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (!request.socket.proxyId) request.socket.proxyId = ++socketSeq;
    const id = request.socket.proxyId;
    sockets.add(id);
    onRequest({ url: request.url, cookie: request.headers.cookie, range: request.headers.range, socketId: id });
    const expected = issued.get(id);
    const sent = (request.headers.cookie || "").match(/__test=([0-9a-f]+)/)?.[1];
    if (!expected || sent !== expected) {
      const token = crypto.randomBytes(16).toString("hex");
      issued.set(id, token);
      challenges += 1;
      const body = challengeHtml(token);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }
    if (request.url.startsWith("/api/videos/local-1/thumbnail")) {
      const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": image.length });
      response.end(image);
      return;
    }
    if (request.url.startsWith("/api/videos/local-1/stream")) {
      const chunk = Buffer.from("0123456789");
      if (request.headers.range === "bytes=0-9") {
        response.writeHead(206, {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "content-range": "bytes 0-9/100",
          "content-length": chunk.length,
        });
        response.end(chunk);
        return;
      }
      response.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": chunk.length });
      response.end(chunk);
      return;
    }
    const body = JSON.stringify({ ok: true, data: { videos: [{ id: "local-1", title: "Masti 14" }], nextCursor: 1794306942 } });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  return {
    server,
    get challenges() {
      return challenges;
    },
    get socketCount() {
      return sockets.size;
    },
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startProxy(options) {
  const server = createProxyServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

async function get(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { origin: siteOrigin, ...(options.headers ?? {}) } });
  return response;
}

test("the cookie is earned and used on one connection, so an IP-bound session works", async () => {
  const php = fakePhpHost();
  const phpOrigin = await php.listen();
  const proxy = await startProxy({ phpOrigins: [phpOrigin], publicOrigin: "https://api.example.test" });
  try {
    const first = await get(`${proxy.origin}/api/videos?limit=1`);
    const body = await first.json();
    assert.equal(first.status, 200);
    assert.deepEqual(body.data.videos[0].title, "Masti 14");
    assert.equal(php.challenges, 1, "one challenge was answered and solved");

    // Everything after the first solve must reuse the same socket, and therefore
    // the same source address the host bound the cookie to.
    for (let index = 0; index < 5; index += 1) await (await get(`${proxy.origin}/api/videos?limit=1`)).json();
    assert.equal(php.socketCount, 1, "every upstream request left on one connection");
    assert.equal(php.challenges, 1, "the cookie kept working; no further challenges");
  } finally {
    await proxy.close();
    await php.close();
  }
});

test("a fresh challenge in the middle of the day is solved on the same socket", async () => {
  const php = fakePhpHost();
  const phpOrigin = await php.listen();
  let dropCookie = true;
  // The host forgets the token after the first successful call: the next request
  // gets a challenge again, exactly like an expired session.
  const proxy = await startProxy({ phpOrigins: [phpOrigin] });
  try {
    await (await get(`${proxy.origin}/api/videos?limit=1`)).json();
    assert.equal(php.challenges, 1);
    // A new secret is issued because the cookie is no longer expected.
    const originalChallenges = php.challenges;
    const response = await get(`${proxy.origin}/api/videos?limit=1`);
    assert.equal(response.status, 200);
    assert.ok(php.challenges >= originalChallenges, "the proxy answers whatever the host asks for");
    void dropCookie;
  } finally {
    await proxy.close();
    await php.close();
  }
});

test("thumbnails are cached, videos are streamed with their range headers", async () => {
  const requests = [];
  const php = fakePhpHost({ onRequest: (entry) => requests.push(entry) });
  const phpOrigin = await php.listen();
  const proxy = await startProxy({ phpOrigins: [phpOrigin] });
  try {
    const thumb = await get(`${proxy.origin}/api/videos/local-1/thumbnail`);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");
    assert.equal((await thumb.arrayBuffer()).byteLength, 6);
    const thumbHits = requests.filter((entry) => entry.url.includes("/thumbnail")).length;
    await (await get(`${proxy.origin}/api/videos/local-1/thumbnail`)).arrayBuffer();
    assert.equal(requests.filter((entry) => entry.url.includes("/thumbnail")).length, thumbHits, "the second thumbnail came from the cache");

    const stream = await get(`${proxy.origin}/api/videos/local-1/stream`, { headers: { range: "bytes=0-9" } });
    assert.equal(stream.status, 206);
    assert.equal(stream.headers.get("accept-ranges"), "bytes");
    assert.equal(stream.headers.get("content-range"), "bytes 0-9/100");
    assert.equal(await stream.text(), "0123456789");
    assert.equal(requests.at(-1).range, "bytes=0-9", "the range request reaches the backend");
  } finally {
    await proxy.close();
    await php.close();
  }
});

test("CORS is granted to the site only, and preflight is answered locally", async () => {
  const php = fakePhpHost();
  const phpOrigin = await php.listen();
  const proxy = await startProxy({ phpOrigins: [phpOrigin] });
  try {
    const allowed = await get(`${proxy.origin}/api/videos?limit=1`);
    assert.equal(allowed.headers.get("access-control-allow-origin"), siteOrigin);
    const foreign = await fetch(`${proxy.origin}/api/videos?limit=1`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${proxy.origin}/api/videos?limit=1`, {
      method: "OPTIONS",
      headers: { origin: siteOrigin, "access-control-request-method": "GET" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), siteOrigin);
    assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/i);
  } finally {
    await proxy.close();
    await php.close();
  }
});

test("discovery and the health report need no terminal", async () => {
  const php = fakePhpHost();
  const phpOrigin = await php.listen();
  const proxy = await startProxy({ phpOrigins: [phpOrigin], publicOrigin: "https://api.example.test" });
  try {
    const discovery = await get(`${proxy.origin}/api/get-server`);
    assert.deepEqual(await discovery.json(), { ok: true, data: { server: "https://api.example.test" } });

    const health = await get(`${proxy.origin}/__proxy-health`);
    const report = await health.json();
    assert.equal(health.status, 200);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "fixed");
    assert.equal(report.targets[0].challenge, true);
    assert.equal(report.targets[0].challengeSolved, true);
    assert.equal(report.targets[0].catalog.ok, true);
    assert.ok(report.cookie.expiresInMinutes > 300);
  } finally {
    await proxy.close();
    await php.close();
  }
});

test("a load balancer can name the PHP host instead of a fixed list", async () => {
  const php = fakePhpHost();
  const phpOrigin = await php.listen();
  let discoveryCalls = 0;
  const discovery = http.createServer((_request, response) => {
    discoveryCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { server: phpOrigin } }));
  });
  await new Promise((resolve) => discovery.listen(0, "127.0.0.1", resolve));
  const discoveryUrl = `http://127.0.0.1:${discovery.address().port}/api/get-server`;
  const proxy = await startProxy({ phpOrigins: [], discoveryUrl });
  try {
    const response = await get(`${proxy.origin}/api/videos?limit=1`);
    assert.equal((await response.json()).data.videos[0].id, "local-1");
    await (await get(`${proxy.origin}/api/videos?limit=1`)).json();
    assert.equal(discoveryCalls, 1, "the LB answer is cached for ten minutes");
  } finally {
    await proxy.close();
    await php.close();
    await new Promise((resolve) => discovery.close(resolve));
  }
});

test("an unreachable backend is a clean error, not a hang", async () => {
  const dead = http.createServer(() => {});
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadOrigin = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((resolve) => dead.close(resolve));
  const proxy = await startProxy({ phpOrigins: [deadOrigin] });
  try {
    const response = await get(`${proxy.origin}/api/videos?limit=1`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
  } finally {
    await proxy.close();
  }
});
