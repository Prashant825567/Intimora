import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROWSE_PATHS } from "../src/services/page-routes.mjs";
import { SITE_ORIGIN } from "./sitemap.mjs";
import { applyPageHead, pageMetaFor } from "./page-head.mjs";

const WATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_WATCH_SHELLS = 500;

// Every page the app can show without knowing a video ID in advance. The host
// serves an existing file before evaluating any rewrite rule, so a copy of the
// built index.html at each path makes direct links work even on a static host
// with no SPA fallback configured.
export const ROUTE_SHELL_PATHS = Object.freeze([
  ...Object.values(BROWSE_PATHS).filter((value) => value !== "/"),
  "/search",
  "/login",
  "/profile",
  "/referral",
  "/dashboard",
]);

// The published sitemap lists exactly the video pages that exist for the site
// origin, so it doubles as the shell list. Only this site's own watch URLs with
// the same ID character set as the app are accepted, and duplicates are ignored.
export function watchIdsFromSitemap(xml, limit = MAX_WATCH_SHELLS) {
  const ids = [];
  if (typeof xml !== "string" || !Number.isInteger(limit) || limit < 1) return ids;
  const seen = new Set();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    let url;
    try { url = new URL(match[1]); } catch { continue; }
    if (url.origin !== SITE_ORIGIN || !url.pathname.startsWith("/watch/")) continue;
    const id = url.pathname.slice("/watch/".length);
    if (!WATCH_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

async function readWatchIds(directory, snapshotPath) {
  for (const candidate of [path.join(directory, "sitemap.xml"), snapshotPath].filter(Boolean)) {
    try {
      const ids = watchIdsFromSitemap(await readFile(candidate, "utf8"));
      if (ids.length) return ids;
    } catch { /* Try the next candidate. */ }
  }
  return [];
}

export function routeShellsPlugin({ snapshotSitemap, state } = {}) {
  return {
    name: "intimora-route-shells",
    apply: "build",
    // Runs after the sitemap plugin so the freshly generated sitemap can be
    // used to enumerate video pages for this build.
    enforce: "post",
    async writeBundle(output) {
      const directory = output.dir;
      if (!directory) {
        this.warn("Route shells were skipped; the build has no output directory.");
        return;
      }
      let html;
      try {
        html = await readFile(path.join(directory, "index.html"), "utf8");
      } catch {
        this.warn("Route shells were skipped; the built index.html was unavailable.");
        return;
      }

      const ids = await readWatchIds(directory, snapshotSitemap);
      // Titles come from the catalogue scan that produced this build's sitemap;
      // a video without one still gets a plain, unique watch page.
      const titles = new Map();
      for (const video of Array.isArray(state?.videos) ? state.videos : []) {
        if (typeof video?.id === "string" && typeof video?.title === "string") titles.set(video.id, video.title);
      }
      const shell = (route, videoTitle, options) => applyPageHead(html, pageMetaFor(route, { videoTitle }), options);
      const files = [["index.html", shell("/")]];
      for (const route of ROUTE_SHELL_PATHS) {
        const name = route.slice(1);
        const page = shell(route);
        files.push([`${name}/index.html`, page], [`${name}.html`, page]);
      }
      for (const id of ids) {
        const page = shell(`/watch/${id}`, titles.get(id));
        files.push([`watch/${id}/index.html`, page], [`watch/${id}.html`, page]);
      }
      files.push(["404.html", shell("/", undefined, { noindex: true })]);

      try {
        for (const [file, content] of files) {
          const target = path.join(directory, ...file.split("/"));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
      } catch {
        this.warn("Route shells were incomplete; some direct links may depend on host rewrites.");
        return;
      }
      console.info(`Route shells generated for ${ROUTE_SHELL_PATHS.length} page(s) and ${ids.length} video page(s).`);
    },
  };
}
