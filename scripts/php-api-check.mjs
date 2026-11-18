#!/usr/bin/env node
// Full end-to-end check of a PHP Intivora backend that sits behind the
// InfinityFree browser check.
//
//   node scripts/php-api-check.mjs                       # default: api2
//   node scripts/php-api-check.mjs https://intimora-api3.site.je
//   node scripts/php-api-check.mjs https://a.site.je https://b.site.je --writes
//
// It solves the host's challenge the same way scripts/php-challenge.mjs does, then walks every
// endpoint the site calls and prints PASS/FAIL per row. Nothing is written
// unless --writes is passed (the share endpoint increments a counter).
import { pathToFileURL } from "node:url";
import { createChallengeClient, isChallengePage, solveChallenge } from "./php-challenge.mjs";

const DEFAULT_ORIGINS = ["https://intimora-api2.site.je"];
const ROWS = [];

function parseArgs(argv) {
  const origins = [];
  let writes = false;
  for (const value of argv.slice(2)) {
    if (value === "--writes") writes = true;
    else if (value === "--help" || value === "-h") origins.length = 0;
    else origins.push(value);
  }
  return { origins: origins.length ? origins : (process.env.PHP_ORIGIN ? [process.env.PHP_ORIGIN] : DEFAULT_ORIGINS), writes };
}

