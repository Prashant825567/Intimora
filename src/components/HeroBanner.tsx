import React, { useEffect, useRef, useState } from "react";
import { Play, ChevronLeft, ChevronRight, Lock, Star } from "lucide-react";
import type { Video } from "../data/mockVideos";
import { isPremiumLabel } from "../utils/video-labels";
import { mediaCrossOrigin } from "../services/media-credentials.mjs";

interface HeroBannerProps {
  videos: Video[];
  onPlay: (video: Video) => void;
}

// A phone shows the poster and nothing else: no title, no WATCH NOW, no creator
// line. The carousel is moved with a finger (swipe) or with the dots under it, so
// the two arrow buttons are a desktop control and are hidden on a phone. On a
// desktop the arrows float vertically centred on the banner — one inside the
// left edge, one inside the right edge.
const HeroBanner: React.FC<HeroBannerProps> = ({ videos, onPlay }) => {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // A tap that ends a swipe must move the carousel, not start a video.
  const lastSwipeAt = useRef(0);
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
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        setPaused(true);
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        setPaused(false);
        const touch = event.changedTouches[0];
        if (!start || !touch || count < 2) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        // A short drag is a scroll, not a swipe: only a mostly-horizontal move
        // counts, so the page keeps scrolling normally over the hero.
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        lastSwipeAt.current = Date.now();
        setCurrent((value) => (dx < 0 ? (value + 1) % count : (value - 1 + count) % count));
      }}
    >
      {/* A phone shows the poster alone — no title, no WATCH NOW. There the whole
          banner is the play button, and a tap that just ended a swipe is ignored
          so the carousel stays swipeable. The dots keep their own taps. */}
      <button
        type="button"
        className="hero-banner__tap"
        aria-label={`Play ${video.title}`}
        onClick={() => { if (Date.now() - lastSwipeAt.current < 500) return; onPlay(video); }}
      />

      <div className="hero-banner__media">
        <img
          key={video.id}
          src={video.thumbnail}
          crossOrigin={mediaCrossOrigin(video.thumbnail)}
          referrerPolicy="no-referrer"
          alt={video.title}
          className="hero-banner__image"
        />

        {/* A phone has no text panel, so the poster carries the card's own
            furniture: the badge row at the top and the title at the bottom. */}
        <div className="hero-banner__card-labels">
          {video.isExclusive && <span className="hero-banner__card-label">EXCLUSIVE</span>}
          {video.locked && !video.isExclusive && (
            <span className="hero-banner__card-label hero-banner__card-label--locked">
              <Lock className="w-2.5 h-2.5" />
              {video.trailerUrl ? "TRAILER" : "PREMIUM"}
            </span>
          )}
        </div>
        <p className="hero-banner__card-title">{video.title}</p>
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

        {/* Dots only: the arrows are drawn outside the content, on the banner. */}
        {count > 1 && (
          <div className="hero-banner__navigation">
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

      {count > 1 && (
        <>
          <button
            type="button"
            className="hero-banner__arrow hero-banner__arrow--prev"
            aria-label="Previous featured video"
            onClick={() => setCurrent((index - 1 + count) % count)}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="hero-banner__arrow hero-banner__arrow--next"
            aria-label="Next featured video"
            onClick={() => setCurrent((index + 1) % count)}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </>
      )}
    </section>
  );
};

export default HeroBanner;
