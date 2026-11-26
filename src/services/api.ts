import type { Video } from "../data/mockVideos";
import { createVisitorRequest } from "./visitor-route.mjs";
import { PHP_ORIGIN_OVERRIDE } from "../config/php-backend.mjs";
import {
  activeTarget,
  confirmPhpSession,
  notePhpFailure,
  phpFailureReason,
  phpSessionPending,
  requestPhpUnlock,
  resetPhpSession,
  setActiveTarget,
} from "./php-session.mjs";
import { recordDiagnostic } from "./diagnostics.mjs";
import { registerEntry } from "./identity.mjs";
import { playbackSources, trailerSource } from "./media-source.mjs";
import { ensureViewerToken, viewerQuery } from "./premium-viewer.mjs";
import { fetchAnimeStream, hlsPlayable, isHlsLink } from "./anime-api.mjs";
import { LIKE_COUNT_BATCH_SIZE, parseLikeCounts } from "./like-counts.mjs";

const visitor = createVisitorRequest({
  discoveryUrl: __INTIMORA_DISCOVERY_URL__,
  // The load balancer decides everything: its `php` flag selects the transport.
  // PHP_ORIGIN_OVERRIDE is empty in normal use; it only pins a host for testing.
  backendOverride: PHP_ORIGIN_OVERRIDE,
  // Remembers which backend the visitor is on, including whether it is a PHP
  // host, so media and account calls follow the same rules.
  onTarget: setActiveTarget,
  // Only a PHP host can ask for this: one navigation through its check page,
  // with no proxy in between.
  requestUnlock: requestPhpUnlock,
  // A PHP answer that arrived means the cookie works; the window goes quiet.
  onPhpSuccess: confirmPhpSession,
  // Every direct call reports how it ended, so the failure screen can name its
  // reason and the console trace can be pasted as-is.
  onOutcome: (outcome: { path: string; php: boolean; ok: boolean; challenge: boolean; blocked: boolean; cors?: boolean; status?: number }) => {
    recordDiagnostic("request", outcome);
    if (!outcome.ok) notePhpFailure(outcome);
  },
});
const unavailable = () => new Error("Content is temporarily unavailable");
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface ApiVideo {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  views?: number;
  likes?: number;
  shares?: number;
  category?: string;
  tags?: string[];
  exclusive?: boolean;
  // Premium arrives as a flag and/or as a tag/category; both are preserved.
  premium?: boolean;
  isPremium?: boolean;
  // Premium videos are drawn but locked, and a locked video may still offer a
  // trailer. Both flags come from the backend and are never inferred here.
  locked?: boolean;
  hasTrailer?: boolean;
  // What the answer says is being played: the full video, or only the trailer.
  playbackType?: "full" | "trailer";
  trailerUrl?: string;
  trailerSize?: number;
  creator?: string;
  uploadedAt?: string;
  // Normalized to Unix milliseconds when present.
  createdAt?: number;
  thumbnailUrl?: string;
  streamUrl?: string;
  // The server pointing at the file on its CDN host. Newer uploads are stored
  // there; older ones still stream their bytes from the backend.
  cdnUrl?: string;
  bestfile?: { download_link?: string };
}

// Cursors and videos retain their source even after this tab discovers a new
// backend. They are public browser data, not authentication tokens.
export interface BackendCursor {
  value: string | number;
  backend: string;
}

export interface CatalogResponse {
  ok: true;
  data: { videos: ApiVideo[]; nextCursor: BackendCursor | null; backend: string };
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/https?:\/\/[^\s<>"']+/gi, "[link removed]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
}

function nonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

// A media link is a URL, not prose: safeText would strip it. Only the shape is
// checked here; whether it is playable is decided by media-source.mjs.
function mediaLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text === value && text.length <= 2048 ? text : undefined;
}

