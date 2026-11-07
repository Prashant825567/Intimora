import type { ServerResponse } from "node:http";

export function applySecurityHeaders(
  res: ServerResponse,
  options?: { development?: boolean; allowPreviewEmbed?: boolean },
): void;
