// Intimora API proxy for a PHP backend on free hosting (InfinityFree).
//
// THE PROBLEM
// Free hosting puts a scripted JavaScript check in front of every request: the
// host answers with an HTML page holding three hex blobs and a line like
//     document.cookie = "__test=" + toHex(slowAES.decrypt(c, 2, a, b))
// A browser navigates, the script runs, the cookie is stored and the page
// reloads. An XHR cannot do any of that: the response has no CORS header, so a
// page on intimora.new.tg cannot even read the HTML, let alone run it, and the
// `__test` cookie would not be sent cross-site anyway (SameSite=Lax).
//
// THE FIX
// This Worker does the browser's part server-side: it decrypts the challenge,
// keeps the `__test` cookie until it expires, forwards the real API request,
// retries once when the host hands out a fresh challenge, and adds the CORS
// headers the site needs. The site never talks to the PHP host at all.
//
// DEPLOY (one paste, no local tooling)
// 1. Cloudflare dashboard → Workers → Edit code → replace everything with this
//    file → Deploy.
// 2. Settings → Variables: PHP_ORIGINS = https://intimora-api2.site.je (comma
//    separated list allowed, the next origin is used when one fails).
//    Optional: ALLOWED_ORIGINS = https://intimora.new.tg,https://www.intimora.new.tg
// 3. Open https://<worker-host>/__proxy-health in a browser: it prints whether
//    the challenge was solved, whether the catalogue answered and how many
//    videos came back. That is the whole test — nothing to run locally.
// 4. Point the discovery endpoint at the Worker, i.e. /api/get-server answers
//    { ok: true, data: { server: "<worker origin>" } } — this file already does
//    that by itself. Best deployment: a Worker route on `intimora.new.tg/api/*`,
//    which makes every call same-origin (no CORS at all). The workers.dev URL
//    works too; this file then adds the CORS headers.
//
// This file has no imports on purpose: it is the complete Worker source.

/* ------------------------------------------------------------------ *
 * AES-128-CBC decryption, no padding
 *
 * `slowAES.decrypt(c, 2, a, b)` is AES-128-CBC with no padding. Web Crypto's
 * AES-CBC always validates PKCS#7 padding and cannot switch it off, so the
 * inverse cipher is implemented here. It is checked against node:crypto in
 * test/php-challenge.test.mjs.
 * ------------------------------------------------------------------ */

function multiply(a, b) {
  let product = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i += 1) {
    if (y & 1) product ^= x;
    const high = x & 0x80;
    x = (x << 1) & 0xff;
    if (high) x ^= 0x1b;
    y >>= 1;
  }
  return product & 0xff;
}

function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (8 - bits))) & 0xff;
}

function buildSboxes() {
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let inverse = 0;
    if (i) {
      let result = 1;
      let base = i;
      let power = 254;
      while (power > 0) {
        if (power & 1) result = multiply(result, base);
        base = multiply(base, base);
        power >>= 1;
      }
      inverse = result;
    }
    sbox[i] = (inverse ^ rotateLeft(inverse, 1) ^ rotateLeft(inverse, 2)
      ^ rotateLeft(inverse, 3) ^ rotateLeft(inverse, 4) ^ 0x63) & 0xff;
  }
  const inverseSbox = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) inverseSbox[sbox[i]] = i;
  return { sbox, inverseSbox };
}

const { sbox: SBOX, inverseSbox: INVERSE_SBOX } = buildSboxes();

function expandKey(key) {
  const schedule = new Uint8Array(176);
  schedule.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    const temp = [schedule[i - 4], schedule[i - 3], schedule[i - 2], schedule[i - 1]];
    if (i % 16 === 0) {
      const rotated = [SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
      temp[0] = rotated[0] ^ rcon;
      temp[1] = rotated[1];
      temp[2] = rotated[2];
      temp[3] = rotated[3];
      rcon = multiply(rcon, 2);
    }
    schedule[i] = schedule[i - 16] ^ temp[0];
    schedule[i + 1] = schedule[i - 15] ^ temp[1];
    schedule[i + 2] = schedule[i - 14] ^ temp[2];
    schedule[i + 3] = schedule[i - 13] ^ temp[3];
  }
  return schedule;
}

function addRoundKey(state, schedule, round) {
  for (let i = 0; i < 16; i += 1) state[i] ^= schedule[round * 16 + i];
}

function inverseShiftRows(state) {
  const copy = state.slice();
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      state[row + 4 * column] = copy[row + 4 * ((column - row + 4) % 4)];
    }
  }
}

