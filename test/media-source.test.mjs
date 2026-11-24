import assert from "node:assert/strict";
import { test } from "node:test";
import { byteStreamUrl, looksLikeMediaFile, playbackSources, trailerSource } from "../src/services/media-source.mjs";

const BACKEND = "https://intimora-api2.site.je";
const BYTES = `${BACKEND}/api/videos/local-1/stream`;

const sources = (video) => playbackSources(video, BACKEND, "local-1");

test("a plain backend plays its own byte stream", () => {
  assert.deepEqual(sources({ streamUrl: "/api/videos/local-1/stream" }), { videoUrl: BYTES });
  assert.deepEqual(sources({}), { videoUrl: BYTES });
  assert.deepEqual(playbackSources(null, BACKEND, "local-1"), { videoUrl: BYTES });
});

test("an absolute stream URL on the backend origin is the byte stream, not a CDN", () => {
  assert.deepEqual(sources({ streamUrl: BYTES }), { videoUrl: BYTES });
});

test("a CDN file URL is played first, with the byte stream behind it", () => {
  const cdn = "https://cdn.example.com/media/clip.mp4";
  assert.deepEqual(sources({ streamUrl: "/api/videos/local-1/stream", cdnUrl: cdn }), {
    videoUrl: cdn,
    fallbackVideoUrl: BYTES,
  });
});

test("the server's own CDN path is accepted even without a file extension", () => {
  const cdn = `${BACKEND}/storage/cdn/abc123`;
  assert.deepEqual(sources({ cdnUrl: cdn }), { videoUrl: cdn, fallbackVideoUrl: BYTES });
});

test("a media-looking URL is used even when it arrives in streamUrl", () => {
  const cdn = "https://files.cdn-edge.net/9f8e/clip.webm";
  assert.deepEqual(sources({ streamUrl: cdn }), { videoUrl: cdn, fallbackVideoUrl: BYTES });
  assert.equal(sources({ bestfile: { download_link: "https://cdn.bestfile.io/x/fs-1.mp4" } }).videoUrl,
    "https://cdn.bestfile.io/x/fs-1.mp4");
});

test("a download page is never given to a media element", () => {
  // This is the shape the backend returns for a new upload: an HTML page with a
  // waiting timer, not a file. A <video> element can only fail on it.
  const page = "https://bestfile.io/ED8U6WTZ7KrIUGB/file";
  assert.deepEqual(sources({ streamUrl: "/api/videos/local-1/stream", bestfile: { download_link: page } }), {
    videoUrl: BYTES,
  });
  assert.equal(looksLikeMediaFile(new URL(page)), false);
});

test("a third-party tracker link is ignored, as it always was", () => {
  assert.deepEqual(sources({ streamUrl: "https://tracker.example/stream?token=secret-marker" }), {
    videoUrl: BYTES,
  });
});

test("only HTTPS media URLs are accepted", () => {
  for (const raw of ["http://cdn.example.com/clip.mp4", "javascript:alert(1)", "data:video/mp4;base64,AAA",
    "https://user:pass@cdn.example.com/clip.mp4", "https://cdn.example.com/clip.mp4#t=10",
    `https://cdn.example.com/${"a".repeat(2100)}.mp4`, " cdn.example.com/clip.mp4"]) {
    assert.deepEqual(sources({ cdnUrl: raw }), { videoUrl: BYTES }, `${raw} must be refused`);
  }
});

test("a relative CDN path is resolved against the backend", () => {
  assert.deepEqual(sources({ cdnUrl: "/storage/clip.mp4" }), {
    videoUrl: `${BACKEND}/storage/clip.mp4`,
    fallbackVideoUrl: BYTES,
  });
});

test("the byte stream URL is built once, without a trailing slash", () => {
  assert.equal(byteStreamUrl(`${BACKEND}/`, "local-1"), BYTES);
  assert.equal(byteStreamUrl("not a url", "local-1"), "not a url/api/videos/local-1/stream");
});

// The premium answers send a trailer as a plain media file as well as the
// tokenised stream link. Both are the backend's own; a page or a script never is.
test("a trailer is accepted only as a plain https media file on our side", () => {
  assert.equal(trailerSource("/storage/trailers/t1.mp4", BACKEND), `${BACKEND}/storage/trailers/t1.mp4`);
  assert.equal(trailerSource("/cdn/trailers/9f2a.webm", BACKEND), `${BACKEND}/cdn/trailers/9f2a.webm`);
  assert.equal(trailerSource("https://files.cdn-host.com/tr/a.mp4", BACKEND), "https://files.cdn-host.com/tr/a.mp4");
  // A tokenised stream link is not this shape: it is validated, with its token, in
  // `mediaLinkFrom`, and must not slip through here where no token is checked.
  assert.equal(trailerSource(`${BACKEND}/api/videos/local-1/stream?kind=trailer&t=abc`, BACKEND), null);
  assert.equal(trailerSource(`${BACKEND}/api/videos/local-1/stream?t=abc`, BACKEND), null);
  // Not a media file, not https, not ours.
  assert.equal(trailerSource("https://bestfile.io/abc/file", BACKEND), null);
  assert.equal(trailerSource("/storage/trailers/notes.txt", BACKEND), null);
  assert.equal(trailerSource("http://files.cdn-host.com/a.mp4", BACKEND), null);
  assert.equal(trailerSource("https://user:pass@files.cdn-host.com/a.mp4", BACKEND), null);
  assert.equal(trailerSource("javascript:alert(1)", BACKEND), null);
  assert.equal(trailerSource(null, BACKEND), null);
  assert.equal(trailerSource("/storage/trailers/a.mp4", ""), null);
});
