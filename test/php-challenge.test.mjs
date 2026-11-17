import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  aesCbcDecryptHex,
  createChallengeClient,
  createPhpProxy,
  DEFAULT_PHP_ORIGINS,
  isChallengePage,
  parseChallenge,
  solveChallenge,
} from "../workers/php-proxy/worker.mjs";

const TOKEN = "2f312d304562ccae42675f89848424b1";

function encrypt(plain, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(plain, "hex")), cipher.final()]);
}

// The InfinityFree challenge, reproduced: three hex blobs plus the line that
// decrypts `c` with the key `a` and the IV `b` and stores the result as __test.
function challengePage({ token = TOKEN, key = crypto.randomBytes(16), iv = crypto.randomBytes(16), names = ["a", "b", "c"], maxAge = 21600 } = {}) {
  const cipherText = encrypt(token, key, iv);
  const [keyName, ivName, dataName] = names;
  return `<html><head><title>Security check</title></head><body><script>
var ${keyName}=toNumbers("${key.toString("hex")}"),${ivName}=toNumbers("${iv.toString("hex")}"),${dataName}=toNumbers("${cipherText.toString("hex")}");
document.cookie="${"__test"}="+toHex(slowAES.decrypt(${dataName},2,${keyName},${ivName}))+"; max-age=${maxAge}; path=/";
location.reload();
</script></body></html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

test("the plain-JS AES matches node:crypto byte for byte", () => {
  for (let index = 0; index < 20; index += 1) {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const plain = crypto.randomBytes([16, 32, 48][index % 3]);
    const cipherText = encrypt(plain.toString("hex"), key, iv);
    assert.equal(
      aesCbcDecryptHex(key.toString("hex"), iv.toString("hex"), cipherText.toString("hex")),
      plain.toString("hex"),
      "the inverse cipher must be exact, because the challenge has no padding to hide a mistake",
    );
  }
  assert.equal(aesCbcDecryptHex("zz", "00".repeat(16), "00".repeat(16)), null, "bad hex is refused");
  assert.equal(aesCbcDecryptHex("00".repeat(16), "00".repeat(16), "00".repeat(15)), null, "a partial block is refused");
});

test("the challenge is parsed and solved into a __test token", () => {
  const html = challengePage();
  const parsed = parseChallenge(html);
  assert.equal(parsed.key.length, 32);
  assert.equal(parsed.iv.length, 32);
  assert.equal(parsed.cookie, "__test");
  assert.equal(parsed.maxAge, 21600);
  assert.equal(solveChallenge(html), TOKEN);
});

test("the challenge works with renamed variables and a different decrypt order", () => {
  const html = challengePage({ names: ["k", "n", "p"] });
  assert.equal(solveChallenge(html), TOKEN, "the variables are read from the page, not assumed to be a/b/c");
  assert.equal(parseChallenge("<html><body>no script here</body></html>"), null);
  assert.equal(parseChallenge("var a=toNumbers(\"00\"),b=toNumbers(\"11\")"), null);
});

test("only an HTML page with the script counts as a challenge", () => {
  assert.equal(isChallengePage(challengePage(), "text/html; charset=utf-8"), true);
  assert.equal(isChallengePage('{"ok":true}', "application/json"), false);
  assert.equal(isChallengePage(challengePage(), "application/json"), false, "JSON is never treated as a challenge");
  assert.equal(isChallengePage("", ""), false);
});

test("the client solves once and reuses the cookie on the next request", async () => {
  const html = challengePage();
  const seen = [];
  const client = createChallengeClient({
    fetchImpl: async (url, init) => {
      const cookie = init.headers.get("cookie");
      seen.push(cookie);
      if (!cookie || !cookie.startsWith("__test=")) return htmlResponse(html);
      return jsonResponse({ ok: true, data: { videos: [{ id: "one" }] } });
    },
  });
  const first = await client.request("https://example.test/api/videos?limit=1");
  assert.equal((await first.response.json()).ok, true);
  assert.equal(seen.length, 2, "one challenged request, one solved request");
  assert.equal(seen[1], `__test=${TOKEN}`);

  const second = await client.request("https://example.test/api/videos?limit=1");
  assert.equal((await second.response.json()).data.videos[0].id, "one");
  assert.equal(seen.length, 3, "the cached cookie is sent straight away");
  assert.equal(seen[2], `__test=${TOKEN}`);
  assert.ok(client.cookie.expiresAt > Date.now());
});

test("a challenge that cannot be solved is reported, not looped forever", async () => {
  const client = createChallengeClient({
    attempts: 2,
    fetchImpl: async () => htmlResponse("<html><script>var a=toNumbers(\"00\"),b=toNumbers(\"11\")</script></html>"),
  });
  await assert.rejects(() => client.request("https://example.test/api/videos"), /could not be solved/);
});

const siteOrigin = "https://intimora.new.tg";

function proxyWith(fetchImpl, extra = {}) {
  const cacheStore = new Map();
  const cache = {
    match: async (key) => cacheStore.get(key) ?? null,
    put: async (key, value) => { cacheStore.set(key, value); },
    store: cacheStore,
  };
  const proxy = createPhpProxy({ fetchImpl, cache, ...extra });
  return { proxy, cacheStore };
}

test("the proxy answers discovery and CORS preflight itself", async () => {
  const { proxy } = proxyWith(async () => jsonResponse({ ok: false }, 500));
  const preflight = await proxy.fetch(new Request("https://worker.test/api/videos?limit=2", {
    method: "OPTIONS",
    headers: { origin: siteOrigin, "access-control-request-method": "GET" },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), siteOrigin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/i);

  const discovery = await proxy.fetch(new Request("https://worker.test/api/get-server", { headers: { origin: siteOrigin } }));
  assert.deepEqual(await discovery.json(), { ok: true, data: { server: "https://worker.test" } });
  assert.equal(discovery.headers.get("access-control-allow-origin"), siteOrigin);
});

test("a foreign origin gets no CORS grant", async () => {
  const { proxy } = proxyWith(async () => jsonResponse({ ok: true, data: { videos: [] } }));
  const response = await proxy.fetch(new Request("https://worker.test/api/videos?limit=2", { headers: { origin: "https://evil.example" } }));
  assert.equal(response.headers.get("access-control-allow-origin"), null, "only the site's own origins are echoed");
});

test("the proxy solves the check and forwards the real request", async () => {
  const html = challengePage();
  const upstream = [];
  const { proxy } = proxyWith(async (url, init) => {
    upstream.push({ url, cookie: init.headers.get("cookie"), range: init.headers.get("range") });
    if (!init.headers.get("cookie")) return htmlResponse(html);
    return jsonResponse({ ok: true, data: { videos: [{ id: "local-1", title: "T" }] } });
  });
  const response = await proxy.fetch(new Request("https://worker.test/api/videos?limit=2", { headers: { origin: siteOrigin } }));
  const body = await response.json();
  assert.equal(body.data.videos[0].id, "local-1");
  assert.equal(response.headers.get("access-control-allow-origin"), siteOrigin);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(upstream[0].url, `${DEFAULT_PHP_ORIGINS[0]}/api/videos?limit=2`, "the path is forwarded to the PHP host");
  assert.equal(upstream[1].cookie, `__test=${TOKEN}`);
});

test("range requests and their response headers pass through", async () => {
  const { proxy } = proxyWith(async (url, init) => {
    if (!init.headers.get("cookie")) return htmlResponse(challengePage());
    assert.equal(init.headers.get("range"), "bytes=0-1023");
    return new Response("video-bytes", {
      status: 206,
      headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": "bytes 0-1023/900000" },
    });
  });
  const response = await proxy.fetch(new Request("https://worker.test/api/videos/local-1/stream", {
    headers: { origin: siteOrigin, range: "bytes=0-1023" },
  }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 0-1023/900000");
  assert.equal(response.headers.get("access-control-allow-origin"), siteOrigin);
});

test("a failed origin falls through to the next one", async () => {
  const origins = ["https://first.test", "https://second.test"];
  const { proxy } = proxyWith(async (url) => {
    if (url.startsWith("https://first.test")) throw new Error("host down");
    return jsonResponse({ ok: true, data: { videos: [{ id: "from-second" }] } });
  }, { phpOrigins: origins });
  const response = await proxy.fetch(new Request("https://worker.test/api/videos?limit=2", { headers: { origin: siteOrigin } }));
  assert.equal((await response.json()).data.videos[0].id, "from-second");
});

test("a thumbnail is cached at the edge and served without another origin hit", async () => {
  let calls = 0;
  const { proxy, cacheStore } = proxyWith(async (url, init) => {
    if (!init.headers.get("cookie")) return htmlResponse(challengePage());
    calls += 1;
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  const request = new Request("https://worker.test/api/videos/local-1/thumbnail", { headers: { origin: siteOrigin } });
  const first = await proxy.fetch(request);
  assert.equal(first.headers.get("content-type"), "image/jpeg");
  assert.equal(calls, 1);
  assert.ok(cacheStore.size > 0, "the image was stored for the next visitor");

  const second = await proxy.fetch(new Request("https://worker.test/api/videos/local-1/thumbnail", { headers: { origin: siteOrigin } }));
  assert.equal(second.status, 200);
  assert.equal(calls, 1, "the cached copy answered instead of the PHP host");
  assert.equal(second.headers.get("access-control-allow-origin"), siteOrigin);
});

test("everything the backend does not need is refused", async () => {
  const { proxy } = proxyWith(async () => jsonResponse({ ok: true }));
  assert.equal((await proxy.fetch(new Request("https://worker.test/admin"))).status, 404);
  assert.equal((await proxy.fetch(new Request("https://worker.test/api/videos/local-1/stream", { method: "POST" }))).status, 405);
  const failing = createPhpProxy({ fetchImpl: async () => { throw new Error("down"); } });
  assert.equal((await failing.fetch(new Request("https://worker.test/api/videos"))).status, 502, "an unreachable host is a clean 502, not a hang");
});

test("the health URL reports every hop, so a deploy is checked from the browser", async () => {
  const html = challengePage();
  const { proxy } = proxyWith(async (url, init) => {
    if (!init.headers.get("cookie")) return htmlResponse(html);
    return jsonResponse({ ok: true, data: { videos: [{ id: "local-1" }, { id: "local-2" }] } });
  });
  const response = await proxy.fetch(new Request("https://worker.test/__proxy-health", { headers: { origin: siteOrigin } }));
  const report = await response.json();
  assert.equal(response.status, 200);
  assert.equal(report.ok, true);
  assert.equal(report.targets.length, 1);
  assert.equal(report.targets[0].challenge, true);
  assert.equal(report.targets[0].challengeSolved, true);
  assert.deepEqual(report.targets[0].catalog, { ok: true, status: 200, videos: 2 });
  assert.equal(report.cookie.name, "__test");
  assert.ok(report.cookie.expiresInMinutes > 300, "the cookie lives for the six hours the host grants");
  assert.equal(response.headers.get("access-control-allow-origin"), siteOrigin);
});

test("the health URL reports a broken deployment instead of hiding it", async () => {
  const { proxy } = proxyWith(async () => { throw new Error("host down"); });
  const response = await proxy.fetch(new Request("https://worker.test/__proxy-health"));
  const report = await response.json();
  assert.equal(response.status, 502);
  assert.equal(report.ok, false);
  assert.match(report.targets[0].error, /host down/);
});

test("the Worker file is self-contained, so it can be pasted as-is", async () => {
  const source = await readFile(new URL("../workers/php-proxy/worker.mjs", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "no imports: the dashboard editor only accepts one file");
  assert.match(source, /export default \{/);
  assert.ok(source.length < 60_000, "small enough for the Cloudflare editor");
});

test("the proxy follows the load balancer when no fixed origin is set", async () => {
  const html = challengePage();
  const calls = [];
  const proxy = createPhpProxy({
    phpOrigins: [],
    discoveryUrl: "https://lb.test/api/get-server",
    cache: null,
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (url === "https://lb.test/api/get-server") {
        return jsonResponse({ ok: true, data: { server: "https://php.test" } });
      }
      if (!init.headers.get("cookie")) return htmlResponse(html);
      return jsonResponse({ ok: true, data: { videos: [{ id: "from-lb" }] } });
    },
  });
  const first = await proxy.fetch(new Request("https://worker.test/api/videos?limit=1", { headers: { origin: siteOrigin } }));
  assert.equal((await first.json()).data.videos[0].id, "from-lb");
  assert.ok(calls.some((url) => url.startsWith("https://php.test/api/videos")), "the LB's URL is the one actually used");

  await proxy.fetch(new Request("https://worker.test/api/videos?limit=1", { headers: { origin: siteOrigin } }));
  assert.equal(
    calls.filter((url) => url === "https://lb.test/api/get-server").length,
    1,
    "the LB answer is kept for ten minutes instead of being asked for on every request",
  );
});

test("a load balancer that points at the proxy itself is reported, not looped", async () => {
  const proxy = createPhpProxy({
    phpOrigins: [],
    discoveryUrl: "https://worker.test/api/get-server",
    cache: null,
    fetchImpl: async (url) => {
      if (url === "https://worker.test/api/get-server") return jsonResponse({ ok: true, data: { server: "https://worker.test" } });
      return jsonResponse({ ok: true, data: { videos: [] } });
    },
  });
  const response = await proxy.fetch(new Request("https://worker.test/api/videos?limit=1"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /points at this proxy/);
});

test("the health report says which mode it runs in", async () => {
  const html = challengePage();
  const proxy = createPhpProxy({
    phpOrigins: [],
    discoveryUrl: "https://lb.test/api/get-server",
    cache: null,
    fetchImpl: async (url, init) => {
      if (url === "https://lb.test/api/get-server") return jsonResponse({ ok: true, data: { server: "https://php.test" } });
      if (!init.headers.get("cookie")) return htmlResponse(html);
      return jsonResponse({ ok: true, data: { videos: [{ id: "one" }] } });
    },
  });
  const report = await (await proxy.fetch(new Request("https://worker.test/__proxy-health"))).json();
  assert.equal(report.mode, "discovery");
  assert.equal(report.targets[0].origin, "https://php.test");
  assert.equal(report.targets[0].catalog.ok, true);
});
