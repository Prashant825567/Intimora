import React, { useEffect, useState } from "react";
import { Play, ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { Video } from "../data/mockVideos";
import { isPremiumLabel } from "../utils/video-labels";

interface HeroBannerProps {
  videos: Video[];
  onPlay: (video: Video) => void;
}

const HeroBanner: React.FC<HeroBannerProps> = ({ videos, onPlay }) => {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const featured = videos.slice(0, 5);
  const count = featured.length;

  useEffect(() => {
    if (count < 2 || paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setCurrent((index) => (index + 1) % count), 5000);
    return () => clearInterval(timer);
  }, [count, paused]);

  if (!count) return null;
  const index = current % count;
  const video = featured[index];

  return (
    <section
      className="hero-banner"
      aria-label="Featured videos"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
    >
      <div className="hero-banner__media">
        <img
          key={video.id}
          src={video.thumbnail}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          alt={video.title}
          className="hero-banner__image"
        />
      </div>

      <div className="hero-banner__content">
        <div className="flex items-center gap-2 mb-3">
          <span className="hero-banner__featured-label">✦ FEATURED</span>
          <div className="flex items-center gap-1 text-yellow-400" aria-hidden="true">
            {[...Array(5)].map((_, star) => <Star key={star} className="w-3 h-3 fill-current" />)}
          </div>
        </div>

        <h2 className="hero-banner__title text-white text-3xl md:text-4xl font-black leading-tight mb-2">
          {video.title}
        </h2>
        <p className="hero-banner__creator text-gray-400 text-sm mb-1">{video.creator}</p>
        <div className="hero-banner__meta flex items-center gap-3 text-sm text-gray-400 mb-5">
          <span>👁 {video.views} views</span>
          <span>•</span>
          <span>⏱ {video.duration}</span>
          {video.category && !isPremiumLabel(video.category) && (
            <>
              <span>•</span>
              <span className="px-2 py-0.5 bg-yellow-900/40 border border-yellow-800/40 rounded text-yellow-500 text-xs">
                {video.category}
              </span>
            </>
          )}
        </div>

        <button
          onClick={() => onPlay(video)}
          className="hero-banner__cta flex items-center gap-3 w-fit px-6 py-3 rounded-full font-bold text-sm transition-all hover:scale-105 active:scale-95"
          style={{
            background: "linear-gradient(135deg, #c9a84c, #f0d080)",
            color: "#000",
            boxShadow: "0 4px 20px rgba(201,168,76,0.25)",
          }}
        >
          <Play className="w-5 h-5 fill-current" />
          WATCH NOW – FREE
        </button>

        {count > 1 && (
          <div className="hero-banner__navigation">
            <div className="hero-banner__arrows">
              <button type="button" className="hero-banner__arrow" aria-label="Previous featured video" onClick={() => setCurrent((index - 1 + count) % count)}>
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button type="button" className="hero-banner__arrow" aria-label="Next featured video" onClick={() => setCurrent((index + 1) % count)}>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="hero-banner__dots" aria-label="Choose featured video">
              {featured.map((item, dot) => (
                <button
                  type="button"
                  key={item.id}
                  aria-label={`Show featured video ${dot + 1}`}
                  aria-pressed={dot === index}
                  className={dot === index ? "hero-banner__dot is-active" : "hero-banner__dot"}
                  onClick={() => setCurrent(dot)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export default HeroBanner;
