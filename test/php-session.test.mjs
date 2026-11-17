import assert from "node:assert/strict";
import { test } from "node:test";
import { UNLOCK_MAX_TRIES } from "../src/config/php-backend.mjs";
import { readUnlockState } from "../src/services/unlock.mjs";
import {
  activeTarget,
  confirmPhpSession,
  phpSessionPending,
  requestPhpUnlock,
  resetPhpSession,
  setActiveTarget,
} from "../src/services/php-session.mjs";
import { mediaCrossOrigin } from "../src/services/media-credentials.mjs";

const php = "https://intimora-api2.site.je";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeDocument() {
  const nodes = [];
  return {
    nodes,
    body: { appendChild: (node) => nodes.push(node) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {} }),
    querySelector: (selector) => nodes.find((node) => `.${node.className}` === selector) ?? null,
  };
}

function navigation(storage, now) {
  const navigations = [];
  const timers = [];
  return {
    navigations,
    timers,
    options: {
      storage,
      now,
      href: "https://intimora.new.tg/trending",
      document: fakeDocument(),
      navigate: (url) => navigations.push(url),
      setTimeoutImpl: (fn) => { timers.push(fn); return 1; },
    },
  };
}

test("a PHP target is remembered for the whole tab, media included", () => {
  setActiveTarget({ backend: php, php: true });
  assert.deepEqual(activeTarget(), { backend: php, php: true });
  assert.equal(mediaCrossOrigin(`${php}/api/videos/local-1/thumbnail`), undefined, "the cookie needs a plain request");
  assert.equal(mediaCrossOrigin("https://api-intimora.vercel.app/x.jpg"), "anonymous");
});

test("the unlock leaves for the host's own page exactly once per page load", () => {
  setActiveTarget({ backend: php, php: true });
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  const first = navigation(storage, now);
  assert.equal(requestPhpUnlock(first.options), true);
  assert.equal(first.timers.length, 1, "the splash gets its frame first");
  first.timers[0]();
  assert.equal(first.navigations.length, 1);
  assert.match(first.navigations[0], new RegExp(`^${php.replace(/\./g, "\\.")}/__unlock\\?back=`));
  assert.equal(readUnlockState(storage).tries, 1);
  assert.equal(requestPhpUnlock(first.options), false, "parallel failures share one redirect");
  confirmPhpSession({ storage, now });
  resetPhpSession(storage);
});

test("the attempts are bounded, so a host that never answers JSON cannot loop", () => {
  setActiveTarget({ backend: php, php: true });
  const storage = memoryStorage();
  let now = 1_700_000_000_000;
  for (let index = 0; index < UNLOCK_MAX_TRIES; index += 1) {
    now += 5_000;
    const trip = navigation(storage, now);
    assert.equal(requestPhpUnlock(trip.options), true, `attempt ${index + 1}`);
    trip.timers[0]();
    // Report the redirect destination as the returned page load, then fail again.
    confirmPhpSession({ storage, now }); // resets `leaving` for the next page
    resetPhpSession(storage); // ... and forgets the confirmation for this test
    storage.setItem("intimora_unlock_v1", JSON.stringify({ at: now, tries: index + 1, ok: false }));
  }
  now += 5_000;
  const blockedTrip = navigation(storage, now);
  assert.equal(requestPhpUnlock(blockedTrip.options), false, "the budget is spent");
  assert.equal(phpSessionPending({ storage, now }), false);
  resetPhpSession(storage);
});

test("a confirmed session is quiet until the host's window expires", () => {
  setActiveTarget({ backend: php, php: true });
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  confirmPhpSession({ storage, now });
  assert.equal(readUnlockState(storage).ok, true);
  assert.equal(phpSessionPending({ storage, now: now + 60_000 }), false);
  const later = now + 5.5 * 60 * 60 * 1000 + 1;
  assert.equal(phpSessionPending({ storage, now: later }), true, "a fresh cookie is earned before it expires");
});

test("an ordinary backend never unlocks and never carries PHP media rules", () => {
  setActiveTarget({ backend: "https://api-intimora.vercel.app", php: false });
  const storage = memoryStorage();
  const trip = navigation(storage, 1_700_000_000_000);
  assert.equal(requestPhpUnlock(trip.options), false);
  assert.equal(trip.navigations.length, 0);
  assert.equal(phpSessionPending({ storage }), false);
  assert.equal(mediaCrossOrigin(`${php}/x.jpg`), "anonymous");
});

test("retrying gives the budget back instead of leaving the page dead", () => {
  setActiveTarget({ backend: php, php: true });
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  storage.setItem("intimora_unlock_v1", JSON.stringify({ at: now, tries: UNLOCK_MAX_TRIES, ok: false }));
  assert.equal(phpSessionPending({ storage, now: now + 60_000 }), false);
  resetPhpSession(storage);
  assert.deepEqual(readUnlockState(storage), {});
  assert.equal(phpSessionPending({ storage, now: now + 60_000 }), true);
});
