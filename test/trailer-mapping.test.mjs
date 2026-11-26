import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `api.ts` is the app's own module (Vite resolves the `__INTIMORA_*` build
// constants), so it is loaded through a Vite server rather than imported directly.
const loadApi = async () => {
  const vite = await createServer({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", server: { middlewareMode: true, hmr: false } });
  try {
    return await vite.ssrLoadModule("/src/services/api.ts");
  } finally {
    await vite.close();
  }
};

// A trailer that a premium answer carries must survive the mapping step. It was
// dropped there — only the tokenised stream form was accepted — so a locked video
// promised a trailer and then had nothing to play.
test("a premium answer's trailer survives mapping, from the record or from metadata", async () => {
  const { publicVideoForTest, mapApiVideoToVideo } = await loadApi();
  // `mapApiVideoToVideo` takes the already-public record; the raw payload is read
  // by the same step the page uses, so both halves of the path are covered.
  const mapped = (raw) => mapApiVideoToVideo(publicVideoForTest(raw), backend);
  const backend = "https://intimora-api1.vercel.app";
  const file = `${backend}/storage/trailers/t1.mp4`;
  const tokenised = `${backend}/api/videos/v-1/stream?kind=trailer&t=abc`;
  const record = { id: "v-1", title: "T", locked: true, hasTrailer: true, trailerUrl: "/storage/trailers/t1.mp4" };

  assert.equal(mapped(record).trailerUrl, file, "a direct media file is kept exactly as sent");
  assert.equal(mapped({ ...record, trailerUrl: tokenised }).trailerUrl, tokenised, "the tokenised form is unchanged");
  // The backend's own trailer link carries no token — the trailer route is public
  // (`/api/videos/<id>/stream?kind=trailer`) — so it must survive as issued.
  assert.equal(mapped({ ...record, trailerUrl: "/api/videos/v-1/stream?kind=trailer" }).trailerUrl,
    `${backend}/api/videos/v-1/stream?kind=trailer`);
  // A full stream with no token is still refused, premium or not.
  assert.equal(mapped({ ...record, premium: true, locked: false, streamUrl: "/api/videos/v-1/stream" }).videoUrl, "");

  // The trailer may arrive inside `metadata` instead of on the record.
  const raw = { id: "v-1", title: "T", locked: true, metadata: { hasTrailer: true, trailerUrl: "/storage/trailers/t1.mp4" } };
  // The flag is read from `metadata`, and the record it becomes keeps both halves.
  assert.equal(publicVideoForTest(raw).hasTrailer, true);
  const fromMetadata = mapped(raw);
  assert.equal(fromMetadata.trailerUrl, file);
  // A premium/locked video never gets the bare `/stream` route as its source: that
  // route answers without a token with a small JSON error (~58 bytes,
  // `content-type: application/json`), which a media element can only report as
  // "media could not be loaded". The trailer is what plays, and it is re-asked from
  // the backend when it expires — never swapped to a stream that would be refused.
  assert.equal(fromMetadata.videoUrl, "");
  assert.equal(fromMetadata.fallbackVideoUrl, undefined);
  assert.equal(fromMetadata.trailerUrl, file);

  // A premium window that is open arrives with its tokenised stream, and that link
  // is used exactly as issued.
  const open = mapped({ ...record, locked: false, premium: true, streamUrl: "/api/videos/v-1/stream?t=abc" });
  assert.equal(open.videoUrl, `${backend}/api/videos/v-1/stream?t=abc`);
  assert.equal(open.fallbackVideoUrl, undefined, "a premium title has no bare-stream fallback");
  // A premium title with no issued link and a trailer still plays the trailer and
  // never builds a stream link of its own.
  const noLink = mapped({ ...record, locked: false, premium: true, streamUrl: null });
  assert.equal(noLink.videoUrl, "", "nothing is invented for a premium title");
  assert.equal(noLink.trailerUrl, file);

  // Still refused: a page, a script, another origin's token, plain http.
  assert.equal(mapped({ ...record, trailerUrl: "https://bestfile.io/abc/file" }).trailerUrl, null);
  assert.equal(mapped({ ...record, trailerUrl: "javascript:alert(1)" }).trailerUrl, null);
  assert.equal(mapped({ ...record, trailerUrl: "https://evil.example/api/videos/v-1/stream?kind=trailer&t=abc" }).trailerUrl, null);
  assert.equal(mapped({ ...record, trailerUrl: "http://intimora-api1.vercel.app/storage/trailers/t1.mp4" }).trailerUrl, null);

  // The token may also arrive in the fragment the element sends; nothing else may
  // ride along with it.
  assert.equal(mapped({ ...record, trailerUrl: "/api/videos/v-1/stream?kind=trailer#abc" }).trailerUrl,
    `${backend}/api/videos/v-1/stream?kind=trailer#abc`);
  assert.equal(mapped({ ...record, trailerUrl: "/api/videos/v-1/stream?kind=trailer#abc&x=1" }).trailerUrl, null);

  // No trailer at all: a locked video still has nothing to play, and the player
  // says so instead of asking for a stream that would be refused.
  assert.equal(mapApiVideoToVideo(publicVideoForTest({ id: "v-1", title: "T", locked: true, hasTrailer: false }), backend).videoUrl, "");
  // `hasTrailer` on its own (no URL) must not make a video look playable.
  assert.equal(mapApiVideoToVideo(publicVideoForTest({ id: "v-1", title: "T", locked: true, hasTrailer: true }), backend).trailerUrl, null);
});

// Z5: the backend also names the type it sent. A trailer that arrives as a plain
// media file carries no `kind=trailer` in its URL, so the type is the only way the
// player can tell the visitor what they are watching. An answer that does not say
// is left undefined, so the link itself stays the fallback.
test("the answer's own type is kept, and unknown values are not guessed", async () => {
  const { publicVideoForTest, mapApiVideoToVideo } = await loadApi();
  const backend = "https://intimora-api1.vercel.app";
  const mapped = (raw) => mapApiVideoToVideo(publicVideoForTest(raw), backend);
  const base = { id: "v-1", title: "T", premium: true, locked: true, hasTrailer: true, trailerUrl: "/storage/trailers/t1.mp4" };

  assert.equal(mapped({ ...base, type: "trailer" }).playbackType, "trailer");
  assert.equal(mapped({ ...base, videoType: "full" }).playbackType, "full");
  assert.equal(mapped({ ...base, playbackType: "trailer" }).playbackType, "trailer", "the explicit field wins");
  assert.equal(mapped({ ...base, metadata: { type: "trailer" } }).playbackType, "trailer", "a type inside metadata is read too");
  assert.equal(mapped(base).playbackType, undefined, "an answer that does not say is not guessed");
  assert.equal(mapped({ ...base, type: "something-else" }).playbackType, undefined);
});
