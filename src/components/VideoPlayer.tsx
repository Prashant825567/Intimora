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
import { loadPreRoll } from "../services/vast-loader.mjs";
import { VAST_CACHED_AD_URL, VAST_DECISION_GRACE_MS, VAST_LIVE_BUDGET_MS, VAST_SKIP_FALLBACK_SECONDS, VAST_TIMEOUT_MS } from "../config/vast";
import { mediaCrossOrigin } from "../services/media-credentials.mjs";
import { RECOVERY_DELAY_MS, shouldAutoRecover, playbackFailureMessage } from "../services/playback-recovery.mjs";

// A link whose token expired is reported in the app's own words, and only after
// the silent refresh above has failed too.
const LINK_EXPIRED = "Is link ki validity khatam ho gayi. Ek baar Try again dabao — naya link aa jayega.";
// How many times a dead premium/stream link is re-issued on its own before the
// visitor is asked to press Try again. Enough for a slow network, small enough
// that a backend returning dead links cannot become a request loop.
const LINK_REFRESH_BUDGET = 3;

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
  // Whether an account is signed in, and whether that has been established yet.
  // A premium video is for members, so a guest is asked to sign in first — with a
  // button that goes to the sign-in page. While the account is still being checked
  // the same notice stays up, so a signed-in visitor never sees a play button for
  // a premium video, not even for the moment the check takes.
  signedIn: boolean;
  accountChecking: boolean;
  onSignIn: () => void;
  // Stream and trailer links are short-lived tokens. When one expires the player
  // asks the app for a freshly issued copy of this video (the backend decides
  // what it may hand out) instead of telling the visitor to reload the page.
  onRefreshVideo?: (video: Video) => Promise<Video | null>;
}

type BufferedRange = { start: number; end: number };

// A third-party CDN rarely sends CORS headers, and `anonymous` would turn that
// into a hard load error. Only our own byte route keeps the attribute; a CDN
// source is requested as a plain media load.
function sourceCrossOrigin(url: string, fallback?: string) {
  return fallback && url !== fallback ? undefined : mediaCrossOrigin(url);
}

