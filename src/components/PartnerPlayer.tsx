import React, { useEffect } from "react";
import { X } from "lucide-react";
import type { SponsoredCard as SponsoredCardData } from "../services/partner-cards.mjs";

// A sponsored partner video opens in the site's own player: the same full-screen
// overlay, the same 16:9 frame, the same close control and typography. The
// partner's page runs inside the frame because that page *is* their player; no
// pre-roll, tracking or related-video logic of ours runs here.
interface PartnerPlayerProps {
  card: SponsoredCardData;
  onClose: () => void;
}

const PartnerPlayer: React.FC<PartnerPlayerProps> = ({ card, onClose }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = card.title || "Sponsored video";
  return (
    <div
      className="mobile-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/95"
      style={{ backdropFilter: "blur(10px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Sponsored video player"
    >
      <div className="mobile-overlay__content video-player__content w-full max-w-6xl mx-auto px-2 sm:px-4">
        <div
          id="partner-player-container"
          className="relative bg-black rounded-xl overflow-hidden"
          style={{ aspectRatio: "16/9", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(201,168,76,0.2)" }}
        >
          <iframe
            src={card.embedUrl}
            title={title}
            className="w-full h-full block"
            referrerPolicy="no-referrer"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
          />
          <div
            className="video-player__top absolute top-0 left-0 right-0 p-4 flex items-start justify-between gap-3 pointer-events-none"
            style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)" }}
          >
            <div className="flex-1 min-w-0 pointer-events-auto">
              <span
                className="inline-block text-[10px] font-bold tracking-[0.2em] uppercase px-2 py-0.5 rounded mb-1"
                style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
              >
                Sponsored
              </span>
              <h3 className="text-white font-bold text-sm sm:text-base truncate">{title}</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close video player"
              className="pointer-events-auto rounded-full bg-black/60 p-2 text-white hover:text-yellow-400 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-gray-500">Sponsored content from our partner.</p>
      </div>
    </div>
  );
};

export default PartnerPlayer;
