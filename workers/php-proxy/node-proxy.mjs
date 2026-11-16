// Node proxy for a PHP backend on free hosting whose browser check binds the
// `__test` cookie to the connection that solved it.
//
// The Cloudflare Worker version solves the same challenge, but a Worker has no
// stable egress IP: the challenge may be answered from IP A and the API request
// from IP B, and the host then rejects the cookie with a fresh challenge. That is
// exactly the "another IP's session cookie does not work" problem.
//
// This proxy therefore keeps ONE keep-alive connection per PHP origin
// (`https.Agent({ maxSockets: 1 })`), so the challenge, the cookie and every API
// call share a single TCP connection and a single source IP. A host with a fixed
// outbound IP (a VPS, or a Render web service) then keeps working for the whole
// six hours the cookie is valid, and re-solves on the same socket after that.
//
// Run:
//   PORT=8787 PHP_ORIGINS=https://intimora-api2.site.je node workers/php-proxy/node-proxy.mjs
// or let the load balancer decide:
//   PORT=8787 DISCOVERY_URL=https://intimora.tmc78lxnu.workers.dev/api/get-server node workers/php-proxy/node-proxy.mjs
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_DISCOVERY_URL,
  DEFAULT_PHP_ORIGINS,
  isChallengePage,
  parseChallenge,
  solveChallenge,
} from "./worker.mjs";

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 25_000;
const THUMBNAIL_TTL_MS = 24 * 60 * 60 * 1000;
const THUMBNAIL_PATH = /\/api\/videos\/[A-Za-z0-9_-]{1,64}\/thumbnail$/;
const MEDIA_PATH = /^\/api\/videos\/[A-Za-z0-9_-]{1,64}\/(?:thumbnail|stream)$/;
const PASS_HEADERS = [
  "content-type", "content-length", "content-range", "accept-ranges",
  "cache-control", "etag", "last-modified", "content-encoding",
];

