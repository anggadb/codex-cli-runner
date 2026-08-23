import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { clearCodexLogs } from "../src/logger.js";

test("clears only regular JSON files directly inside the logs directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-runner-logs-"));
  try {
    await writeFile(path.join(directory, "first.json"), "{}", "utf8");
    await writeFile(path.join(directory, "keep.txt"), "keep", "utf8");
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "nested", "nested.json"), "{}", "utf8");

    assert.deepEqual(await clearCodexLogs(directory), { deleted: 1 });
    assert.deepEqual((await readdir(directory)).sort(), ["keep.txt", "nested"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats a missing logs directory as empty", async () => {
  const directory = path.join(os.tmpdir(), `missing-codex-logs-${Date.now()}`);
  assert.deepEqual(await clearCodexLogs(directory), { deleted: 0 });
});
