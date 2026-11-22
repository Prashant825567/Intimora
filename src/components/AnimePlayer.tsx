import React, { useEffect, useRef, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import Hls from "hls.js";
import type { AnimeCard as AnimeCardData } from "../services/anime-api.mjs";
import { isHlsLink } from "../services/anime-api.mjs";
import { fetchAnimeStreamUrl } from "../services/api";

// An anime click plays the service's own link. The watch route answers with an
// HLS playlist for the title (some titles do come back as a plain file), and that
// answer is used exactly as it arrives: a file goes into the <video> element, a
// playlist is handed to the browser's own HLS reader (Safari) or to hls.js, which
// fetches the playlist and its segments from the source directly. Nothing is
// proxied, rebuilt or read out of a page, and there is no iframe — which is also
// why there is no pre-roll here (the ad overlay belongs to our catalogue player).
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Where the element got its media from: the returned URL, or "hls" when hls.js
  // attached the playlist to it. The attribute cannot hold a playlist URL (no
  // browser can load one straight into src), so this marker is the evidence.
  const [source, setSource] = useState<{ url: string; via: "src" | "hls" } | null>(null);
  // The link the service returned for this click, kept even after the element
  // reports a failed load, so the answer is unchanged by playback trouble.
  const [chosen, setChosen] = useState<string | null>(null);

  // HLS: hls.js drives the same <video> element from the same URL wherever the
  // browser exposes MSE; Safari on iOS, which has no MSE, reads the playlist
  // natively.
  useEffect(() => {
    if (state.kind !== "playing" || !isHlsLink(state.url)) return;
    const element = videoRef.current;
    if (!element) return;
    let hls: Hls | null = null;
    let active = true;
    const fail = () => { if (active) setState({ kind: "broken" }); };
    // hls.js first wherever the browser can feed it (MSE): `canPlayType` answers
    // "maybe" for a playlist even in browsers that cannot decode one, so it is
    // only trusted where MSE is absent — Safari on iOS, which plays the playlist
    // natively.
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data?.fatal) fail(); });
      hls.loadSource(state.url);
      hls.attachMedia(element);
      setSource({ url: state.url, via: "hls" });
    } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = state.url;
      element.addEventListener("error", fail);
      setSource({ url: state.url, via: "src" });
    } else {
      fail();
    }
    return () => {
      active = false;
      element.removeEventListener("error", fail);
      hls?.destroy();
    };
  }, [state]);

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
    setSource(null);
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
          <span data-anime-via={source?.via ?? ""} hidden aria-hidden="true" />
          {state.kind === "playing" ? (
            <video
              ref={videoRef}
              // A playlist is attached to this element by the effect above; the
              // plain file is loaded by the attribute.
              src={isHlsLink(state.url) ? undefined : state.url}
              poster={card.thumbnail}
              controls
              autoPlay
              playsInline
              preload="auto"
              className="w-full h-full block bg-black"
              onError={() => { if (!isHlsLink(state.url)) setState({ kind: "broken" }); }}
              onLoadedMetadata={() => { if (!isHlsLink(state.url)) setSource({ url: state.url, via: "src" }); }}
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
