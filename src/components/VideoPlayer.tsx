import React, { useRef, useState, useEffect } from "react";
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  SkipBack, SkipForward, Settings, Share2, Heart,
  ThumbsUp, Flag, X
} from "lucide-react";
import type { Video } from "../data/mockVideos";
import { likeVideo } from "../services/api";

interface VideoPlayerProps {
  video: Video;
  onClose: () => void;
  onShare: (video: Video) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ video, onClose, onShare }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(video.likes);
  const [quality, setQuality] = useState("1080p");
  const [showSettings, setShowSettings] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => setCurrentTime(v.currentTime);
    const onDuration = () => setDuration(v.duration);
    const onProgress = () => {
      if (v.buffered.length > 0) {
        setBuffered((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
      }
    };
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("loadedmetadata", onDuration);
    v.addEventListener("progress", onProgress);
    return () => {
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("loadedmetadata", onDuration);
      v.removeEventListener("progress", onProgress);
    };
  }, []);

  const resetControlsTimer = () => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { v.pause(); setPlaying(false); }
    else { v.play(); setPlaying(true); }
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
    if (videoRef.current) videoRef.current.volume = val;
    setMuted(val === 0);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect || !videoRef.current) return;
    const pct = (e.clientX - rect.left) / rect.width;
    videoRef.current.currentTime = pct * duration;
  };

  const skip = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
    }
    resetControlsTimer();
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
    if (!t || isNaN(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const handleLike = async () => {
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => (newLiked ? c + 1 : c - 1));
    
    try {
      if (newLiked) {
        await likeVideo(video.id);
      }
    } catch {
      // Revert on failure
      setLiked(!newLiked);
      setLikeCount((c) => (newLiked ? c - 1 : c + 1));
    }
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

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
            className="w-full h-full object-contain"
            onClick={togglePlay}
            onEnded={() => setPlaying(false)}
          />

          {/* Play overlay */}
          {!playing && (
            <div className="absolute inset-0 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
              <div
                className="video-player__play-button w-20 h-20 rounded-full flex items-center justify-center transition-all hover:scale-110"
                style={{ background: "rgba(201,168,76,0.9)", boxShadow: "0 0 30px rgba(201,168,76,0.5)" }}
              >
                <Play className="video-player__play-icon w-10 h-10 text-black ml-1" fill="black" />
              </div>
            </div>
          )}

          {/* Top controls */}
          <div
            className={`video-player__top absolute top-0 left-0 right-0 p-4 flex items-center justify-between transition-all duration-300 ${showControls || !playing ? "opacity-100" : "opacity-0"}`}
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
            className={`absolute bottom-0 left-0 right-0 transition-all duration-300 ${showControls || !playing ? "opacity-100" : "opacity-0"}`}
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)" }}
          >
            {/* Progress bar */}
            <div
              ref={progressRef}
              className="mx-4 mt-2 h-1.5 bg-gray-700 rounded-full cursor-pointer relative group/progress"
              onClick={handleProgressClick}
            >
              {/* Buffered */}
              <div className="absolute inset-y-0 left-0 bg-gray-500 rounded-full" style={{ width: `${buffered}%` }} />
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
              <button onClick={() => skip(-10)} className="text-white hover:text-yellow-400 transition">
                <SkipBack className="w-5 h-5" />
              </button>
              <button onClick={togglePlay} className="text-white hover:text-yellow-400 transition">
                {playing ? <Pause className="w-7 h-7" fill="currentColor" /> : <Play className="w-7 h-7" fill="currentColor" />}
              </button>
              <button onClick={() => skip(10)} className="text-white hover:text-yellow-400 transition">
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

              {/* Quality */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-white hover:text-yellow-400 transition flex items-center gap-1 text-xs"
                >
                  <Settings className="w-4 h-4" />
                  <span className="hidden sm:inline">{quality}</span>
                </button>
                {showSettings && (
                  <div className="absolute bottom-8 right-0 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden text-xs">
                    {["2160p", "1080p", "720p", "480p", "360p"].map((q) => (
                      <button
                        key={q}
                        onClick={() => { setQuality(q); setShowSettings(false); }}
                        className={`block w-full px-4 py-2 text-left hover:bg-gray-800 transition ${quality === q ? "text-yellow-400" : "text-white"}`}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
              {video.tags.map((tag) => (
                <span key={tag} className="video-player__tag px-2 py-0.5 bg-yellow-900/20 border border-yellow-800/30 rounded text-xs text-yellow-500">
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleLike}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border transition-all ${
                liked
                  ? "bg-yellow-500/20 border-yellow-500 text-yellow-400"
                  : "bg-gray-800 border-gray-700 text-gray-300 hover:border-yellow-700 hover:text-yellow-400"
              }`}
            >
              <ThumbsUp className={`w-4 h-4 ${liked ? "fill-current" : ""}`} />
              {likeCount.toLocaleString()}
            </button>
            <button className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border border-gray-700 bg-gray-800 text-gray-300 hover:border-yellow-700 hover:text-yellow-400 transition">
              <Heart className="w-4 h-4" />
              Save
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
      </div>
    </div>
  );
};

export default VideoPlayer;
