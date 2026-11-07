import React, { useState } from "react";
import { Play, Clock, Eye, Share2, Heart, ThumbsUp } from "lucide-react";
import type { Video } from "../data/mockVideos";
import { isPremiumLabel } from "../utils/video-labels";

interface VideoCardProps {
  video: Video;
  onPlay: (video: Video) => void;
  onShare: (video: Video) => void;
}

const VideoCard: React.FC<VideoCardProps> = ({ video, onPlay, onShare }) => {
  const [hovered, setHovered] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div
      className="group rounded-xl overflow-hidden border border-gray-800/50 hover:border-yellow-800/50 transition-all duration-300 cursor-pointer"
      style={{
        background: "#0d0d0d",
        boxShadow: hovered ? "0 8px 30px rgba(201,168,76,0.12), 0 2px 8px rgba(0,0,0,0.5)" : "0 2px 8px rgba(0,0,0,0.3)",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Thumbnail */}
      <div className="relative overflow-hidden" style={{ aspectRatio: "16/9" }}>
        <img
          src={video.thumbnail}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          alt={video.title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          loading="lazy"
        />

        {/* Overlay */}
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{
            background: "linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.2) 50%, transparent 100%)",
            opacity: hovered ? 1 : 0.6,
          }}
        />

        {/* Category badge */}
        {!isPremiumLabel(video.category) && (
          <div
            className="video-card__badge absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold tracking-wider"
            style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
          >
            {video.category.toUpperCase()}
          </div>
        )}

        {/* Duration */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/80 text-white text-xs font-mono">
          <Clock className="w-3 h-3" />
          {video.duration}
        </div>

        {/* Play button */}
        <div
          className="video-card__play absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200"
          onClick={() => onPlay(video)}
        >
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-110"
            style={{ background: "rgba(201,168,76,0.9)", boxShadow: "0 0 25px rgba(201,168,76,0.6)" }}
          >
            <Play className="w-7 h-7 text-black ml-1" fill="black" />
          </div>
        </div>

        {/* Quick actions on hover */}
        <div className="video-card__quick-actions absolute top-2 right-2 flex flex-col gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
          <button
            onClick={(e) => { e.stopPropagation(); setSaved(!saved); }}
            aria-label={saved ? "Remove saved video" : "Save video"}
            className={`p-1.5 rounded-full transition-all ${saved ? "bg-yellow-500 text-black" : "bg-black/70 text-white hover:bg-yellow-500 hover:text-black"}`}
          >
            <Heart className="w-3.5 h-3.5" fill={saved ? "currentColor" : "none"} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onShare(video); }}
            aria-label="Share video"
            className="p-1.5 rounded-full bg-black/70 text-white hover:bg-yellow-500 hover:text-black transition-all"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="p-3" onClick={() => onPlay(video)}>
        <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors">
          {video.title}
        </h3>

        <div className="video-card__creator flex items-center gap-2 mt-2">
          <img src={video.creatorAvatar} alt={video.creator} className="video-card__avatar w-5 h-5 rounded-full border border-yellow-800/50" />
          <span className="video-card__creator-name text-gray-500 text-xs">{video.creator}</span>
        </div>

        <div className="video-card__metadata flex items-center justify-between mt-2">
          <div className="video-card__counts flex items-center gap-3 text-xs text-gray-600">
            <span className="flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {video.views}
            </span>
            <span className="flex items-center gap-1">
              <ThumbsUp className="w-3 h-3" />
              {video.likes.toLocaleString()}
            </span>
          </div>
          <span className="video-card__date text-gray-700 text-xs">{video.uploadedAt}</span>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1 mt-2">
          {video.tags.filter((tag) => !isPremiumLabel(tag)).slice(0, 2).map((tag) => (
            <span key={tag} className="video-card__tag px-1.5 py-0.5 bg-gray-800 rounded text-xs text-gray-500">
              #{tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VideoCard;
