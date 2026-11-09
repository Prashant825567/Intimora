import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createAppServer } from "../server/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();

function pngDimensions(image) {
  assert.deepEqual(image.subarray(0, 8), pngSignature);
  assert.equal(image.subarray(12, 16).toString(), "IHDR");
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

test("the static home page provides a consistent Google site name and crawlable icon links", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "WebSite structured data is present without executing JavaScript");
  const schema = JSON.parse(match[1]);
  assert.deepEqual(schema, {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Intimora",
    url: "https://intimora.new.tg/",
  });
  assert.match(html, /<title>Intimora\s*\|/);
  assert.match(html, /property="og:site_name"\s+content="Intimora"/);
  assert.match(html, /rel="icon"[^>]*type="image\/png"[^>]*sizes="16x16"[^>]*href="\/favicon-16\.png"/);
  assert.match(html, /rel="icon"[^>]*type="image\/png"[^>]*sizes="32x32"[^>]*href="\/favicon-32\.png"/);
  assert.match(html, /rel="icon"[^>]*type="image\/png"[^>]*sizes="192x192"[^>]*href="\/favicon-192\.png"/);
  assert.match(html, /rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/);
  assert.match(html, /name="robots"\s+content="index, follow"/);

  const robots = await readFile(path.join(root, "public/robots.txt"), "utf8");
  assert.match(robots, /User-agent:\s*\*/i);
  assert.match(robots, /Allow:\s*\//i);
  assert.doesNotMatch(robots, /Disallow:\s*\//i);
});

test("the requested site verification tag is present exactly once in the static head", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  assert.ok(head, "the page has a static head");
  assert.match(head, /<meta\s+name="6a97888e-site-verification"\s+content="f4423f712c6f1c15fb7fc4c833c8c020"\s*\/?\s*>/i);
  assert.equal((html.match(/name="6a97888e-site-verification"/g) || []).length, 1);
});

test("favicons have the expected square dimensions and a safe vector master", async () => {
  const smallFavicon = await readFile(path.join(root, "public/favicon-16.png"));
  const mediumFavicon = await readFile(path.join(root, "public/favicon-32.png"));
  const favicon = await readFile(path.join(root, "public/favicon-192.png"));
  const apple = await readFile(path.join(root, "public/apple-touch-icon.png"));
  const logo = await readFile(path.join(root, "public/logo.png"));
  assert.deepEqual(pngDimensions(smallFavicon), [16, 16]);
  assert.deepEqual(pngDimensions(mediumFavicon), [32, 32]);
  assert.deepEqual(pngDimensions(favicon), [192, 192]);
  assert.deepEqual(pngDimensions(apple), [180, 180]);
  assert.deepEqual(pngDimensions(logo), [512, 512]);
  const ico = await readFile(path.join(root, "public/favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const iconCount = ico.readUInt16LE(4);
  const sizes = Array.from({ length: iconCount }, (_, index) => ico[6 + index * 16]);
  for (const size of [16, 32, 48, 64]) assert.ok(sizes.includes(size), `${size}px browser icon is present`);

  const svg = await readFile(path.join(root, "public/logo.svg"), "utf8");
  assert.match(svg, /viewBox="0 0 128 128"/);
  assert.match(svg, /Intimora diamond/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b/i);
  assert.doesNotMatch(svg.replace("http://www.w3.org/2000/svg", ""), /https?:\/\//i);
});

test("the production server serves icons and robots.txt to crawler user agents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-branding-"));
  let server;
  try {
    await copyFile(path.join(root, "index.html"), path.join(directory, "index.html"));
    for (const file of ["logo.svg", "favicon-16.png", "favicon-32.png", "favicon-192.png", "favicon.ico", "apple-touch-icon.png", "robots.txt"]) {
      await copyFile(path.join(root, "public", file), path.join(directory, file));
    }
    await mkdir(path.join(directory, "licenses"));
    await copyFile(path.join(root, "public/licenses/Dancing-Script-OFL.txt"), path.join(directory, "licenses/Dancing-Script-OFL.txt"));
    server = createAppServer({ distDir: directory });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const paths = [
      ["/", "text/html"], ["/logo.svg", "image/svg+xml"], ["/favicon-16.png", "image/png"],
      ["/favicon-32.png", "image/png"], ["/favicon-192.png", "image/png"], ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/robots.txt", "text/plain"], ["/licenses/Dancing-Script-OFL.txt", "text/plain"],
    ];
    for (const [pathname, contentType] of paths) {
      const response = await fetch(`${base}${pathname}`, { headers: { "User-Agent": "Googlebot-Image" } });
      assert.equal(response.status, 200, pathname);
      assert.ok(response.headers.get("content-type").startsWith(contentType), pathname);
      if (pathname === "/") assert.match(response.headers.get("content-security-policy"), /script-src 'self' https:\/\/apis\.google\.com;/);
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("production CSP preserves the static site-name data block", { skip: !existsSync(browserPath) }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-branding-csp-"));
  let server;
  let browser;
  try {
    await copyFile(path.join(root, "index.html"), path.join(directory, "index.html"));
    server = createAppServer({ distDir: directory });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.brandCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.brandCspViolations.push(event.violatedDirective));
    });
    await page.route("**/src/main.tsx", (route) => route.fulfill({ contentType: "text/javascript", body: "// Site-name metadata is static." }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    const content = await page.locator('script[type="application/ld+json"]').textContent();
    assert.equal(JSON.parse(content).name, "Intimora");
    assert.deepEqual(await page.evaluate(() => window.brandCspViolations), []);
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
