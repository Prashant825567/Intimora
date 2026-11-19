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
import { playbackSources } from "./media-source.mjs";
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
  onOutcome: (outcome: { path: string; php: boolean; ok: boolean; challenge: boolean; blocked: boolean; status?: number }) => {
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

async function catalog(path: string, pinnedBackend?: string): Promise<CatalogResponse> {
  const { body, backend, invalidate } = await visitor.requestJson(path, undefined, pinnedBackend);
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
export const primeBackendSelection = () => visitor.selectBackend();
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

export async function fetchVideoDetail(id: string, backend?: string) {
  const result = await visitor.requestJson(videoPath(id), undefined, backend);
  return { ok: true as const, video: publicVideo(result.body?.data), backend: result.backend };
}

export async function shareVideo(id: string, backend?: string) {
  await visitor.requestJson(`${videoPath(id)}/share`, { method: "POST" }, backend);
  return { ok: true as const };
}

export const getThumbnailUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/thumbnail`;
export const getStreamUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/stream`;

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
    likes: apiVideo.likes ?? null,
    category: apiVideo.category || (apiVideo.exclusive ? "Exclusive" : ""),
    tags: apiVideo.tags || [],
    // The CDN file when the server offered one, otherwise the byte stream; the
    // byte stream also stays behind a CDN URL so a dead link cannot stop playback.
    videoUrl: playback.videoUrl,
    fallbackVideoUrl: playback.fallbackVideoUrl,
    backendBase: backend,
    creator: apiVideo.creator || "Intimora",
    creatorAvatar: "/logo.png",
    uploadedAt: apiVideo.uploadedAt || formatDate(apiVideo.createdAt),
    description: apiVideo.description || "",
  };
};

// Visitor log: one POST per page load, fired after the 18+ gate. It travels
// through the same visitor route as the catalogue, so a PHP host's HTML check,
// its cookie and the one-time unlock are handled instead of being bypassed by a
// raw fetch. `text/plain` keeps it a "simple" request — no preflight, which a
// free host answers with its check page instead of JSON. Everything is
// swallowed: logging never slows down or breaks the catalogue.
let visitLogged = false;
export async function logVisit() {
  if (visitLogged) return;
  visitLogged = true;

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

  try {
    const payload = JSON.stringify({
      ua: navigator.userAgent.slice(0, 500),
      ...(model ? { model: model.slice(0, 60) } : {}),
      lang: (navigator.language || "").slice(0, 20),
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "").slice(0, 40),
      screen: `${window.screen.width}x${window.screen.height}`,
      path: (location.pathname + location.search).slice(0, 250),
      referer: (document.referrer || "").slice(0, 250),
    });
    await visitor.requestJson("/api/visit", { method: "POST", body: payload });
  } catch { /* Logging never breaks the app. */ }
}
