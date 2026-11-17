import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountRequestError, createAuthenticatedRequest } from "../src/services/auth-request.mjs";

const backendA = "https://api-intimora.vercel.app";
const backendB = "https://intimora-api1.vercel.app";
const allowedBackends = [backendA, backendB];
const token = "test.token-123.signature";
const generic = { name: "AccountRequestError", message: "Account service is temporarily unavailable." };

test("authenticated requests use the visitor's selected backend and pin video actions safely", async () => {
  const calls = [];
  let selection = backendB;
  let selections = 0;
  const request = createAuthenticatedRequest({
    selectBackend: async () => { selections += 1; return selection; },
    allowedBackends,
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      return Response.json({ ok: true, data: { liked: true } });
    },
  });
  const me = await request("/api/auth/me", { token });
  assert.equal(me.backend, backendB);
  await request("/api/videos/video-1/like", { method: "POST", token, backend: backendA });
  // Pinned actions still refresh visitor discovery independently.
  await Promise.resolve();
  assert.equal(selections, 2);
  assert.equal(calls[1].url, `${backendA}/api/videos/video-1/like`);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body, "{}");
  for (const call of calls) {
    // An ordinary (non-PHP) backend keeps the documented bearer contract.
    assert.equal(call.headers.Authorization, `Bearer ${token}`);
    assert.ok(!call.url.includes(token), "the token never appears in a URL");
    assert.equal(call.credentials, "omit");
    assert.equal(call.cache, "no-store");
    assert.equal(call.mode, "cors");
    assert.equal(call.redirect, "error");
    assert.equal(call.referrerPolicy, "no-referrer");
  }
  assert.equal(calls[0].method, "GET", "an ordinary backend keeps its GET route");
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  selection = backendA;
  assert.equal((await request("/api/auth/me", { token })).backend, backendA);
});

test("tokens never leave the exact trusted origins or permitted account routes", async () => {
  const badTargets = [
    "https://api-intimora.vercel.app.evil.example",
    "https://api-intimora.vercel.app:444",
    "https://api-intimora.vercel.app/path",
    "https://api-intimora.vercel.app/?x=secret",
    "https://user:password@api-intimora.vercel.app",
    "http://api-intimora.vercel.app",
    "https://127.0.0.1",
  ];
  let calls = 0;
  for (const target of badTargets) {
    const request = createAuthenticatedRequest({ selectBackend: async () => target, allowedBackends, fetcher: async () => { calls += 1; } });
    await assert.rejects(request("/api/auth/me", { token }), generic);
    await assert.rejects(request("/api/videos/video-1/save", { method: "POST", token, backend: target }), generic);
  }
  assert.equal(calls, 0, "no request, including a bearer token, reaches an untrusted origin");
  const request = createAuthenticatedRequest({ selectBackend: async () => backendA, allowedBackends, fetcher: async () => { calls += 1; } });
  for (const [route, method] of [
    ["/api/user/liked", "GET"], ["/api/user/saved", "GET"], ["/api/auth/me?token=x", "GET"],
    ["//evil.example/api/auth/me", "GET"], ["/api/admin", "GET"], ["/api/videos/../save", "POST"],
    ["/api/videos/video-1/like", "GET"], ["/api/auth/verify", "GET"],
  ]) await assert.rejects(request(route, { method, token }), generic);
  // On a PHP host every account route is POST (a GET cannot carry the body), and
  // omitting the method must not be refused.
  const postable = createAuthenticatedRequest({
    selectBackend: async () => backendA,
    allowedBackends,
    resolveTarget: async () => ({ backend: backendA, php: true }),
    fetcher: async () => Response.json({ ok: true, data: {} }),
  });
  for (const method of [undefined, "POST"]) {
    assert.equal((await postable("/api/auth/me", { method, token })).backend, backendA);
  }
  assert.equal((await postable("/api/user/referrals", { method: "POST", token })).backend, backendA);
  assert.equal((await postable("/api/auth/verify", { method: "POST", token })).backend, backendA);
  await assert.rejects(request("/api/auth/me", { token: "bad\nAuthorization: secret" }), generic);
  assert.equal(calls, 0);
});

