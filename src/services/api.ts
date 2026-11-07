import type { Video } from "../data/mockVideos";
import { createVisitorRequest } from "./visitor-route.mjs";

// All browser requests are same-origin. The server resolves and contacts the
// upstream privately, and only returns the fields needed by the UI.
const API_BASE = "/_api";
const videoPath = (id: string) => `${API_BASE}/api/videos/${encodeURIComponent(id)}`;

const safeMediaUrl = (url: string | undefined, id: string, type: "thumbnail" | "stream"): string => {
  if (url && /^\/_api\/media\/[A-Za-z0-9_-]+$/.test(url)) return url;
  return `${videoPath(id)}/${type}`;
};

const formatDuration = (seconds: number | string | undefined): string => {
  if (!seconds || seconds === 0) return "0:00";
  const secs = typeof seconds === "string" ? parseFloat(seconds) : seconds;
  if (isNaN(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const formatViews = (views: number | undefined): string => {
  if (!views || views === 0) return "0";
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
};

const formatDate = (createdAt: number | string | undefined): string => {
  if (!createdAt) return "Just now";
  const ts = typeof createdAt === "string" ? parseInt(createdAt) : createdAt;
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)} months ago`;
  return `${Math.floor(diff / 31536000)} years ago`;
};

export interface ApiVideo {
  id: string;
  title: string;
  description?: string;
  duration?: number | string;
  views?: number;
  likes?: number;
  shares?: number;
  category?: string;
  tags?: string[];
  creator?: string;
  uploadedAt?: string;
  createdAt?: number | string;
  thumbnailUrl?: string;
  streamUrl?: string;
}

const requestJson = createVisitorRequest();

export const fetchVideos = async (cursor?: string | null | number) => {
  const params = new URLSearchParams();
  if (cursor !== undefined && cursor !== null && cursor !== "") params.set("cursor", String(cursor));
  const query = params.size ? `?${params}` : "";
  return requestJson(`${API_BASE}/api/videos${query}`);
};

export const fetchVideoDetail = (id: string) => requestJson(videoPath(id));
export const searchVideos = (query: string) =>
  requestJson(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`);
export const likeVideo = (id: string) => requestJson(`${videoPath(id)}/like`, { method: "POST" });
export const shareVideo = (id: string) => requestJson(`${videoPath(id)}/share`, { method: "POST" });
export const getThumbnailUrl = (id: string) => `${videoPath(id)}/thumbnail`;
export const getStreamUrl = (id: string) => `${videoPath(id)}/stream`;

export const mapApiVideoToVideo = (apiVideo: ApiVideo): Video => ({
  id: apiVideo.id,
  title: apiVideo.title || "Untitled Video",
  thumbnail: safeMediaUrl(apiVideo.thumbnailUrl, apiVideo.id, "thumbnail"),
  duration: formatDuration(apiVideo.duration),
  views: formatViews(apiVideo.views),
  likes: apiVideo.likes || 0,
  category: apiVideo.category || "New",
  tags: apiVideo.tags || [],
  videoUrl: safeMediaUrl(apiVideo.streamUrl, apiVideo.id, "stream"),
  creator: apiVideo.creator || "Intimora",
  // Avoid exposing arbitrary external avatar URLs or sending viewer IPs to them.
  creatorAvatar: "/logo.png",
  uploadedAt: apiVideo.uploadedAt || formatDate(apiVideo.createdAt),
  description: apiVideo.description || "",
});
