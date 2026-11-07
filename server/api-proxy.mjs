import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const API_PREFIX = "/_api";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 4096;
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

// Reject private, loopback, link-local and other non-public destinations. DNS is
// checked in the request's lookup callback so the checked address is the one
// actually used for the connection (rather than a separate, rebindable lookup).
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedAddresses.addSubnet(address, prefix, "ipv6");

function unbracket(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLoopbackAddress(address) {
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

function isLoopbackHost(hostname) {
  const host = unbracket(hostname);
  return host === "localhost" || isLoopbackAddress(host);
}

function isAllowedAddress(address, allowLoopback) {
  const family = isIP(address);
  if (!family) return false;
  if (allowLoopback && isLoopbackAddress(address)) return true;
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function validateNetworkUrl(value, { allowLoopback = false, allowQuery = true } = {}) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) throw new Error("Invalid network target");
  const url = new URL(value);
  const host = unbracket(url.hostname);
  if (!host || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error("Invalid network target");
  }
  const local = allowLoopback && isLoopbackHost(host);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Invalid network target");
  }
  // Public upstreams use the standard HTTPS port; this also prevents the
  // discovery response from being used to probe arbitrary service ports.
  if (!local && url.port) throw new Error("Invalid network target");
  if (isIP(host) && !isAllowedAddress(host, local)) throw new Error("Invalid network target");
  if (host === "localhost" && !local) throw new Error("Invalid network target");
  return url;
}

