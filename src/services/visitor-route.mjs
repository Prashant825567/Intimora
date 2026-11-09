import { publicBackendBase, publicHttpsUrl } from "./public-url.mjs";

const STORAGE_KEY = "intimora_direct_backend_v1";
const MAX_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const UNAVAILABLE = "Content is temporarily unavailable";
const ROUTE = /^\/api\/(?:search|videos(?:\/[A-Za-z0-9_-]{1,128}(?:\/share)?)?)$/;

function isReloadOrHistoryNavigation() {
  try {
    const entry = globalThis.performance?.getEntriesByType("navigation")?.[0];
    return entry?.type === "reload" || entry?.type === "back_forward";
  } catch {
    return false;
  }
}

function apiUrl(base, path, method) {
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const route = new URL(path, "https://route.invalid");
    if (route.origin !== "https://route.invalid" || route.hash || !ROUTE.test(route.pathname)) return null;
    const action = /\/share$/.test(route.pathname);
    if ((action && method !== "POST") || (!action && method !== "GET")) return null;
    const allowedParams = route.pathname === "/api/videos" ? ["cursor", "limit"]
      : route.pathname === "/api/search" ? ["q"] : [];
    for (const key of route.searchParams.keys()) {
      if (!allowedParams.includes(key) || route.searchParams.getAll(key).length !== 1) return null;
    }
    if (route.pathname === "/api/search" && (route.searchParams.get("q") || "").length > 200) return null;
    if (route.pathname === "/api/videos") {
      if ((route.searchParams.get("cursor") || "").length > 1024) return null;
      const limit = route.searchParams.get("limit");
      if (limit !== null && (!/^(?:[1-9]|[1-4]\d|50)$/.test(limit))) return null;
    }
    return `${base}${route.pathname}${route.search}`;
  } catch {
    return null;
  }
}

// Every tab keeps its own selection. The cache is an optimization, not an
// identity or an authorization mechanism. New navigations do not restore a
// copied sessionStorage entry; a reload can reuse this tab's unexpired entry.
export function createVisitorRequest(options = {}) {
  const discoveryUrl = publicHttpsUrl(options.discoveryUrl);
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => globalThis.performance?.now?.() ?? now());
  const getStorage = options.storage === undefined
    ? () => { try { return globalThis.sessionStorage; } catch { return null; } }
    : () => options.storage;
  const reuseStoredSelection = options.reuseStoredSelection ?? isReloadOrHistoryNavigation();
  let cached;
  let monotonicDeadline = 0;
  let loaded = false;
  let bootstrap;
  let generation = 0;

  function clear() {
    generation += 1;
    cached = undefined;
    monotonicDeadline = 0;
    try { getStorage()?.removeItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
  }

  function current() {
    if (!loaded) {
      loaded = true;
      if (reuseStoredSelection) {
        try {
          const entry = JSON.parse(getStorage()?.getItem(STORAGE_KEY) || "null");
          const backend = publicBackendBase(entry?.backend);
          const timestamp = now();
          if (backend && backend === entry.backend && Number.isFinite(entry.selectedAt)
            && Number.isFinite(entry.expiresAt) && entry.selectedAt <= timestamp
            && entry.expiresAt <= entry.selectedAt + MAX_TTL_MS && entry.expiresAt > timestamp) {
            cached = { backend, selectedAt: entry.selectedAt, expiresAt: entry.expiresAt };
            monotonicDeadline = monotonicNow() + Math.min(entry.expiresAt - timestamp, MAX_TTL_MS);
          }
        } catch { /* Keep an in-memory cache when storage is unavailable. */ }
      } else {
        // sessionStorage may have been copied from an opener or duplicated tab.
        try { getStorage()?.removeItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
      }
    }
    if (cached && (now() < cached.selectedAt || now() >= cached.expiresAt || monotonicNow() >= monotonicDeadline)) clear();
    return cached;
  }

  function save(backend, selectedAt) {
    const timestamp = now();
    const expiresAt = selectedAt + MAX_TTL_MS;
    if (!Number.isFinite(timestamp) || timestamp < selectedAt || timestamp >= expiresAt) throw new Error(UNAVAILABLE);
    cached = { backend, selectedAt, expiresAt };
    monotonicDeadline = monotonicNow() + (expiresAt - timestamp);
    generation += 1;
    try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify(cached)); } catch { /* In-memory selection still works. */ }
  }

  async function readJson(url, method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        method,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return { failed: true, invalidate: response.status >= 500 };
      const body = await response.json();
      if (!body || body.ok !== true) return { failed: true, invalidate: true };
      return { body };
    } catch {
      return { failed: true, invalidate: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function selectBackend() {
    const selection = current();
    if (selection) return selection.backend;
    if (bootstrap) return bootstrap;
    if (!discoveryUrl) throw new Error(UNAVAILABLE);

    const selectedAt = now();
    const startedGeneration = generation;
    const request = (async () => {
      const result = await readJson(discoveryUrl, "GET");
      const backend = publicBackendBase(result.body?.data?.server);
      if (result.failed || !backend || !Number.isFinite(selectedAt)) throw new Error(UNAVAILABLE);
      if (generation !== startedGeneration) {
        const latest = current();
        if (latest) return latest.backend;
        throw new Error(UNAVAILABLE);
      }
      save(backend, selectedAt);
      return backend;
    })();
    bootstrap = request;
    try { return await request; }
    finally { if (bootstrap === request) bootstrap = undefined; }
  }

  async function requestJson(path, init = {}, pinnedBackend) {
    const method = init.method || "GET";
    let backend;
    if (pinnedBackend !== undefined) {
      backend = publicBackendBase(pinnedBackend);
      if (!backend) throw new Error(UNAVAILABLE);
      // Refresh the visitor's expired selection independently, but do not make
      // an existing video's playback or actions depend on discovery succeeding.
      if (!current()) void selectBackend().catch(() => {});
    } else {
      backend = await selectBackend();
    }
    const url = apiUrl(backend, path, method);
    if (!url) throw new Error(UNAVAILABLE);
    const requestGeneration = generation;
    const result = await readJson(url, method);
    if (result.failed) {
      // A stale response for an older backend must not erase a newer selection.
      if (result.invalidate && generation === requestGeneration && cached?.backend === backend) clear();
      throw new Error(UNAVAILABLE);
    }
    return {
      body: result.body,
      backend,
      invalidate() {
        if (generation === requestGeneration && cached?.backend === backend) clear();
      },
    };
  }

  return { selectBackend, requestJson };
}