function inverseSubBytes(state) {
  for (let i = 0; i < 16; i += 1) state[i] = INVERSE_SBOX[state[i]];
}

function inverseMixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const offset = 4 * column;
    const [a0, a1, a2, a3] = [state[offset], state[offset + 1], state[offset + 2], state[offset + 3]];
    state[offset] = multiply(a0, 14) ^ multiply(a1, 11) ^ multiply(a2, 13) ^ multiply(a3, 9);
    state[offset + 1] = multiply(a0, 9) ^ multiply(a1, 14) ^ multiply(a2, 11) ^ multiply(a3, 13);
    state[offset + 2] = multiply(a0, 13) ^ multiply(a1, 9) ^ multiply(a2, 14) ^ multiply(a3, 11);
    state[offset + 3] = multiply(a0, 11) ^ multiply(a1, 13) ^ multiply(a2, 9) ^ multiply(a3, 14);
  }
}

function decryptBlock(block, schedule) {
  const state = Uint8Array.from(block);
  addRoundKey(state, schedule, 10);
  for (let round = 9; round >= 1; round -= 1) {
    inverseShiftRows(state);
    inverseSubBytes(state);
    addRoundKey(state, schedule, round);
    inverseMixColumns(state);
  }
  inverseShiftRows(state);
  inverseSubBytes(state);
  addRoundKey(state, schedule, 0);
  return state;
}

function toBytes(hex, length) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  if (length && hex.length !== length * 2) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function aesCbcDecryptHex(keyHex, ivHex, dataHex) {
  const key = toBytes(keyHex, 16);
  const iv = toBytes(ivHex, 16);
  const data = toBytes(dataHex);
  if (!key || !iv || !data || !data.length || data.length % 16 !== 0) return null;
  const schedule = expandKey(key);
  const output = new Uint8Array(data.length);
  let previous = iv;
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    const plain = decryptBlock(block, schedule);
    for (let i = 0; i < 16; i += 1) output[offset + i] = plain[i] ^ previous[i];
    previous = block;
  }
  return toHex(output);
}

/* ------------------------------------------------------------------ *
 * The challenge
 * ------------------------------------------------------------------ */

