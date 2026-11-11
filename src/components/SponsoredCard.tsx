import React, { useState } from "react";
import { Play, Clock } from "lucide-react";
import type { SponsoredCard as SponsoredCardData } from "../services/partner-cards.mjs";

// A sponsored partner video rendered with the same card markup, outline and
// typography as the site's own cards, so it reads as part of the catalogue. The
// only difference is the badge: the slot that shows EXCLUSIVE on our videos
// shows SPONSORED here.
interface SponsoredCardProps {
  card: SponsoredCardData;
  onPlay: (card: SponsoredCardData) => void;
}

const SponsoredCard: React.FC<SponsoredCardProps> = ({ card, onPlay }) => {
  const [hovered, setHovered] = useState(false);
  const title = card.title || "Sponsored video";
  return (
    <div
      className="video-card video-card--sponsored group rounded-xl overflow-hidden border border-gray-800/50 hover:border-yellow-800/50 transition-all duration-300 cursor-pointer"
      style={{
        background: "#0d0d0d",
        boxShadow: hovered ? "0 8px 30px rgba(201,168,76,0.12), 0 2px 8px rgba(0,0,0,0.5)" : "0 2px 8px rgba(0,0,0,0.3)",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="video-card__media relative overflow-hidden" style={{ aspectRatio: "16/9" }}>
        {card.thumbnail ? (
          <img
            src={card.thumbnail}
            referrerPolicy="no-referrer"
            alt={title}
            className="video-card__image w-full h-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="video-card__image w-full h-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #141414, #0a0a0a)" }}>
            <Play className="w-10 h-10" style={{ color: "#3a3a3a" }} />
          </div>
        )}

        {/* Same badge slot as the EXCLUSIVE badge on our own videos. */}
        <div
          className="video-card__badge absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold tracking-wider"
          style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
        >
          SPONSORED
        </div>

        <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/80 text-white text-xs font-mono">
          <Clock className="w-3 h-3" />
          AD
        </div>

        <button
          type="button"
          aria-label={`Play ${title}`}
          className="video-card__play absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-200"
          onClick={() => onPlay(card)}
        >
          <span className="video-card__play-icon w-14 h-14 rounded-full flex items-center justify-center">
            <Play className="w-7 h-7 text-black ml-1" fill="black" />
          </span>
        </button>
      </div>

      <div className="p-3" onClick={() => onPlay(card)}>
        <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors">
          {title}
        </h3>
        <div className="video-card__creator flex items-center gap-2 mt-2">
          <img src="/logo.png" alt="Intimora" className="video-card__avatar w-5 h-5 rounded-full border border-yellow-800/50 object-contain" />
          <span className="video-card__creator-name text-gray-500 text-xs">Sponsored</span>
        </div>
        <div className="video-card__metadata flex items-center justify-between mt-2">
          <div className="video-card__counts flex items-center gap-3 text-xs text-gray-600">
            <span className="flex items-center gap-1">Promoted</span>
          </div>
          <span className="video-card__date text-gray-700 text-xs">Ad</span>
        </div>
      </div>
    </div>
  );
};

export default SponsoredCard;