function parseOrigins(list) {
  return (Array.isArray(list) ? list : [])
    .map((value) => {
      try {
        const url = new URL(String(value).trim());
        if (url.username || url.password) return null;
        const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
        return url.origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function createProxyServer({
  phpOrigins = DEFAULT_PHP_ORIGINS,
  discoveryUrl = null,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  publicOrigin = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const fixedTargets = parseOrigins(phpOrigins);
  if (!fixedTargets.length && !discoveryUrl) throw new Error("no php origin configured");
  const allowed = new Set(parseOrigins(allowedOrigins));
  // One socket per origin: the cookie, the challenge and the API call must all
  // leave from the same address, which is what the host ties the session to.
  const agents = new Map();
  const cookies = new Map(); // origin -> { name, value, expiresAt }
  const thumbnails = new Map(); // url -> { body, type, at }
  let discovered = null;

  const agentFor = (origin) => {
    if (!agents.has(origin)) {
      agents.set(origin, origin.startsWith("https:")
        ? new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, keepAliveMsecs: 15_000 })
        : new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, keepAliveMsecs: 15_000 }));
    }
    return agents.get(origin);
  };

  async function resolveTargets(selfOrigin) {
    if (fixedTargets.length) return fixedTargets;
    if (discovered && now() - discovered.at < DISCOVERY_TTL_MS) return discovered.targets;
    const response = await sendRaw(discoveryUrl, { headers: { accept: "application/json" } });
    if (response.status >= 400) throw new Error(`discovery answered ${response.status}`);
    const body = JSON.parse(response.body.toString("utf8"));
    const targets = parseOrigins([body?.data?.server]);
    if (!targets.length) throw new Error("discovery did not return a usable server");
    if (targets.includes(selfOrigin)) throw new Error("discovery points at this proxy itself");
    discovered = { targets, at: now() };
    return targets;
  }

  // A single request on the shared socket. Returns the whole body for small
  // responses (pages, thumbnails) and the raw stream for media.
  function sendRaw(url, { method = "GET", headers = {}, body = null, stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method,
        agent: agentFor(target.origin),
        headers: {
          // Never negotiate compression: the challenge is detected by reading a
          // small HTML body, and a compressed body would hide it.
          "accept-encoding": "identity",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          accept: "*/*",
          ...headers,
        },
        timeout: UPSTREAM_TIMEOUT_MS,
      }, (response) => {
        if (stream) {
          resolve({ status: response.statusCode || 0, headers: response.headers, stream: response, socket: request.socket });
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks), socket: request.socket }));
        response.on("error", reject);
      });
      request.on("timeout", () => request.destroy(new Error("upstream timeout")));
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  const readStream = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  // Challenge + retry on the same socket, so the cookie is always used from the
  // address that earned it. Media is streamed, but a challenge answered instead
  // of media is buffered (it is small), solved and retried.
  async function callUpstream(origin, path, init = {}) {
    const wantsStream = init.stream === true;
    // Media cannot be inspected and retried cheaply, so earn the cookie with one
    // small request on the same socket before the big one starts.
    if (wantsStream && !(cookies.get(origin)?.expiresAt > now())) {
      await callUpstream(origin, "/api/videos?limit=1", {});
    }
    let last = null;
    for (let attempt = 0; attempt < CHALLENGE_ATTEMPTS; attempt += 1) {
      const cookie = cookies.get(origin);
      const valid = cookie && cookie.expiresAt > now();
      const headers = { ...(init.headers ?? {}) };
      if (valid) headers.cookie = `${cookie.name}=${cookie.value}`;
      const response = await sendRaw(origin + path, { ...init, headers, stream: wantsStream && Boolean(valid) });
      const type = String(response.headers["content-type"] ?? "").toLowerCase();
      const text = response.stream
        ? (type.includes("html") ? (await readStream(response.stream)).toString("utf8") : null)
        : response.body.toString("utf8");
      if (text === null) return response; // real media flowing
      if (!isChallengePage(text, type)) {
        return response.stream
          ? { status: response.status, headers: response.headers, body: Buffer.from(text) }
          : response;
      }
      const challenge = parseChallenge(text);
      const value = solveChallenge(text);
      if (!challenge || !value) {
        last = response.stream ? { status: response.status, headers: response.headers, body: Buffer.from(text) } : response;
        break;
      }
      cookies.set(origin, {
        name: challenge.cookie,
        value,
        expiresAt: now() + Math.max(60, challenge.maxAge - 60) * 1000,
      });
      last = response.stream ? { status: response.status, headers: response.headers, body: Buffer.from(text) } : response;
      log(`challenge solved for ${origin} (${attempt + 1}/${CHALLENGE_ATTEMPTS})`);
    }
    return last;
  }

  const cors = (origin) => {
    const headers = {
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
      "Access-Control-Max-Age": "600",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    };
    if (origin && allowed.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    return headers;
  };

  const sendJson = (response, status, body, origin) => {
    const payload = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      ...cors(origin),
      "content-type": "application/json; charset=utf-8",
      "content-length": payload.length,
      "cache-control": "no-store",
    });
    response.end(payload);
  };

  const readRequestBody = (request) => new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });

  async function health(origin, selfOrigin) {
    const report = { ok: true, targets: [], cookie: null };
    let targets;
    try {
      targets = await resolveTargets(selfOrigin);
    } catch (error) {
      return { status: 502, body: { ok: false, error: String(error?.message ?? error), targets: [], cookie: null } };
    }
    report.mode = fixedTargets.length ? "fixed" : "discovery";
    for (const target of targets) {
      const entry = { origin: target };
      const started = now();
      try {
        const page = await sendRaw(`${target}/api/videos?limit=1`);
        const text = page.body.toString("utf8");
        entry.status = page.status;
        entry.challenge = isChallengePage(text, String(page.headers["content-type"] ?? ""));
        if (entry.challenge) {
          const token = solveChallenge(text);
          entry.challengeSolved = Boolean(token);
        }
        const result = await callUpstream(target, "/api/videos?limit=1", {});
        const body = JSON.parse(result.body.toString("utf8"));
        entry.catalog = { ok: body?.ok === true, status: result.status, videos: body?.data?.videos?.length ?? 0 };
        entry.ms = now() - started;
      } catch (error) {
        entry.error = String(error?.message ?? error);
        report.ok = false;
      }
      report.targets.push(entry);
    }
    const cookie = targets.map((target) => ({ target, cookie: cookies.get(target) }))[0]?.cookie;
    report.cookie = cookie
      ? { name: cookie.name, expiresInMinutes: Math.max(0, Math.round((cookie.expiresAt - now()) / 60000)) }
      : null;
    return { status: report.ok ? 200 : 502, body: report };
  }

  async function handle(request, response) {
    const origin = request.headers.origin || "";
    const url = new URL(request.url || "/", publicOrigin || `http://${request.headers.host || "localhost"}`);
    const selfOrigin = publicOrigin || `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${request.headers.host}`;
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors(origin));
      response.end();
      return;
    }
    if (url.pathname === "/__proxy-health") {
      const result = await health(origin, selfOrigin);
      sendJson(response, result.status, result.body, origin);
      return;
    }
    if (url.pathname === "/api/get-server") {
      sendJson(response, 200, { ok: true, data: { server: selfOrigin } }, origin);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { ok: false, error: "not found" }, origin);
      return;
    }
    if (MEDIA_PATH.test(url.pathname) && !["GET", "HEAD"].includes(request.method)) {
      sendJson(response, 405, { ok: false, error: "method not allowed" }, origin);
      return;
    }

    const wantsThumbnail = request.method === "GET" && THUMBNAIL_PATH.test(url.pathname);
    if (wantsThumbnail) {
      const hit = thumbnails.get(url.pathname);
      if (hit && now() - hit.at < THUMBNAIL_TTL_MS) {
        response.writeHead(200, {
          ...cors(origin),
          "content-type": hit.type,
          "content-length": hit.body.length,
          "cache-control": "public, max-age=86400",
        });
        response.end(hit.body);
        return;
      }
    }

    let targets;
    try {
      targets = await resolveTargets(selfOrigin);
    } catch (error) {
      sendJson(response, 502, { ok: false, error: String(error?.message ?? error) }, origin);
      return;
    }

    const headers = {};
    for (const name of ["authorization", "content-type", "range", "if-range", "accept"]) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    const body = ["GET", "HEAD"].includes(request.method) ? null : await readRequestBody(request);
    const path = url.pathname + url.search;

    // Media is streamed; JSON and thumbnails are buffered so a challenge page can
    // never be mistaken for content.
    const isStream = /\/stream$/.test(url.pathname);
    let lastError = null;
    for (const target of targets) {
      try {
        const upstream = await callUpstream(target, path, { method: request.method, headers, body, stream: isStream });
        if (!upstream) continue;
        const outHeaders = { ...cors(origin) };
        for (const name of PASS_HEADERS) {
          if (upstream.headers[name]) outHeaders[name] = upstream.headers[name];
        }
        if (upstream.stream) {
          response.writeHead(upstream.status, outHeaders);
          upstream.stream.pipe(response);
          return;
        }
        const size = upstream.body?.length ?? 0;
        outHeaders["content-length"] = size;
        if (wantsThumbnail && upstream.status === 200 && String(upstream.headers["content-type"] ?? "").startsWith("image/")) {
          thumbnails.set(path, { body: upstream.body, type: upstream.headers["content-type"], at: now() });
        }
        response.writeHead(upstream.status, outHeaders);
        response.end(request.method === "HEAD" ? undefined : upstream.body);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    log(`all origins failed: ${lastError?.message ?? "unknown"}`);
    sendJson(response, 502, { ok: false, error: "backend unreachable" }, origin);
  }

  return http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "proxy error" }, request.headers.origin || "");
      else response.destroy(error);
    });
  });
}

// Started directly (Render, a VPS, or `node workers/php-proxy/node-proxy.mjs`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const server = createProxyServer({
    phpOrigins: process.env.PHP_ORIGINS ? process.env.PHP_ORIGINS.split(",").filter(Boolean) : (process.env.DISCOVERY_URL ? [] : DEFAULT_PHP_ORIGINS),
    discoveryUrl: process.env.DISCOVERY_URL || null,
    allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : DEFAULT_ALLOWED_ORIGINS,
    publicOrigin: process.env.PUBLIC_ORIGIN || null,
    log: (message) => console.log(`[php-proxy] ${message}`),
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[php-proxy] listening on ${port}`);
    console.log(`[php-proxy] mode: ${process.env.PHP_ORIGINS ? "fixed origins" : process.env.DISCOVERY_URL ? `discovery (${process.env.DISCOVERY_URL})` : `fixed default (${DEFAULT_PHP_ORIGINS.join(", ")})`}`);
  });
  void DEFAULT_DISCOVERY_URL;
}

export { parseOrigins };
