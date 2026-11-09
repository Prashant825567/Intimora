import type { Plugin } from "vite";
import type { buildSitemap } from "./sitemap.mjs";

export function sitemapPlugin(options: {
  discoveryUrl: string;
  generate?: typeof buildSitemap;
}): Plugin;
