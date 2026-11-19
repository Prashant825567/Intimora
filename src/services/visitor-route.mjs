import { publicBackendBase, publicHttpsUrl } from "./public-url.mjs";

const STORAGE_KEY = "intimora_direct_backend_v1";
const MAX_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const UNAVAILABLE = "Content is temporarily unavailable";
const ROUTE = /^\/api\/(?:search|likes\/counts|visit|videos(?:\/[A-Za-z0-9_-]{1,128}(?:\/share)?)?)$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LIKE_COUNTS_BYTES = 32_768;

function isReloadOrHistoryNavigation() {
  try {
    const entry = globalThis.performance?.getEntriesByType("navigation")?.[0];
    return entry?.type === "reload" || entry?.type === "back_forward";
  } catch {
    return false;
  }
}

function apiUrl(base, path, method, body) {
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const route = new URL(path, "https://route.invalid");
    if (route.origin !== "https://route.invalid" || route.hash || !ROUTE.test(route.pathname)) return null;
    // Only two routes post: a share action and the visitor log. Everything else
    // is a read, so a stray POST can never reach the backend.
    const action = /\/share$/.test(route.pathname);
    const visit = route.pathname === "/api/visit";
    if (action && method !== "POST") return null;
    if (visit && method !== "POST") return null;
    if (!action && !visit && method !== "GET") return null;
    const allowedParams = route.pathname === "/api/videos" ? ["cursor", "limit"]
      : route.pathname === "/api/search" ? ["q"]
        : route.pathname === "/api/likes/counts" ? ["ids"] : [];
    for (const key of route.searchParams.keys()) {
      if (!allowedParams.includes(key) || route.searchParams.getAll(key).length !== 1) return null;
    }
    if (route.pathname === "/api/search" && (route.searchParams.get("q") || "").length > 200) return null;
    if (route.pathname === "/api/likes/counts") {
      const ids = (route.searchParams.get("ids") || "").split(",");
      if (ids.length > 20 || ids.some((id) => !VIDEO_ID.test(id)) || new Set(ids).size !== ids.length) return null;
    }
    if (visit && typeof body !== "string") return null;
    if (visit && (body.length > 2048 || route.search !== "")) return null;
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
  // Temporary testing mode: one fixed PHP origin instead of discovery. The
  // browser then calls that host directly, with cookies, so the one-time unlock
  // navigation can hand it the session cookie its own check issues.
  const backendOverride = publicBackendBase(options.backendOverride);
  // Called when a direct call hits the host's HTML check. Returns true when the
  // browser was sent to the unlock page and this request should stop waiting.
  const requestUnlock = typeof options.requestUnlock === "function" ? options.requestUnlock : null;
  // Told whenever the visitor's target is (re)selected, so media and the unlock
  // flow know whether this backend is the kind behind a browser check.
  const onTarget = typeof options.onTarget === "function" ? options.onTarget : null;
  // Told when a PHP answer actually arrived, which is the proof its session
  // cookie works — from then on the window needs no new unlock.
  const onPhpSuccess = typeof options.onPhpSuccess === "function" ? options.onPhpSuccess : null;
  // Told how every direct call ended, so a failure can name its own reason
  // (the host's check page, a blocked request, an error status) instead of a
  // generic message.
  const onOutcome = typeof options.onOutcome === "function" ? options.onOutcome : null;
  // A pinned origin is treated as PHP, because that is what it is used for.
  const pinnedPhp = Boolean(backendOverride);
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
            cached = { backend, php: entry.php === true, selectedAt: entry.selectedAt, expiresAt: entry.expiresAt };
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

  function save(backend, selectedAt, php = false) {
    const timestamp = now();
    const expiresAt = selectedAt + MAX_TTL_MS;
    if (!Number.isFinite(timestamp) || timestamp < selectedAt || timestamp >= expiresAt) throw new Error(UNAVAILABLE);
    cached = { backend, php: php === true, selectedAt, expiresAt };
    monotonicDeadline = monotonicNow() + (expiresAt - timestamp);
    generation += 1;
    try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify(cached)); } catch { /* In-memory selection still works. */ }
  }

  async function readJson(url, method, { signal, counts = false, php = false, requestBody } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, counts ? 8_000 : REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        method,
        // `text/plain` is a "simple" content type, so a POST is sent without a
        // preflight. A preflight carries no cookies, and a free host answers one
        // without cookies with its HTML check instead of JSON.
        ...(method === "POST"
          ? { headers: { "Content-Type": "text/plain" }, body: typeof requestBody === "string" ? requestBody : "{}" }
          : {}),
        mode: "cors",
        // Cookies travel only to a backend the load balancer flagged as PHP; an
        // ordinary backend stays credential-free exactly as before.
        credentials: php ? "include" : "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        // A PHP host may answer with a redirect of its own (to the check page or
        // a canonical path); following it is what a browser navigation does.
        // An ordinary backend keeps its stricter behaviour.
        redirect: php ? "follow" : "error",
        signal: controller.signal,
      });
      // The free host's browser check answers with an HTML page instead of JSON;
      // that is what the unlock flow is for.
      const contentType = response.headers.get("content-type") || "";
      const challenge = contentType.toLowerCase().includes("text/html");
      if (!response.ok) return { failed: true, invalidate: response.status >= 500, challenge, status: response.status };
      if (challenge) return { failed: true, invalidate: false, challenge: true, status: response.status };
      let body;
      if (counts) {
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > MAX_LIKE_COUNTS_BYTES) throw new Error(UNAVAILABLE);
        const reader = response.body?.getReader();
        if (!reader) {
          const text = await response.text();
          if (text.length > MAX_LIKE_COUNTS_BYTES) throw new Error(UNAVAILABLE);
          body = JSON.parse(text);
        } else {
          const decoder = new TextDecoder();
          let text = "";
          let bytes = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > MAX_LIKE_COUNTS_BYTES) throw new Error(UNAVAILABLE);
              text += decoder.decode(part.value, { stream: true });
            }
            body = JSON.parse(text + decoder.decode());
          } finally {
            reader.releaseLock();
          }
        }
      } else body = await response.json();
      if (!body || body.ok !== true) return { failed: true, invalidate: true, status: response.status };
      return { body };
    } catch {
      controller.abort();
      // A CORS rejection, a refused connection and a redirect all look like
      // this. On a PHP host the browser's own unlock page is the only thing that
      // can hand out the cookie, so that is what the caller is told next.
      return { failed: true, invalidate: true, network: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function announce(target) {
    if (onTarget) onTarget(target);
    return target;
  }

  // The load balancer decides the transport: `php: true` means the server hides
  // its API behind a cookie-based browser check, so only that case sends
  // credentials and may ask for the one-time unlock navigation. There is no
  // proxy: the browser calls that host itself.
  async function selectTarget() {
    // A pinned origin skips discovery entirely (and never caches a selection).
    if (backendOverride) return announce({ backend: backendOverride, php: pinnedPhp });
    const selection = current();
    if (selection) return announce({ backend: selection.backend, php: selection.php === true });
    if (bootstrap) return announce(await bootstrap);
    if (!discoveryUrl) throw new Error(UNAVAILABLE);

    const selectedAt = now();
    const startedGeneration = generation;
    const request = (async () => {
      const result = await readJson(discoveryUrl, "GET");
      const backend = publicBackendBase(result.body?.data?.server);
      const php = result.body?.data?.php === true;
      if (result.failed || !backend || !Number.isFinite(selectedAt)) throw new Error(UNAVAILABLE);
      if (generation !== startedGeneration) {
        const latest = current();
        if (latest) return { backend: latest.backend, php: latest.php === true };
        throw new Error(UNAVAILABLE);
      }
      save(backend, selectedAt, php);
      return { backend, php };
    })();
    bootstrap = request;
    try { return announce(await request); }
    finally { if (bootstrap === request) bootstrap = undefined; }
  }

  async function selectBackend() {
    return (await selectTarget()).backend;
  }

  // Resolves the transport for one request: the visitor's target, or a backend
  // pinned with a video so its playback and actions keep working after a switch.
  async function resolveTarget(pinnedBackend) {
    if (pinnedBackend === undefined) return selectTarget();
    const backend = publicBackendBase(pinnedBackend);
    if (!backend) throw new Error(UNAVAILABLE);
    const selection = current();
    const php = pinnedPhp || (selection?.backend === backend && selection.php === true);
    // Refresh the visitor's expired selection independently, but do not make an
    // existing video's playback or actions depend on discovery succeeding.
    if (!current()) void selectTarget().catch(() => {});
    return { backend, php };
  }

  async function requestJson(path, init = {}, pinnedBackend) {
    const method = init.method || "GET";
    const target = await resolveTarget(pinnedBackend);
    const backend = target.backend;
    const php = target.php;
    const body = typeof init.body === "string" ? init.body : undefined;
    const url = apiUrl(backend, path, method, body);
    if (!url) throw new Error(UNAVAILABLE);
    const requestGeneration = generation;
    const counts = new URL(path, "https://route.invalid").pathname === "/api/likes/counts";
    const result = await readJson(url, method, { signal: init.signal, counts, php, requestBody: body });
    if (onOutcome) {
      onOutcome({
        path,
        php,
        ok: !result.failed,
        challenge: Boolean(result.challenge),
        blocked: Boolean(result.network),
        status: result.status,
      });
    }
    if (result.failed) {
      // Optional count polling must not disrupt catalog routing. A stale
      // response for an older backend must not erase a newer selection either.
      if (!counts && result.invalidate && generation === requestGeneration && cached?.backend === backend) clear();
      // PHP mode: the host answered with its own HTML check, or the call never
      // left the browser. Send the visitor through the host's own unlock page
      // once (no proxy in between); the request stops here because the page is
      // about to leave.
      if (!counts && php && requestUnlock && (result.challenge || result.network)) {
        if (requestUnlock({ path, challenge: Boolean(result.challenge) })) throw new Error(UNAVAILABLE);
      }
      throw new Error(UNAVAILABLE);
    }
    if (php && onPhpSuccess) onPhpSuccess();
    return {
      body: result.body,
      backend,
      invalidate() {
        if (generation === requestGeneration && cached?.backend === backend) clear();
      },
    };
  }

  return { selectBackend, selectTarget, resolveTarget, requestJson };
}
