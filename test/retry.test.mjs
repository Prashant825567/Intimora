import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_RETRY_DELAYS_MS,
  retryWithDelays,
  SEARCH_RETRY_DELAYS_MS,
  SHARED_LINK_RETRY_DELAYS_MS,
} from "../src/services/retry.mjs";

function recorder() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test("a task that succeeds first time is never repeated", async () => {
  let calls = 0;
  const { waits, sleep } = recorder();
  const value = await retryWithDelays(async () => { calls += 1; return "ok"; }, { delays: CATALOG_RETRY_DELAYS_MS, sleep });
  assert.equal(value, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(waits, [], "no delay is paid for a successful call");
});

test("a transient failure is retried with the given delays", async () => {
  let calls = 0;
  const { waits, sleep } = recorder();
  const value = await retryWithDelays(async (attempt) => {
    calls += 1;
    if (attempt < 2) throw new Error(`flaky ${attempt}`);
    return attempt;
  }, { delays: [100, 250], sleep });
  assert.equal(value, 2);
  assert.equal(calls, 3, "one try plus one per delay");
  assert.deepEqual(waits, [100, 250]);
});

test("the last error is thrown once the budget is spent", async () => {
  let calls = 0;
  const { waits, sleep } = recorder();
  await assert.rejects(retryWithDelays(async () => {
    calls += 1;
    throw new Error(`fail ${calls}`);
  }, { delays: SHARED_LINK_RETRY_DELAYS_MS, sleep }), { message: `fail ${SHARED_LINK_RETRY_DELAYS_MS.length + 1}` });
  assert.deepEqual(waits, SHARED_LINK_RETRY_DELAYS_MS);
});

test("a caller can refuse to retry, and no delay is paid then", async () => {
  const { waits, sleep } = recorder();
  let calls = 0;
  const fatal = Object.assign(new Error("stale"), { fatal: true });
  await assert.rejects(retryWithDelays(async () => {
    calls += 1;
    throw calls === 1 ? new Error("transient") : fatal;
  }, { delays: SEARCH_RETRY_DELAYS_MS, sleep, shouldRetry: (error) => !error.fatal }));
  assert.equal(calls, 2);
  assert.deepEqual(waits, SEARCH_RETRY_DELAYS_MS);
});

test("without delays the task runs exactly once", async () => {
  let calls = 0;
  await assert.rejects(retryWithDelays(async () => { calls += 1; throw new Error("nope"); }, { sleep: async () => {} }));
  assert.equal(calls, 1);
});
