import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisitorRequest } from "../src/services/visitor-route.mjs";
import { completeUnlockReturn, unlockReturnedThisLoad } from "../src/services/unlock.mjs";
import { clearDiagnostics, installDiagnostics, readDiagnostics, recordDiagnostic } from "../src/services/diagnostics.mjs";
import { notePhpFailure, phpFailureReason, resetPhpSession, setActiveTarget } from "../src/services/php-session.mjs";
import { createAuthenticatedRequest } from "../src/services/auth-request.mjs";

const discoveryUrl = "https://discovery.example/api/get-server";
const php = "https://intimora-api2.site.je";

function visitorWith(answer, options = {}) {
  const calls = [];
  const outcomes = [];
  const visitor = createVisitorRequest({
    discoveryUrl,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (url === discoveryUrl) return Response.json({ ok: true, data: { server: php, php: true } });
      return answer(url, init);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    storage: null,
    ...options,
  });
  return { visitor, calls, outcomes };
}

test("the diagnostic trace stays local and small", () => {
  clearDiagnostics();
  for (let index = 0; index < 60; index += 1) recordDiagnostic("request", { path: `/api/videos?limit=${index}`, ok: index % 2 === 0 });
  const rows = readDiagnostics();
  assert.equal(rows.length, 40, "the oldest entries fall off");
  assert.equal(rows.at(-1).path, "/api/videos?limit=59");
  assert.equal(rows.at(-1).name, "request");
  assert.ok(!JSON.stringify(rows).includes("token"), "no credentials are ever recorded");
  clearDiagnostics();
  assert.deepEqual(readDiagnostics(), []);
});

test("`__intimoraDiag()` returns the trace as a table", () => {
  clearDiagnostics();
  const tables = [];
  const target = { console: { table: (rows) => tables.push(rows) }, __intimoraDiag: undefined };
  installDiagnostics(target);
  recordDiagnostic("target", { backend: php, php: true });
  const rows = target.__intimoraDiag();
  assert.equal(rows.length, 1);
  assert.equal(tables.length, 1);
  assert.equal(rows[0].backend, php);
  clearDiagnostics();
});

test("a success is reported as such, and follows redirects on a PHP host", async () => {
  const { visitor, calls, outcomes } = visitorWith(() => Response.json({ ok: true, data: { videos: [] } }));
  await visitor.requestJson("/api/videos?limit=5");
  assert.deepEqual(outcomes, [{ path: "/api/videos?limit=5", php: true, ok: true, challenge: false, blocked: false, cors: false, status: undefined }]);
  assert.equal(calls[1].init.redirect, "follow", "a PHP host may redirect to its own check page");
  assert.equal(calls[1].init.credentials, "include");
});

test("the host's check page, a blocked request and an error status are told apart", async () => {
  const check = visitorWith(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
  await assert.rejects(check.visitor.requestJson("/api/videos?limit=5"));
  assert.equal(check.outcomes[0].challenge, true, "an HTML answer is the check page");
  assert.equal(check.outcomes[0].status, 200);

  const blocked = visitorWith(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(blocked.visitor.requestJson("/api/videos?limit=5"));
  assert.equal(blocked.outcomes[0].blocked, true, "a CORS rejection is not a check page");

  const failing = visitorWith(() => new Response("boom", { status: 503 }));
  await assert.rejects(failing.visitor.requestJson("/api/videos?limit=5"));
  assert.equal(failing.outcomes[0].status, 503);
  assert.equal(failing.outcomes[0].blocked, false);
});

test("an ordinary backend keeps its stricter redirects and credential-free calls", async () => {
  const calls = [];
  const outcomes = [];
  const visitor = createVisitorRequest({
    discoveryUrl,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (url === discoveryUrl) return Response.json({ ok: true, data: { server: "https://api-intimora.vercel.app", php: false } });
      return Response.json({ ok: true, data: { videos: [] } });
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    storage: null,
  });
  await visitor.requestJson("/api/videos?limit=5");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(outcomes[0].php, false);
});

test("the failure reason drives the message on screen", () => {
  setActiveTarget({ backend: php, php: true });
  resetPhpSession(null);
  assert.equal(phpFailureReason(), null, "nothing failed yet");
  notePhpFailure({ challenge: true, status: 200, path: "/api/videos?limit=5" });
  assert.deepEqual(phpFailureReason(), { kind: "check-page", status: 200, path: "/api/videos?limit=5" });
  notePhpFailure({ blocked: true, path: "/api/videos?limit=5" });
  assert.equal(phpFailureReason().kind, "blocked");
  notePhpFailure({ status: 502, path: "/api/videos?limit=5" });
  assert.equal(phpFailureReason().kind, "status");
  resetPhpSession(null);
  assert.equal(phpFailureReason(), null, "a retry forgets the old reason");
});

test("an ordinary backend never records a PHP failure", () => {
  setActiveTarget({ backend: "https://api-intimora.vercel.app", php: false });
  resetPhpSession(null);
  notePhpFailure({ blocked: true });
  assert.equal(phpFailureReason(), null);
});

test("the page that the host sent back is remembered for one load", () => {
  assert.equal(unlockReturnedThisLoad(), false, "a plain visit is not a return");
  const returned = completeUnlockReturn({
    location: { pathname: "/", search: "?__unlocked=1", hash: "" },
    history: { state: null, replaceState() {} },
    storage: null,
  });
  assert.equal(returned, true);
  assert.equal(unlockReturnedThisLoad(), true, "the first request gets a second chance");
});

test("an account call reports its own failure and follows the host's redirect", async () => {
  clearDiagnostics();
  const calls = [];
  const request = createAuthenticatedRequest({
    selectBackend: async () => php,
    allowedBackends: [],
    resolveTarget: async () => ({ backend: php, php: true }),
    trustedPhpBackend: () => php,
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(request("/api/auth/me", { token: "a.b-c_d" }));
  assert.equal(calls[0].redirect, "follow");
  const entry = readDiagnostics().find((row) => row.name === "account");
  assert.equal(entry?.path, "/api/auth/me");
  assert.equal(entry?.blocked, true);
  assert.ok(!JSON.stringify(readDiagnostics()).includes("a.b-c_d"), "the token is never recorded");
  clearDiagnostics();
});
