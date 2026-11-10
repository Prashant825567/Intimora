import { useState, useEffect, useRef, useMemo } from "react";
import type { ReactNode } from "react";
import AgeGate from "./components/AgeGate";
import Navbar from "./components/Navbar";
import HeroBanner from "./components/HeroBanner";
import VideoCard from "./components/VideoCard";
import VideoPlayer from "./components/VideoPlayer";
import ShareModal from "./components/ShareModal";
import Footer from "./components/Footer";
import AccountPages from "./components/AccountPages";
import type { AccountPage } from "./components/AccountPages";
import { useAccount } from "./hooks/useAccount";
import type { AccountController } from "./hooks/useAccount";
import { useLiveLikes } from "./hooks/useLiveLikes";
import type { LiveLikes } from "./hooks/useLiveLikes";
import type { Video } from "./data/mockVideos";
import type { BrowseView } from "./types/navigation";
import { TrendingUp, Flame, Sparkles, ChevronRight, Loader2, Upload, Wifi, WifiOff, Grid2X2 } from "lucide-react";
import { fetchVideos, searchVideos, fetchVideoDetail, formatViews, mapApiVideoToVideo, primeBackendSelection } from "./services/api";
import type { CatalogResponse } from "./services/api";
import { collectCatalog } from "./services/catalog-pages.mjs";
import { selectExclusive, selectNewReleases, selectTrending } from "./services/catalog-views.mjs";
import { accountPageFromPath, BROWSE_PATHS, browseViewFromPath, isSearchPath, searchPathFor, searchTermFromLocation, watchIdFromPath, watchPathFor } from "./services/page-routes.mjs";

const AGE_VERIFIED_KEY = "intimora_age_verified";
const CATALOG_PAGE_SIZE = 50;
const DISPLAY_PAGE_SIZE = 12;
type CatalogStatus = "loading" | "complete" | "partial";
type FeedView = Exclude<BrowseView, "Home" | "Categories">;

function VideoGrid({ videos, onPlay, onShare, onSave, account, liveLikes, compact = false }: {
  videos: Video[];
  onPlay: (video: Video) => void;
  onShare: (video: Video) => void;
  onSave: (video: Video) => void;
  account: AccountController;
  liveLikes: LiveLikes;
  compact?: boolean;
}) {
  return (
    <div className={compact
      ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4"
      : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"}>
      {videos.map((video) => <VideoCard key={video.id} video={liveLikes.withCount(video)} onPlay={onPlay} onShare={onShare} onSave={onSave} saved={account.isSaved(video.id)} savePending={account.pending.has(`save:${video.id}`)} observeLikes={liveLikes.observe} />)}
    </div>
  );
}

function FeedSection({ title, icon, videos, emptyMessage, onSeeAll, onPlay, onShare, onSave, account, liveLikes }: {
  title: string;
  icon: ReactNode;
  videos: Video[];
  emptyMessage: string;
  onSeeAll: () => void;
  onPlay: (video: Video) => void;
  onShare: (video: Video) => void;
  onSave: (video: Video) => void;
  account: AccountController;
  liveLikes: LiveLikes;
}) {
  return (
    <section className="mb-10" aria-label={title}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2" style={{ color: "#c9a84c" }}>
          {icon}
          <h2 className="text-white font-bold text-lg">{title}</h2>
        </div>
        <button type="button" onClick={onSeeAll} aria-label={`See all ${title}`} className="flex items-center gap-1 text-xs text-gray-500 hover:text-yellow-400 transition">
          See all <ChevronRight className="w-3 h-3" />
        </button>
      </div>
      {videos.length ? <VideoGrid videos={videos.slice(0, 6)} onPlay={onPlay} onShare={onShare} onSave={onSave} account={account} liveLikes={liveLikes} compact />
        : <p className="text-gray-500 text-sm">{emptyMessage}</p>}
    </section>
  );
}

function useLocalDayClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const current = new Date();
      setNow(current.getTime());
      const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
      timer = setTimeout(refresh, Math.max(100, tomorrow - current.getTime() + 100));
    };
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  return now;
}

