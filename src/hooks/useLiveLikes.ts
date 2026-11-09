import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Video } from "../data/mockVideos";
import { fetchLikeCounts } from "../services/api";
import { LIKE_COUNT_BATCH_SIZE, likeCountKey, mergeLikeCounts } from "../services/like-counts.mjs";
import type { LikeCount } from "../services/like-counts.mjs";

type Target = { id: string; backendBase: string };
type VisibleTarget = Target & { references: number };
type Observed = { target: Target; visible: boolean };

const POLL_INTERVAL_MS = 5_000;
const MAX_TARGETS_PER_POLL = 80;

/** Public counts only. Identity and Firebase tokens are never used here. */
export function useLiveLikes(enabled: boolean, activeVideo: Video | null) {
  const [counts, setCounts] = useState<Map<string, LikeCount>>(() => new Map());
  const [visible, setVisible] = useState<Map<string, VisibleTarget>>(() => new Map());
  const observer = useRef<IntersectionObserver | null>(null);
  const elements = useRef(new Map<Element, Observed>());
  const rotation = useRef(0);

  const setVisibility = useCallback((entry: Observed, isVisible: boolean) => {
    if (entry.visible === isVisible) return;
    entry.visible = isVisible;
    const key = likeCountKey(entry.target.backendBase, entry.target.id);
    setVisible((previous) => {
      const current = previous.get(key);
      if (!isVisible && !current) return previous;
      const next = new Map(previous);
      const references = (current?.references ?? 0) + (isVisible ? 1 : -1);
      if (references <= 0) next.delete(key);
      else next.set(key, { ...entry.target, references });
      return next;
    });
  }, []);

  // A single observer tracks on-screen cards. Duplicate cards for one video
  // share one request; the player is included separately while open.
  const observe = useCallback((element: Element, video: Video) => {
    if (!enabled || !video.backendBase) return () => {};
    const entry: Observed = { target: { id: video.id, backendBase: video.backendBase }, visible: false };
    elements.current.set(element, entry);
    if (typeof IntersectionObserver === "undefined") {
      setVisibility(entry, true);
    } else {
      if (!observer.current) {
        observer.current = new IntersectionObserver((changes) => {
          for (const change of changes) {
            const target = elements.current.get(change.target);
            if (target) setVisibility(target, change.isIntersecting);
          }
        }, { rootMargin: "100px" });
      }
      observer.current.observe(element);
    }
    return () => {
      observer.current?.unobserve(element);
      elements.current.delete(element);
      setVisibility(entry, false);
    };
  }, [enabled, setVisibility]);

  useEffect(() => () => { observer.current?.disconnect(); elements.current.clear(); }, []);

  const targets = useMemo(() => {
    const items = new Map<string, Target>();
    if (activeVideo?.backendBase) {
      items.set(likeCountKey(activeVideo.backendBase, activeVideo.id), { id: activeVideo.id, backendBase: activeVideo.backendBase });
    }
    for (const entry of visible.values()) items.set(likeCountKey(entry.backendBase, entry.id), entry);
    return [...items.values()];
  }, [visible, activeVideo?.id, activeVideo?.backendBase]);
  const targetKey = targets.map((target) => likeCountKey(target.backendBase, target.id)).join("\n");
  const activeKey = activeVideo?.backendBase ? likeCountKey(activeVideo.backendBase, activeVideo.id) : null;

  useEffect(() => {
    if (!enabled || !targets.length) return;
    let stopped = false;
    let running = false;
    let wake = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      if (stopped || running || document.visibilityState !== "visible") return;
      running = true;
      controller = new AbortController();
      let failed = false;
      try {
        const active = activeKey ? targets.find((target) => likeCountKey(target.backendBase, target.id) === activeKey) : undefined;
        const others = active ? targets.filter((target) => likeCountKey(target.backendBase, target.id) !== activeKey) : targets;
        const count = Math.min(others.length, MAX_TARGETS_PER_POLL - (active ? 1 : 0));
        const start = others.length > count ? rotation.current % others.length : 0;
        const selected = Array.from({ length: count }, (_, index) => others[(start + index) % others.length]);
        if (active) selected.unshift(active);
        if (others.length > count) rotation.current = (start + count) % others.length;
        const groups = new Map<string, string[]>();
        for (const target of selected) {
          const ids = groups.get(target.backendBase) ?? [];
          ids.push(target.id);
          groups.set(target.backendBase, ids);
        }
        for (const [backend, ids] of groups) {
          for (let index = 0; index < ids.length; index += LIKE_COUNT_BATCH_SIZE) {
            if (stopped || controller.signal.aborted) return;
            try {
              const result = await fetchLikeCounts(ids.slice(index, index + LIKE_COUNT_BATCH_SIZE), backend, controller.signal);
              if (!stopped && !controller.signal.aborted) setCounts((previous) => mergeLikeCounts(previous, backend, result));
            } catch {
              if (controller.signal.aborted) return;
              failed = true;
            }
          }
        }
      } finally {
        running = false;
        if (!stopped && document.visibilityState === "visible") {
          failures = failed ? Math.min(failures + 1, 4) : 0;
          const delay = wake ? 0 : Math.min(60_000, POLL_INTERVAL_MS * 2 ** failures);
          wake = false;
          schedule(delay);
        }
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") controller?.abort();
      else if (running) wake = true;
      else schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(200); // Coalesce card intersections during scrolling.
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, targetKey, activeKey]);

  const record = useCallback((video: Video, count: LikeCount) => {
    if (!video.backendBase || count.id !== video.id) return;
    setCounts((previous) => mergeLikeCounts(previous, video.backendBase!, [count]));
  }, []);

  const withCount = useCallback((video: Video) => {
    const value = video.backendBase ? counts.get(likeCountKey(video.backendBase, video.id)) : undefined;
    return value && value.likes !== video.likes ? { ...video, likes: value.likes } : video;
  }, [counts]);

  return { observe, record, withCount };
}

export type LiveLikes = ReturnType<typeof useLiveLikes>;
