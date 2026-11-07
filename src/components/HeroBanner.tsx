import React, { useState, useEffect } from "react";
import { Play, ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { Video } from "../data/mockVideos";

interface HeroBannerProps {
  videos: Video[];
  onPlay: (video: Video) => void;
}

const HeroBanner: React.FC<HeroBannerProps> = ({ videos, onPlay }) => {
  const [current, setCurrent] = useState(0);
  const featured = videos.slice(0, 5);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((c) => (c + 1) % featured.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [featured.length]);

  if (!featured.length) return null;
  const video = featured[current];

  return (
    <div className="hero-banner relative w-full h-[380px] overflow-hidden rounded-2xl">
      {/* Background image */}
      {featured.map((v, i) => (
        <div
          key={v.id}
          className="absolute inset-0 transition-opacity duration-1000"
          style={{ opacity: i === current ? 1 : 0 }}
        >
          <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to right, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.2) 100%), linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 50%)",
            }}
          />
        </div>
      ))}

      {/* Content */}
      <div className="hero-banner__content absolute inset-0 flex flex-col justify-center px-8 md:px-12 max-w-2xl">
        {/* Badge */}
        <div className="flex items-center gap-2 mb-3">
          <span
            className="px-3 py-1 rounded-full text-xs font-black tracking-widest uppercase"
            style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
          >
            ✦ FEATURED
          </span>
          <div className="flex items-center gap-1 text-yellow-400">
            {[...Array(5)].map((_, i) => <Star key={i} className="w-3 h-3 fill-current" />)}
          </div>
        </div>

        <h2 className="hero-banner__title text-white text-3xl md:text-4xl font-black leading-tight mb-2 drop-shadow-lg">
          {video.title}
        </h2>
        <p className="hero-banner__creator text-gray-400 text-sm mb-1">{video.creator}</p>
        <div className="hero-banner__meta flex items-center gap-3 text-sm text-gray-400 mb-5">
          <span>👁 {video.views} views</span>
          <span>•</span>
          <span>⏱ {video.duration}</span>
          <span>•</span>
          <span className="px-2 py-0.5 bg-yellow-900/40 border border-yellow-800/40 rounded text-yellow-500 text-xs">
            {video.category}
          </span>
        </div>

        <button
          onClick={() => onPlay(video)}
          className="hero-banner__cta flex items-center gap-3 w-fit px-6 py-3 rounded-full font-bold text-sm transition-all hover:scale-105 active:scale-95"
          style={{
            background: "linear-gradient(135deg, #c9a84c, #f0d080)",
            color: "#000",
            boxShadow: "0 4px 20px rgba(201,168,76,0.4)",
          }}
        >
          <Play className="w-5 h-5 fill-current" />
          WATCH NOW – FREE
        </button>
      </div>

      {/* Dot indicators */}
      <div className="hero-banner__dots absolute bottom-4 right-6 flex gap-2">
        {featured.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrent(i)}
            className="rounded-full transition-all"
            style={{
              width: i === current ? "24px" : "8px",
              height: "8px",
              background: i === current ? "#c9a84c" : "rgba(255,255,255,0.3)",
            }}
          />
        ))}
      </div>

      {/* Arrows */}
      <button
        onClick={() => setCurrent((c) => (c - 1 + featured.length) % featured.length)}
        aria-label="Previous featured video"
        className="hero-banner__previous absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-yellow-800/50 transition"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <button
        onClick={() => setCurrent((c) => (c + 1) % featured.length)}
        aria-label="Next featured video"
        className="hero-banner__next absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-yellow-800/50 transition"
      >
        <ChevronRight className="w-5 h-5" />
      </button>
    </div>
  );
};

export default HeroBanner;