function App() {
  const [ageVerified, setAgeVerified] = useState(() => {
    try { return sessionStorage.getItem(AGE_VERIFIED_KEY) === "true"; }
    catch { return false; }
  });
  const account = useAccount(ageVerified);
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }));
  const { pathname } = location;
  const accountPage = accountPageFromPath(pathname);
  const activeBrowseView = browseViewFromPath(pathname);
  const activeView = activeBrowseView ?? "Home";
  const submittedQuery = searchTermFromLocation(pathname, location.search);
  const [actionError, setActionError] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [visibleCount, setVisibleCount] = useState(DISPLAY_PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState(() => submittedQuery ?? "");
  const [searchRevision, setSearchRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [searchResults, setSearchResults] = useState<Video[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [activeVideo, setActiveVideo] = useState<Video | null>(null);
  const liveLikes = useLiveLikes(__INTIMORA_LIVE_LIKES__, activeVideo);
  const [startVideoOnOpen, setStartVideoOnOpen] = useState(false);
  const [shareVideo, setShareVideo] = useState<Video | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>("loading");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [apiError, setApiError] = useState(false);
  const [sharedVideoUnavailable, setSharedVideoUnavailable] = useState(false);
  const firstPageRequest = useRef<{ revision: number; promise: Promise<CatalogResponse> } | null>(null);
  const catalogFinishedAt = useRef(0);
  const sharedVideoRequest = useRef<{ id: string; promise: ReturnType<typeof fetchVideoDetail> } | null>(null);
  const locallyOpenedVideo = useRef<string | null>(null);
  const returnFromWatch = useRef("/");
  const searchRequest = useRef(0);
  const loaderRef = useRef<HTMLDivElement>(null);
  const now = useLocalDayClock();

  const goTo = (path: string, replace = false) => {
    // All navigation remains on this origin, even when returning from a watch URL.
    const destination = path.startsWith("/") && !path.startsWith("//") ? path : "/";
    let target = new URL(destination, window.location.origin);
    if (target.origin !== window.location.origin) target = new URL("/", window.location.origin);
    const href = `${target.pathname}${target.search}`;
    if (`${window.location.pathname}${window.location.search}` !== href) {
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
    }
    searchRequest.current += 1;
    locallyOpenedVideo.current = null;
    setLocation({ pathname: target.pathname, search: target.search });
    setVisibleCount(DISPLAY_PAGE_SIZE);
    setSearchQuery("");
    setSearchResults(null);
    setSearchLoading(false);
    setSearchError(false);
    setActiveVideo(null);
    setShareVideo(null);
    setActionError("");
    setSharedVideoUnavailable(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  useEffect(() => {
    const onPopState = () => {
      searchRequest.current += 1;
      locallyOpenedVideo.current = null;
      setLocation({ pathname: window.location.pathname, search: window.location.search });
      // A history entry can have the same URL as its neighbor. Its state still
      // needs to be restored after a back/forward navigation.
      setHistoryRevision((revision) => revision + 1);
      setVisibleCount(DISPLAY_PAGE_SIZE);
      setSearchResults(null);
      setSearchLoading(false);
      setSearchError(false);
      setActiveVideo(null);
      setShareVideo(null);
      setActionError("");
      setSharedVideoUnavailable(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Deep-linked account pages are protected by the age gate and the current
  // Firebase/account state. Replace redirects so Back doesn't loop.
  useEffect(() => {
    if (!ageVerified || !accountPage) return;
    let destination: AccountPage | null = null;
    if (account.status === "guest" && accountPage !== "login") destination = "login";
    else if (account.status === "needs-profile" && accountPage !== "profile" && accountPage !== "referral") destination = "profile";
    else if (account.status === "ready" && accountPage !== "dashboard") destination = "dashboard";
    if (destination) goTo(`/${destination}`, true);
  }, [ageVerified, account.status, accountPage]);

  // Discovery starts on arrival; no catalog or media is requested before age confirmation.
  useEffect(() => { primeBackendSelection().catch(() => {}); }, []);

  const handleAgeConfirm = () => {
    try { sessionStorage.setItem(AGE_VERIFIED_KEY, "true"); }
    catch { /* The current page can still be used when storage is disabled. */ }
    setAgeVerified(true);
  };

  // The backend only offers date-ordered pages. Scan them in the background so
  // Trending and Exclusive are based on the whole available catalog, while the
  // first page and ordinary browsing remain usable immediately.
  useEffect(() => {
    if (!ageVerified) return;
    let cancelled = false;
    setVideos([]);
    setInitialLoading(true);
    setCatalogStatus("loading");
    setApiError(false);
    if (!firstPageRequest.current || firstPageRequest.current.revision !== catalogRevision) {
      firstPageRequest.current = { revision: catalogRevision, promise: fetchVideos(null, CATALOG_PAGE_SIZE) };
    }
    const first = firstPageRequest.current.promise;
    (async () => {
      let receivedFirstPage = false;
      try {
        const response = await first;
        if (cancelled) return;
        receivedFirstPage = true;
        const result = await collectCatalog({
          firstPage: response,
          fetchPage: (cursor) => fetchVideos(cursor, CATALOG_PAGE_SIZE),
          isCancelled: () => cancelled,
          onPage: (page, backend) => {
            if (cancelled) return;
            const mapped = page.map((video) => mapApiVideoToVideo(video, backend));
            setVideos((previous) => [...previous, ...mapped]);
            setInitialLoading(false);
          },
          pageSize: CATALOG_PAGE_SIZE,
        });
        if (!cancelled) {
          if (result.complete) catalogFinishedAt.current = Date.now();
          setCatalogStatus(result.complete ? "complete" : "partial");
        }
      } catch {
        if (!cancelled) {
          if (receivedFirstPage) setCatalogStatus("partial");
          else setApiError(true);
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ageVerified, catalogRevision]);

  // Search results are driven by the URL so a copied link, refresh, and browser
  // history restore the same query. Never query the catalog before the age gate.
  useEffect(() => {
    const request = ++searchRequest.current;
    setSearchQuery(submittedQuery ?? "");
    setSearchResults(null);
    setSearchError(false);
    if (!ageVerified || !submittedQuery) {
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    searchVideos(submittedQuery).then((response) => {
      if (!cancelled && request === searchRequest.current) {
        setSearchResults(response.data.videos.map((video) => mapApiVideoToVideo(video, response.data.backend)));
      }
    }).catch(() => {
      if (!cancelled && request === searchRequest.current) setSearchError(true);
    }).finally(() => {
      if (!cancelled && request === searchRequest.current) setSearchLoading(false);
    });
    return () => { cancelled = true; };
  }, [ageVerified, pathname, location.search, submittedQuery, searchRevision, historyRevision]);

  // Shared links resolve through the recipient's independently selected backend.
  useEffect(() => {
    const id = watchIdFromPath(pathname);
    setSharedVideoUnavailable(false);
    if (!ageVerified || !id || locallyOpenedVideo.current === id) return;
    let cancelled = false;
    if (!sharedVideoRequest.current || sharedVideoRequest.current.id !== id) {
      sharedVideoRequest.current = { id, promise: fetchVideoDetail(id) };
    }
    sharedVideoRequest.current.promise.then(({ video, backend }) => {
      if (cancelled) return;
      if (video) {
        // A shared link may open after the gate without an explicit play click.
        setStartVideoOnOpen(false);
        setActiveVideo(mapApiVideoToVideo(video, backend));
      } else setSharedVideoUnavailable(true);
    }).catch(() => { if (!cancelled) setSharedVideoUnavailable(true); });
    return () => { cancelled = true; };
  }, [ageVerified, pathname, historyRevision]);

  const trending = useMemo(() => selectTrending(videos), [videos]);
  const newReleases = useMemo(() => selectNewReleases(videos, Date.now()), [videos, now]);
  const exclusive = useMemo(() => selectExclusive(videos), [videos]);
  const feeds: Record<FeedView, Video[]> = { Trending: trending, New: newReleases, Exclusive: exclusive };
  const feedLabels: Record<FeedView, { title: string; subtitle: string; empty: string }> = {
    Trending: { title: "Trending Now", subtitle: "The most viewed videos, in order.", empty: "No videos are available yet." },
    New: { title: "New Releases", subtitle: "Today's uploads, or yesterday's if there are none today.", empty: "No videos were uploaded today or yesterday." },
    Exclusive: { title: "Exclusive", subtitle: "Videos marked exclusive in their metadata.", empty: "No exclusive videos are available yet." },
  };
  const currentFeed = activeView === "Home" || activeView === "Categories" ? videos : feeds[activeView];
  const hasMoreVisible = visibleCount < currentFeed.length;

  // Keep rendering a small number of cards at a time even while catalog pages
  // are collected in the background for correct ranking/filtering.
  useEffect(() => {
    if (!ageVerified || initialLoading || apiError || submittedQuery !== null || activeView === "Categories" || !hasMoreVisible) return;
    const element = loaderRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((count) => Math.min(count + DISPLAY_PAGE_SIZE, currentFeed.length));
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ageVerified, initialLoading, apiError, submittedQuery, activeView, catalogStatus, hasMoreVisible, visibleCount, currentFeed.length]);

  const retryCatalog = () => {
    firstPageRequest.current = null;
    setCatalogStatus("loading");
    setInitialLoading(true);
    setApiError(false);
    setVisibleCount(DISPLAY_PAGE_SIZE);
    setCatalogRevision((revision) => revision + 1);
  };

  const navigate = (view: BrowseView) => {
    const elapsed = Date.now() - catalogFinishedAt.current;
    if (view !== "Home" && view !== "Categories" && catalogStatus === "complete" && (elapsed < 0 || elapsed >= 60_000)) retryCatalog();
    goTo(BROWSE_PATHS[view]);
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (!query && isSearchPath(pathname)) goTo("/", true);
  };

  const handleSearch = (query: string) => {
    const target = searchPathFor(query);
    if (target === "/search") {
      handleSearchChange("");
      return;
    }
    if (`${window.location.pathname}${window.location.search}` === target) {
      // Allow the user to retry the same query without adding a history entry.
      searchRequest.current += 1;
      setSearchRevision((revision) => revision + 1);
    } else goTo(target);
  };

  const handlePlayVideo = async (video: Video) => {
    const path = watchPathFor(video.id);
    if (path) {
      if (!watchIdFromPath(window.location.pathname)) {
        returnFromWatch.current = `${window.location.pathname}${window.location.search}`;
      }
      locallyOpenedVideo.current = video.id;
      if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, "", path);
      searchRequest.current += 1;
      setLocation({ pathname: path, search: "" });
      setShareVideo(null);
      setActionError("");
      setSharedVideoUnavailable(false);
    }
    // "Watch now" and card play are explicit user actions. Try to start on
    // that first click; if the browser blocks it, the play button remains.
    setStartVideoOnOpen(true);
    setActiveVideo(video);
    try {
      // The route effect must not make a second detail request: this endpoint
      // also counts a view. Back/forward may reuse this same promise.
      const promise = fetchVideoDetail(video.id, video.backendBase);
      if (path) sharedVideoRequest.current = { id: video.id, promise };
      const detail = await promise;
      if (detail.video?.views === undefined) return;
      const viewCount = detail.video.views;
      const update = (item: Video) => item.id === video.id && item.backendBase === video.backendBase
        ? { ...item, viewCount, views: formatViews(viewCount) } : item;
      setVideos((previous) => previous.map(update));
      setSearchResults((previous) => previous?.map(update) ?? null);
      setActiveVideo((previous) => previous ? update(previous) : previous);
    } catch {
      // Playback can continue even if the view count cannot be updated.
    }
  };

  const closeVideo = () => {
    if (watchIdFromPath(pathname)) goTo(returnFromWatch.current, true);
    else { setActiveVideo(null); setActionError(""); }
  };
  const closeShare = () => {
    if (watchIdFromPath(pathname) && !activeVideo) goTo(returnFromWatch.current, true);
    else setShareVideo(null);
  };

  const openAccount = () => {
    goTo(account.status === "ready" ? "/dashboard" : account.status === "needs-profile" ? "/profile" : "/login");
  };

  const handleAccountAction = (action: "like" | "save", video: Video) => {
    setActionError("");
    if (account.status === "checking") {
      if (!account.identity) openAccount();
      else setActionError("Checking your account. Please try again in a moment.");
      return;
    }
    if (account.status !== "ready") {
      openAccount();
      return;
    }
    void account.toggle(action, video).then((result) => {
      if (result?.count) liveLikes.record(video, result.count);
    }).catch(() => setActionError(`Could not confirm ${action}. Please refresh and check before trying again.`));
  };
  const handleSave = (video: Video) => handleAccountAction("save", video);
  const handleLike = (video: Video) => handleAccountAction("like", video);

  if (!ageVerified) return <AgeGate onConfirm={handleAgeConfirm} />;

  const searchInProgress = searchLoading || (submittedQuery !== null && searchResults === null && !searchError);
  const catalogMessage = catalogStatus === "loading" ? (
    <div className="catalog-status" role="status"><Loader2 className="w-4 h-4 animate-spin" /> Checking the full catalog…</div>
  ) : catalogStatus === "partial" ? (
    <div className="catalog-status" role="alert">
      <span>We could not check the full catalog. Please try again.</span>
      <button type="button" onClick={retryCatalog} className="catalog-status__retry">Retry</button>
    </div>
  ) : null;

  const listFooter = (total: number) => (
    <div ref={loaderRef} className="flex justify-center mt-10 py-6" aria-live="polite">
      {visibleCount < total ? <span className="text-gray-500 text-sm">Loading more videos…</span>
        : catalogStatus === "loading" ? <span className="text-gray-500 text-sm">Checking for more videos…</span>
          : total > 0 && <p className="text-gray-700 text-sm">— You've reached the end —</p>}
    </div>
  );

  return (
    <div className="min-h-screen" style={{ background: "#080808", color: "#fff" }}>
      <Navbar searchQuery={searchQuery} onSearchChange={handleSearchChange} onSearchSubmit={handleSearch} activeView={activeBrowseView} onNavigate={navigate} accountLabel={account.status === "ready" ? "Account dashboard" : "Sign in"} accountInitial={account.profile?.name.charAt(0).toUpperCase()} onAccountClick={openAccount} />
      <main className="site-main max-w-[1600px] mx-auto px-4 pt-24 pb-10">
        {actionError && !activeVideo && <p role="alert" className="account-action-error sticky top-20 z-40">{actionError}</p>}
        {sharedVideoUnavailable && !accountPage && !initialLoading && !apiError && (
          <p role="status" className="mb-4 text-center text-sm text-gray-400">This video is currently unavailable.</p>
        )}

        {accountPage ? (
          <AccountPages page={accountPage} account={account} videos={videos} catalogLoading={!apiError && (initialLoading || catalogStatus === "loading")} catalogUnavailable={apiError || catalogStatus === "partial"} onRetryCatalog={retryCatalog} renderVideos={(items) => <VideoGrid videos={items} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />} onPage={(page) => goTo(`/${page}`)} onBack={() => goTo("/")} />
        ) : submittedQuery !== null ? (
          <section aria-label="Search results">
            <div className="mb-6">
              <h2 className="mobile-break-words text-white text-2xl font-bold">Search results for <span style={{ color: "#c9a84c" }}>"{submittedQuery}"</span></h2>
              {!searchInProgress && !searchError && <p className="text-gray-500 text-sm mt-1">{searchResults?.length ?? 0} videos found</p>}
            </div>
            {searchInProgress ? <div className="catalog-status" role="status"><Loader2 className="w-4 h-4 animate-spin" /> Searching…</div>
              : searchError ? <p role="alert" className="text-gray-400 text-sm">Search is temporarily unavailable. Please try again.</p>
                : searchResults?.length ? <VideoGrid videos={searchResults} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />
                  : <div className="text-center py-20"><h3 className="text-white text-xl font-bold mb-2">No results found</h3><p className="text-gray-500">Try searching for something else</p></div>}
          </section>
        ) : isSearchPath(pathname) ? (
          <section aria-label="Search videos" className="py-12">
            <h1 className="text-white text-2xl font-bold">Search videos</h1>
            <p className="mt-2 text-sm text-gray-500">Enter a search in the bar above.</p>
          </section>
        ) : activeView === "Categories" ? (
          <section className="coming-soon" aria-label="Categories">
            <div className="coming-soon__icon"><Grid2X2 className="w-7 h-7" /></div>
            <p className="coming-soon__eyebrow">CATEGORIES</p>
            <h1>Coming Soon</h1>
            <p>We're getting this space ready for you.</p>
            <button type="button" onClick={() => navigate("Home")}>Back to Home</button>
          </section>
        ) : initialLoading ? (
          <div className="flex flex-col items-center justify-center py-40" role="status">
            <img src="/logo.png" alt="Intimora" className="w-20 h-20 object-contain animate-pulse mb-6" />
            <Loader2 className="w-8 h-8 animate-spin mb-4" style={{ color: "#c9a84c" }} />
            <p className="text-gray-500 text-sm tracking-widest uppercase">Loading content...</p>
          </div>
        ) : apiError ? (
          <div className="flex flex-col items-center justify-center py-32">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6" style={{ background: "rgba(239,68,68,0.1)", border: "2px solid rgba(239,68,68,0.3)" }}><WifiOff className="w-10 h-10 text-red-500" /></div>
            <h2 className="text-white text-2xl font-bold mb-2">Content Unavailable</h2>
            <p className="text-gray-500 text-sm mb-6 text-center">We could not load content right now. Please try again.</p>
            <button type="button" onClick={retryCatalog} className="px-6 py-3 rounded-full font-bold text-sm transition-all hover:scale-105" style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}>🔄 Retry Connection</button>
          </div>
        ) : activeView === "Home" && videos.length === 0 && catalogStatus === "complete" ? (
          <div className="flex flex-col items-center justify-center py-28">
            <div className="w-24 h-24 rounded-2xl flex items-center justify-center mb-6" style={{ background: "rgba(201,168,76,0.1)", border: "2px dashed rgba(201,168,76,0.3)" }}><Upload className="w-12 h-12" style={{ color: "#c9a84c" }} /></div>
            <h2 className="text-white text-2xl font-bold mb-2">No Videos Yet</h2>
            <p className="text-gray-500 text-sm mb-1 text-center max-w-md">New videos will appear here when available.</p>
            <div className="flex items-center gap-2 mt-3 mb-6"><Wifi className="w-4 h-4 text-green-500" /><span className="text-green-500 text-xs font-semibold">Content service available</span></div>
          </div>
        ) : activeView === "Home" ? (
          <>
            {videos.length > 0 && <div className="mb-10"><HeroBanner videos={videos} onPlay={handlePlayVideo} /></div>}
            <div className="flex items-center gap-3 mb-8 overflow-x-auto pb-2 scrollbar-hide" aria-label="Explore videos">
              {["All", "Free", "Trending", "New", "Exclusive", "HD", "4K", "Solo", "Couple"].map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => navigate(tag === "All" ? "Home" : tag === "Trending" || tag === "New" || tag === "Exclusive" ? tag : "Categories")}
                  className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-bold tracking-wider border transition-all hover:scale-105"
                  style={tag === "All" ? { background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000", border: "none" } : { background: "transparent", color: "#666", borderColor: "#2a2a2a" }}
                >{tag}</button>
              ))}
            </div>
            {catalogMessage}
            {catalogStatus === "complete" && videos.length > 0 && (
              <>
                <FeedSection title="Trending Now" icon={<Flame className="w-4 h-4" />} videos={trending} emptyMessage={feedLabels.Trending.empty} onSeeAll={() => navigate("Trending")} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />
                <FeedSection title="New Releases" icon={<Sparkles className="w-4 h-4" />} videos={newReleases} emptyMessage={feedLabels.New.empty} onSeeAll={() => navigate("New")} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />
                <FeedSection title="Exclusive" icon={<Sparkles className="w-4 h-4" />} videos={exclusive} emptyMessage={feedLabels.Exclusive.empty} onSeeAll={() => navigate("Exclusive")} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />
              </>
            )}
            {videos.length > 0 && (
              <section aria-label="All Videos">
                <div className="flex items-center gap-2 mb-5" style={{ color: "#c9a84c" }}><TrendingUp className="w-5 h-5" /><h2 className="text-white font-bold text-xl">All Videos</h2><span className="text-gray-600 text-sm ml-1">({videos.length})</span></div>
                <VideoGrid videos={videos.slice(0, visibleCount)} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />
                {listFooter(videos.length)}
              </section>
            )}
          </>
        ) : (
          <section aria-label={feedLabels[activeView].title}>
            <div className="mb-6"><h1 className="text-white text-2xl font-bold">{feedLabels[activeView].title}</h1><p className="text-gray-500 text-sm mt-1">{feedLabels[activeView].subtitle}</p></div>
            {catalogMessage}
            {catalogStatus === "complete" && (currentFeed.length
              ? <><VideoGrid videos={currentFeed.slice(0, visibleCount)} onPlay={handlePlayVideo} onShare={setShareVideo} onSave={handleSave} account={account} liveLikes={liveLikes} />{listFooter(currentFeed.length)}</>
              : <p className="text-gray-500 text-sm py-8">{feedLabels[activeView].empty}</p>)}
          </section>
        )}
      </main>
      <Footer />
      {activeVideo && <VideoPlayer key={`${activeVideo.backendBase}:${activeVideo.id}:${activeVideo.videoUrl}`} video={liveLikes.withCount(activeVideo)} startOnOpen={startVideoOnOpen} onClose={closeVideo} onShare={(video) => { setShareVideo(video); setActiveVideo(null); }} liked={account.isLiked(activeVideo.id)} saved={account.isSaved(activeVideo.id)} likePending={account.pending.has(`like:${activeVideo.id}`)} savePending={account.pending.has(`save:${activeVideo.id}`)} onLike={handleLike} onSave={handleSave} actionError={actionError} />}
      {shareVideo && <ShareModal video={shareVideo} onClose={closeShare} />}
    </div>
  );
}

export default App;
