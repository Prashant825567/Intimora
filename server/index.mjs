import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "./api-proxy.mjs";
import { applySecurityHeaders } from "./security.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function respond(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

function serveStatic(req, res, distDir) {
  if (req.method !== "GET" && req.method !== "HEAD") return respond(res, 405, "Method not allowed");
  try {
    const url = new URL(req.url || "/", "http://internal.invalid");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) {
      return respond(res, 404, "Not found");
    }
    if (pathname === "/" || /^\/watch\/[A-Za-z0-9_-]{1,128}\/?$/.test(pathname)) pathname = "/index.html";
    const extension = path.extname(pathname).toLowerCase();
    const contentType = contentTypes.get(extension);
    if (!contentType) return respond(res, 404, "Not found");

    const root = realpathSync(distDir);
    const file = realpathSync(path.resolve(root, `.${pathname}`));
    if (!file.startsWith(`${root}${path.sep}`)) return respond(res, 404, "Not found");
    const stat = statSync(file);
    if (!stat.isFile()) return respond(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : pathname === "/index.html" ? "no-store" : "public, max-age=3600",
    });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch {
    respond(res, 404, "Not found");
  }
}

export function createAppServer({ apiOptions, distDir = path.join(projectDir, "dist"), allowPreviewEmbed = false } = {}) {
  const apiHandler = createApiHandler(apiOptions);
  return createServer((req, res) => {
    applySecurityHeaders(res, { allowPreviewEmbed });
    if (req.headers["x-forwarded-proto"]?.split(",")[0].trim() === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    apiHandler(req, res, () => serveStatic(req, res, distDir));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const port = Number(process.env.PORT || 5173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    const server = createAppServer({ allowPreviewEmbed: process.env.ALLOW_PREVIEW_EMBED === "1" });
    server.listen(port, "0.0.0.0", () => console.log(`Intimora listening on port ${port}`));
  } catch {
    // Configuration can contain private URLs or secrets; do not print it.
    console.error("Unable to start Intimora. Check the server configuration.");
    process.exitCode = 1;
  }
}
