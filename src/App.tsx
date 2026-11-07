import { useState, useEffect, useRef, useCallback } from "react";
import AgeGate from "./components/AgeGate";
import Navbar from "./components/Navbar";
import HeroBanner from "./components/HeroBanner";
import VideoCard from "./components/VideoCard";
import VideoPlayer from "./components/VideoPlayer";
import ShareModal from "./components/ShareModal";
import Footer from "./components/Footer";
import type { Video } from "./data/mockVideos";
import { TrendingUp, Flame, Sparkles, Crown, ChevronRight, Loader2, Upload, Wifi, WifiOff } from "lucide-react";
import { fetchVideos, searchVideos, fetchVideoDetail, mapApiVideoToVideo } from "./services/api";

const AGE_VERIFIED_KEY = "intimora_age_verified";

function App() {
  const [ageVerified, setAgeVerified] = useState(() => {
    try { return sessionStorage.getItem(AGE_VERIFIED_KEY) === "true"; }
    catch { return false; }
  });
  const [videos, setVideos] = useState<Video[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Video[] | null>(null);
  const [activeVideo, setActiveVideo] = useState<Video | null>(null);
  const [shareVideo, setShareVideo] = useState<Video | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | number | null>(null);
  const [apiError, setApiError] = useState(false);
  const loaderRef = useRef<HTMLDivElement>(null);

  // Age gate confirm
  const handleAgeConfirm = () => {
    try { sessionStorage.setItem(AGE_VERIFIED_KEY, "true"); }
    catch { /* The current page can still be used when storage is disabled. */ }
    setAgeVerified(true);
  };

  // Initial load - ALWAYS from API, no mock data
  useEffect(() => {
    if (!ageVerified) return;

    const loadInitial = async () => {
      setInitialLoading(true);
      setLoading(true);
      try {
        const res = await fetchVideos();
        if (res.ok && res.data) {
          const apiVids = res.data.videos.map(mapApiVideoToVideo);
          setVideos(apiVids);
          setNextCursor(res.data.nextCursor);
          setHasMore(!!res.data.nextCursor);
          setApiError(false);
        } else {
          setVideos([]);
          setHasMore(false);
        }
      } catch {
        setApiError(true);
        setVideos([]);
        setHasMore(false);
      } finally {
        setLoading(false);
        setInitialLoading(false);
      }
    };

    loadInitial();
  }, [ageVerified]);

  // Infinite scroll - load more from API
  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !nextCursor) return;
    setLoading(true);
    try {
      const res = await fetchVideos(nextCursor);
      if (res.ok && res.data && res.data.videos.length > 0) {
        const apiVids = res.data.videos.map(mapApiVideoToVideo);
        setVideos((prev) => [...prev, ...apiVids]);
        setNextCursor(res.data.nextCursor);
        setHasMore(!!res.data.nextCursor);
      } else {
        setHasMore(false);
      }
    } catch {
      setHasMore(false);
    }
    setLoading(false);
  }, [loading, hasMore, nextCursor]);

  useEffect(() => {
    if (!ageVerified) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { threshold: 0.1 }
    );
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [loadMore, ageVerified]);

  // Search - ALWAYS from API
  const handleSearch = async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }

    setLoading(true);
    try {
      const res = await searchVideos(q);
      if (res.ok && res.data) {
        setSearchResults(res.data.videos.map(mapApiVideoToVideo));
      } else {
        setSearchResults([]);
      }
    } catch {
      setSearchResults([]);
    }
    setLoading(false);
  };

  // Play video - increment views via API
  const handlePlayVideo = async (v: Video) => {
    setActiveVideo(v);
    try {
      await fetchVideoDetail(v.id);
    } catch {
      // Playback can continue even if the view count cannot be updated.
    }
  };

  const displayedVideos = searchResults ?? videos;

  const categories = [
    { icon: <Flame className="w-4 h-4" />, label: "Trending Now", key: "Trending" },
    { icon: <Sparkles className="w-4 h-4" />, label: "New Releases", key: "New" },
    { icon: <Crown className="w-4 h-4" />, label: "Premium", key: "Premium" },
    { icon: <TrendingUp className="w-4 h-4" />, label: "Popular", key: "Popular" },
  ];

  if (!ageVerified) {
    return <AgeGate onConfirm={handleAgeConfirm} />;
  }

  return (
    <div
      className="min-h-screen"
      style={{ background: "#080808", color: "#fff" }}
    >
      {/* Navbar */}
      <Navbar
        searchQuery={searchQuery}
        onSearchChange={(q) => { setSearchQuery(q); if (!q) setSearchResults(null); }}
        onSearchSubmit={handleSearch}
      />

      {/* Main content */}
      <main className="site-main max-w-[1600px] mx-auto px-4 pt-24 pb-10">

        {/* INITIAL LOADING STATE */}
        {initialLoading && (
          <div className="flex flex-col items-center justify-center py-40">
            <div className="relative mb-6">
              <img src="/logo.png" alt="Intimora" className="w-20 h-20 object-contain animate-pulse" />
            </div>
            <Loader2 className="w-8 h-8 animate-spin mb-4" style={{ color: "#c9a84c" }} />
            <p className="text-gray-500 text-sm tracking-widest uppercase">Loading content...</p>
          </div>
        )}

        {/* API ERROR STATE */}
        {!initialLoading && apiError && (
          <div className="flex flex-col items-center justify-center py-32">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6" style={{ background: "rgba(239,68,68,0.1)", border: "2px solid rgba(239,68,68,0.3)" }}>
              <WifiOff className="w-10 h-10 text-red-500" />
            </div>
            <h2 className="text-white text-2xl font-bold mb-2">Content Unavailable</h2>
            <p className="text-gray-500 text-sm mb-6 text-center">We could not load content right now. Please try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-3 rounded-full font-bold text-sm transition-all hover:scale-105"
              style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
            >
              🔄 Retry Connection
            </button>
          </div>
        )}

        {/* EMPTY STATE - API works but no videos uploaded yet */}
        {!initialLoading && !apiError && videos.length === 0 && !searchResults && (
          <div className="flex flex-col items-center justify-center py-28">
            <div
              className="w-24 h-24 rounded-2xl flex items-center justify-center mb-6"
              style={{ background: "rgba(201,168,76,0.1)", border: "2px dashed rgba(201,168,76,0.3)" }}
            >
              <Upload className="w-12 h-12" style={{ color: "#c9a84c" }} />
            </div>
            <h2 className="text-white text-2xl font-bold mb-2">No Videos Yet</h2>
            <p className="text-gray-500 text-sm mb-1 text-center max-w-md">
              New videos will appear here when available.
            </p>
            <div className="flex items-center gap-2 mt-3 mb-6">
              <Wifi className="w-4 h-4 text-green-500" />
              <span className="text-green-500 text-xs font-semibold">Content service available</span>
            </div>
          </div>
        )}

        {/* MAIN CONTENT - when videos exist */}
        {!initialLoading && !apiError && videos.length > 0 && (
          <>
            {/* Hero Banner (only on home, no search) */}
            {!searchResults && (
              <div className="mb-10">
                <HeroBanner videos={videos} onPlay={handlePlayVideo} />
              </div>
            )}

            {/* Search results header */}
            {searchResults && (
              <div className="mb-6">
                <h2 className="mobile-break-words text-white text-2xl font-bold">
                  Search results for <span style={{ color: "#c9a84c" }}>"{searchQuery}"</span>
                </h2>
                <p className="text-gray-500 text-sm mt-1">{searchResults.length} videos found</p>
              </div>
            )}

            {/* Category Sections (home only) */}
            {!searchResults && (
              <>
                {/* Quick category pills */}
                <div className="flex items-center gap-3 mb-8 overflow-x-auto pb-2 scrollbar-hide">
                  {["All", "Free", "Premium", "Trending", "New", "Exclusive", "HD", "4K", "Solo", "Couple"].map((tag) => (
                    <button
                      key={tag}
                      className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold tracking-wider border transition-all hover:scale-105"
                      style={
                        tag === "All"
                          ? { background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000", border: "none" }
                          : { background: "transparent", color: "#666", borderColor: "#2a2a2a" }
                      }
                    >
                      {tag}
                    </button>
                  ))}
                </div>

                {/* Category sections */}
                {categories.map((cat) => {
                  const catVideos = videos.filter((v) => v.category === cat.key).slice(0, 6);
                  if (catVideos.length === 0) return null;
                  return (
                    <section key={cat.key} className="mb-10">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2" style={{ color: "#c9a84c" }}>
                          {cat.icon}
                          <h2 className="text-white font-bold text-lg">{cat.label}</h2>
                        </div>
                        <button className="flex items-center gap-1 text-xs text-gray-500 hover:text-yellow-400 transition">
                          See all <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                        {catVideos.map((video) => (
                          <VideoCard
                            key={video.id}
                            video={video}
                            onPlay={handlePlayVideo}
                            onShare={setShareVideo}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            )}

            {/* Main video grid */}
            <section>
              {!searchResults && (
                <div className="flex items-center gap-2 mb-5" style={{ color: "#c9a84c" }}>
                  <TrendingUp className="w-5 h-5" />
                  <h2 className="text-white font-bold text-xl">All Videos</h2>
                  <span className="text-gray-600 text-sm ml-1">({displayedVideos.length})</span>
                </div>
              )}

              {displayedVideos.length === 0 && searchResults ? (
                <div className="text-center py-20">
                  <div className="text-6xl mb-4">🔍</div>
                  <h3 className="text-white text-xl font-bold mb-2">No results found</h3>
                  <p className="text-gray-500">Try searching for something else</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                  {displayedVideos.map((video) => (
                    <VideoCard
                      key={video.id}
                      video={video}
                      onPlay={handlePlayVideo}
                      onShare={setShareVideo}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Infinite scroll loader */}
            {!searchResults && (
              <div ref={loaderRef} className="flex justify-center mt-10 py-6">
                {loading && (
                  <div className="flex items-center gap-3 text-gray-500">
                    <Loader2 className="w-6 h-6 animate-spin" style={{ color: "#c9a84c" }} />
                    <span className="text-sm">Loading more videos...</span>
                  </div>
                )}
                {!loading && !hasMore && videos.length > 0 && (
                  <p className="text-gray-700 text-sm">— You've reached the end —</p>
                )}
              </div>
            )}
          </>
        )}

        {/* Search results when no videos on home but search was done */}
        {!initialLoading && !apiError && videos.length === 0 && searchResults && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">🔍</div>
            <h3 className="mobile-break-words text-white text-xl font-bold mb-2">No results found for "{searchQuery}"</h3>
            <p className="text-gray-500">No videos are available yet.</p>
          </div>
        )}

      </main>

      <Footer />

      {/* Video Player Modal */}
      {activeVideo && (
        <VideoPlayer
          video={activeVideo}
          onClose={() => setActiveVideo(null)}
          onShare={(v) => { setShareVideo(v); setActiveVideo(null); }}
        />
      )}

      {/* Share Modal */}
      {shareVideo && (
        <ShareModal
          video={shareVideo}
          onClose={() => setShareVideo(null)}
        />
      )}
    </div>
  );
}

export default App;
