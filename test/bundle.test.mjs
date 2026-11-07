import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(name) : [name];
  }));
  return nested.flat();
}

test("production bundle does not contain server configuration or VITE-prefixed values", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "intimora-bundle-"));
  const values = [
    "https://private-discovery.example/secret-marker-93846",
    "https://private-upstream.example/secret-marker-93846",
    "private-token-secret-marker-93846-0123456789",
    "vite-secret-marker-93846",
  ];
  try {
    await run("npm", ["run", "build", "--", "--outDir", output], {
      cwd: root,
      timeout: 120_000,
      env: {
        ...process.env,
        API_DISCOVERY_URL: values[0],
        API_PROXY_UPSTREAM: values[1],
        PROXY_TOKEN_SECRET: values[2],
        VITE_SECRET_TEST: values[3],
      },
    });
    for (const file of await allFiles(output)) {
      const data = await readFile(file);
      for (const value of values) assert.equal(data.includes(value), false, `private value in ${path.basename(file)}`);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
