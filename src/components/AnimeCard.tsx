import React from "react";
import { Play, Sparkles } from "lucide-react";
import type { AnimeCard as AnimeCardData } from "../services/anime-feed.mjs";

// Anime titles come from the feed, so they have no catalogue record of ours: no
// views, no like/save and no backend id. The card therefore shows only what the
// feed can honestly promise — poster, title, duration, and the tags, author and
// rating the source's own video page volunteered. A click opens the source's own
// embed player inside our frame; no media URL is ever copied here.
const AnimeCard: React.FC<{ card: AnimeCardData; onPlay: (card: AnimeCardData) => void }> = ({ card, onPlay }) => (
  <button
    type="button"
    className="video-card video-card--anime group text-left"
    onClick={() => onPlay(card)}
    aria-label={`Play ${card.title}`}
  >
    <div className="video-card__media relative overflow-hidden rounded-lg" style={{ aspectRatio: "16/9" }}>
      <img
        src={card.thumbnail}
        alt={card.title}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="video-card__image w-full h-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(201,168,76,0.92)" }}>
          <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
        </span>
      </div>
      <span
        className="video-card__badge absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider flex items-center gap-1"
        style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
      >
        <Sparkles className="w-3 h-3" />ANIME
      </span>
      {card.duration && (
        <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/85 text-white text-[11px] font-semibold tabular-nums">
          {card.duration}
        </div>
      )}
    </div>
    <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors mt-2">
      {card.title}
    </h3>
    <p className="text-gray-500 text-xs mt-1">
      Anime · {card.author ?? "Hentai City"}
      {typeof card.rating === "number" ? ` · ${card.rating}%` : ""}
    </p>
    {card.tags?.length ? (
      <p className="anime-card__tags flex flex-wrap gap-1 mt-1.5">
        {card.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide" style={{ background: "rgba(201,168,76,0.14)", color: "#d8bf74" }}>
            {tag}
          </span>
        ))}
      </p>
    ) : null}
  </button>
);

export default AnimeCard;
