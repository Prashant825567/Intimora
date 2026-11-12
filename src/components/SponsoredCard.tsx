import React, { useState } from "react";
import { Play, Eye } from "lucide-react";
import type { SponsoredCard as SponsoredCardData } from "../services/partner-cards.mjs";

// A sponsored partner video in the site's own card design: same thumbnail
// treatment, same title block, same metadata line. The only difference is the
// badge, which occupies the slot that shows EXCLUSIVE on our own videos.
interface SponsoredCardProps {
  card: SponsoredCardData;
  onPlay: (card: SponsoredCardData) => void;
}

const SponsoredCard: React.FC<SponsoredCardProps> = ({ card, onPlay }) => {
  const [hovered, setHovered] = useState(false);
  const title = card.title || "Sponsored video";
  return (
    <div
      className="video-card video-card--sponsored group cursor-pointer"
      style={{
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 200ms ease",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="video-card__media relative overflow-hidden rounded-lg" style={{ aspectRatio: "16/9" }}>
        {card.thumbnail ? (
          <img
            src={card.thumbnail}
            referrerPolicy="no-referrer"
            alt={title}
            className="video-card__image w-full h-full object-contain"
            loading="lazy"
          />
        ) : (
          <div className="video-card__image w-full h-full flex items-center justify-center">
            <Play className="w-10 h-10" style={{ color: "#3a3a3a" }} />
          </div>
        )}

        {/* Same badge slot as the EXCLUSIVE badge on our own videos. */}
        <div
          className="video-card__badge absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider"
          style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
        >
          SPONSORED
        </div>

        <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/85 text-white text-[11px] font-semibold">
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

      <div className="pt-2" onClick={() => onPlay(card)}>
        <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors">
          {title}
        </h3>

        <div className="video-card__metadata flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5 text-xs text-gray-500">
          <span className="video-card__creator flex items-center gap-1.5 min-w-0">
            <img src="/logo.png" alt="Intimora" className="video-card__avatar w-4 h-4 rounded-full border border-yellow-800/50 object-contain" />
            <span className="video-card__creator-name break-words">Sponsored</span>
          </span>
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span aria-hidden="true" className="hidden sm:inline text-gray-700">·</span>
            <span className="video-card__views flex items-center gap-1">
              <Eye className="w-3 h-3" />
              Promoted
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};

export default SponsoredCard;
