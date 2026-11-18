import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const TOKEN = "7f39af6b9db948ab9b104841acf7115e";

// Cloudflare Web Analytics is the only visitor counter on the site: it is
// cookie-less, so an 18+ site needs no consent banner for it, and it is served
// by Cloudflare itself. The beacon is a build-time part of index.html.
test("the visitor counter is in the document head", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const beacons = head.match(/static\.cloudflareinsights\.com\/beacon\.min\.js/g) ?? [];
  assert.equal(beacons.length, 1, "exactly one beacon: a second copy counts every visit twice");
  assert.match(head, /data-cf-beacon='\{"token": "([0-9a-f]{32})"\}'/, "the beacon carries the site token");
  assert.ok(head.includes(TOKEN), "the token is the one registered for this site");
  assert.match(head, /type="module"/, "Cloudflare ships an ES module, not a classic script");
});

test("the counter never ships a tracker that needs a consent banner", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  for (const vendor of ["googletagmanager.com", "google-analytics.com", "connect.facebook.net", "plausible.io"]) {
    assert.equal(html.includes(vendor), false, `${vendor} would need consent handling this site does not have`);
  }
});

test("the beacon is not part of the application bundle", async () => {
  const vite = await readFile(new URL("vite.config.ts", root), "utf8");
  assert.equal(/cloudflareinsights/.test(vite), false, "the beacon stays a plain tag in index.html, so a CSP or budget change stays visible");
});

test("both production CSPs allow the beacon script", async () => {
  const security = await readFile(new URL("server/security.mjs", root), "utf8");
  const yaml = await readFile(new URL("render.yaml", root), "utf8");
  const expected = "script-src 'self' https://apis.google.com https://static.cloudflareinsights.com";
  for (const [name, source] of [["server/security.mjs", security], ["render.yaml", yaml]]) {
    assert.ok(source.includes(expected), `${name} must allow the beacon script`);
    assert.ok(source.includes("connect-src 'self' https:"), `${name} must allow the beacon's report`);
    assert.equal(source.includes("script-src *"), false, `${name} must not fall back to a wildcard script source`);
    assert.equal(/script-src[^;]*unsafe-eval/.test(source), false, `${name} must not loosen to unsafe-eval`);
  }
});
