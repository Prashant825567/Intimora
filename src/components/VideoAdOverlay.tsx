import React, { useEffect, useRef, useState } from "react";
import { X, Volume2, VolumeX } from "lucide-react";
import { firePixels, QUARTILE_EVENTS } from "../services/vast-tracking.mjs";

export interface VastAd {
  id: string;
  system: string;
  title: string;
  mediaUrl: string;
  mediaType: string;
  durationSeconds: number | null;
  skipAfterSeconds: number | null;
  skippable: boolean;
  clickThrough: string | null;
  clickTracking: string[];
  impressions: string[];
  errors: string[];
  events: Record<string, string[]>;
}

interface VideoAdOverlayProps {
  ad: VastAd;
  onFinish: (reason: "complete" | "skip" | "error") => void;
  onClose: () => void;
}

// A linear pre-roll rendered with a plain <video>. No VPAID, no nested frame and
// no ad script runs in this page; the creative is the only third-party media.
const VideoAdOverlay: React.FC<VideoAdOverlayProps> = ({ ad, onFinish, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fired = useRef(new Set<string>());
  const finished = useRef(false);
  // A ref, not state: the watchdog below is registered once on mount, so a
  // state value captured there would stay false forever and cut a playing ad.
  const playing = useRef(false);
  const [muted, setMuted] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(ad.skippable ? Math.ceil(ad.skipAfterSeconds ?? 0) : null);

  const track = (event: string) => {
    if (fired.current.has(event)) return;
    fired.current.add(event);
    firePixels(ad.events[event]);
  };

  const finish = (reason: "complete" | "skip" | "error") => {
    if (finished.current) return;
    finished.current = true;
    if (reason === "error") firePixels(ad.errors);
    onFinish(reason);
  };

  useEffect(() => {
    firePixels(ad.impressions);
    const element = videoRef.current;
    if (element) {
      // Browsers may refuse an unmuted autoplay. Muted playback is always
      // allowed, so retry that way instead of dropping the ad entirely; the
      // viewer can unmute with the button in the overlay.
      const retryMuted = () => {
        if (element.muted) {
          finish("error");
          return;
        }
        element.muted = true;
        setMuted(true);
        const retry = element.play();
        if (retry) void retry.catch(() => finish("error"));
      };
      const attempt = element.play();
      if (attempt) void attempt.catch(retryMuted);
    }
    // If the creative never starts, fall through to the video instead of
    // leaving the viewer on a black frame.
    const watchdog = setTimeout(() => { if (!playing.current) finish("error"); }, 6000);
    return () => clearTimeout(watchdog);
    // Ad identity never changes for a mounted overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ad.skippable) return undefined;
    const timer = setInterval(() => {
      const element = videoRef.current;
      const skipAt = ad.skipAfterSeconds ?? 0;
      const remaining = Math.max(0, Math.ceil(skipAt - (element?.currentTime ?? 0)));
      setSecondsLeft(remaining);
    }, 250);
    return () => clearInterval(timer);
  }, [ad.skippable, ad.skipAfterSeconds]);

  const handleTimeUpdate = () => {
    const element = videoRef.current;
    if (!element) return;
    const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : ad.durationSeconds;
    if (!duration) return;
    const fraction = element.currentTime / duration;
    for (const quartile of QUARTILE_EVENTS) {
      if (fraction >= quartile.fraction) track(quartile.event);
    }
  };

  const skip = () => {
    track("skip");
    finish("skip");
  };

  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !muted;
    setMuted(!muted);
    track(!muted ? "mute" : "unmute");
  };

  const skippableNow = ad.skippable && (secondsLeft ?? 0) <= 0;

  return (
    <div
      className="absolute inset-0 z-[6] bg-black"
      role="region"
      aria-label="Advertisement"
      data-ad-overlay=""
    >
      <video
        ref={videoRef}
        data-ad-video=""
        src={ad.mediaUrl}
        className="w-full h-full object-contain"
        playsInline
        autoPlay
        preload="auto"
        muted={muted}
        onPlaying={() => { playing.current = true; track("start"); }}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => { track("complete"); finish("complete"); }}
        onError={() => finish("error")}
      />

      <div className="absolute top-0 left-0 right-0 flex items-start justify-between p-3" style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)" }}>
        <span className="rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/90" style={{ background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.25)" }}>
          Advertisement
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute advertisement" : "Mute advertisement"} className="rounded-full p-2 text-white hover:text-yellow-400" style={{ background: "rgba(0,0,0,0.55)" }}>
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <button type="button" onClick={onClose} aria-label="Close video player" className="rounded-full p-2 text-white hover:text-yellow-400" style={{ background: "rgba(0,0,0,0.55)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center justify-between gap-3 p-3" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85), transparent)" }}>
        {ad.clickThrough ? (
          <a
            href={ad.clickThrough}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => firePixels(ad.clickTracking)}
            className="rounded-full px-4 py-2 text-xs font-semibold text-black"
            style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)" }}
          >
            {ad.title ? `Visit ${ad.title}` : "Visit advertiser"}
          </a>
        ) : <span />}
        {ad.skippable ? (
          skippableNow ? (
            <button
              type="button"
              onClick={skip}
              aria-label="Skip advertisement"
              className="rounded-full px-4 py-2 text-xs font-bold text-white"
              style={{ background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.4)" }}
            >
              Skip ad
            </button>
          ) : (
            <span role="status" className="rounded-full px-3 py-2 text-xs text-white/80" style={{ background: "rgba(0,0,0,0.7)" }}>
              Skip in {Math.max(0, secondsLeft ?? 0)}s
            </span>
          )
        ) : null}
      </div>
    </div>
  );
};

export default VideoAdOverlay;
