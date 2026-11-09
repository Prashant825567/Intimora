import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public discovery configuration is bundled, while unsafe URLs fail without leaking their value", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-public-build-"));
  try {
    const publicUrl = "https://discovery.example/api/get-server";
    await run("npm", ["run", "build", "--", "--outDir", output], {
      cwd: root, timeout: 120_000, env: { ...process.env, INTIMORA_PUBLIC_API_DISCOVERY_URL: publicUrl },
    });
    const assets = await readdir(path.join(output, "assets"));
    const js = await Promise.all(assets.filter((name) => name.endsWith(".js")).map((name) => readFile(path.join(output, "assets", name), "utf8")));
    assert.ok(js.some((content) => content.includes(publicUrl)), "the endpoint is intentionally public");
    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(html, /"@type":\s*"WebSite"/);
    assert.match(html, /"name":\s*"Intimora"/);
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    assert.ok(head, "the built HTML has a head");
    assert.match(head, /<meta\s+name="6a97888e-site-verification"\s+content="f4423f712c6f1c15fb7fc4c833c8c020"\s*\/?\s*>/i);
    assert.equal((html.match(/name="6a97888e-site-verification"/g) || []).length, 1);
    assert.match(head, /<meta\s+name="juicyads-site-verification"\s+content="c7a81b4796e08427b06a280d95a76a9a"\s*\/?\s*>/i);
    assert.equal((html.match(/name="juicyads-site-verification"/g) || []).length, 1);
    for (const file of ["favicon-16.png", "favicon-32.png", "favicon-192.png", "favicon.ico", "apple-touch-icon.png", "logo.svg", "robots.txt", "sitemap.xml"]) {
      assert.ok((await readFile(path.join(output, file))).length > 0, `${file} is published`);
    }
    assert.match(await readFile(path.join(output, "sitemap.xml"), "utf8"), /<loc>https:\/\/intimora\.new\.tg\/<\/loc>/);
    const verification = await readFile(path.join(output, "f4423f712c6f1c15fb7fc4c833c8c020.html"));
    assert.equal(createHash("sha256").update(verification).digest("hex"), "338cf2a6211bfad50c5b806bc3b8a2df53f0549e593a6d2ae9279cb4708ae985");
    assert.deepEqual(verification, await readFile(path.join(root, "public/f4423f712c6f1c15fb7fc4c833c8c020.html")));
    assert.ok(js.some((content) => content.includes("intimora-app.firebaseapp.com")), "the public Firebase web app is bundled");

    const secret = "secret-query-marker-0123456789";
    let error;
    try {
      await run("npm", ["run", "build", "--", "--outDir", output], {
        cwd: root, timeout: 120_000,
        env: { ...process.env, INTIMORA_PUBLIC_API_DISCOVERY_URL: `https://discovery.example/api/get-server?token=${secret}` },
      });
    } catch (caught) { error = caught; }
    assert.ok(error, "credential-bearing discovery URLs must be rejected at build time");
    assert.match(`${error.stdout}\n${error.stderr}`, /Invalid public discovery URL/);
    assert.ok(!`${error.stdout}\n${error.stderr}`.includes(secret), "build errors must not print the invalid value");

    error = undefined;
    try {
      await run("npm", ["run", "build", "--", "--outDir", output], {
        cwd: root, timeout: 120_000,
        env: { ...process.env, INTIMORA_PUBLIC_API_DISCOVERY_URL: publicUrl, INTIMORA_PUBLIC_AUTH_BACKENDS: `https://api.example/?token=${secret}` },
      });
    } catch (caught) { error = caught; }
    assert.ok(error, "credential-bearing token destinations must be rejected at build time");
    assert.match(`${error.stdout}\n${error.stderr}`, /Invalid trusted auth backend configuration/);
    assert.ok(!`${error.stdout}\n${error.stderr}`.includes(secret), "auth configuration errors must not print the invalid value");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Render Blueprint describes a static site with watch/account rewrites and a scoped Firebase CSP", async () => {
  const yaml = await readFile(path.join(root, "render.yaml"), "utf8");
  assert.match(yaml, /runtime:\s*static/);
  assert.match(yaml, /staticPublishPath:\s*\.\/dist/);
  assert.match(yaml, /source:\s*\/watch\/\*/);
  for (const route of ["login", "profile", "referral", "dashboard"]) {
    assert.match(yaml, new RegExp(`source:\\s*\\/${route}\\n\\s*destination:\\s*\\/index\\.html`));
    assert.match(yaml, new RegExp(`source:\\s*\\/${route}\\/\\n\\s*destination:\\s*\\/index\\.html`));
  }
  assert.match(yaml, /script-src 'self' https:\/\/apis\.google\.com;/);
  assert.match(yaml, /frame-src 'self' https:\/\/intimora-app\.firebaseapp\.com https:\/\/accounts\.google\.com;/);
  assert.match(yaml, /connect-src 'self' https:/);
  assert.match(yaml, /media-src 'self' blob: https:/);
  assert.doesNotMatch(yaml, /startCommand:/);
});
