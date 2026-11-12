import React, { useEffect, useRef, useState } from "react";
import { Play, Eye, Share2, Heart, ThumbsUp } from "lucide-react";
import type { Video } from "../data/mockVideos";
import type { LiveLikes } from "../hooks/useLiveLikes";
import { isPremiumLabel } from "../utils/video-labels";

interface VideoCardProps {
  video: Video;
  onPlay: (video: Video) => void;
  onShare: (video: Video) => void;
  onSave: (video: Video) => void;
  saved: boolean;
  savePending: boolean;
  observeLikes: LiveLikes["observe"];
}

// A catalogue card: the thumbnail is the card, with the title and a single
// metadata line underneath (creator · views · likes). No box, no frame — the
// grid reads like a wall of thumbnails, and the image is never cropped or
// zoomed.
const VideoCard: React.FC<VideoCardProps> = ({ video, onPlay, onShare, onSave, saved, savePending, observeLikes }) => {
  const [hovered, setHovered] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!cardRef.current) return;
    return observeLikes(cardRef.current, video);
  }, [observeLikes, video.id, video.backendBase]);

  return (
    <div
      ref={cardRef}
      className="video-card group cursor-pointer"
      style={{
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 200ms ease",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="video-card__media relative overflow-hidden rounded-lg" style={{ aspectRatio: "16/9" }}>
        <img
          src={video.thumbnail}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          alt={video.title}
          className="video-card__image w-full h-full object-contain"
          loading="lazy"
        />

        {/* Only our exclusive videos carry a badge — the sponsored card reuses
            this exact slot. Ordinary categories stay off the artwork. */}
        {video.isExclusive && (
          <div
            className="video-card__badge absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider"
            style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
          >
            EXCLUSIVE
          </div>
        )}

        {/* Duration, bottom right. */}
        <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/85 text-white text-[11px] font-semibold tabular-nums">
          {video.duration}
        </div>

        {/* The play control is separate from the image, which never zooms or crops. */}
        <button
          type="button"
          aria-label={`Play ${video.title}`}
          className="video-card__play absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-200"
          onClick={() => onPlay(video)}
        >
          <span className="video-card__play-icon w-14 h-14 rounded-full flex items-center justify-center">
            <Play className="w-7 h-7 text-black ml-1" fill="black" />
          </span>
        </button>

        {/* Quick actions on hover */}
        <div className="video-card__quick-actions absolute top-2 right-2 flex flex-col gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSave(video); }}
            aria-label={saved ? "Remove saved video" : "Save video"}
            aria-pressed={saved}
            aria-busy={savePending || undefined}
            title={savePending ? "Saving…" : undefined}
            disabled={savePending}
            className={`p-1.5 rounded-full transition-all ${saved ? "bg-yellow-500 text-black" : "bg-black/70 text-white hover:bg-yellow-500 hover:text-black"}`}
          >
            <Heart className={`w-3.5 h-3.5 ${savePending ? "animate-pulse" : ""}`} fill={saved ? "currentColor" : "none"} />
          </button>
          {savePending && <span role="status" className="absolute right-full top-0 mr-1 whitespace-nowrap rounded bg-black/85 px-2 py-1 text-xs text-white">Saving…</span>}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onShare(video); }}
            aria-label="Share video"
            className="p-1.5 rounded-full bg-black/70 text-white hover:bg-yellow-500 hover:text-black transition-all"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="pt-2" onClick={() => onPlay(video)}>
        <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors">
          {video.title}
        </h3>

        <div className="video-card__metadata flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5 text-xs text-gray-500">
          <span className="video-card__creator flex items-center gap-1.5 min-w-0">
            <img src={video.creatorAvatar} alt={video.creator} className="video-card__avatar w-4 h-4 rounded-full border border-yellow-800/50" />
            <span className="video-card__creator-name break-words">{video.creator}</span>
          </span>
          {/* Views and likes break onto the next line as one unit, so no
              separator is ever left dangling at the end of a row. */}
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span aria-hidden="true" className="hidden sm:inline text-gray-700">·</span>
            <span className="video-card__views flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {video.views} views
            </span>
            <span aria-hidden="true" className="text-gray-700">·</span>
            <span
              className="video-card__counts flex items-center gap-1"
              aria-label={video.likes === null ? "Like count unavailable" : `${video.likes.toLocaleString()} likes`}
            >
              <ThumbsUp className="w-3 h-3" />
              {video.likes === null ? "—" : video.likes.toLocaleString()}
            </span>
          </span>
        </div>

        {video.tags.filter((tag) => !isPremiumLabel(tag)).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {video.tags.filter((tag) => !isPremiumLabel(tag)).slice(0, 2).map((tag) => (
              <span key={tag} className="video-card__tag px-1.5 py-0.5 bg-gray-800/70 rounded text-[11px] text-gray-500">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoCard;
