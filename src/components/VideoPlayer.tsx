import React, { useRef, useState, useEffect, useLayoutEffect } from "react";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, Share2, Heart,
  ThumbsUp, Flag, X
} from "lucide-react";
import type { Video } from "../data/mockVideos";
import { isPremiumLabel } from "../utils/video-labels";
import VideoAdOverlay from "./VideoAdOverlay";
import type { VastAd } from "./VideoAdOverlay";
import { loadVastAd } from "../services/vast-loader.mjs";
import { VAST_DECISION_GRACE_MS, VAST_SKIP_FALLBACK_SECONDS, VAST_TIMEOUT_MS } from "../config/vast";

// The ad tag is a public build constant. An empty value disables pre-roll.
const VAST_TAG = __INTIMORA_VAST_TAG_URL__;

interface VideoPlayerProps {
  video: Video;
  startOnOpen: boolean;
  onClose: () => void;
  onShare: (video: Video) => void;
  liked: boolean;
  saved: boolean;
  likePending: boolean;
  savePending: boolean;
  onLike: (video: Video) => void;
  onSave: (video: Video) => void;
  actionError: string;
}

type BufferedRange = { start: number; end: number };

// Only the selected player is preloaded, after the age gate. This is a browser
// hint rather than a byte limit; honor data-saver and very slow connections.
function preloadHint(): "auto" | "metadata" {
  const connection = typeof navigator === "undefined" ? undefined
    : (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g"
    ? "metadata" : "auto";
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ video, startOnOpen, onClose, onShare, liked, saved, likePending, savePending, onLike, onSave, actionError }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const playAttempt = useRef(0);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preload] = useState(preloadHint);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [adPlaying, setAdPlaying] = useState<VastAd | null>(null);
  const adState = useRef<{ status: "idle" | "loading" | "deciding" | "done"; promise: Promise<VastAd | null> | null }>({ status: "idle", promise: null });

  useEffect(() => () => {
    playAttempt.current += 1;
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
  }, []);

  // The tag is requested once per player, while it opens. It resolves to null on
  // any failure, so a play request can always continue without an ad.
  const ensureAdRequest = () => {
    if (!VAST_TAG || adState.current.status !== "idle") return;
    adState.current.status = "loading";
    adState.current.promise = loadVastAd(VAST_TAG, {
      timeoutMs: VAST_TIMEOUT_MS,
      skipFallbackSeconds: VAST_SKIP_FALLBACK_SECONDS,
    }).then((ad: VastAd | null) => ad, () => null);
  };

  useEffect(() => { ensureAdRequest(); }, []);

  const updateBuffered = (v: HTMLVideoElement) => {
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const ranges: BufferedRange[] = [];
    if (total) {
      for (let i = 0; i < v.buffered.length; i += 1) {
        const start = Math.max(0, Math.min(100, v.buffered.start(i) / total * 100));
        const end = Math.max(start, Math.min(100, v.buffered.end(i) / total * 100));
        ranges.push({ start, end });
      }
    }
    setBuffered(ranges);
  };

  const updateDuration = (v: HTMLVideoElement) => {
    setDuration(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
    updateBuffered(v);
  };

  const resetControlsTimer = () => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
  };

  const playContent = (v: HTMLVideoElement, automatic: boolean, attempt: number) => {
    setPlaybackError("");
    setBuffering(v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    const failed = (error: unknown) => {
      if (attempt !== playAttempt.current || videoRef.current !== v) return;
      setPlaying(false);
      setBuffering(false);
      setShowControls(true);
      const blocked = error instanceof DOMException && error.name === "NotAllowedError";
      // If an automatic start is blocked, leave the large play button visible
      // so the user can explicitly start it with a gesture.
      if (blocked && automatic) return;
      setPlaybackError(blocked ? "Playback was blocked. Please try again." : "This video could not be played. Please try again.");
    };
    try {
      // A rejected play() must not leave the UI stuck in the playing state.
      const result = v.play();
      if (result) void result.catch(failed);
    } catch (error) { failed(error); }
  };

  // A pre-roll only ever plays before the content has started. If the ad tag has
  // not answered within the short grace window, playback begins instead, so an
  // ad server can never block the video.
  const startPlayback = (v: HTMLVideoElement, automatic = false) => {
    const attempt = ++playAttempt.current;
    ensureAdRequest();
    if (!VAST_TAG || adState.current.status === "done") {
      playContent(v, automatic, attempt);
      return;
    }
    adState.current.status = "deciding";
    const pending = adState.current.promise ?? Promise.resolve(null);
    const decision = Promise.race<VastAd | null>([
      pending,
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), VAST_DECISION_GRACE_MS); }),
    ]);
    void decision.then((ad) => {
      if (attempt !== playAttempt.current) return;
      adState.current.status = "done";
      if (ad) {
        setAdPlaying(ad);
        setPlaying(false);
        setBuffering(false);
        setPlaybackError("");
        return;
      }
      playContent(v, automatic, attempt);
    });
  };

  const finishAd = () => {
    setAdPlaying(null);
    adState.current.status = "done";
    const v = videoRef.current;
    if (v) playContent(v, false, ++playAttempt.current);
  };

  useLayoutEffect(() => {
    // This commit follows the user's play click; shared links skip this step.
    // A browser may still require a second gesture, handled by startPlayback.
    if (startOnOpen && videoRef.current) startPlayback(videoRef.current, true);
  }, [startOnOpen]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || adPlaying) return;
    if (!v.paused && !v.ended) {
      playAttempt.current += 1;
      v.pause();
    } else {
      startPlayback(v);
    }
    resetControlsTimer();
  };

  const retryPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    // Reload only after a media error. For a blocked play request, retain any
    // data already buffered instead of starting a second download.
    if (v.error) {
      setCurrentTime(0);
      setDuration(0);
      setBuffered([]);
      v.load();
    }
    startPlayback(v);
    resetControlsTimer();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !muted;
    setMuted(!muted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
    }
    setMuted(val === 0);
  };

  const seekTo = (seconds: number) => {
    const v = videoRef.current;
    if (!v || !duration || !Number.isFinite(seconds)) return;
    v.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrentTime(v.currentTime);
    resetControlsTimer();
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect?.width || !duration) return;
    seekTo((e.clientX - rect.left) / rect.width * duration);
  };

  const skip = (seconds: number) => {
    if (videoRef.current) seekTo(videoRef.current.currentTime + seconds);
  };

  const handleProgressKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") skip(-10);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") skip(10);
    else if (e.key === "Home") seekTo(0);
    else if (e.key === "End") seekTo(duration);
    else return;
    e.preventDefault();
  };

  const toggleFullscreen = () => {
    const container = document.getElementById("player-container");
    if (!fullscreen) {
      container?.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
    resetControlsTimer();
  };

  const formatTime = (t: number) => {
    if (!Number.isFinite(t) || t <= 0) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const progress = duration ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;

  return (
    <div className="mobile-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/95" style={{ backdropFilter: "blur(10px)" }}>
      <div className="mobile-overlay__content video-player__content w-full max-w-6xl mx-auto px-2 sm:px-4">
        {/* Player container */}
        <div
          id="player-container"
          className="relative bg-black rounded-xl overflow-hidden group"
          style={{ aspectRatio: "16/9", boxShadow: "0 0 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(201,168,76,0.2)" }}
          onMouseMove={resetControlsTimer}
          onMouseLeave={() => playing && setShowControls(false)}
        >
          <video
            ref={videoRef}
            src={video.videoUrl}
            poster={video.thumbnail}
            crossOrigin="anonymous"
            preload={preload}
            playsInline
            className="w-full h-full object-contain"
            onClick={togglePlay}
            onPlay={() => { setPlaying(true); setPlaybackError(""); }}
            onPlaying={() => { setPlaying(true); setBuffering(false); setPlaybackError(""); }}
            onCanPlay={(e) => { if (!e.currentTarget.paused) setBuffering(false); }}
            onWaiting={(e) => { if (!e.currentTarget.paused && !e.currentTarget.ended) setBuffering(true); }}
            onStalled={(e) => { if (!e.currentTarget.paused && e.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setBuffering(true); }}
            onPause={() => { playAttempt.current += 1; setPlaying(false); setBuffering(false); }}
            onEnded={() => { setPlaying(false); setBuffering(false); setShowControls(true); }}
            onError={() => {
              playAttempt.current += 1;
              setPlaying(false);
              setBuffering(false);
              setShowControls(true);
              setPlaybackError("This video could not be loaded. Please try again.");
            }}
            onTimeUpdate={(e) => setCurrentTime(Number.isFinite(e.currentTarget.currentTime) ? e.currentTarget.currentTime : 0)}
            onLoadedMetadata={(e) => updateDuration(e.currentTarget)}
            onDurationChange={(e) => updateDuration(e.currentTarget)}
            onProgress={(e) => updateBuffered(e.currentTarget)}
            onSeeked={(e) => updateBuffered(e.currentTarget)}
          />

          {adPlaying && <VideoAdOverlay ad={adPlaying} onFinish={finishAd} onClose={onClose} />}

          {/* The poster and native preload are used only for the selected video. */}
          {!adPlaying && !playing && !playbackError && (
            <button type="button" aria-label="Play video" className="absolute inset-0 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
              <span
                className="video-player__play-button w-20 h-20 rounded-full flex items-center justify-center transition-all hover:scale-110"
                style={{ background: "rgba(201,168,76,0.9)", boxShadow: "0 0 30px rgba(201,168,76,0.5)" }}
              >
                <Play className="video-player__play-icon w-10 h-10 text-black ml-1" fill="black" />
              </span>
            </button>
          )}
          {buffering && playing && (
            <div role="status" className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="flex items-center gap-2 rounded-full bg-black/80 px-4 py-2 text-sm text-white">
                <span aria-hidden="true" className="h-4 w-4 rounded-full border-2 border-yellow-400/30 border-t-yellow-400 animate-spin" />
                Buffering…
              </span>
            </div>
          )}
          {playbackError && (
            <div role="alert" className="absolute inset-0 flex items-center justify-center px-4 text-center">
              <div className="rounded-xl bg-black/85 p-3 text-sm text-white">
                <p>{playbackError}</p>
                <button type="button" onClick={retryPlayback} className="mt-2 rounded-full bg-yellow-500 px-4 py-1 font-semibold text-black hover:bg-yellow-400">Try again</button>
              </div>
            </div>
          )}

          {/* Top controls */}
          <div
            className={`video-player__top absolute top-0 left-0 right-0 p-4 flex items-center justify-between transition-all duration-300 ${adPlaying ? "opacity-0 pointer-events-none" : showControls || !playing ? "opacity-100" : "opacity-0"}`}
            style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)" }}
          >
            <div className="flex-1 min-w-0">
              <h3 className="text-white font-bold text-sm sm:text-base truncate">{video.title}</h3>
              <p className="video-player__top-meta text-gray-400 text-xs">{video.creator} · {video.views} views</p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close video player"
              className="ml-3 p-2 rounded-full text-white hover:text-yellow-400 transition flex-shrink-0"
              style={{ background: "rgba(0,0,0,0.5)" }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Bottom controls */}
          <div
            className={`absolute bottom-0 left-0 right-0 transition-all duration-300 ${adPlaying ? "opacity-0 pointer-events-none" : showControls || !playing ? "opacity-100" : "opacity-0"}`}
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)" }}
          >
            {/* Progress bar */}
            <div
              ref={progressRef}
              role="slider"
              aria-label="Seek video"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={Math.min(duration, currentTime)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              aria-disabled={!duration}
              tabIndex={0}
              className="mx-4 mt-2 h-1.5 bg-gray-700 rounded-full cursor-pointer relative group/progress focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-400"
              onClick={handleProgressClick}
              onKeyDown={handleProgressKeyDown}
            >
              {/* Seeking can create disjoint buffered ranges. */}
              {buffered.map((range, index) => (
                <div key={index} className="video-player__buffered-range absolute inset-y-0 bg-gray-500 rounded-full" style={{ left: `${range.start}%`, width: `${range.end - range.start}%` }} />
              ))}
              {/* Progress */}
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{ width: `${progress}%`, background: "linear-gradient(to right, #c9a84c, #f0d080)" }}
              />
              {/* Thumb */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-yellow-400 bg-white opacity-0 group-hover/progress:opacity-100 transition"
                style={{ left: `calc(${progress}% - 8px)` }}
              />
            </div>

            {/* Controls row */}
            <div className="video-player__controls flex items-center px-4 py-3 gap-3">
              <button type="button" onClick={() => skip(-10)} aria-label="Back 10 seconds" className="text-white hover:text-yellow-400 transition">
                <SkipBack className="w-5 h-5" />
              </button>
              <button type="button" onClick={playbackError ? retryPlayback : togglePlay} aria-label={playing ? "Pause video" : "Play video"} className="text-white hover:text-yellow-400 transition">
                {playing ? <Pause className="w-7 h-7" fill="currentColor" /> : <Play className="w-7 h-7" fill="currentColor" />}
              </button>
              <button type="button" onClick={() => skip(10)} aria-label="Forward 10 seconds" className="text-white hover:text-yellow-400 transition">
                <SkipForward className="w-5 h-5" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group/vol">
                <button onClick={toggleMute} className="text-white hover:text-yellow-400 transition">
                  {muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 accent-yellow-400 hidden sm:block"
                />
              </div>

              <span className="text-xs text-gray-300 ml-1 hidden sm:block">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="flex-1" />

              {/* The backend exposes one source, not selectable quality variants. */}
              <span className="hidden sm:block text-xs text-gray-400" title="Playback uses the uploaded video">Original</span>

              <button onClick={toggleFullscreen} className="text-white hover:text-yellow-400 transition">
                {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Video info & actions */}
        <div className="video-player__info mt-4 px-2 flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="video-player__title text-white font-bold text-lg truncate">{video.title}</h2>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <div className="video-player__creator flex items-center gap-2">
                <img src={video.creatorAvatar} alt={video.creator} className="video-player__avatar w-7 h-7 rounded-full border border-yellow-800" />
                <span className="video-player__creator-name text-sm text-gray-400">{video.creator}</span>
              </div>
              <span className="text-gray-600 text-sm">•</span>
              <span className="text-gray-500 text-sm">{video.views} views</span>
              <span className="text-gray-600 text-sm">•</span>
              <span className="text-gray-500 text-sm">{video.uploadedAt}</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {video.tags.filter((tag) => !isPremiumLabel(tag)).map((tag) => (
                <span key={tag} className="video-player__tag px-2 py-0.5 bg-yellow-900/20 border border-yellow-800/30 rounded text-xs text-yellow-500">
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onLike(video)}
              aria-label={liked ? "Unlike video" : "Like video"}
              aria-pressed={liked}
              aria-busy={likePending || undefined}
              title={video.likes === null ? "Like count unavailable" : `${video.likes.toLocaleString()} likes`}
              disabled={likePending}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border transition-all ${
                liked
                  ? "bg-yellow-500/20 border-yellow-500 text-yellow-400"
                  : "bg-gray-800 border-gray-700 text-gray-300 hover:border-yellow-700 hover:text-yellow-400"
              }`}
            >
              <ThumbsUp className={`w-4 h-4 ${liked ? "fill-current" : ""} ${likePending ? "animate-pulse" : ""}`} />
              {video.likes === null ? "—" : video.likes.toLocaleString()}
            </button>
            <button type="button" onClick={() => onSave(video)} aria-label={saved ? "Remove saved video" : "Save video"} aria-pressed={saved} aria-busy={savePending || undefined} disabled={savePending} className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border transition ${saved ? "bg-yellow-500/20 border-yellow-500 text-yellow-400" : "border-gray-700 bg-gray-800 text-gray-300 hover:border-yellow-700 hover:text-yellow-400"}`}>
              <Heart className={`w-4 h-4 ${saved ? "fill-current" : ""} ${savePending ? "animate-pulse" : ""}`} />
              {saved ? "Saved" : "Save"}
            </button>
            <button
              onClick={() => onShare(video)}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border border-gray-700 bg-gray-800 text-gray-300 hover:border-yellow-700 hover:text-yellow-400 transition"
            >
              <Share2 className="w-4 h-4" />
              Share
            </button>
            <button className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 transition">
              <Flag className="w-4 h-4" />
              Report
            </button>
          </div>
        </div>
        {(likePending || savePending) && (
          <p role="status" className="mt-2 px-2 text-xs text-gray-400">
            {likePending && savePending ? "Saving like and video…" : likePending ? "Saving like…" : "Saving video…"}
          </p>
        )}
        {actionError && <p role="alert" className="account-action-error">{actionError}</p>}
      </div>
    </div>
  );
};

export default VideoPlayer;