// Only the selected player is preloaded, after the age gate. This is a browser
// hint rather than a byte limit; honor data-saver and very slow connections.
function preloadHint(): "auto" | "metadata" {
  const connection = typeof navigator === "undefined" ? undefined
    : (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g"
    ? "metadata" : "auto";
}

// A phone held upright would show a fullscreen video in a letterboxed strip, so
// the player asks for landscape when it goes fullscreen. iOS has no orientation
// lock; there the inline player simply stays as it is.
type OrientationApi = { lock?: (value: string) => Promise<void>; unlock?: () => void };

function orientationApi(): OrientationApi | undefined {
  if (typeof screen === "undefined") return undefined;
  return screen.orientation as unknown as OrientationApi | undefined;
}

function lockLandscape() {
  try { void orientationApi()?.lock?.("landscape")?.catch(() => { /* unsupported */ }); } catch { /* unsupported */ }
}

function unlockOrientation() {
  try { orientationApi()?.unlock?.(); } catch { /* unsupported */ }
}

// `onSignIn` stays in the props for the caller, but the player itself no longer
// sends anyone to sign in: the backend's answer decides what plays.
const VideoPlayer: React.FC<VideoPlayerProps> = ({ video: openedVideo, startOnOpen, onClose, onShare, liked, saved, likePending, savePending, onLike, onSave, actionError, signedIn, accountChecking, onRefreshVideo }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  // A fresh answer from the backend (a re-issued link, or the member's full stream
  // where the first answer only had a trailer) replaces what this player was opened
  // with. It lives here, next to the element, so the position is kept.
  const [refreshedVideo, setRefreshedVideo] = useState<Video | null>(null);
  const video = refreshedVideo ?? openedVideo;
  const refreshed = useRef(false);
  const refreshedPlay = useRef(false);
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const playAttempt = useRef(0);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preload] = useState(preloadHint);
  // The URL a media element is actually loading. It is the CDN file when the
  // backend offered one, and it moves to the byte stream if that link fails.
  // A locked video (premium, not active for this visitor) plays its trailer and
  // never asks for the full stream — the backend is the authority on that, and a
  // request it refuses would only waste the visitor's data.
  const locked = video.locked === true && !video.videoUrl?.includes("kind=trailer") && Boolean(video.trailerUrl);
  // What the server actually gave us: a trailer, or the video itself. The player
  // says which one it is showing, so a member never wonders why the runtime is short
  // and a guest never wonders why a premium title ended early.
  const playingTrailer = (url: string | undefined | null) => typeof url === "string" && /[?&]kind=trailer\b/.test(url);
  // The backend also names the type it sent, which is the only way to know a
  // trailer that arrived as a plain media file is a trailer. An explicit `full`
  // only wins when the link itself carries no trailer marker.
  const serverSaysTrailer = video.playbackType === "trailer";
  const trailerOnly = locked || serverSaysTrailer || playingTrailer(locked ? video.trailerUrl : video.videoUrl);
  // What this player opens with: the trailer when the backend calls the title
  // locked, otherwise the link the answer carried — and the trailer when it carried
  // no full link at all. A premium title with neither is the panel case below.
  const welcomeSource = locked ? (video.trailerUrl as string) : (video.videoUrl || (video.trailerUrl as string) || "");
  // A 4xx on a tokenised link is an expiry even when the element only reports a
  // generic decode error. Performance entries are read-only and cheap.
  const refusalSeen = (_element: HTMLVideoElement, url: string | undefined) => {
    if (typeof url !== "string" || !tokenisedLink(url) || typeof performance === "undefined" || !performance.getEntriesByName) return false;
    try {
      return performance.getEntriesByName(url, "resource").some((entry) => {
        const status = (entry as PerformanceResourceTiming).responseStatus;
        return typeof status === "number" && status >= 400;
      });
    } catch {
      return false;
    }
  };

  // Whether the current source carries a short-lived token, so an error on it may
  // mean "expired" rather than "broken".
  const tokenisedLink = (url: string | undefined) => typeof url === "string" && /[?&]t=/.test(url);
  // A premium title never gets a pre-roll — not the trailer, not the full video.
  // It is premium whether the backend marked the title (`premium`) or answered
  // that this visitor may not see it (`locked`); either way an ad has no place
  // in front of it.
  const premiumTitle = video.premium === true || video.locked === true;
  // Premium video, no active window and no trailer: there is nothing to play, and
  // the backend said so. The panel explains it instead of showing a broken player.
  const lockedBlocked = premiumTitle && !video.trailerUrl && !video.videoUrl;
  // Who may watch what is the backend's answer, never a sign-in gate in the player:
  // a premium title returns its full stream for an active member and the locked
  // shape (a trailer) for everyone else, and those links are what plays. So a guest
  // watches the trailer the backend sent, without being stopped first. Only a title
  // the backend sent nothing for is blocked, and that is `lockedBlocked`.
  const [source, setSource] = useState(welcomeSource);
  const sourceSwapped = useRef(false);
  const resumeAt = useRef(0);
  // The CORS attribute is read once: changing it makes the browser throw away
  // the media load in progress, which showed up as a playback error. It follows
  // a different video only while nothing is being loaded.
  const [crossOrigin, setCrossOrigin] = useState(() => sourceCrossOrigin(welcomeSource, video.fallbackVideoUrl));
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const playbackErrorRef = useRef("");
  useEffect(() => { playbackErrorRef.current = playbackError; }, [playbackError]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [adPlaying, setAdPlaying] = useState<VastAd | null>(null);
  // The pre-roll's own media element cuts the content's request; that failure is
  // remembered and repaired when the ad ends instead of being shown to anyone.
  const adPlayingRef = useRef(false);
  const pendingReload = useRef(false);
  const recoveries = useRef(0);
  // Whether playback was asked for at all: a silent reload must not start a
  // video that nobody wanted to watch.
  const wantsPlay = useRef(false);
  const playingRef = useRef(false);
  // A click arrives together with the pointer move that precedes it; without
  // this the move would re-show the controls the click just hid.
  const controlsToggledAt = useRef(0);
  // One pending reload at a time. It is deliberately not tied to playAttempt:
  // a second play request (StrictMode, a fast double tap) must not cancel it.
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adState = useRef<{ status: "idle" | "loading" | "deciding" | "done"; promise: Promise<VastAd | null> | null }>({ status: "idle", promise: null });

  useEffect(() => { adPlayingRef.current = Boolean(adPlaying); }, [adPlaying]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // A premium title can be opened while the account is still being checked: the
  // backend then sends the locked shape, which only carries a trailer. Once the
  // member is confirmed, the video is asked for exactly once more, and the answer
  // replaces the trailer if it now has the full stream.
  const askedAfterSignIn = useRef(false);
  useEffect(() => {
    if (!signedIn || accountChecking || askedAfterSignIn.current || !onRefreshVideo) return;
    if (video.premium !== true) return;
    const onlyTrailer = video.locked === true || !video.videoUrl || video.videoUrl.includes("kind=trailer");
    if (!onlyTrailer) return;
    askedAfterSignIn.current = true;
    void onRefreshVideo(video).then((fresh) => {
      const nextSource = fresh?.videoUrl;
      if (!fresh || !nextSource || nextSource.includes("kind=trailer")) return;
      const at = Number.isFinite(videoRef.current?.currentTime) ? videoRef.current!.currentTime : 0;
      installFresh(fresh, at);
    }).catch(() => { /* The trailer keeps playing. */ });
  }, [signedIn, accountChecking, video, onRefreshVideo]);

  // A different video starts with a fresh budget.
  useEffect(() => {
    recoveries.current = 0;
    pendingReload.current = false;
    sourceSwapped.current = false;
    resumeAt.current = 0;
    setSource(welcomeSource);
    const element = videoRef.current;
    if (!element || element.networkState === HTMLMediaElement.NETWORK_EMPTY) {
      setCrossOrigin(sourceCrossOrigin(welcomeSource, video.fallbackVideoUrl));
    }
  }, [welcomeSource]);

  useEffect(() => () => {
    playAttempt.current += 1;
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
  }, []);

  // The tag is requested once per player, while it opens. It resolves to null on
  // any failure, so a play request can always continue without an ad.
  const ensureAdRequest = () => {
    if (!VAST_TAG || adState.current.status !== "idle") return;
    adState.current.status = "loading";
    adState.current.promise = loadPreRoll(VAST_TAG, {
      timeoutMs: VAST_TIMEOUT_MS,
      skipFallbackSeconds: VAST_SKIP_FALLBACK_SECONDS,
      cachedUrl: VAST_CACHED_AD_URL,
      liveBudgetMs: VAST_LIVE_BUDGET_MS,
    }).then((ad: VastAd | null) => ad, () => null);
  };

  // The tag is only ever requested for a title that may carry one, so a premium
  // click does not even ask the ad server.
  useEffect(() => { if (!premiumTitle) ensureAdRequest(); }, [premiumTitle]);

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

  // Controls stay while paused; while playing they fade after a few seconds of
  // no movement. Nothing here ever touches playback.
  const scheduleControlsHide = () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = null;
    if (!playingRef.current || adPlayingRef.current) return;
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
  };

  const resetControlsTimer = () => {
    setShowControls(true);
    scheduleControlsHide();
  };

  // A click on the picture is for the controls only: it never pauses, because
  // pausing is the pause button's job (and an accidental tap mid-video is
  // exactly what the visitor does not want).
  const toggleControls = () => {
    if (adPlayingRef.current) return;
    controlsToggledAt.current = Date.now();
    setShowControls((visible) => {
      const next = !visible;
      if (next) scheduleControlsHide();
      else if (controlsTimer.current) { clearTimeout(controlsTimer.current); controlsTimer.current = null; }
      return next;
    });
  };

  // A CDN link can be dead, expired or hotlink-blocked. The byte stream behind
  // it is the same video, so one silent switch keeps playback going; the position
  // is kept and playback resumes from metadata without another click. Only one
  // switch is ever made, so a broken pair can never loop.
  //
  // While a locked video is playing its trailer, the byte stream behind it is the
  // *full* video, not the trailer: the backend refuses it without a premium
  // window, so switching there would replace a working trailer with a 403. A
  // trailer that needs recovering is re-asked from the backend instead
  // (`refreshLinks`), using the token the fresh answer carries.
  const swapToFallback = (element: HTMLVideoElement) => {
    if (locked) return false;
    const fallback = video.fallbackVideoUrl;
    if (!fallback || sourceSwapped.current || source === fallback) return false;
    sourceSwapped.current = true;
    resumeAt.current = Number.isFinite(element.currentTime) && element.currentTime > 0 ? element.currentTime : 0;
    recoveries.current = 0;
    setSource(fallback);
    setCrossOrigin(sourceCrossOrigin(fallback, video.fallbackVideoUrl));
    return true;
  };

  // The link this player should play from a fresh answer: a member's full stream
  // when the backend granted one, otherwise the trailer it may offer instead.
  // The same rule as `welcomeSource`, so a refreshed answer can never start playing
  // a full stream this visitor is not allowed to see.
  const sourceFrom = (fresh: Video) => {
    const lockedNow = fresh.locked === true && !fresh.videoUrl?.includes("kind=trailer") && Boolean(fresh.trailerUrl);
    if (lockedNow) return fresh.trailerUrl as string;
    // A locked title whose stream link is missing still has its trailer to play;
    // an empty answer keeps the player on what it already has.
    return fresh.videoUrl || fresh.trailerUrl || "";
  };

  // Install that answer in place of the current one, keeping the position. The
  // element is sitting on the dead link, so it is pointed at the new one directly;
  // the state follows so React does not pull it back.
  const installFresh = (fresh: Video, resume: number) => {
    const nextSource = sourceFrom(fresh);
    if (!nextSource) return false;
    resumeAt.current = resume;
    recoveries.current = 0;
    refreshedPlay.current = true;
    setRefreshedVideo(fresh);
    setSource(nextSource);
    setCrossOrigin(sourceCrossOrigin(nextSource, fresh.fallbackVideoUrl));
    if (elementRef.current) {
      elementRef.current.src = nextSource;
      elementRef.current.load();
    }
    return true;
  };

  // A token that expired is not an error the visitor should act on: the app asks
  // the backend for this video again, and if the answer carries a new link the
  // player swaps to it once, from the same position.
  //
  // One read at a time: an expiry that arrives while the backend is already
  // answering is covered by that answer (`return true`), never turned into a second
  // request and never into an error the visitor has to clear.
  //
  // A budget bounds the automatic re-issues, so a backend that keeps handing back a
  // dead link cannot become a request loop: after three of them the honest "Try
  // again" is shown, and that button asks once more and refills the budget. No timer
  // is ever put on a link — this only counts answers the backend actually gave.
  const refreshBudget = useRef(LINK_REFRESH_BUDGET);
  const refreshLinks = (element: HTMLVideoElement) => {
    if (!onRefreshVideo) return false;
    if (refreshBudget.current <= 0) return false;
    if (refreshed.current) return true;
    refreshBudget.current -= 1;
    refreshed.current = true;
    const resume = Number.isFinite(element.currentTime) && element.currentTime > 0 ? element.currentTime : 0;
    setPlaybackError("");
    setBuffering(true);
    const settle = (fresh: Video | null) => {
      if (fresh && installFresh(fresh, resume)) {
        // A fresh token means the next expiry is a new event, not a loop.
        window.setTimeout(() => { refreshed.current = false; }, 1_000);
        return;
      }
      // Nothing new arrived: keep what is already loaded rather than refusing it.
      refreshed.current = false;
      setBuffering(false);
      setPlaybackError(LINK_EXPIRED);
    };
    void onRefreshVideo(video).then(settle).catch(() => settle(null));
    return true;
  };

  // The recovery is exactly what the "Try again" button does — load(), then play
  // — only without making the visitor press it. A media element leaves its error
  // state in no other way, so this is the whole fix for a request that was cut
  // while the pre-roll (or anything else) was using the network.
  const recoverContent = (v: HTMLVideoElement, automatic: boolean) => {
    if (!shouldAutoRecover({ code: v.error?.code ?? 0, recoveries: recoveries.current })) return false;
    recoveries.current += 1;
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (videoRef.current !== v) return;
      v.load();
      if (wantsPlay.current) playContent(v, automatic, ++playAttempt.current);
    }, RECOVERY_DELAY_MS);
    return true;
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
      if (blocked) { setPlaybackError("Playback was blocked. Please try again."); return; }
      // An element in the error state rejects play() until it is reloaded.
      if (recoverContent(v, automatic)) return;
      setPlaybackError(playbackFailureMessage({ code: v.error?.code ?? 0 }));
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
    wantsPlay.current = true;
    const attempt = ++playAttempt.current;
    // No pre-roll for a premium title: playback starts on the click, with the
    // trailer when the backend gave one.
    if (premiumTitle) {
      playContent(v, automatic, attempt);
      return;
    }
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
    adPlayingRef.current = false;
    adState.current.status = "done";
    const v = videoRef.current;
    if (!v) return;
    // The content request is usually cut while the ad plays, so the element is
    // in its error state by now. One reload brings it back with whatever the
    // browser already buffered, and playback starts on its own.
    if (pendingReload.current || v.error) {
      pendingReload.current = false;
      v.load();
    }
    playContent(v, false, ++playAttempt.current);
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
      wantsPlay.current = false;
      v.pause();
    } else {
      startPlayback(v);
    }
    resetControlsTimer();
  };

  const retryPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    // An expired link is re-issued first: the button asks for a fresh one instead
    // of reloading a token the server has already stopped honouring.
    if (playbackErrorRef.current === LINK_EXPIRED) {
      refreshed.current = false;
      refreshBudget.current = LINK_REFRESH_BUDGET;
      if (refreshLinks(v)) return;
    }
    // Reload only after a media error. For a blocked play request, retain any
    // data already buffered instead of starting a second download.
    recoveries.current = 0;
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

  // Dragging the bar scrubs, like a native player: the pointer is captured on
  // press, so a finger that slides off the thin bar keeps seeking instead of
  // stopping. A tap is the same gesture without movement.
  const dragging = useRef(false);

  const seekFromPointer = (clientX: number) => {
    const v = videoRef.current;
    const rect = progressRef.current?.getBoundingClientRect();
    if (!v || !rect?.width || !duration) return;
    const at = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
    v.currentTime = at;
    setCurrentTime(at);
  };

  const startScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    e.preventDefault();
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older Safari */ }
    seekFromPointer(e.clientX);
    resetControlsTimer();
  };

  const moveScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    seekFromPointer(e.clientX);
  };

  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    seekFromPointer(e.clientX);
    resetControlsTimer();
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

  // Fullscreen is read from the document, not from this component's state, so
  // leaving with the phone's back gesture (or Esc) counts the same as pressing
  // the button, and the orientation lock is released either way.
  const toggleFullscreen = async () => {
    resetControlsTimer();
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* already left */ }
      unlockOrientation();
      return;
    }
    const container = document.getElementById("player-container");
    try {
      await container?.requestFullscreen({ navigationUI: "hide" });
    } catch { /* iOS keeps the inline player */ }
    lockLandscape();
  };

  // The browser is the authority on fullscreen: Esc, the system back gesture or
  // the button all land here, so the icon and the orientation lock stay in step.
  useEffect(() => {
    const sync = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreen(active);
      if (!active) unlockOrientation();
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      unlockOrientation();
    };
  }, []);

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
          onMouseMove={() => { if (Date.now() - controlsToggledAt.current > 250) resetControlsTimer(); }}
          onMouseLeave={() => { if (playing && !adPlaying) setShowControls(false); }}
        >
          {lockedBlocked ? (
            // The backend sent no stream and no trailer for this title, so there is
            // nothing to play. It says so instead of showing a broken player.
            <div className="video-player__gate absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <img src={video.thumbnail} alt="" className="absolute inset-0 w-full h-full object-contain opacity-30" />
              <p className="relative text-white font-bold">{video.title}</p>
              <p className="relative text-white font-semibold">Premium video · sirf premium members ke liye</p>
              <p className="relative text-gray-300 text-sm">Sign in karke premium activate karo — uske baad yahi video full chalegi.</p>
              <p className="relative text-gray-500 text-xs">Filhaal is video ka trailer bhi available nahi hai.</p>
            </div>
          ) : (
          <video
            ref={(node) => { videoRef.current = node; elementRef.current = node; }}
            src={source}
            poster={video.thumbnail}
            crossOrigin={crossOrigin}
            preload={preload}
            playsInline
            className="w-full h-full object-contain"
            onClick={toggleControls}
            onPlay={() => { playingRef.current = true; setPlaying(true); setPlaybackError(""); scheduleControlsHide(); }}
            onPlaying={() => { playingRef.current = true; setPlaying(true); setBuffering(false); setPlaybackError(""); }}
            onCanPlay={(e) => { if (!e.currentTarget.paused) setBuffering(false); }}
            onWaiting={(e) => { if (!e.currentTarget.paused && !e.currentTarget.ended) setBuffering(true); }}
            onStalled={(e) => { if (!e.currentTarget.paused && e.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) setBuffering(true); }}
            onPause={() => { playingRef.current = false; playAttempt.current += 1; setPlaying(false); setBuffering(false); setShowControls(true); }}
            onEnded={() => { playingRef.current = false; setPlaying(false); setBuffering(false); setShowControls(true); }}
            onError={(e) => {
              playAttempt.current += 1;
              setPlaying(false);
              setBuffering(false);
              setShowControls(true);
              const element = e.currentTarget;
              const code = element.error?.code ?? 0;
              // Nothing is shown while the pre-roll is on screen: its own media
              // element is what interrupted this request, and the reload below
              // happens the moment the ad ends.
              if (adPlayingRef.current) {
                pendingReload.current = true;
                return;
              }
              // A failed CDN source is answered by the byte stream first; the
              // ordinary reload only runs when there is nothing to switch to.
              if (swapToFallback(element)) return;
              // Both the stream and the trailer link carry a short-lived token.
              // The backend issues a fresh one for this visitor; the player asks
              // for it once, on its own, and keeps the position.
              if (locked || tokenisedLink(source) || refusalSeen(element, source)) {
                if (refreshLinks(element)) return;
                setPlaybackError(LINK_EXPIRED);
                return;
              }
              if (recoverContent(element, false)) return;
              setPlaybackError(playbackFailureMessage({ code }));
            }}
            onTimeUpdate={(e) => setCurrentTime(Number.isFinite(e.currentTarget.currentTime) ? e.currentTarget.currentTime : 0)}
            onLoadedMetadata={(e) => {
              const element = e.currentTarget;
              updateDuration(element);
              // After a CDN → bytes switch: keep the position and, when the
              // visitor was already watching, continue without a second click.
              if (resumeAt.current > 0) {
                const at = resumeAt.current;
                resumeAt.current = 0;
                try { element.currentTime = at; } catch { /* Start from the beginning instead. */ }
              }
              if (sourceSwapped.current && wantsPlay.current && element.paused) {
                playContent(element, false, ++playAttempt.current);
              }
              // A re-issued link (the old token expired) starts on its own from
              // where the visitor was; if the browser insists on a gesture, the
              // play button is already on screen.
              if (refreshedPlay.current && element.paused) {
                refreshedPlay.current = false;
                playContent(element, false, ++playAttempt.current);
              }
            }}
            onDurationChange={(e) => updateDuration(e.currentTarget)}
            onProgress={(e) => updateBuffered(e.currentTarget)}
            onSeeked={(e) => updateBuffered(e.currentTarget)}
          />
          )}

          {trailerOnly && (
            <>
              {/* The server sent a trailer, so that is what is playing and the note
                  says exactly that. The full video is unlocked by the account, not
                  by anything this player can do. */}
              <p className="video-player__trailer-note absolute bottom-16 left-4 z-10 rounded-full bg-black/75 px-3 py-1 text-xs text-gray-200">
                Trailer · full video premium members ke liye
              </p>
              {premiumTitle && (
                <p className="video-player__premium-note absolute top-3 left-3 z-10 max-w-[16rem] rounded-lg bg-black/80 px-3 py-2 text-[11px] leading-snug text-gray-200">
                  Abhi trailer chal raha hai. Sign in karke premium activate karo — phir yahi video full chalegi.
                </p>
              )}
            </>
          )}
          {adPlaying && <VideoAdOverlay ad={adPlaying} onFinish={finishAd} onClose={onClose} />}

          {/* The poster and native preload are used only for the selected video. */}
          {!lockedBlocked && !adPlaying && !playing && !playbackError && (
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

          {/* Top controls — only when there is something to control. Behind the
              sign-in gate the message is the only thing on screen. */}
          {!lockedBlocked && (
          <div
            className={`video-player__top absolute top-0 left-0 right-0 p-4 flex items-center justify-between transition-all duration-300 ${adPlaying || !showControls ? "opacity-0 pointer-events-none" : "opacity-100"}`}
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
          )}

          {/* Bottom controls */}
          {!lockedBlocked && (
          <div
            data-controls={adPlaying || !showControls ? "hidden" : "visible"}
            className={`absolute bottom-0 left-0 right-0 transition-all duration-300 ${adPlaying || !showControls ? "opacity-0 pointer-events-none" : "opacity-100"}`}
            style={{ background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)" }}
          >
            {/* Progress bar — the grab strip is 24px tall so a finger can take
                it while the visible bar stays thin. Dragging it scrubs. */}
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
              className="mx-4 mt-2 flex h-6 items-center cursor-pointer touch-none group/progress focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-400"
              style={{ touchAction: "none" }}
              onPointerDown={startScrub}
              onPointerMove={moveScrub}
              onPointerUp={endScrub}
              onPointerCancel={endScrub}
              onKeyDown={handleProgressKeyDown}
            >
              <div className="relative h-1.5 w-full rounded-full bg-gray-700">
                {/* Seeking can create disjoint buffered ranges. */}
                {buffered.map((range, index) => (
                  <div key={index} className="video-player__buffered-range absolute inset-y-0 bg-gray-500 rounded-full" style={{ left: `${range.start}%`, width: `${range.end - range.start}%` }} />
                ))}
                {/* Progress */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${progress}%`, background: "linear-gradient(to right, #c9a84c, #f0d080)" }}
                />
                {/* Thumb: shown while hovering, always while dragging. */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-yellow-400 bg-white opacity-0 group-hover/progress:opacity-100 group-active/progress:opacity-100 transition"
                  style={{ left: `calc(${progress}% - 8px)` }}
                />
              </div>
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
          )}
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
