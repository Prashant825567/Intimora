import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// A plain static host: exact file, then `<path>.html`, then `<path>/index.html`,
// and finally the custom 404 page. There are deliberately no rewrite rules, so
// these tests prove direct links work without any host configuration.
export async function resolveStaticFile(directory, pathname) {
  const target = path.join(directory, pathname);
  if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) return null;
  try {
    if ((await stat(target)).isFile()) return { file: target, status: 200 };
  } catch { /* Try the next candidate. */ }
  for (const candidate of [`${target}.html`, path.join(target, "index.html")]) {
    try {
      if ((await stat(candidate)).isFile()) return { file: candidate, status: 200 };
    } catch { /* Try the next candidate. */ }
  }
  try {
    const fallback = path.join(directory, "404.html");
    if ((await stat(fallback)).isFile()) return { file: fallback, status: 404 };
  } catch { /* No custom 404 page. */ }
  return null;
}

export function createStaticHost(directory) {
  return createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain" }).end("Bad Request");
      return;
    }
    const resolved = await resolveStaticFile(directory, pathname);
    if (!resolved) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
      return;
    }
    response.writeHead(resolved.status, {
      "Content-Type": types[path.extname(resolved.file)] || "application/octet-stream",
    });
    createReadStream(resolved.file).pipe(response);
  });
}
