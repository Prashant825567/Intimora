# Backend handoff: public like counts and faster actions

This frontend cannot make a public count correct by incrementing a browser-local number. The separate backend repository must implement the contract below on **every backend selected by the Worker**, backed by the same shared data store. Do not enable live polling until the complete contract is deployed and verified.

## Findings in the inspected backend

The inspected `Prashant825567/-Intimora-backend` `main` commit `c30e2712d25300ee798a9092228a5c559e287aa0` has:

- `POST /api/videos/:id/like` calling `users.toggleLike`, which edits only the user's `likedVideos`; it does not update the public `likes` on video metadata. The separate `store.toggleLike` exists but is not called by that route. Simply calling both Telegram-based toggles is **not** an atomic solution: concurrent requests or partial failures could desynchronize the two records.
- A new 60-second in-memory user cache avoids a Telegram scan on a warm cache hit. Cold instances and expired caches still read up to 5,000 messages; each like/save still waits for a Telegram edit and Firebase's `accounts:lookup` REST request. Cache state is per instance, not shared between hosts. No sub-second production latency was measured here.
- The cache returns mutable user objects and changes them **before** the Telegram edit succeeds. With the actual backend functions and mocked storage, a failed edit left the cache showing an unsaved like. In a separate mock with two backend instances, a stale cached save overwrote a like written by the other instance. Updating any user also refreshes the timestamp for the entire cached list, potentially keeping unrelated users stale. These are local reproductions, not live-account tests.
- `GET /api/videos/:id` increments views, so it must not be polled to refresh likes.

## Required storage and behavior

1. Use one durable, indexed database shared by both backend instances, such as PostgreSQL. Store a unique `(video_id, firebase_uid)` membership for likes and for saves. Keep the public count and a nonnegative integer `version` per video. A transaction must set the desired membership and adjust the count and increment `version` **only when membership actually changes**. Like, unlike and concurrent updates must not lose increments, go negative, or partially update the user's state and the aggregate. Changes to saves must not overwrite likes or profile fields. `version` must monotonically increase on every like/unlike change and survive restarts and deployments.
2. Carefully migrate existing user `likedVideos` and `savedVideos` from Telegram, deduplicate each user/video pair, and rebuild the aggregates from the migrated likes. Paginate all records rather than assuming the current 5,000-message scan is complete; reconcile and back up before switching. Do not trust the old public `likes` field to match user records. Preserve accounts and other profile data.
3. Remove Telegram user-channel scans and synchronous Telegram message edits from the action hot path. Until storage is migrated, do not mutate shared cached objects before a write is confirmed: edit a copy, invalidate on error, and do not refresh the entire cache TTL for one user's update. This alone does **not** solve cross-instance lost updates; atomic shared storage or an equivalent cross-instance concurrency mechanism is required. An asynchronous backup should use a durable queue/outbox after the database commit, not a fire-and-forget promise that can disappear when a serverless invocation ends. Reuse connection pools where the platform permits. Keep Firebase authentication: use the official Firebase Admin ID-token verifier with cached Google signing keys, correct project/issuer/audience/expiry checks, and an explicit revocation policy. Never trust an unverified token or disable auth to improve speed.
4. Return the same aggregate `likes` in public catalog and search results from this shared store. Return no `likedBy`, UIDs, emails, Telegram identifiers, file references, tokens or other private information. The count endpoint below must be read-only and must not increment views.

## API contract for this frontend

### Authenticated actions

Both requests require a valid Firebase bearer token and a valid existing video. The `active` field is the **desired final state**, not a toggle. Repeating the same request must not add another like or remove a prior one.

`POST /api/videos/video-1/like` with `{ "active": true }`:

```json
{ "ok": true, "data": { "liked": true, "likes": 123, "version": 42 } }
```

`POST /api/videos/video-1/save` with `{ "active": true }`:

```json
{ "ok": true, "data": { "saved": true } }
```

`active: false` removes the membership and returns `liked: false` or `saved: false`. The like response's `likes` and `version` must describe the same committed transaction. This frontend also accepts optional `likedVideos`/`savedVideos` arrays for the current user. During rollout, older deployed frontend versions require those arrays and may send an empty body expecting a toggle; preserve compatibility until they are retired. A legacy toggle is not safe to automatically retry after an uncertain response.

### Public batch counts

`GET /api/likes/counts?ids=video-1,video-2` (no authentication required):

```json
{
  "ok": true,
  "data": {
    "counts": [
      { "id": "video-1", "likes": 123, "version": 42 },
      { "id": "video-2", "likes": 7, "version": 10 }
    ]
  }
}
```

Accept one comma-separated `ids` parameter with 1–20 unique IDs matching `[A-Za-z0-9_-]{1,128}`. Omit unknown IDs, reject malformed or oversized requests, and return only requested IDs. `likes` and `version` must be nonnegative JavaScript-safe integers. Both hosts must return versions from the **same** source of truth. Set `Cache-Control: no-store`, allow the deployed site's origin for GET and OPTIONS, and rate-limit appropriately. Include no personal information in this public response.

## Rollout and verification

1. Deploy and migrate the backend, test simultaneous duplicate like/unlike/save requests, retries and timeouts, plus guest reads on both backend hosts. Check that a missing video is rejected and that no public response leaks personal or Telegram storage data.
2. Check that Firebase auth, both backends, CORS and account libraries work with real accounts. Instrument total, authentication, database and any remaining Telegram durations; compare p50/p95 latency before and after. Never log bearer tokens. Local browser mocks are not production timing evidence.
3. After **all** selectable backends implement and pass the contract, set the public build-time variable `INTIMORA_PUBLIC_LIVE_LIKES=1` in the frontend deployment and rebuild. This enables polling of visible cards and the open player approximately every five seconds plus request time; hidden tabs pause and resume when visible. It is near-live polling, not instant push. Requests are batched in groups of at most 20, with at most 80 videos polled per cycle and rotation for larger sets.
4. The current frontend shows an immediate, clearly pending like/save state and rolls it back with a confirmation error if a response fails. This improves perceived responsiveness but does **not** make the current Telegram-backed write faster. No public count is invented when the server omits it. On an uncertain failure, refresh/check the profile before retrying; the old toggle endpoint is not idempotent.

Revert the build flag to off if the endpoint is unavailable or inconsistent. The production site and both backend hosts must be tested after deployment; this document does not deploy either repository.