const TO_NUMBERS = /(\w+)\s*=\s*toNumbers\(\s*["']([0-9a-fA-F]{16,512})["']\s*\)/g;
const COOKIE_NAME = /document\.cookie\s*=\s*["']([A-Za-z0-9_-]{1,32})\s*=/;
const DECRYPT_CALL = /decrypt\(\s*(\w+)\s*,\s*(\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/;
const MAX_AGE = /max-age\s*=\s*(\d+)/i;
const HEX_TOKEN = /^[0-9a-f]{16,128}$/i;

// The blobs are named a (key), b (IV) and c (ciphertext) on every host seen so
// far, but the page is generated, so the names are read from it and the
// `decrypt(c, 2, a, b)` argument order decides what is what.
export function parseChallenge(html) {
  if (typeof html !== "string" || !html.includes("toNumbers")) return null;
  const values = new Map();
  for (const match of html.matchAll(TO_NUMBERS)) values.set(match[1], match[2].toLowerCase());
  if (values.size < 3) return null;
  const call = DECRYPT_CALL.exec(html);
  let data;
  let key;
  let iv;
  if (call) {
    data = values.get(call[1]);
    key = values.get(call[3]);
    iv = values.get(call[4]);
  } else if (values.has("a") && values.has("b") && values.has("c")) {
    key = values.get("a");
    iv = values.get("b");
    data = values.get("c");
  }
  if (!key || !iv || !data) return null;
  const cookie = COOKIE_NAME.exec(html)?.[1] ?? "__test";
  const maxAge = Number(MAX_AGE.exec(html)?.[1] ?? 0);
  return { key, iv, data, cookie, maxAge: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 21600 };
}

// The token is the decrypted plaintext as hex — 32 characters on this host.
export function solveChallenge(html) {
  const challenge = parseChallenge(html);
  if (!challenge) return null;
  const token = aesCbcDecryptHex(challenge.key, challenge.iv, challenge.data);
  if (!token) return null;
  const trimmed = token.replace(/(?:0d0a)+$/, "");
  return HEX_TOKEN.test(trimmed) ? trimmed : token;
}

export function isChallengePage(body, contentType) {
  if (typeof body !== "string" || !body) return false;
  const type = (contentType || "").toLowerCase();
  if (type && !type.includes("html")) return false;
  return body.includes("toNumbers(") || (body.includes("slowAES") && body.includes("__test"));
}

// Keeps the solved cookie, retries once when the host hands out a fresh
// challenge, and hands ordinary responses to its caller.
export function createChallengeClient({
  fetchImpl = globalThis.fetch,
  userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  now = () => Date.now(),
  attempts = 2,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
  let cookie = null; // { name, value, expiresAt }

  const readBody = async (response) => {
    const type = response.headers?.get?.("content-type") ?? "";
    const text = typeof response.text === "function" ? await response.text() : "";
    if (!isChallengePage(text, type)) {
      return { response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }), text };
    }
    const challenge = parseChallenge(text);
    const value = solveChallenge(text);
    if (!challenge || !value) return { response: null, text, unsolvable: true };
    cookie = {
      name: challenge.cookie,
      value,
      // Refresh a minute early so a request never races the expiry.
      expiresAt: now() + Math.max(60, challenge.maxAge - 60) * 1000,
    };
    return { response: null, text, solved: true };
  };

  const send = (url, init, withCookie) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    if (withCookie && cookie) headers.set("cookie", `${cookie.name}=${cookie.value}`);
    return fetchImpl(url, { ...init, headers, redirect: "follow" });
  };

  return {
    get cookie() {
      return cookie ? { name: cookie.name, value: cookie.value, expiresAt: cookie.expiresAt } : null;
    },
    async request(url, init = {}) {
      let reused = Boolean(cookie && cookie.expiresAt > now());
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await send(url, init, reused);
        const result = await readBody(response);
        if (result.response) return { response: result.response, text: result.text, solved: false, reused, attempts: attempt + 1 };
        reused = true; // a challenge was just solved
      }
      throw new Error("challenge could not be solved");
    },
  };
}

/* ------------------------------------------------------------------ *
 * The proxy
 * ------------------------------------------------------------------ */

export const DEFAULT_PHP_ORIGINS = ["https://intimora-api2.site.je"];
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://intimora.new.tg",
  "https://www.intimora.new.tg",
  "https://intimora.tg",
];

const MEDIA_PATH = /^\/api\/videos\/[A-Za-z0-9_-]{1,64}\/(?:thumbnail|stream)$/;
const THUMBNAIL_PATH = /\/thumbnail$/;

function cleanOrigins(list) {
  return (Array.isArray(list) ? list : [])
    .map((value) => {
      try {
        const url = new URL(String(value).trim());
        if (url.protocol !== "https:" || url.username || url.password) return null;
        return url.origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export const DEFAULT_DISCOVERY_URL = "https://intimora.tmc78lxnu.workers.dev/api/get-server";
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export function createPhpProxy({
  phpOrigins = DEFAULT_PHP_ORIGINS,
  discoveryUrl = null,
  discoveryTtlMs = DISCOVERY_TTL_MS,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  cache = typeof caches !== "undefined" ? caches.default : null,
  now = () => Date.now(),
  ...clientOptions
} = {}) {
  const fixedTargets = cleanOrigins(phpOrigins);
  if (!fixedTargets.length && !discoveryUrl) throw new Error("no php origin configured");
  const allowed = new Set(cleanOrigins(allowedOrigins));
  const client = createChallengeClient({ now, ...clientOptions });
  const reach = clientOptions.fetchImpl ?? globalThis.fetch;
  let discovered = null; // { targets, at }

  // The load balancer is the source of truth: when DISCOVERY_URL is configured
  // and no fixed origin is given, the proxy asks the LB which PHP host to use and
  // refreshes that answer every ten minutes, so a changed backend URL needs no
  // redeploy.
  async function resolveTargets(selfOrigin) {
    if (fixedTargets.length) return fixedTargets;
    if (discovered && now() - discovered.at < discoveryTtlMs) return discovered.targets;
    const response = await reach(discoveryUrl, { headers: new Headers({ accept: "application/json" }) });
    if (!response.ok) throw new Error(`discovery answered ${response.status}`);
    const body = JSON.parse(await response.text());
    const targets = cleanOrigins([body?.data?.server]);
    if (!targets.length) throw new Error("discovery did not return a usable server");
    if (targets.includes(selfOrigin)) {
      throw new Error("discovery points at this proxy itself; set PHP_ORIGINS instead of DISCOVERY_URL");
    }
    discovered = { targets, at: now() };
    return targets;
  }

  const corsHeaders = (origin) => {
    const headers = new Headers({
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
      "Access-Control-Max-Age": "600",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    });
    // The site's own origins are echoed; anything else gets no CORS grant.
    if (origin && allowed.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
    return headers;
  };

  const json = (body, status, origin) => new Response(JSON.stringify(body), {
    status,
    headers: (() => {
      const headers = corsHeaders(origin);
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      return headers;
    })(),
  });

  const withCors = (upstream, origin) => {
    const headers = new Headers(upstream.headers);
    corsHeaders(origin).forEach((value, name) => headers.set(name, value));
    headers.set("Vary", "Origin");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  };

  // Opens in a browser and says whether every hop works, so a deployment can be
  // verified without a terminal.
  async function health(origin, selfOrigin) {
    const report = { ok: true, targets: [], cookie: null };
    let targets;
    try {
      targets = await resolveTargets(selfOrigin);
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error), targets: [], cookie: null }, 502, origin);
    }
    report.mode = fixedTargets.length ? "fixed" : "discovery";
    for (const target of targets) {
      const entry = { origin: target };
      const started = Date.now();
      try {
        const page = await reach(`${target}/api/videos?limit=1`, { headers: new Headers({ accept: "*/*" }) });
        const text = await page.text();
        entry.status = page.status;
        entry.challenge = isChallengePage(text, page.headers?.get?.("content-type") ?? "");
        if (entry.challenge) {
          const token = solveChallenge(text);
          entry.challengeSolved = Boolean(token);
          entry.tokenPreview = token ? `${token.slice(0, 6)}…` : null;
        }
        const { response } = await client.request(`${target}/api/videos?limit=1`);
        const body = JSON.parse(await response.text());
        entry.catalog = { ok: body?.ok === true, status: response.status, videos: body?.data?.videos?.length ?? 0 };
        entry.ms = Date.now() - started;
      } catch (error) {
        entry.error = String(error?.message ?? error);
        report.ok = false;
      }
      report.targets.push(entry);
    }
    const cookie = client.cookie;
    report.cookie = cookie
      ? { name: cookie.name, expiresInMinutes: Math.max(0, Math.round((cookie.expiresAt - Date.now()) / 60000)) }
      : null;
    return json(report, report.ok ? 200 : 502, origin);
  }

  async function forward(request, url, origin) {
    const path = url.pathname + url.search;
    let targets;
    try {
      targets = await resolveTargets(url.origin);
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 502, origin);
    }
    const finish = (response) => withCors(response, origin);
    const wantsCache = request.method === "GET" && THUMBNAIL_PATH.test(url.pathname) && cache;
    if (wantsCache) {
      const hit = await cache.match(request.url).catch(() => null);
      if (hit) return finish(hit);
    }
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "range", "if-range", "accept"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const init = {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    };
    for (const target of targets) {
      try {
        const { response } = await client.request(target + path, init);
        if (!response) continue;
        if (wantsCache && response.status === 200) {
          const cached = new Response(response.clone().body, response);
          cached.headers.set("Cache-Control", "public, max-age=86400");
          await cache.put(request.url, cached).catch(() => {});
        }
        return finish(response);
      } catch {
        // Fall through to the next origin; the last one reports the failure.
      }
    }
    return json({ ok: false, error: "backend unreachable" }, 502, origin);
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin") || "";
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
      if (url.pathname === "/__proxy-health") return health(origin, url.origin);
      // Discovery: the site asks where the API is, and the answer is this proxy,
      // so the browser never needs to reach the PHP host.
      if (url.pathname === "/api/get-server") return json({ ok: true, data: { server: url.origin } }, 200, origin);
      if (!url.pathname.startsWith("/api/")) return json({ ok: false, error: "not found" }, 404, origin);
      if (MEDIA_PATH.test(url.pathname) && !["GET", "HEAD"].includes(request.method)) {
        return json({ ok: false, error: "method not allowed" }, 405, origin);
      }
      return forward(request, url, origin);
    },
  };
}

// One proxy per isolate keeps the solved challenge cookie alive between
// requests; a cold isolate simply solves the check again.
const workerState = {};

export function sharedProxy(env) {
  if (!workerState.proxy) {
    const explicit = env?.PHP_ORIGINS ? String(env.PHP_ORIGINS).split(",").filter(Boolean) : [];
    const discoveryUrl = env?.DISCOVERY_URL ? String(env.DISCOVERY_URL) : null;
    workerState.proxy = createPhpProxy({
      // Fixed origins win; without them the proxy follows the load balancer.
      phpOrigins: explicit.length ? explicit : (discoveryUrl ? [] : DEFAULT_PHP_ORIGINS),
      discoveryUrl,
      allowedOrigins: env?.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(",") : DEFAULT_ALLOWED_ORIGINS,
    });
  }
  return workerState.proxy;
}

export default {
  fetch(request, env) {
    return sharedProxy(env).fetch(request);
  },
};