function timestampMs(value: unknown): number | undefined {
  const numeric = nonnegativeNumber(value);
  if (numeric !== undefined && numeric > 0) {
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
  }
  if (typeof value !== "string") return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date.getTime() : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/i.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasExclusiveMetadata(video: Record<string, unknown>): boolean {
  const metadata = video.metadata && typeof video.metadata === "object" && !Array.isArray(video.metadata)
    ? video.metadata as Record<string, unknown> : {};
  const exclusiveFlag = (value: unknown): boolean | undefined => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "exclusive"].includes(normalized)) return true;
    if (["false", "0", "non-exclusive", "public"].includes(normalized)) return false;
    return undefined;
  };
  // The backend's explicit boolean is authoritative; labels are only a
  // fallback for other public API formats that do not supply a flag.
  const flag = exclusiveFlag(video.exclusive) ?? exclusiveFlag(metadata.exclusive);
  if (flag !== undefined) return flag;
  const exclusiveLabel = (value: unknown) => typeof value === "string"
    && value.trim().replace(/^#+\s*/, "").toLowerCase() === "exclusive";
  const labels = [video.category, metadata.category, video.metadata];
  for (const tags of [video.tags, metadata.tags]) {
    if (Array.isArray(tags)) labels.push(...tags.slice(0, 30));
  }
  return labels.some(exclusiveLabel);
}

// Premium follows the same rule as exclusive: an explicit boolean is
// authoritative, and the word in a category or a tag is the fallback for public
// API formats that do not send a flag. The raw record is read here so the value
// survives into the mapped Video the Premium chip reads.
function hasPremiumMetadata(video: Record<string, unknown>): boolean {
  const metadata = video.metadata && typeof video.metadata === "object" && !Array.isArray(video.metadata)
    ? video.metadata as Record<string, unknown> : {};
  const flagOf = (value: unknown): boolean | undefined => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "premium"].includes(normalized)) return true;
    if (["false", "0", "free", "public"].includes(normalized)) return false;
    return undefined;
  };
  const flag = flagOf(video.premium) ?? flagOf(video.isPremium) ?? flagOf(metadata.premium) ?? flagOf(metadata.isPremium);
  if (flag !== undefined) return flag;
  const premiumLabel = (value: unknown) => typeof value === "string"
    && /(^|[^a-z])premium([^a-z]|$)/i.test(value.trim().replace(/^#+\s*/, ""));
  const labels: unknown[] = [video.category, metadata.category, video.badge, video.tier];
  for (const tags of [video.tags, metadata.tags]) {
    if (Array.isArray(tags)) labels.push(...tags.slice(0, 30));
  }
  return labels.some(premiumLabel);
}

function metadataValue(video: Record<string, unknown>, key: string): unknown {
  const own = video[key];
  if (own !== undefined && own !== null) return own;
  const value = video.metadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) return own;
  const nested = value as Record<string, unknown>;
  const direct = nested[key];
  if (direct !== undefined && direct !== null) return direct;
  // Some uploads keep the media facts one level deeper, under `media`.
  const media = nested.media;
  return media && typeof media === "object" && !Array.isArray(media)
    ? (media as Record<string, unknown>)[key]
    : direct;
}
// A link that may live on the record, in `metadata`, or in `metadata.media`; it is
// kept only when it is a plain string, exactly as `mediaLink` requires.
function metadataLink(video: Record<string, unknown>, key: string): string | undefined {
  const value = metadataValue(video, key);
  return typeof value === "string" ? mediaLink(value) : undefined;
}

function metadataFlag(video: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadataValue(video, key);
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase()) ? true
    : ["false", "0", "no", ""].includes(value.trim().toLowerCase()) ? false : undefined;
  return undefined;
}

// The backend sends the type of what it just handed over (`type`, `playbackType`
// or `videoType`, on the record or in `metadata`). Anything it does not say is
// left undefined, so the player falls back to reading the link itself.
function playbackTypeOf(video: Record<string, unknown>): "full" | "trailer" | undefined {
  const raw = metadataValue(video, "playbackType") ?? metadataValue(video, "videoType") ?? metadataValue(video, "type");
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["trailer", "trailer_only", "trailer-only", "preview", "teaser"].includes(value)) return "trailer";
  if (["full", "full_video", "full-video", "stream", "main", "main_video"].includes(value)) return "full";
  return undefined;
}

