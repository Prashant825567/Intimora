export const DISCOVERY_URL = import.meta.env.VITE_API_DISCOVERY_URL
  || "https://intimora.tmc78lxnu.workers.dev/api/get-server";

// Production has no fixed API host: the server is set from the Worker discovery
// response at runtime. Local development uses Vite's proxy path.
let API_BASE = import.meta.env.DEV ? "/_api" : "";

export const setApiBase = (url: string) => {
  const discoveredBase = url.trim().replace(/\/+$/, "");
  if (!discoveredBase) throw new Error("API discovery returned an empty server URL");
  API_BASE = import.meta.env.DEV ? "/_api" : discoveredBase;
};

export const getApiBase = () => API_BASE;

// Helper: convert relative URL from API to full URL
const toFullUrl = (urlOrPath: string | undefined, id: string, type: "thumbnail" | "stream"): string => {
  if (!urlOrPath) {
    return `${getApiBase()}/api/videos/${id}/${type}`;
  }
  // Already a full URL
  if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
    return urlOrPath;
  }
  // Relative path like "/api/videos/.../thumbnail"
  return `${getApiBase()}${urlOrPath}`;
};

// Format duration seconds -> "mm:ss"
const formatDuration = (seconds: number | string | undefined): string => {
  if (!seconds || seconds === 0) return "0:00";
  const secs = typeof seconds === "string" ? parseFloat(seconds) : seconds;
  if (isNaN(secs) || secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Format views count
const formatViews = (views: number | undefined): string => {
  if (!views || views === 0) return "0";
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
};

// Format timestamp -> "X days ago"
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
  creatorAvatar?: string;
  uploadedAt?: string;
  createdAt?: number | string;
  thumbnailUrl?: string;
  streamUrl?: string;
}

export const fetchVideos = async (cursor?: string | null | number) => {
  const base = getApiBase();
  const url = cursor ? `${base}/api/videos?cursor=${cursor}` : `${base}/api/videos`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch videos");
  return res.json();
};

export const fetchVideoDetail = async (id: string) => {
  const res = await fetch(`${getApiBase()}/api/videos/${id}`);
  if (!res.ok) throw new Error("Failed to fetch video detail");
  return res.json();
};

export const searchVideos = async (query: string) => {
  const res = await fetch(`${getApiBase()}/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("Failed to search videos");
  return res.json();
};

export const likeVideo = async (id: string) => {
  const res = await fetch(`${getApiBase()}/api/videos/${id}/like`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to like video");
  return res.json();
};

export const shareVideo = async (id: string) => {
  const res = await fetch(`${getApiBase()}/api/videos/${id}/share`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to share video");
  return res.json();
};

export const getThumbnailUrl = (id: string) => `${getApiBase()}/api/videos/${id}/thumbnail`;
export const getStreamUrl = (id: string) => `${getApiBase()}/api/videos/${id}/stream`;

import type { Video } from "../data/mockVideos";

export const mapApiVideoToVideo = (apiVideo: ApiVideo): Video => {
  return {
    id: apiVideo.id,
    title: apiVideo.title || "Untitled Video",
    // Fix relative thumbnailUrl -> full URL
    thumbnail: toFullUrl(apiVideo.thumbnailUrl, apiVideo.id, "thumbnail"),
    duration: formatDuration(apiVideo.duration),
    views: formatViews(apiVideo.views),
    likes: apiVideo.likes || 0,
    category: apiVideo.category || "New",
    tags: apiVideo.tags || [],
    // Fix relative streamUrl -> full URL
    videoUrl: toFullUrl(apiVideo.streamUrl, apiVideo.id, "stream"),
    creator: apiVideo.creator || "Intimora",
    creatorAvatar: apiVideo.creatorAvatar || `https://i.pravatar.cc/40?img=${Math.floor(Math.random() * 10) + 1}`,
    uploadedAt: apiVideo.uploadedAt || formatDate(apiVideo.createdAt),
    description: apiVideo.description || "",
  };
};
