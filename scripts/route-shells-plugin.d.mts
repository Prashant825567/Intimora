import type { Plugin } from "vite";

export const MAX_WATCH_SHELLS: number;
export const ROUTE_SHELL_PATHS: readonly string[];

export function watchIdsFromSitemap(xml: string, limit?: number): string[];

export function routeShellsPlugin(options?: {
  snapshotSitemap?: string;
}): Plugin;