function publicVideo(input: unknown): ApiVideo | null {
  if (!input || typeof input !== "object") return null;
  const video = input as Record<string, unknown>;
  if (typeof video.id !== "string" || !ID_PATTERN.test(video.id)) return null;
  const likes = nonnegativeNumber(video.likes);
  return {
    id: video.id,
    title: safeText(video.title, 300) || "Untitled Video",
    description: safeText(video.description, 4000),
    duration: nonnegativeNumber(video.duration),
    views: nonnegativeNumber(video.views),
    likes: Number.isSafeInteger(likes) ? likes : undefined,
    shares: nonnegativeNumber(video.shares),
    category: safeText(video.category, 100),
    exclusive: hasExclusiveMetadata(video),
    premium: hasPremiumMetadata(video),
    locked: video.locked === true,
    // Some answers carry the trailer inside `metadata` instead of on the record.
    // Both places are read, the record winning, so a trailer that exists is never
    // missed — a missing trailer is what made a locked video unplayable.
    hasTrailer: video.hasTrailer === true || metadataFlag(video, "hasTrailer") === true,
    // The backend also says which of the two links this answer is offering. It is
    // read as a hint only — the links themselves stay the authority on what plays —
    // so the player can label a trailer that arrives as a plain media file, where
    // there is no `kind=trailer` in the URL to read.
    playbackType: playbackTypeOf(video),
    trailerUrl: metadataLink(video, "trailerUrl"),
    trailerSize: nonnegativeNumber(video.trailerSize) ?? nonnegativeNumber(metadataValue(video, "trailerSize")),
    creator: safeText(video.creator, 200),
    uploadedAt: safeText(video.uploadedAt, 100),
    createdAt: timestampMs(video.createdAt) ?? timestampMs(video.uploadedAt),
    tags: Array.isArray(video.tags) ? video.tags.slice(0, 30)
      .map((tag: unknown) => safeText(tag, 80)).filter((tag: string | undefined): tag is string => tag !== undefined) : undefined,
    thumbnailUrl: typeof video.thumbnailUrl === "string" ? video.thumbnailUrl : undefined,
    streamUrl: typeof video.streamUrl === "string" ? video.streamUrl : undefined,
    cdnUrl: mediaLink(video.cdnUrl),
    bestfile: mediaLink((video.bestfile as Record<string, unknown> | undefined)?.download_link)
      ? { download_link: mediaLink((video.bestfile as Record<string, unknown>).download_link) as string }
      : undefined,
  };
}

const videoPath = (id: string) => {
  if (!ID_PATTERN.test(id)) throw unavailable();
  return `/api/videos/${id}`;
};

function safeMediaUrl(raw: string | undefined, id: string, type: "thumbnail" | "stream", backend: string): string {
  const fallback = `${backend}${videoPath(id)}/${type}`;
  if (raw && raw.length <= 2048) {
    try {
      const candidate = new URL(raw, `${backend}/`);
      const expected = new URL(fallback);
      // Only the public media route for this video is accepted. This also
      // rejects third-party trackers and signed/credential-bearing URLs.
      if (candidate.origin === expected.origin && candidate.pathname === expected.pathname
        && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) return candidate.href;
    } catch { /* Use the ordinary backend media route instead. */ }
  }
  return fallback;
}

const formatDuration = (seconds: number | undefined): string => {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

export const formatViews = (views: number | undefined): string => {
  if (!views) return "0";
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
};

const formatDate = (createdAt: number | undefined): string => {
  if (!createdAt) return "Date unavailable";
  const diff = Math.max(0, (Date.now() - createdAt) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)} months ago`;
  return `${Math.floor(diff / 31536000)} years ago`;
};

// The video reads carry the signed viewer token when this tab has one, so the
// backend can shape premium answers for the account on a preflight-free GET.
function withViewer(path: string): string {
  const viewer = viewerQuery();
  if (!viewer) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${viewer}`;
}

async function catalog(path: string, pinnedBackend?: string): Promise<CatalogResponse> {
  await ensureViewerToken();
  const { body, backend, invalidate } = await visitor.requestJson(withViewer(path), undefined, pinnedBackend);
  if (!Array.isArray(body?.data?.videos)) {
    // The server answered, but not in the shape this client reads. That is a
    // different problem from a check page, so it is reported as one.
    recordDiagnostic("shape", { path });
    notePhpFailure({ shape: true, path });
    invalidate();
    throw unavailable();
  }
  const videos = body.data.videos.slice(0, 500).map(publicVideo).filter((video: ApiVideo | null): video is ApiVideo => video !== null);
  const cursor: unknown = body.data.nextCursor;
  const validCursor = (typeof cursor === "string" && cursor.length > 0 && cursor.length <= 1024)
    || (typeof cursor === "number" && Number.isFinite(cursor));
  return { ok: true, data: { videos, nextCursor: validCursor ? { value: cursor as string | number, backend } : null, backend } };
}

