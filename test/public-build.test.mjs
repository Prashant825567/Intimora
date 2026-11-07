import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Render Blueprint describes a static site with a watch rewrite and direct-access CSP", async () => {
  const yaml = await readFile(path.join(root, "render.yaml"), "utf8");
  assert.match(yaml, /runtime:\s*static/);
  assert.match(yaml, /staticPublishPath:\s*\.\/dist/);
  assert.match(yaml, /source:\s*\/watch\/\*/);
  assert.match(yaml, /destination:\s*\/index\.html/);
  assert.match(yaml, /connect-src 'self' https:/);
  assert.match(yaml, /media-src 'self' blob: https:/);
  assert.doesNotMatch(yaml, /startCommand:/);
});