function record(origin, name, ok, detail) {
  ROWS.push({ origin, name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

async function checkOrigin(origin, { writes }) {
  console.log(`\n=== ${origin}`);
  const client = createChallengeClient();
  const request = async (path, init = {}) => {
    const url = `${origin}${path}`;
    const started = Date.now();
    const { response, attempts } = await client.request(url, init);
    return { response, ms: Date.now() - started, attempts };
  };

  // 1. The challenge itself must be solvable on its own first.
  let challengeOk = false;
  try {
    const raw = await fetch(origin + "/api/videos?limit=1", { headers: { accept: "*/*" } });
    const text = await raw.text();
    const type = raw.headers.get("content-type") || "";
    if (!isChallengePage(text, type)) {
      challengeOk = true;
      record(origin, "challenge page", true, `no challenge (content-type: ${type || "none"})`);
    } else {
      const token = solveChallenge(text);
      challengeOk = Boolean(token);
      record(origin, "challenge solved", challengeOk, token ? `__test=${token.slice(0, 8)}… (${token.length} chars)` : "no token");
    }
  } catch (error) {
    record(origin, "challenge page", false, error.message);
  }
  if (!challengeOk) {
    record(origin, "cookie reuse", false, "skipped: challenge unsolved");
    return;
  }

  // 2. Catalog: the two calls the home page makes.
  let firstId = null;
  try {
    const { response, ms } = await request("/api/videos?limit=2");
    const { json } = await readJson(response);
    const videos = json?.data?.videos ?? [];
    firstId = videos[0]?.id ?? null;
    record(origin, "GET /api/videos?limit=2", response.status === 200 && json?.ok === true && videos.length > 0,
      `${response.status} · ${videos.length} video(s) · nextCursor=${json?.data?.nextCursor ?? "-"} · ${ms} ms`);
    if (json?.data?.nextCursor) {
      const page = await request(`/api/videos?limit=2&cursor=${json.data.nextCursor}`);
      const pageJson = (await readJson(page.response)).json;
      record(origin, "GET /api/videos?cursor=…", page.response.status === 200 && pageJson?.ok === true,
        `${page.response.status} · ${pageJson?.data?.videos?.length ?? 0} video(s)`);
    }
    record(origin, "cookie reused (no second challenge)", client.cookie !== null,
      client.cookie ? `expires in ${Math.round((client.cookie.expiresAt - Date.now()) / 60000)} min` : "no cookie kept");
  } catch (error) {
    record(origin, "GET /api/videos?limit=2", false, error.message);
  }

  if (firstId) {
    try {
      const { response } = await request(`/api/videos/${encodeURIComponent(firstId)}`);
      const { json } = await readJson(response);
      record(origin, `GET /api/videos/${firstId}`, response.status === 200 && json?.ok === true,
        `${response.status} · ${json?.data?.video?.title ? "title ok" : "no title field"}`);
    } catch (error) {
      record(origin, "GET /api/videos/<id>", false, error.message);
    }
    try {
      const { response } = await request("/api/search?q=test");
      const { json } = await readJson(response);
      record(origin, "GET /api/search?q=test", response.status === 200 && json?.ok === true,
        `${response.status} · ${json?.data?.videos?.length ?? 0} result(s)`);
    } catch (error) {
      record(origin, "GET /api/search?q=test", false, error.message);
    }
    try {
      const { response } = await request(`/api/likes/counts?ids=${encodeURIComponent(firstId)}`);
      const { json } = await readJson(response);
      record(origin, "GET /api/likes/counts", response.status === 200 && json?.ok === true, `${response.status}`);
    } catch (error) {
      record(origin, "GET /api/likes/counts", false, error.message);
    }
    // 3. Media: thumbnails are images, streams must support Range for seeking.
    try {
      const { response, ms } = await request(`/api/videos/${encodeURIComponent(firstId)}/thumbnail`);
      const buffer = await response.arrayBuffer();
      const type = response.headers.get("content-type") || "";
      record(origin, "GET /api/videos/<id>/thumbnail", response.status === 200 && type.startsWith("image/") && buffer.byteLength > 0,
        `${response.status} · ${type || "no type"} · ${Math.round(buffer.byteLength / 1024)} KB · ${ms} ms`);
    } catch (error) {
      record(origin, "thumbnail", false, error.message);
    }
    try {
      const { response } = await request(`/api/videos/${encodeURIComponent(firstId)}/stream`, { headers: { range: "bytes=0-2047" } });
      const accepts = response.headers.get("accept-ranges");
      const length = response.headers.get("content-range") || response.headers.get("content-length");
      await response.arrayBuffer();
      record(origin, "GET /api/videos/<id>/stream (Range)", response.status === 206 || response.status === 200,
        `${response.status} · accept-ranges=${accepts ?? "none"} · ${response.status === 206 ? "seeking ok" : "no 206"} · ${length ?? ""}`);
    } catch (error) {
      record(origin, "stream range", false, error.message);
    }
  }

  // 4. Auth endpoints must answer 401 JSON (not HTML) when no token is sent.
  for (const [path, method] of [["/api/auth/verify", "POST"], ["/api/auth/me", "GET"], ["/api/auth/profile", "GET"], ["/api/user/referrals", "GET"]]) {
    try {
      const { response } = await request(path, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        body: method === "POST" ? "{}" : undefined,
      });
      const { json, text } = await readJson(response);
      const isJson = json !== null;
      record(origin, `${method} ${path} (no token)`,
        isJson && [200, 400, 401, 403].includes(response.status),
        `${response.status} · ${isJson ? `ok=${json?.ok}` : `HTML/plain: ${text.slice(0, 40).replace(/\s+/g, " ")}`}`);
    } catch (error) {
      record(origin, `${method} ${path}`, false, error.message);
    }
  }

  if (writes && firstId) {
    try {
      const { response } = await request(`/api/videos/${encodeURIComponent(firstId)}/share`, { method: "POST" });
      const { json } = await readJson(response);
      record(origin, "POST /api/videos/<id>/share", response.status === 200 && json?.ok === true, `${response.status}`);
    } catch (error) {
      record(origin, "POST share", false, error.message);
    }
  }

  // 5. Informational: the free host sends no CORS header, which is why the site
  //    has to talk to the Worker instead of the PHP host directly.
  try {
    const probe = await fetch(origin + "/api/videos?limit=1", { headers: { origin: "https://intimora.new.tg", accept: "*/*" } });
    const allow = probe.headers.get("access-control-allow-origin");
    console.log(`  INFO  CORS header for https://intimora.new.tg: ${allow ?? "missing (expected — the Worker adds it)"}`);
  } catch { /* informational only */ }
}

async function main() {
  const { origins, writes } = parseArgs(process.argv);
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node scripts/php-api-check.mjs [origin...] [--writes]");
    return 0;
  }
  for (const origin of origins) {
    try {
      await checkOrigin(origin.replace(/\/+$/, ""), { writes });
    } catch (error) {
      record(origin, "connection", false, error.message);
    }
  }
  const failed = ROWS.filter((row) => !row.ok);
  console.log(`\n${ROWS.length - failed.length}/${ROWS.length} checks passed`);
  if (failed.length) {
    console.log("Failed:");
    for (const row of failed) console.log(`  - ${row.origin} ${row.name}: ${row.detail}`);
    return 1;
  }
  return 0;
}

// Only run when invoked directly, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { checkOrigin, parseArgs, ROWS };
