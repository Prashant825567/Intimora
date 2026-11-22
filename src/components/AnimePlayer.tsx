import React, { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import type { AnimeCard as AnimeCardData } from "../services/anime-api.mjs";
import { fetchAnimeStreamUrl } from "../services/api";

// An anime click now plays the file itself. The service's watch route is asked
// for the playable link and that link goes straight into a <video> element: the
// browser talks to the source, this site only passes the answer along. There is
// no proxy, no rebuilt URL and no iframe — which is also why there is no pre-roll
// here (the ad overlay belongs to our own catalogue player).
interface AnimePlayerProps {
  card: AnimeCardData;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "playing"; url: string }
  | { kind: "missing"; reason: "no-link" | "unreachable" | "no-id" }
  | { kind: "broken" };

const reasonText: Record<string, string> = {
  "no-link": "This title has no playable file right now.",
  unreachable: "The anime server did not answer. Try again in a moment.",
  "no-id": "This card has no usable video id.",
};

const AnimePlayer: React.FC<AnimePlayerProps> = ({ card, onClose }) => {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The link the service returned for this click, kept even after the element
  // reports a failed load, so the answer is unchanged by playback trouble.
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setChosen(null);
    fetchAnimeStreamUrl(card.id)
      .then((answer) => {
        if (!active) return;
        if (answer.url) { setChosen(answer.url); setState({ kind: "playing", url: answer.url }); }
        else setState({ kind: "missing", reason: answer.reason === "ok" ? "no-link" : answer.reason });
      })
      .catch(() => { if (active) setState({ kind: "missing", reason: "unreachable" }); });
    return () => { active = false; controller.abort(); };
  }, [card.id, attempt]);

  return (
    <div
      className="mobile-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/95"
      style={{ backdropFilter: "blur(10px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Anime player"
    >
      <div className="mobile-overlay__content video-player__content w-full max-w-6xl mx-auto px-2 sm:px-4">
        <div
          id="anime-player-container"
          className="relative bg-black rounded-xl overflow-hidden"
          style={{ aspectRatio: "16/9", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(201,168,76,0.2)" }}
        >
          <span data-anime-src={chosen ?? ""} hidden aria-hidden="true" />
          {state.kind === "playing" ? (
            <video
              src={state.url}
              poster={card.thumbnail}
              controls
              autoPlay
              playsInline
              preload="auto"
              className="w-full h-full block bg-black"
              onError={() => setState({ kind: "broken" })}
            />
          ) : state.kind === "broken" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="w-8 h-8" style={{ color: "#c9a84c" }} />
              <p className="text-white font-semibold">{card.title}</p>
              <p className="text-gray-400 text-sm">The source stopped this stream. Try it once more.</p>
              <button
                type="button"
                className="px-4 py-2 rounded-full text-sm font-bold"
                style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : state.kind === "missing" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="w-8 h-8" style={{ color: "#c9a84c" }} />
              <p className="text-white font-semibold">{card.title}</p>
              <p className="text-gray-400 text-sm">{reasonText[state.reason] ?? reasonText.unreachable}</p>
              <button
                type="button"
                className="px-4 py-2 rounded-full text-sm font-bold"
                style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <img src={card.thumbnail} alt="" referrerPolicy="no-referrer" className="absolute inset-0 w-full h-full object-contain opacity-40" />
              <Loader2 className="w-8 h-8 animate-spin relative" style={{ color: "#c9a84c" }} />
              <p className="text-gray-300 text-sm relative">Opening {card.title}…</p>
            </div>
          )}

          <div className="video-player__top absolute top-0 left-0 right-0 p-4 flex items-start justify-between gap-3 pointer-events-none">
            <div className="min-w-0">
              <p className="text-white font-bold text-sm sm:text-base truncate">{card.title}</p>
              <p className="text-gray-400 text-xs">Anime · Hentai City</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close anime player"
              className="pointer-events-auto w-9 h-9 rounded-full grid place-items-center bg-black/70 text-white hover:bg-black/90 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnimePlayer;