// Start discovery when the visitor arrives, including while the age gate is open.
// Every discovery waits for this page load's entry, so the identity step always
// happens first and the server is chosen afterwards.
const discover = () => visitor.selectBackend();
export const primeBackendSelection = () => startEntry().then(discover);
// The visitor pressed "Retry Connection": give the PHP unlock its budget back.
export const retryPhpSession = resetPhpSession;
// True when the visitor is on a PHP host that already spent its unlock budget
// and still has not been let in — the honest reason for an "unavailable" screen.
export const phpConnectionBlocked = () => activeTarget().php && !phpSessionPending();
// The reason behind an "unavailable" screen on a PHP host, for the message on
// screen and for `__intimoraDiag()` in the console.
export const phpFailure = phpFailureReason;
// The transport (backend + `php` flag) for the account calls.
export const primeBackendTarget = () => visitor.selectTarget();
export const resolveBackendTarget = (pinned?: string) => visitor.resolveTarget(pinned);

// A click asks the anime service's own watch route for the playable link; that
// answer is the only source of an anime stream. The link is handed to the player
// exactly as it arrived — nothing is proxied, rebuilt or cached — and the
// <video> element then talks to the source directly.
// `refused` is the case the backend's own playlist shows: the manifest is sent,
// but the source host denies the segments to this page (referrer/origin check).
export type AnimeStreamReason = "ok" | "no-id" | "no-link" | "unreachable" | "refused";

export async function fetchAnimeStreamUrl(id: string): Promise<{ url: string | null; reason: AnimeStreamReason }> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return { url: null, reason: "no-id" };
  const url = await fetchAnimeStream(id);
  if (!url) return { url: null, reason: "no-link" };
  if (isHlsLink(url) && !(await hlsPlayable(url))) return { url: null, reason: "refused" };
  return { url, reason: "ok" };
}

export const fetchVideos = (cursor?: BackendCursor | null, limit?: number) => {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", String(cursor.value));
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw unavailable();
    params.set("limit", String(limit));
  }
  const query = params.size ? `?${params}` : "";
  return catalog(`/api/videos${query}`, cursor?.backend);
};

export const searchVideos = (query: string) => catalog(`/api/search?${new URLSearchParams({ q: query })}`);

// This optional endpoint is read-only: unlike the detail route, it must never
// count a view. Do not poll it until the backend contract is deployed.
export async function fetchLikeCounts(ids: string[], backend: string, signal?: AbortSignal) {
  if (!ids.length || ids.length > LIKE_COUNT_BATCH_SIZE || ids.some((id) => !ID_PATTERN.test(id))
    || new Set(ids).size !== ids.length) throw unavailable();
  const query = new URLSearchParams({ ids: ids.join(",") });
  const { body } = await visitor.requestJson(`/api/likes/counts?${query}`, { signal }, backend);
  return parseLikeCounts(body?.data, ids);
}

// The detail answer carries the view count and the media links. A host can refuse
// the call itself (a WAF rule, a rate limit, a blocked visitor): that is reported
// as `detailFailed` instead of a generic failure, because the card the visitor
// already has is still good — the player must not be taken away for it.
//
// `token` is the signed-in visitor's Firebase token. The backend answers this route
// differently when it knows who is asking — a premium title comes back with its full
// tokenised stream for an active member, and with the locked shape (a trailer) for
// everyone else — so a signed-in visitor's request carries it. The token travels in
// the header only; it never reaches a URL, the storage or a log. Without a token
// (a guest) the call is exactly what it was before.
export async function fetchVideoDetail(id: string, backend?: string, token?: string) {
  const headers = typeof token === "string" && token ? { Authorization: `Bearer ${token}` } : undefined;
  // A host behind a browser check refuses the preflight that Authorization
  // header would trigger, so the account also travels as a short-lived signed
  // viewer token. That one is a plain query parameter and needs no preflight.
  await ensureViewerToken();
  try {
    const result = await visitor.requestJson(withViewer(videoPath(id)), headers ? { headers } : undefined, backend);
    return { ok: true as const, video: publicVideo(result.body?.data), backend: result.backend, detailFailed: false };
  } catch (error) {
    const refused = typeof error === "object" && error !== null && (error as { detailFailed?: boolean }).detailFailed === true;
    return {
      ok: false as const,
      video: null,
      backend: backend ?? "",
      detailFailed: true,
      status: refused ? (error as { status?: number }).status : undefined,
      refused,
    };
  }
}

