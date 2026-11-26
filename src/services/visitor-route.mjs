import { publicBackendBase, publicHttpsUrl } from "./public-url.mjs";

const REQUEST_TIMEOUT_MS = 20_000;
const UNAVAILABLE = "Content is temporarily unavailable";
const ROUTE = /^\/api\/(?:search|likes\/counts|visit|videos(?:\/[A-Za-z0-9_-]{1,128}(?:\/share)?)?)$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LIKE_COUNTS_BYTES = 32_768;

// The one header a public read may carry: a bearer token, so the backend can
// answer for this visitor. Anything else (`Cookie`, `Authorization: Basic …`, a
// password) is dropped rather than forwarded.
function forwardedHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const value = headers.Authorization ?? headers.authorization;
  if (typeof value !== "string") return undefined;
  if (!/^Bearer [A-Za-z0-9._~+/=-]{1,8192}$/.test(value)) return undefined;
  return { Authorization: value };
}

// The visitor's own arrival does not change which server is theirs: a reload, a
// new tab and a later visit all reuse the stored selection. The navigation type is
// kept as a diagnostic only, so a fresh discovery can be asked for deliberately.
export function isReloadOrHistoryNavigation() {
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
    // `viewer` is the short-lived signed token that lets a premium answer be
    // shaped for this account; it is scoped to the video reads only.
    const videoDetail = /^\/api\/videos\/[A-Za-z0-9_-]{1,128}$/.test(route.pathname);
    const allowedParams = route.pathname === "/api/videos" ? ["cursor", "limit", "viewer"]
      : route.pathname === "/api/search" ? ["q", "viewer"]
        : videoDetail ? ["viewer"]
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

// One page load is one entry. The server the load balancer names belongs to this
// page load and to nothing else: every request it makes — catalogue, media,
// actions — goes to that one server, and no part of the answer is stored (no
// sessionStorage, no localStorage, no cookie of ours). A refresh is a new entry
// and asks the load balancer again, which is also what keeps a click inside the
// page from silently moving the visitor to a different server.
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
  // The selection lives in this closure for the life of the page load only.
  let cached;
  let bootstrap;
  let generation = 0;
  // The backend that has already refused this tab's bearer token, so it is not
  // offered again there (see `requestJson`).
  let tokenRejectedFor;

  function clear() {
    generation += 1;
    cached = undefined;
  }

  function current() {
    return cached;
  }

  function save(backend, php = false) {
    cached = { backend, php: php === true };
    generation += 1;
  }

  // A CORS refusal and a dead connection look identical to `fetch`: both throw.
  // They are very different problems though — one is fixed by the host's cookie
  // page, the other can only be fixed on the host's server. A `no-cors` probe
  // tells them apart: it resolves when the host answered at all, and rejects
  // only when nothing came back.
  async function answeredAtAll(url) {
    try {
      await fetcher(url, { mode: "no-cors", credentials: "omit", redirect: "follow", cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }

  async function readJson(url, method, { signal, counts = false, php = false, requestBody, headers: extraHeaders } = {}) {
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
          ? { headers: { "Content-Type": "text/plain", ...(extraHeaders || {}) }, body: typeof requestBody === "string" ? requestBody : "{}" }
          : (extraHeaders ? { headers: extraHeaders } : {})),
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
      // A 401/403 is the host refusing this visitor's request itself (a WAF rule, a
      // host-level block, a rate limit). Retrying the same call on the same backend
      // cannot help, so the caller is told the reason and can try another one. A
      // 404 is passed through the same way: the id is simply not there.
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { failed: true, invalidate: false, challenge, status: response.status, refused: true };
      }
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
      // can hand out the cookie — but only when the host actually received the
      // request. A refused answer (missing Access-Control-Allow-Origin) is
      // reported as such and never turns into an unlock redirect.
      const cors = php ? await answeredAtAll(url) : false;
      return { failed: true, invalidate: true, network: true, cors };
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

    const startedGeneration = generation;
    const request = (async () => {
      const result = await readJson(discoveryUrl, "GET");
      const backend = publicBackendBase(result.body?.data?.server);
      const php = result.body?.data?.php === true;
      if (result.failed || !backend) throw new Error(UNAVAILABLE);
      if (generation !== startedGeneration) {
        const latest = current();
        if (latest) return { backend: latest.backend, php: latest.php === true };
        throw new Error(UNAVAILABLE);
      }
      save(backend, php);
      return { backend, php };
    })();
    bootstrap = request;
    try { return announce(await request); }
    finally { if (bootstrap === request) bootstrap = undefined; }
  }

  async function selectBackend() {
    return (await selectTarget()).backend;
  }

  // Resolves the transport for one request: this page load's server, or a backend
  // pinned with a video/cursor so its playback and actions keep working even when
  // a failed call made this page load discover a new one.
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
    // A caller may pass one header (`Authorization: Bearer <firebase token>`) for a
    // public read the backend answers differently when it knows who is asking. The
    // value is never stored, logged or put anywhere but this request; a password
    // or any other header name is not passed along, so this stays the one case.
    // Once a backend has shown that it will not take the token (a CORS preflight
    // that does not allow `Authorization`, or a 401/403), this tab stops sending
    // it there: the answer is the same public one, without asking the same counting
    // route twice for every later play.
    const forwarded = backend === tokenRejectedFor ? undefined : forwardedHeaders(init.headers);
    let result = await readJson(url, method, { signal: init.signal, counts, php, requestBody: body, headers: forwarded });
    // A signed-in visitor's token can simply have run out between two requests, and
    // a host that has not allowed `Authorization` through its CORS preflight refuses
    // the call before the backend ever sees it. The caller cannot fix either from
    // here, but the answer must still be a video rather than an error: the same
    // request is asked once more without the token, and the public answer (the
    // trailer, or the locked shape) is what comes back. One retry, never a loop.
    if (result.failed && forwarded && (result.network
      || (result.refused && (result.status === 401 || result.status === 403)))) {
      tokenRejectedFor = backend;
      result = await readJson(url, method, { signal: init.signal, counts, php, requestBody: body });
    }
    if (onOutcome) {
      onOutcome({
        path,
        php,
        ok: !result.failed,
        challenge: Boolean(result.challenge),
        blocked: Boolean(result.network) && !result.cors,
        cors: Boolean(result.cors),
        status: result.status,
      });
    }
    if (result.failed) {
      // A host that refused the call on its own (WAF, rate limit, missing route)
      // is not a broken backend for everyone: the failure names it, and the visitor
      // is not sent through a lock page for it.
      if (result.refused) {
        // `detailFailed` tells the caller this host answered but refused the
        // request itself, which is not the same as "the video is gone".
        const failure = Object.assign(new Error(UNAVAILABLE), { status: result.status, refused: true, detailFailed: true });
        throw failure;
      }
      // Optional count polling must not disrupt catalog routing. A stale
      // response for an older backend must not erase a newer selection either.
      if (!counts && result.invalidate && generation === requestGeneration && cached?.backend === backend) clear();
      // PHP mode: the host answered with its own HTML check, or the call never
      // left the browser. Send the visitor through the host's own unlock page
      // once (no proxy in between); the request stops here because the page is
      // about to leave.
      // The host's own check page is one reason to visit it; a request that never
      // left the browser is another. A refused answer (missing CORS header) is
      // passed along too, because on a host whose session was never proven a
      // cookieless request looks exactly like that — `requestUnlock` decides, and
      // it refuses once a session has been proven.
      if (!counts && php && requestUnlock && (result.challenge || result.network)) {
        if (requestUnlock({ path, challenge: Boolean(result.challenge), cors: Boolean(result.cors) })) throw new Error(UNAVAILABLE);
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