function safeLookup(allowLoopback) {
  return (hostname, options, callback) => {
    const requestedFamily = typeof options === "object" ? options.family : options;
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = addresses.filter(({ address, family }) =>
        (!requestedFamily || requestedFamily === family) && isAllowedAddress(address, allowLoopback),
      );
      if (!allowed.length) return callback(new Error("Network target is not permitted"));
      if (typeof options === "object" && options.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

function parseHostList(value) {
  if (!value) return new Set();
  const hosts = value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.some((host) => !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) || host.startsWith(".") || host.includes(".."))) {
    throw new Error("Invalid host allowlist");
  }
  return new Set(hosts);
}

function isListedHost(url, hosts) {
  return hosts.has(url.hostname.toLowerCase()) || hosts.has(url.host.toLowerCase());
}

function createTokenCodec(secret) {
  if (secret && secret.length < 32) throw new Error("Proxy token secret must be at least 32 characters");
  const key = secret ? createHash("sha256").update(secret).digest() : randomBytes(32);
  return {
    seal(purpose, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const payload = Buffer.from(JSON.stringify({ purpose, value, expires: Date.now() + TOKEN_LIFETIME_MS }));
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    },
    open(token, purpose) {
      try {
        if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return null;
        const packed = Buffer.from(token, "base64url");
        if (packed.length < 29 || packed.toString("base64url") !== token) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
        decipher.setAuthTag(packed.subarray(12, 28));
        const payload = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
        if (payload.purpose !== purpose || !Number.isFinite(payload.expires) || payload.expires <= Date.now()) return null;
        return payload.value;
      } catch {
        return null;
      }
    },
  };
}

function requestUpstream(url, { method = "GET", headers = {}, allowLoopback = false, allowRedirect, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const local = allowLoopback && isLoopbackHost(url.hostname);
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = requester(url, {
      method,
      headers: { "accept-encoding": "identity", ...headers },
      lookup: safeLookup(local),
      maxHeaderSize: 16 * 1024,
    }, (incoming) => {
      const status = incoming.statusCode || 502;
      if (status >= 300 && status < 400) {
        const location = incoming.headers.location;
        incoming.resume();
        if (!location || redirects <= 0 || (method !== "GET" && method !== "HEAD")) {
          reject(new Error("Upstream redirect unavailable"));
          return;
        }
        try {
          const next = validateNetworkUrl(new URL(location, url).href, { allowLoopback });
          if (!allowRedirect?.(next, url)) throw new Error("Redirect is not permitted");
          resolve(requestUpstream(next, { method, headers, allowLoopback, allowRedirect, redirects: redirects - 1 }));
        } catch (error) {
          reject(error);
        }
        return;
      }
      resolve(incoming);
    });
    // Limit DNS/connect/header time as well as inactivity after a response starts.
    const headerTimer = setTimeout(() => outgoing.destroy(new Error("Upstream timeout")), 15_000);
    outgoing.once("response", () => clearTimeout(headerTimer));
    outgoing.once("error", () => clearTimeout(headerTimer));
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("Upstream timeout")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function readJson(incoming, maxBytes = MAX_JSON_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of incoming) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      incoming.destroy();
      throw new Error("Upstream response too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status = 503) {
  sendJson(res, status, { ok: false, message: "Content is temporarily unavailable. Please try again later." });
}

function sameOriginMutation(req) {
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  if (typeof req.headers.origin !== "string" || typeof req.headers.host !== "string") return false;
  try {
    const origin = new URL(req.headers.origin);
    if (origin.origin !== req.headers.origin || !["https:", "http:"].includes(origin.protocol)) return false;
    return origin.host === new URL(`${origin.protocol}//${req.headers.host}`).host;
  } catch {
    return false;
  }
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, "[link removed]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, maxLength);
}

function nonnegativeNumber(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function upstreamPath(base, pathname, params) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = params.toString();
  return url;
}

function validRange(value) {
  return typeof value === "string" && value.length <= 100 && /^bytes=(?:\d+-\d*|-\d+)$/.test(value);
}

/** Only public catalog/video routes are proxied; arbitrary URLs and admin routes are never accepted. */
export function createApiHandler(options = {}) {
  const discoveryUrl = options.discoveryUrl ?? process.env.API_DISCOVERY_URL ?? "";
  const fixedUpstream = options.upstreamUrl ?? process.env.API_PROXY_UPSTREAM ?? "";
  const allowedHosts = parseHostList(options.allowedHosts ?? process.env.API_ALLOWED_HOSTS ?? "");
  const mediaHosts = parseHostList(options.mediaAllowedHosts ?? process.env.API_MEDIA_ALLOWED_HOSTS ?? "");
  const allowLoopback = options.allowLoopback === true;
  const codec = createTokenCodec(options.tokenSecret ?? process.env.PROXY_TOKEN_SECRET ?? "");
  let cachedTarget;
  let cachedUntil = 0;
  let discoveryInFlight;

  function validateTarget(value) {
    const target = validateNetworkUrl(value, { allowLoopback, allowQuery: false });
    if (allowedHosts.size && !isListedHost(target, allowedHosts)) throw new Error("Upstream host is not allowed");
    return target;
  }

  async function getTarget() {
    if (fixedUpstream) return validateTarget(fixedUpstream);
    if (cachedTarget && Date.now() < cachedUntil) return cachedTarget;
    if (!discoveryInFlight) {
      discoveryInFlight = (async () => {
        const url = validateNetworkUrl(discoveryUrl, { allowLoopback });
        const incoming = await requestUpstream(url, {
          allowLoopback,
          headers: { accept: "application/json" },
          allowRedirect: (next, current) => next.origin === current.origin,
        });
        if (incoming.statusCode !== 200) {
          incoming.resume();
          throw new Error("Discovery unavailable");
        }
        const result = await readJson(incoming, 64 * 1024);
        const target = validateTarget(result?.ok && typeof result?.data?.server === "string" ? result.data.server : "");
        cachedTarget = target;
        cachedUntil = Date.now() + DISCOVERY_CACHE_MS;
        return target;
      })().finally(() => { discoveryInFlight = undefined; });
    }
    return discoveryInFlight;
  }

  function isAllowedMedia(url, target) {
    return url.origin === target.origin || isListedHost(url, mediaHosts);
  }

  function mediaPath(rawUrl, target, id, type) {
    const fallback = `${API_PREFIX}/api/videos/${encodeURIComponent(id)}/${type}`;
    if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > MAX_URL_LENGTH) return fallback;
    try {
      const resolved = validateNetworkUrl(new URL(rawUrl, `${target.href.replace(/\/+$/, "")}/`).href, { allowLoopback });
      if (!isAllowedMedia(resolved, target)) return fallback;
      const token = codec.seal(type, resolved.href);
      return token.length <= MAX_TOKEN_LENGTH ? `${API_PREFIX}/media/${token}` : fallback;
    } catch {
      return fallback;
    }
  }

  function publicVideo(video, target) {
    if (!video || typeof video !== "object" || typeof video.id !== "string" || !ID_PATTERN.test(video.id)) return null;
    const result = {
      id: video.id,
      title: safeText(video.title, 300) || "Untitled Video",
      thumbnailUrl: mediaPath(video.thumbnailUrl, target, video.id, "thumbnail"),
      streamUrl: mediaPath(video.streamUrl, target, video.id, "stream"),
    };
    for (const [key, max] of [["description", 4000], ["category", 100], ["creator", 200], ["uploadedAt", 100]]) {
      const value = safeText(video[key], max);
      if (value !== undefined) result[key] = value;
    }
    for (const key of ["duration", "views", "likes", "shares", "createdAt"]) {
      const value = nonnegativeNumber(video[key]);
      if (value !== undefined) result[key] = value;
    }
    if (Array.isArray(video.tags)) {
      result.tags = video.tags.slice(0, 30).map((tag) => safeText(tag, 80)).filter((tag) => tag !== undefined);
    }
    return result;
  }

  async function handle(req, res, url) {
    if ((req.url || "").length > 8192) return sendError(res, 414);
    if (req.headers["sec-fetch-site"] === "cross-site") return sendError(res, 403);

    const path = url.pathname.slice(API_PREFIX.length);
    const method = req.method || "GET";
    const video = path.match(/^\/api\/videos\/([A-Za-z0-9_-]{1,128})(?:\/(thumbnail|stream|like|share))?$/);
    const media = path.match(/^\/media\/([A-Za-z0-9_-]+)$/);
    let route;
    if (path === "/api/videos") route = "list";
    else if (path === "/api/search") route = "search";
    else if (media) route = "opaque-media";
    else if (video) route = video[2] || "detail";
    else return sendError(res, 404);

    const mutation = route === "like" || route === "share";
    const isMedia = route === "thumbnail" || route === "stream" || route === "opaque-media";
    if (mutation ? method !== "POST" : isMedia ? !["GET", "HEAD"].includes(method) : method !== "GET") {
      return sendError(res, 405);
    }
    if (mutation && (!sameOriginMutation(req) || Number(req.headers["content-length"] || 0) !== 0 || req.headers["transfer-encoding"])) {
      req.resume();
      return sendError(res, 403);
    }
    if (!mutation && (Number(req.headers["content-length"] || 0) !== 0 || req.headers["transfer-encoding"])) {
      req.resume();
      return sendError(res, 400);
    }

    const allowedParam = route === "list" ? "cursor" : route === "search" ? "q" : null;
    for (const key of url.searchParams.keys()) {
      if (key !== allowedParam || url.searchParams.getAll(key).length !== 1) return sendError(res, 400);
    }
    const params = new URLSearchParams();
    if (route === "list" && url.searchParams.has("cursor")) {
      const cursor = codec.open(url.searchParams.get("cursor"), "cursor");
      if (!((typeof cursor === "string" && cursor.length <= 1024) || (typeof cursor === "number" && Number.isFinite(cursor)))) {
        return sendError(res, 400);
      }
      params.set("cursor", String(cursor));
    }
    if (route === "search") {
      const query = url.searchParams.get("q") || "";
      if (query.length > 200) return sendError(res, 400);
      params.set("q", query);
    }
    if (isMedia && req.headers.range && !validRange(req.headers.range)) return sendError(res, 416);

    const target = await getTarget();
    let destination;
    let mediaType = route;
    if (route === "opaque-media") {
      if (media[1].length > MAX_TOKEN_LENGTH) return sendError(res, 404);
      const thumbnail = codec.open(media[1], "thumbnail");
      const stream = thumbnail === null ? codec.open(media[1], "stream") : null;
      const raw = thumbnail ?? stream;
      mediaType = thumbnail !== null ? "thumbnail" : "stream";
      if (typeof raw !== "string") return sendError(res, 404);
      destination = validateNetworkUrl(raw, { allowLoopback });
      if (!isAllowedMedia(destination, target)) return sendError(res, 404);
    } else {
      destination = upstreamPath(target, path, params);
    }

    const headers = { accept: isMedia ? "*/*" : "application/json" };
    if (isMedia && req.headers.range) headers.range = req.headers.range;
    const incoming = await requestUpstream(destination, {
      method,
      headers,
      allowLoopback,
      allowRedirect: isMedia
        ? (next, current) => next.origin === current.origin || isAllowedMedia(next, target)
        : (next, current) => next.origin === current.origin,
    });
    const status = incoming.statusCode || 502;

    if (isMedia && status === 416) {
      const contentRange = incoming.headers["content-range"];
      incoming.resume();
      if (typeof contentRange === "string" && /^bytes \*\/\d+$/.test(contentRange)) res.setHeader("Content-Range", contentRange);
      return sendError(res, 416);
    }
    if (status < 200 || status >= 300) {
      incoming.resume();
      return sendError(res, status === 404 ? 404 : 503);
    }
    if (isMedia) {
      const contentType = String(incoming.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
      const videoTypes = new Set(["video/mp4", "video/webm", "video/ogg", "application/octet-stream"]);
      const allowedType = mediaType === "thumbnail" ? imageTypes.has(contentType) : videoTypes.has(contentType);
      if (!allowedType || (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity")) {
        incoming.resume();
        return sendError(res, 503);
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, no-store");
      const length = incoming.headers["content-length"];
      const range = incoming.headers["content-range"];
      if (typeof length === "string" && /^\d+$/.test(length)) res.setHeader("Content-Length", length);
      if (typeof range === "string" && /^bytes \d+-\d+\/(?:\d+|\*)$/.test(range)) res.setHeader("Content-Range", range);
      if (incoming.headers["accept-ranges"] === "bytes") res.setHeader("Accept-Ranges", "bytes");
      res.statusCode = status;
      if (method === "HEAD") {
        incoming.resume();
        return res.end();
      }
      res.on("close", () => { if (!res.writableEnded) incoming.destroy(); });
      incoming.on("error", () => res.destroy());
      incoming.pipe(res);
      return;
    }

    if (route === "list" || route === "search") {
      const payload = await readJson(incoming);
      if (!payload?.ok || !Array.isArray(payload?.data?.videos)) throw new Error("Invalid catalog response");
      const videos = payload.data.videos.slice(0, 500).map((item) => publicVideo(item, target)).filter(Boolean);
      const cursor = payload.data.nextCursor;
      const validCursor = (typeof cursor === "string" && cursor.length > 0 && cursor.length <= 1024)
        || (typeof cursor === "number" && Number.isFinite(cursor));
      return sendJson(res, 200, { ok: true, data: { videos, nextCursor: validCursor ? codec.seal("cursor", cursor) : null } });
    }
    // Detail, like and share responses aren't needed by the UI. Never relay
    // upstream response bodies, error messages, headers or cookies to the client.
    incoming.resume();
    return sendJson(res, 200, { ok: true });
  }

  return (req, res, next) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://internal.invalid");
    } catch {
      sendError(res, 400);
      return;
    }
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return next();
    handle(req, res, url).catch(() => {
      // Do not log or return upstream errors: they can contain private URLs,
      // headers, query-string credentials, or response bodies.
      cachedTarget = undefined;
      cachedUntil = 0;
      sendError(res);
    });
  };
}
