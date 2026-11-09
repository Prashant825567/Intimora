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
    assert.equal(call.headers.Authorization, `Bearer ${token}`);
    assert.ok(!call.url.includes(token));
    assert.equal(call.credentials, "omit");
    assert.equal(call.cache, "no-store");
    assert.equal(call.mode, "cors");
    assert.equal(call.redirect, "error");
    assert.equal(call.referrerPolicy, "no-referrer");
  }
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
    ["/api/videos/video-1/like", "GET"], ["/api/auth/me", "POST"],
  ]) await assert.rejects(request(route, { method, token }), generic);
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
