// The backend answers a play request in two different ways: it streams the bytes
// itself (the older uploads) or it hands the player a CDN URL (the newer uploads
// that live on an outside host). Both must play, so this module decides which URL
// goes into <video src> and which one stays behind it as the fallback.
//
// A CDN URL is trusted when the server says it is one (`cdnUrl`), when it is on
// the backend's own origin, or when it actually looks like a media file
// (`.../clip.mp4`, `cdn.example/...`). A *download page*
// (`https://bestfile.io/<id>/file`) answers with HTML, so it can never play: it
// is skipped here instead of costing the visitor a failed load and a reload.
const MAX_URL_LENGTH = 2048;
const MEDIA_FILE = /\.(?:mp4|m4v|webm|mov|m3u8|mpd|ts)$/i;
// cdn.example.com, media.cdn-edge.net, files.cdn.example
const CDN_HOST = /(?:^|\.)cdn[.-]/i;

function backendBase(backend) {
  return typeof backend === "string" ? backend.replace(/\/+$/, "") : "";
}

export function byteStreamUrl(backend, id) {
  return `${backendBase(backend)}/api/videos/${id}/stream`;
}

export function byteStreamPath(id) {
  return `/api/videos/${id}/stream`;
}

function resolveHttps(raw, backend) {
  if (typeof raw !== "string" || raw !== raw.trim()) return null;
  if (!raw || raw.length > MAX_URL_LENGTH || !backendBase(backend)) return null;
  let url;
  try {
    url = new URL(raw, `${backendBase(backend)}/`);
  } catch {
    return null;
  }
  // Playback is HTTPS only, and a signed-in or fragment-bearing URL is never
  // handed to a media element: the tag cannot carry credentials and a fragment
  // would be dropped by the request anyway.
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  return url;
}

export function looksLikeMediaFile(url) {
  return MEDIA_FILE.test(url.pathname) || CDN_HOST.test(url.hostname);
}

// `cdnUrl` is the server saying "this is the CDN file" — trusted as long as it
// is a plain HTTPS URL. `streamUrl` and `bestfile.download_link` are generic
// links, so they have to look like something a media element can actually open.
export function playbackSources(video, backend, id) {
  const bytes = byteStreamUrl(backend, id);
  let bytesOrigin = null;
  try {
    bytesOrigin = new URL(bytes).origin;
  } catch {
    bytesOrigin = null;
  }
  const candidates = [
    { value: video?.cdnUrl, explicit: true },
    { value: video?.streamUrl, explicit: false },
    { value: video?.bestfile?.download_link, explicit: false },
  ];
  for (const { value, explicit } of candidates) {
    const url = resolveHttps(value, backend);
    if (!url) continue;
    const ownOrigin = bytesOrigin !== null && url.origin === bytesOrigin;
    // The server's own stream route on the backend origin *is* the byte path;
    // it is never treated as a second CDN source.
    if (ownOrigin && url.pathname === byteStreamPath(id)) continue;
    if (explicit || ownOrigin || looksLikeMediaFile(url)) {
      return { videoUrl: url.href, fallbackVideoUrl: bytes };
    }
  }
  return { videoUrl: bytes };
}

// A trailer the backend points at directly. The tokenised form
// (`/stream?kind=trailer&t=…`, `mediaLinkFrom` in `api.ts`) is handled there; this
// is the other shape the premium answers really send — a plain media file, either a
// CDN/object-storage URL or a path on the backend's own origin
// (`/storage/trailers/<file>.mp4`, `/cdn/trailers/…`).
//
// The rule is the same one playback uses: HTTPS only, no credentials, no fragment,
// and the link must actually be a media file. A page (`bestfile.io/<id>/file`) can
// never be a trailer, so it is dropped rather than handed to an element that would
// only fail. Nothing is proxied and the URL is used exactly as received.
export function trailerSource(raw, backend) {
  const url = resolveHttps(raw, backend);
  if (!url) return null;
  const params = [...url.searchParams.keys()];
  // A tokenised stream link keeps its own validation in `mediaLinkFrom`; it must
  // not be accepted here, where a token is not checked.
  if (url.pathname.includes("/stream") || params.length) return null;
  if (!MEDIA_FILE.test(url.pathname)) return null;
  return url.href;
}