test("account failures are generic except for the exact actionable validation codes", async () => {
  const responses = [
    Response.json({ ok: false, error: "Username already exists" }, { status: 400 }),
    Response.json({ ok: false, error: "Invalid referral code" }, { status: 400 }),
    Response.json({ ok: false, error: "User already exists" }, { status: 400 }),
    Response.json({ ok: false, error: "secret URL https://private.example" }, { status: 500 }),
    Response.json({ ok: false, error: "secret URL https://private.example" }, { status: 401 }),
    new Response("not json, secret URL https://private.example", { status: 500 }),
    new Response("{}", { status: 200, headers: { "Content-Length": String(3 * 1024 * 1024) } }),
  ];
  const request = createAuthenticatedRequest({ selectBackend: async () => backendA, allowedBackends, fetcher: async () => responses.shift() });
  const expected = ["username_taken", "invalid_referral", "already_exists", "unavailable", "unauthorized", "unavailable", "unavailable"];
  for (const code of expected) {
    try { await request("/api/auth/profile", { method: "POST", token }); assert.fail("expected rejection"); }
    catch (error) {
      assert.ok(error instanceof AccountRequestError);
      assert.equal(error.code, code);
      assert.equal(error.message, generic.message);
      assert.ok(!String(error).includes("private.example"));
    }
  }
  const failing = createAuthenticatedRequest({ selectBackend: async () => { throw Error("secret https://private.example"); }, allowedBackends });
  await assert.rejects(failing("/api/auth/me", { token }), generic);
});

test("an HTML answer asks for the one-time unlock instead of a dead account screen", async () => {
  const unlocks = [];
  const request = createAuthenticatedRequest({
    selectBackend: async () => backendA,
    allowedBackends,
    requestUnlock: (context) => unlocks.push(context),
    fetcher: async () => new Response("<html><script>var a=toNumbers('00')</script></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  await assert.rejects(request("/api/auth/me", { token }), generic);
  assert.deepEqual(unlocks, [{ path: "/api/auth/me" }]);

  const offline = createAuthenticatedRequest({
    selectBackend: async () => backendA,
    allowedBackends,
    requestUnlock: (context) => unlocks.push(context),
    fetcher: async () => { throw new TypeError("Failed to fetch"); },
  });
  await assert.rejects(offline("/api/user/referrals", { token }), generic);
  assert.deepEqual(unlocks[1], { path: "/api/user/referrals" }, "a blocked or refused call is the same situation");

  // A 401 is the server's own answer: no redirect is forced.
  const unauthorized = createAuthenticatedRequest({
    selectBackend: async () => backendA,
    allowedBackends,
    requestUnlock: (context) => unlocks.push(context),
    fetcher: async () => Response.json({ ok: false, error: "Invalid token" }, { status: 401 }),
  });
  await assert.rejects(unauthorized("/api/auth/me", { token }), { name: "AccountRequestError", code: "unauthorized" });
  assert.equal(unlocks.length, 2, "the server's own rejection does not trigger an unlock");
});

test("a PHP backend gets the preflight-free shape, an ordinary one keeps the bearer contract", async () => {
  const phpBackend = "https://intimora-api3.site.je";
  const calls = [];
  const phpRequest = createAuthenticatedRequest({
    selectBackend: async () => phpBackend,
    allowedBackends,
    resolveTarget: async (pinned) => ({ backend: pinned ?? phpBackend, php: true }),
    trustedPhpBackend: () => phpBackend,
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      return Response.json({ ok: true, data: { user: "me" } });
    },
  });

  await phpRequest("/api/auth/me", { token });
  const me = calls[0];
  assert.equal(me.method, "POST", "a GET cannot carry the token without a query string");
  assert.equal(me.headers.Authorization, undefined, "no custom header: no preflight");
  assert.equal(me.headers["Content-Type"], "text/plain", "a simple content type: no preflight");
  assert.equal(JSON.parse(me.body).token, token);
  assert.equal(me.credentials, "include", "the host's session cookie has to travel");
  assert.equal(me.redirect, "follow", "the host may redirect to its own check page first");
  assert.ok(!me.url.includes(token), "the token never appears in a URL");

  const plainCall = [];
  const plainRequest = createAuthenticatedRequest({
    selectBackend: async () => backendA,
    allowedBackends,
    resolveTarget: async (pinned) => ({ backend: pinned ?? backendA, php: false }),
    fetcher: async (url, init) => {
      plainCall.push({ url, ...init });
      return Response.json({ ok: true, data: { user: "me" } });
    },
  });
  await plainRequest("/api/auth/me", { token });
  assert.equal(plainCall[0].method, "GET", "an ordinary backend keeps its GET route");
  assert.equal(plainCall[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(plainCall[0].credentials, "omit");
});

test("a runtime PHP host is trusted, but an arbitrary one is not", async () => {
  const runtime = "https://intimora-api9.site.je";
  let trusted = runtime;
  let calls = 0;
  const request = createAuthenticatedRequest({
    selectBackend: async () => runtime,
    allowedBackends,
    resolveTarget: async () => ({ backend: runtime, php: true }),
    trustedPhpBackend: () => trusted,
    fetcher: async () => { calls += 1; return Response.json({ ok: true, data: {} }); },
  });
  await request("/api/auth/me", { token });
  assert.equal(calls, 1, "the host the load balancer named is trusted");

  trusted = "https://intimora-api8.site.je";
  await assert.rejects(request("/api/auth/me", { token }), generic);
  assert.equal(calls, 1, "a token never reaches an origin nobody vouched for");
});
