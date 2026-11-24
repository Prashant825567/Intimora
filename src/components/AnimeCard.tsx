import React from "react";
import { Play, Sparkles, Heart, Bookmark } from "lucide-react";
import type { AnimeCard as AnimeCardData } from "../services/anime-api.mjs";

// Anime titles come from our anime API, so they have no catalogue record of ours:
// no views, no rating, and no backend id. A list row can honestly promise only a
// poster, a title and a duration, so that is all the card shows — no author or
// tags are invented. Like and save are offered because the account keeps them
// itself: the entry is stored under a namespaced `anime-…` id with its title and
// poster, in the same lists as our own videos, so nothing about the source's
// catalogue is claimed. A click opens the source's own player; no media URL is
// ever copied here.
const AnimeCard: React.FC<{
  card: AnimeCardData;
  onPlay: (card: AnimeCardData) => void;
  liked?: boolean;
  saved?: boolean;
  likePending?: boolean;
  savePending?: boolean;
  onLike?: (card: AnimeCardData) => void;
  onSave?: (card: AnimeCardData) => void;
}> = ({ card, onPlay, liked = false, saved = false, likePending = false, savePending = false, onLike, onSave }) => (
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
      {/* The account's own actions. They sit on the artwork, like our catalogue
          cards, and stay out of the play button so a click cannot be mistaken for
          a play. A guest is sent to sign in by the caller, as with every card. */}
      <div className="video-card__quick-actions absolute top-2 right-2 flex flex-col gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onLike?.(card); }}
          aria-label={liked ? "Unlike anime" : "Like anime"}
          aria-pressed={liked}
          aria-busy={likePending || undefined}
          disabled={likePending}
          className={`p-1.5 rounded-full transition-all ${liked ? "bg-yellow-500 text-black" : "bg-black/70 text-white hover:bg-yellow-500 hover:text-black"}`}
        >
          <Heart className={`w-3.5 h-3.5 ${likePending ? "animate-pulse" : ""}`} fill={liked ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onSave?.(card); }}
          aria-label={saved ? "Remove saved anime" : "Save anime"}
          aria-pressed={saved}
          aria-busy={savePending || undefined}
          disabled={savePending}
          className={`p-1.5 rounded-full transition-all ${saved ? "bg-yellow-500 text-black" : "bg-black/70 text-white hover:bg-yellow-500 hover:text-black"}`}
        >
          <Bookmark className={`w-3.5 h-3.5 ${savePending ? "animate-pulse" : ""}`} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
    <h3 className="video-card__title text-white text-sm font-semibold line-clamp-2 leading-snug group-hover:text-yellow-300 transition-colors mt-2">
      {card.title}
    </h3>
    <p className="text-gray-500 text-xs mt-1">Anime · Hentai City</p>
  </button>
);

export default AnimeCard;
