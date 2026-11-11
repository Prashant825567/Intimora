import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verification = "f4423f712c6f1c15fb7fc4c833c8c020.html";

test("local production server serves account deep links and the unchanged root verification file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-account-routing-"));
  let server;
  try {
    await copyFile(path.join(root, "index.html"), path.join(directory, "index.html"));
    await copyFile(path.join(root, "public", verification), path.join(directory, verification));
    server = createAppServer({ distDir: directory });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const pathname of ["/login", "/profile", "/referral", "/dashboard", "/login/", "/profile/", "/referral/", "/dashboard/", "/trending", "/new/", "/exclusive", "/categories/", "/search?q=cats%20%26%20dogs", "/watch/video-1", "/watch/video-1/"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 200, pathname);
      assert.match(await response.text(), /<div id="root"><\/div>/);
      const csp = response.headers.get("content-security-policy");
      assert.match(csp, /script-src 'self' https:\/\/apis\.google\.com;/);
      assert.match(csp, /frame-src 'self' https:\/\/intimora-app\.firebaseapp\.com https:\/\/accounts\.google\.com https:\/\/hdzog\.com https:\/\/desi-porntube\.com;/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
    const response = await fetch(`${base}/${verification}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, "public", verification)));
    const head = await fetch(`${base}/trending`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type"), /^text\/html/);
    assert.equal(await head.text(), "");
    for (const pathname of ["/dashboard/private", "/assets/missing.js", "/.env", "/watch/invalid%2Fid"]) {
      assert.equal((await fetch(`${base}${pathname}`)).status, 404, pathname);
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production identity adapter uses Firebase's Google account chooser without redirect fallback", async () => {
  const source = await readFile(path.join(root, "src/services/firebase.ts"), "utf8");
  assert.match(source, /new GoogleAuthProvider\(\)/);
  assert.match(source, /prompt:\s*"select_account"/);
  assert.match(source, /signInWithPopup\(auth, provider\)/);
  assert.doesNotMatch(source, /signInWithRedirect/);
});
