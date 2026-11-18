import type { Plugin } from "vite";
import type { buildSitemap } from "./sitemap.mjs";

export function sitemapPlugin(options: {
  discoveryUrl: string;
  generate?: typeof buildSitemap;
  // Receives the catalogue titles for the route shells' per-page <title>.
  state?: { videos?: Array<{ id: string; title: string }> };
}): Plugin;
