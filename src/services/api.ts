import type { Video } from "../data/mockVideos";
import { createVisitorRequest } from "./visitor-route.mjs";

const visitor = createVisitorRequest({ discoveryUrl: __INTIMORA_DISCOVERY_URL__ });
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
  creator?: string;
  uploadedAt?: string;
  createdAt?: number;
  thumbnailUrl?: string;
  streamUrl?: string;
}

// Cursors and videos retain their source even after this tab discovers a new
// backend. They are public browser data, not authentication tokens.
export interface BackendCursor {
  value: string | number;
  backend: string;
}

interface CatalogResponse {
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

function publicVideo(input: unknown): ApiVideo | null {
  if (!input || typeof input !== "object") return null;
  const video = input as Record<string, unknown>;
  if (typeof video.id !== "string" || !ID_PATTERN.test(video.id)) return null;
  return {
    id: video.id,
    title: safeText(video.title, 300) || "Untitled Video",
    description: safeText(video.description, 4000),
    duration: nonnegativeNumber(video.duration),
    views: nonnegativeNumber(video.views),
    likes: nonnegativeNumber(video.likes),
    shares: nonnegativeNumber(video.shares),
    category: safeText(video.category, 100),
    creator: safeText(video.creator, 200),
    uploadedAt: safeText(video.uploadedAt, 100),
    createdAt: nonnegativeNumber(video.createdAt),
    tags: Array.isArray(video.tags) ? video.tags.slice(0, 30)
      .map((tag: unknown) => safeText(tag, 80)).filter((tag: string | undefined): tag is string => tag !== undefined) : undefined,
    thumbnailUrl: typeof video.thumbnailUrl === "string" ? video.thumbnailUrl : undefined,
    streamUrl: typeof video.streamUrl === "string" ? video.streamUrl : undefined,
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

const formatViews = (views: number | undefined): string => {
  if (!views) return "0";
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
};

const formatDate = (createdAt: number | undefined): string => {
  if (!createdAt) return "Just now";
  const ts = createdAt > 1e12 ? createdAt / 1000 : createdAt;
  const diff = Date.now() / 1000 - ts;
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

export const fetchVideos = (cursor?: BackendCursor | null) => {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", String(cursor.value));
  const query = params.size ? `?${params}` : "";
  return catalog(`/api/videos${query}`, cursor?.backend);
};

export const searchVideos = (query: string) => catalog(`/api/search?${new URLSearchParams({ q: query })}`);

export async function fetchVideoDetail(id: string, backend?: string) {
  const result = await visitor.requestJson(videoPath(id), undefined, backend);
  return { ok: true as const, video: publicVideo(result.body?.data), backend: result.backend };
}

export async function likeVideo(id: string, backend?: string) {
  await visitor.requestJson(`${videoPath(id)}/like`, { method: "POST" }, backend);
  return { ok: true as const };
}

export async function shareVideo(id: string, backend?: string) {
  await visitor.requestJson(`${videoPath(id)}/share`, { method: "POST" }, backend);
  return { ok: true as const };
}

export const getThumbnailUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/thumbnail`;
export const getStreamUrl = (id: string, backend: string) => `${backend}${videoPath(id)}/stream`;

export const mapApiVideoToVideo = (apiVideo: ApiVideo, backend: string): Video => ({
  id: apiVideo.id,
  title: apiVideo.title || "Untitled Video",
  thumbnail: safeMediaUrl(apiVideo.thumbnailUrl, apiVideo.id, "thumbnail", backend),
  duration: formatDuration(apiVideo.duration),
  views: formatViews(apiVideo.views),
  likes: apiVideo.likes || 0,
  category: apiVideo.category || "New",
  tags: apiVideo.tags || [],
  videoUrl: safeMediaUrl(apiVideo.streamUrl, apiVideo.id, "stream", backend),
  backendBase: backend,
  creator: apiVideo.creator || "Intimora",
  creatorAvatar: "/logo.png",
  uploadedAt: apiVideo.uploadedAt || formatDate(apiVideo.createdAt),
  description: apiVideo.description || "",
});