export async function shareVideo(id: string, backend?: string) {
  await visitor.requestJson(`${videoPath(id)}/share`, { method: "POST" }, backend);
  return { ok: true as const };
}

export const getThumbnailUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/thumbnail`;
// A premium stream link carries the backend's own token, so it is passed through
// only when it is a same-backend/media-shaped URL; otherwise the plain byte route
// stays the answer (which is what a free video gets anyway).
export const getStreamUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/stream`;

// The backend hands premium playback a token-carrying link
// (`/api/videos/<id>/stream?t=…`, `/stream?kind=trailer&t=…`). A media element
// cannot send an Authorization header, so that exact link is what it must use —
// but only after it is checked to be an https URL on the same backend with the
// media path and a token, so a hostile answer cannot point the player elsewhere.
export function mediaLinkFrom(raw: unknown, backend: string, kind: "stream" | "trailer" = "stream"): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let base: URL;
  try { base = new URL(backend); } catch { return null; }
  const value = raw.startsWith("/") ? `${base.origin}${raw}` : raw;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== base.origin) return null;
  if (url.username || url.password) return null;
  if (!/^\/api\/videos\/[A-Za-z0-9_-]{1,128}\/stream$/.test(url.pathname)) return null;
  // The query may carry only the token, plus `kind=trailer` on a trailer link.
  for (const key of url.searchParams.keys()) {
    if (key !== "t" && !(kind === "trailer" && key === "kind")) return null;
  }
  if (kind === "trailer" && url.searchParams.get("kind") !== "trailer") return null;
  if (kind === "stream" && url.searchParams.get("kind") !== null) return null;
  const tokens = url.searchParams.getAll("t");
  if (tokens.length > 1) return null;
  if (tokens.length === 1) {
    const token = tokens[0];
    if (!token || token.length > 512) return null;
    return url.href;
  }
  // A trailer is public on the backend: its own answers send
  // `/api/videos/<id>/stream?kind=trailer` with no token at all, and that exact
  // link is what the player must use. Requiring a token here dropped it, so a
  // locked premium video promised a trailer and then had nothing to play.
  if (kind === "trailer" && !url.hash) return url.href;
  // No `t` in the query: the token may instead be the fragment a media element
  // sends (`#t=<token>`, or the bare token some deploy scripts build). It is the
  // backend's own token either way, and nothing else may ride along with it.
  const hash = url.hash.replace(/^#/, "");
  if (!hash || hash.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(hash)) return null;
  return url.href;
}

// Exported for the trailer tests only: the payload and the backend go in, the
// mapped record comes out, with no network involved.
export const publicVideoForTest = publicVideo;

// The titles where the backend, not the player, decides which link exists: the
// `locked` verdict on this answer (this visitor may not see it in full), or a
// premium record. `publicVideo` has already merged the flag, the category and the
// tag into `premium`, so reading it here is the same decision the player makes.
function premiumTitleOf(apiVideo: ApiVideo): boolean {
  return apiVideo.premium === true || apiVideo.locked === true;
}

// The link this title may play in full, or an empty string when the backend did
// not issue one for this answer. Nothing here invents a stream link: a premium
// title with no issued link plays its trailer (or shows the panel that says it
// has neither), instead of asking `/stream` for a JSON refusal.
function streamLink(apiVideo: ApiVideo, backend: string): string {
  const issued = mediaLinkFrom(apiVideo.streamUrl, backend, "stream");
  if (issued) return issued;
  if (premiumTitleOf(apiVideo)) return "";
  const playback = playbackSources(apiVideo, backend, apiVideo.id);
  return playback.videoUrl;
}

