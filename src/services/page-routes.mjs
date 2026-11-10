// Keep the browser and the optional Node server in agreement about real pages.
export const BROWSE_PATHS = Object.freeze({
  Home: "/",
  Trending: "/trending",
  New: "/new",
  Exclusive: "/exclusive",
  Categories: "/categories",
});

const viewsByPath = new Map(Object.entries(BROWSE_PATHS).map(([view, path]) => [path, view]));
const accountRoute = /^\/(login|profile|referral|dashboard)\/?$/;
const watchRoute = /^\/watch\/([A-Za-z0-9_-]{1,128})\/?$/;
const videoId = /^[A-Za-z0-9_-]{1,128}$/;

export function browseViewFromPath(pathname) {
  if (typeof pathname !== "string") return null;
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return viewsByPath.get(normalized) ?? null;
}

export function accountPageFromPath(pathname) {
  return typeof pathname === "string" ? accountRoute.exec(pathname)?.[1] ?? null : null;
}

export function watchIdFromPath(pathname) {
  return typeof pathname === "string" ? watchRoute.exec(pathname)?.[1] ?? null : null;
}

export function watchPathFor(id) {
  return typeof id === "string" && videoId.test(id) ? `/watch/${id}` : null;
}

export function isSearchPath(pathname) {
  return pathname === "/search" || pathname === "/search/";
}

export function searchTermFromLocation(pathname, search) {
  if (!isSearchPath(pathname) || typeof search !== "string") return null;
  const term = (new URLSearchParams(search).get("q") || "").trim().slice(0, 200);
  return term || null;
}

export function searchPathFor(query) {
  const term = typeof query === "string" ? query.trim().slice(0, 200) : "";
  return term ? `/search?${new URLSearchParams({ q: term })}` : "/search";
}

export function isAppPath(pathname) {
  return browseViewFromPath(pathname) !== null || accountPageFromPath(pathname) !== null
    || watchIdFromPath(pathname) !== null || isSearchPath(pathname);
}
