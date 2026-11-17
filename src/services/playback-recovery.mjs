// A media element that has fired `error` never plays again until it is asked to
// reload. The pre-roll makes that likely: while the ad's own <video> is playing,
// browsers throttle or cut the second element's request (mobile is strictest),
// and the content element ends up in the error state before the visitor ever
// presses play. The old code answered that with "This video could not be
// played. Please try again." — a button for something the player can do itself.
//
// This module is the decision only: whether a failure is worth one silent reload.
export const RECOVERY_LIMIT = 2;
export const RECOVERY_DELAY_MS = 300;

// HTMLMediaElement.error codes.
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// Aborted and network failures are the ones a busy browser produces while
// something else is playing; they deserve two tries. A decode error or an
// unsupported source is usually the URL or its headers, so it gets one try (a
// host's check page and a transient 503 both look exactly like that).
export function shouldAutoRecover({ code, recoveries = 0, maxRecoveries = RECOVERY_LIMIT } = {}) {
  if (!Number.isFinite(recoveries) || recoveries < 0 || recoveries >= maxRecoveries) return false;
  if (code === MEDIA_ERR_ABORTED || code === MEDIA_ERR_NETWORK) return true;
  if (code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED) return recoveries < 1;
  // No media error at all: `play()` itself was rejected (autoplay policy, a
  // gesture is required). Reloading cannot fix that, and it would throw away
  // data that is already buffered.
  return false;
}

// The sentence shown only after the silent reloads above were exhausted.
export function playbackFailureMessage({ code } = {}) {
  return code === MEDIA_ERR_SRC_NOT_SUPPORTED || code === MEDIA_ERR_DECODE
    ? "This video could not be loaded. Please try again."
    : "This video could not be played. Please try again.";
}