export const mapApiVideoToVideo = (apiVideo: ApiVideo, backend: string): Video => {
  // Validate the id the same way every other media URL does before it is used.
  videoPath(apiVideo.id);
  const playback = playbackSources(apiVideo, backend, apiVideo.id);
  return {
    id: apiVideo.id,
    title: apiVideo.title || "Untitled Video",
    thumbnail: safeMediaUrl(apiVideo.thumbnailUrl, apiVideo.id, "thumbnail", backend),
    duration: formatDuration(apiVideo.duration),
    views: formatViews(apiVideo.views),
    viewCount: apiVideo.views ?? 0,
    createdAt: apiVideo.createdAt ?? null,
    isExclusive: apiVideo.exclusive === true,
    // The backend's own premium flags: `premium` marks a premium title, `locked`
    // says this visitor may not see it in full. Both are kept so the player can
    // treat either as "premium" without deciding anything itself.
    premium: apiVideo.premium === true || apiVideo.isPremium === true || apiVideo.locked === true || undefined,
    likes: apiVideo.likes ?? null,
    category: apiVideo.category || (apiVideo.exclusive ? "Exclusive" : ""),
    tags: apiVideo.tags || [],
    // The CDN file when the server offered one, otherwise the byte stream; the
    // byte stream also stays behind a CDN URL so a dead link cannot stop playback.
    // A locked video gets a tokenised stream when the visitor's premium window is
    // open; otherwise the backend sends no stream at all and the player must not
    // build one itself — it would only be refused.
    // A locked video without a trailer has nothing to play: the backend sent no
    // stream link and no trailer, so the player says so instead of asking for a
    // stream it knows will be refused.
    //
    // A premium title only ever plays a link the backend issued for this answer
    // (its tokenised `streamUrl`, or the trailer). The bare `/stream` route is
    // never put in an `src` for it: without a token that route answers with a
    // small JSON error (`content-type: application/json`, ~58 bytes), and a media
    // element can only render that as "media could not be loaded" on an otherwise
    // playable title. That is exactly what happened on premium videos when the
    // detail call did not carry a link.
    videoUrl: streamLink(apiVideo, backend),
    fallbackVideoUrl: premiumTitleOf(apiVideo) ? undefined : playback.fallbackVideoUrl,
    locked: apiVideo.locked === true,
    // The tokenised stream form, or the direct media file the newer answers send.
    // Only the first keeps its token; the second carries none.
    trailerUrl: mediaLinkFrom(apiVideo.trailerUrl, backend, "trailer") ?? trailerSource(apiVideo.trailerUrl, backend),
    playbackType: apiVideo.playbackType,
    backendBase: backend,
    creator: apiVideo.creator || "Intimora",
    creatorAvatar: "/logo.png",
    uploadedAt: apiVideo.uploadedAt || formatDate(apiVideo.createdAt),
    description: apiVideo.description || "",
  };
};

// One entry per page load, in this order: the PHP identity host unlocks this
// visitor (its cookie) and writes the visitor row — IP, geo, browser, device —
// and only then does the load balancer name this page load's server. The server
// URL is never stored: a refresh is a new entry and a new answer, while a click
// inside the page keeps the server that delivered the page. Everything is
// swallowed, so neither step can ever delay or break the catalogue.
let entry: Promise<void> | null = null;

async function visitPayload(): Promise<string> {
  // Chrome on Android exposes the device model here; Safari and iOS have no
  // such API, so the field is simply left out there.
  let model = "";
  try {
    const uaData = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }> };
    }).userAgentData;
    if (uaData?.getHighEntropyValues) {
      const hints = await uaData.getHighEntropyValues(["model"]);
      if (typeof hints?.model === "string") model = hints.model;
    }
  } catch { /* No client hints: the user agent string is the fallback. */ }
  return JSON.stringify({
    ua: navigator.userAgent.slice(0, 500),
    ...(model ? { model: model.slice(0, 60) } : {}),
    lang: (navigator.language || "").slice(0, 20),
    tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "").slice(0, 40),
    screen: `${window.screen.width}x${window.screen.height}`,
    path: (location.pathname + location.search).slice(0, 250),
    referer: (document.referrer || "").slice(0, 250),
  });
}

export function startEntry(): Promise<void> {
  if (entry) return entry;
  entry = (async () => {
    try {
      const payload = await visitPayload();
      const identity = await registerEntry({ payload });
      // No identity host configured (an offline build or a test): the row still
      // travels through this page load's server, exactly as it used to.
      if (identity.skipped) {
        await discover().catch(() => {});
        await visitor.requestJson("/api/visit", { method: "POST", body: payload });
      }
    } catch { /* The identity step never blocks the catalogue. */ }
    await discover().catch(() => {});
  })();
  return entry;
}
