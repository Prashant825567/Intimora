import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiProxyOptions {
  discoveryUrl?: string;
  upstreamUrl?: string;
  allowedHosts?: string;
  mediaAllowedHosts?: string;
  allowLoopback?: boolean;
  tokenSecret?: string;
  /** Optional clock, useful for testing expiration deterministically. */
  now?: () => number;
}

export function createApiHandler(
  options?: ApiProxyOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** Server-side network guards reused for build-time public catalog requests. */
export function validateNetworkUrl(value: string, options?: { allowLoopback?: boolean; allowQuery?: boolean }): URL;
export function requestUpstream(url: URL, options?: {
  method?: string;
  headers?: Record<string, string>;
  allowLoopback?: boolean;
  allowRedirect?: (next: URL, previous: URL) => boolean;
  redirects?: number;
  timeoutMs?: number;
}): Promise<IncomingMessage>;
export function readJson(incoming: IncomingMessage, maxBytes?: number): Promise<unknown>;
