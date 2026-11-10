import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROWSE_PATHS } from "../src/services/page-routes.mjs";
import { SITE_ORIGIN } from "./sitemap.mjs";

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

export function routeShellsPlugin({ snapshotSitemap } = {}) {
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
        html = await readFile(path.join(directory, "index.html"));
      } catch {
        this.warn("Route shells were skipped; the built index.html was unavailable.");
        return;
      }

      const ids = await readWatchIds(directory, snapshotSitemap);
      const files = [];
      for (const route of ROUTE_SHELL_PATHS) {
        const name = route.slice(1);
        files.push([`${name}/index.html`, html], [`${name}.html`, html]);
      }
      for (const id of ids) {
        files.push([`watch/${id}/index.html`, html], [`watch/${id}.html`, html]);
      }
      files.push(["404.html", html]);

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
