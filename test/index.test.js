const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const { createApp } = require("../index");

const projectMap = { demo: "D:\\Projects\\demo" };

function createChild({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  process.nextTick(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", exitCode);
  });

  return child;
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function post(app, body) {
  let response;

  await withServer(app, async (baseUrl) => {
    response = await fetch(`${baseUrl}/codex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    response.bodyJson = await response.json();
  });

  return response;
}

test("rejects a project outside the allowlist", async () => {
  const app = createApp({ projectMap, spawnProcess: assert.fail });
  const response = await post(app, { project: "unknown", task: "Do work" });

  assert.equal(response.status, 400);
  assert.deepEqual(response.bodyJson, { error: "Project not allowed" });
});

test("rejects a missing or non-string task", async (t) => {
  for (const task of [undefined, "", 123]) {
    await t.test(`task: ${String(task)}`, async () => {
      const app = createApp({ projectMap, spawnProcess: assert.fail });
      const response = await post(app, { project: "demo", task });

      assert.equal(response.status, 400);
      assert.deepEqual(response.bodyJson, { error: "Task is required" });
    });
  }
});

test("runs Codex with the expected arguments and returns its output", async () => {
  let invocation;
  const spawnProcess = (...args) => {
    invocation = args;
    return createChild({ stdout: "Task complete" });
  };
  const app = createApp({ projectMap, spawnProcess });
  const response = await post(app, { project: "demo", task: "Update README" });

  assert.equal(response.status, 200);
  assert.deepEqual(invocation, [
    "codex",
    ["exec", "--sandbox", "workspace-write", "Update README"],
    { cwd: "D:\\Projects\\demo", shell: false },
  ]);
  assert.deepEqual(response.bodyJson, {
    success: true,
    exitCode: 0,
    project: "demo",
    output: "Task complete",
    error: "",
  });
});

test("returns stderr and a failed status for a nonzero Codex exit", async () => {
  const spawnProcess = () =>
    createChild({ stderr: "Codex failed", exitCode: 2 });
  const app = createApp({ projectMap, spawnProcess });
  const response = await post(app, { project: "demo", task: "Fail" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.bodyJson, {
    success: false,
    exitCode: 2,
    project: "demo",
    output: "",
    error: "Codex failed",
  });
});
