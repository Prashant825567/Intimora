import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSitemap } from "./sitemap.mjs";

// Vite copies the checked-in sitemap snapshot before this hook runs. Only a
// complete scan replaces it, and the replacement is atomic.
export function sitemapPlugin({ discoveryUrl, generate = buildSitemap }) {
  return {
    name: "intimora-sitemap",
    apply: "build",
    async writeBundle(output) {
      const directory = output.dir;
      if (!directory) {
        this.warn("Sitemap refresh was skipped; the checked-in snapshot remains available.");
        return;
      }
      const temp = path.join(directory, `.sitemap-${process.pid}.tmp`);
      try {
        const result = await generate({ discoveryUrl });
        if (!result.complete) {
          this.warn("Sitemap catalog was incomplete; using the checked-in snapshot until a successful rebuild.");
          return;
        }
        await writeFile(temp, result.xml, "utf8");
        await rename(temp, path.join(directory, "sitemap.xml"));
        console.info(`Sitemap generated with ${result.videoCount} video page(s).`);
      } catch {
        await rm(temp, { force: true }).catch(() => {});
        this.warn("Sitemap refresh failed; the checked-in snapshot remains available.");
      }
    },
  };
}
