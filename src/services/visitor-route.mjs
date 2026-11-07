const ROUTE_HEADER = "x-intimora-route";
const TTL_HEADER = "x-intimora-route-ttl";
const STORAGE_KEY = "intimora_visitor_route_v1";
const MAX_TOKEN_LENGTH = 6144;
const MAX_TTL_MS = 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNAVAILABLE = "Content is temporarily unavailable";

// Each tab owns its short-lived opaque selection. It never contains a readable
// backend address, and works even when third-party cookies are unavailable.
export function createVisitorRequest(options = {}) {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const getStorage = options.storage === undefined
    ? () => { try { return globalThis.sessionStorage; } catch { return null; } }
    : () => options.storage;
  let cached;
  let loaded = false;
  let bootstrap;
  let generation = 0;

  function clear() {
    generation += 1;
    cached = undefined;
    try { getStorage()?.removeItem(STORAGE_KEY); } catch { /* Private browsing can disable storage. */ }
  }

  function currentToken() {
    if (!loaded) {
      loaded = true;
      try {
        const entry = JSON.parse(getStorage()?.getItem(STORAGE_KEY) || "null");
        if (entry && typeof entry.token === "string" && entry.token.length <= MAX_TOKEN_LENGTH
          && TOKEN_PATTERN.test(entry.token) && Number.isFinite(entry.expiresAt)) cached = entry;
      } catch { /* Continue with an in-memory cache when storage is unavailable. */ }
    }
    if (cached && cached.expiresAt <= now()) clear();
    return cached?.token;
  }

  function save(token, ttl, receivedAt) {
    if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)
      || !Number.isFinite(ttl)) return;
    // Count from receipt of the headers, not after a potentially slow body download.
    // Repeated responses must never extend the lifetime of an existing token.
    const deadline = receivedAt + Math.min(ttl, MAX_TTL_MS) - 1000;
    const expiresAt = cached?.token === token ? Math.min(deadline, cached.expiresAt) : deadline;
    if (ttl <= 1000 || expiresAt <= now()) { clear(); return; }
    cached = { token, expiresAt };
    try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify(cached)); } catch { /* Keep the in-memory selection. */ }
  }

  async function perform(url, init, token) {
    const requestGeneration = generation;
    const headers = new Headers(init?.headers);
    if (token) headers.set(ROUTE_HEADER, token);
    else headers.delete(ROUTE_HEADER);
    let response;
    try {
      // Never forward the opaque visitor token across an unexpected redirect.
      response = await fetcher(url, { ...init, headers, redirect: "error" });
    } catch {
      if (generation === requestGeneration) clear();
      throw new Error(UNAVAILABLE);
    }
    if (!response.ok) {
      // A failing selected backend can be rediscovered for this visitor only.
      if (response.status >= 500 && generation === requestGeneration) clear();
      throw new Error(UNAVAILABLE);
    }
    const receivedAt = now();
    let data;
    try {
      data = await response.json();
    } catch {
      if (generation === requestGeneration) clear();
      throw new Error(UNAVAILABLE);
    }
    const nextToken = response.headers.get(ROUTE_HEADER);
    // A slower response from before a failure/refresh must not restore stale routing.
    if (nextToken && generation === requestGeneration && (!token || cached?.token === token)) {
      save(nextToken, Number(response.headers.get(TTL_HEADER)), receivedAt);
    }
    return data;
  }

  return async function requestJson(url, init) {
    for (;;) {
      const token = currentToken();
      if (token) return perform(url, init, token);
      if (bootstrap) {
        await bootstrap;
        continue;
      }
      // The first catalog/search requests of one tab share a single discovery.
      // Other tabs have a different module instance and their own session cache.
      const request = perform(url, init);
      const lock = request.then(
        () => { if (bootstrap === lock) bootstrap = undefined; },
        () => { if (bootstrap === lock) bootstrap = undefined; },
      );
      bootstrap = lock;
      return request;
    }
  };
}
