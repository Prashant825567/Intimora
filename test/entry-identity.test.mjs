import assert from "node:assert/strict";
import { test } from "node:test";
import { identityOrigin, registerEntry } from "../src/services/identity.mjs";
import { readUnlockState } from "../src/services/unlock.mjs";

const origin = "https://identity.example";

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    snapshot() { return Object.fromEntries(entries); },
  };
}

test("the entry row is posted to the identity host itself, cookie included, before anything else", async () => {
  const calls = [];
  const payload = JSON.stringify({ ua: "agent", path: "/" });
  const result = await registerEntry({
    origin,
    payload,
    storage: memoryStorage(),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, data: { logged: true } });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, "one request, and it is the visitor row");
  assert.equal(calls[0].url, `${origin}/api/visit`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "text/plain");
  assert.equal(calls[0].init.body, payload);
  assert.equal(calls[0].init.credentials, "include", "the host's cookie is the identity");
  assert.equal(calls[0].init.redirect, "follow");
  assert.equal(calls[0].init.cache, "no-store");
});

test("no identity host configured means the step is skipped instead of guessed", async () => {
  let contacted = 0;
  const result = await registerEntry({
    origin: "",
    payload: "{}",
    fetcher: async () => { contacted += 1; return Response.json({ ok: true }); },
  });
  assert.deepEqual(result, { ok: false, skipped: true });
  assert.equal(contacted, 0);
  assert.equal(identityOrigin(""), null);
  assert.equal(identityOrigin("http://identity.example"), null, "only HTTPS is accepted");
  assert.equal(identityOrigin(`${origin}/`), origin);
});

test("the host's own check page sends the browser through it once, and the guard stops there", async () => {
  const navigations = [];
  const storage = memoryStorage();
  const options = {
    origin,
    payload: "{}",
    storage,
    href: "https://intimora.net/watch/one",
    now: 1_000_000,
    splashMs: 0,
    navigate: (url) => navigations.push(url),
    setTimeoutImpl: (fn) => fn(),
    fetcher: async () => new Response("<html>check</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  };
  const first = await registerEntry(options);
  assert.equal(first.ok, false);
  assert.equal(first.challenge, true);
  assert.equal(navigations.length, 1, "the browser is sent to the host's unlock page");
  assert.equal(navigations[0], `${origin}/__unlock?back=${encodeURIComponent(options.href)}`);
  assert.equal(readUnlockState(storage, "intimora_identity_unlock_v1").tries, 1);

  // A second attempt inside the minimum gap does not navigate again: the visitor
  // sees the reason instead of a flicker of redirects.
  const second = await registerEntry({ ...options, now: 1_000_000 + 100 });
  assert.equal(second.ok, false);
  assert.equal(second.unlocking, false);
  assert.equal(navigations.length, 1);
});

test("an unreachable identity host never starts a redirect loop", async () => {
  const navigations = [];
  const result = await registerEntry({
    origin,
    payload: "{}",
    storage: memoryStorage(),
    splashMs: 0,
    navigate: (url) => navigations.push(url),
    setTimeoutImpl: (fn) => fn(),
    fetcher: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.down, true);
  assert.deepEqual(navigations, [], "a host that never answered cannot be helped by its check page");
});
