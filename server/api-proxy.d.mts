import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiProxyOptions {
  discoveryUrl?: string;
  upstreamUrl?: string;
  allowedHosts?: string;
  mediaAllowedHosts?: string;
  allowLoopback?: boolean;
  tokenSecret?: string;
}

export function createApiHandler(
  options?: ApiProxyOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
