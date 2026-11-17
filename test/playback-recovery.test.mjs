import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEDIA_ERR_ABORTED,
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  RECOVERY_LIMIT,
  playbackFailureMessage,
  shouldAutoRecover,
} from "../src/services/playback-recovery.mjs";

test("an aborted or network-failed request is reloaded on its own", () => {
  for (const code of [MEDIA_ERR_ABORTED, MEDIA_ERR_NETWORK]) {
    assert.equal(shouldAutoRecover({ code, recoveries: 0 }), true, `code ${code} first time`);
    assert.equal(shouldAutoRecover({ code, recoveries: RECOVERY_LIMIT - 1 }), true);
    assert.equal(shouldAutoRecover({ code, recoveries: RECOVERY_LIMIT }), false, "the budget is finite");
  }
});

test("an unreadable source is tried once, then left to the visitor", () => {
  // A host's check page, a 503 without a media type and a CORS rejection all
  // arrive as "no supported source"; one attempt covers the transient ones.
  for (const code of [MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED]) {
    assert.equal(shouldAutoRecover({ code, recoveries: 0 }), true);
    assert.equal(shouldAutoRecover({ code, recoveries: 1 }), false);
  }
});

test("a blocked play() is never answered with a reload", () => {
  // Autoplay policy needs a gesture; reloading would throw away buffered data
  // and still be blocked.
  assert.equal(shouldAutoRecover({ code: 0, recoveries: 0 }), false);
  assert.equal(shouldAutoRecover({ code: undefined, recoveries: 0 }), false);
  assert.equal(shouldAutoRecover({ recoveries: 0 }), false);
  assert.equal(shouldAutoRecover({ code: 7, recoveries: 0 }), false, "an unknown code is not guessed at");
});

test("nonsense counters never loop", () => {
  assert.equal(shouldAutoRecover({ code: MEDIA_ERR_ABORTED, recoveries: -1 }), false);
  assert.equal(shouldAutoRecover({ code: MEDIA_ERR_ABORTED, recoveries: Number.NaN }), false);
  assert.equal(shouldAutoRecover({ code: MEDIA_ERR_ABORTED, recoveries: 10, maxRecoveries: 3 }), false);
});

test("the message names what actually failed", () => {
  assert.equal(playbackFailureMessage({ code: MEDIA_ERR_SRC_NOT_SUPPORTED }), "This video could not be loaded. Please try again.");
  assert.equal(playbackFailureMessage({ code: MEDIA_ERR_DECODE }), "This video could not be loaded. Please try again.");
  assert.equal(playbackFailureMessage({ code: MEDIA_ERR_NETWORK }), "This video could not be played. Please try again.");
  assert.equal(playbackFailureMessage({}), "This video could not be played. Please try again.");
});
