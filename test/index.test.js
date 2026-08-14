const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const { createApp, getProjectMap } = require("../index");

const projectPath = process.cwd();
const projectMap = { demo: projectPath };

function createTestApp(options = {}) {
  return createApp({ logResponse: async () => {}, clock: () => 0, ...options });
}

test("reads a project allowlist from JSON", () => {
  assert.deepEqual(getProjectMap('{"demo":"/workspaces/demo"}'), {
    demo: "/workspaces/demo",
  });
});

test("rejects a non-object project allowlist", () => {
  assert.throws(() => getProjectMap("[]"), {
    name: "TypeError",
    message: "PROJECTS_JSON must be a JSON object",
  });
});

function createChild({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
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
  const app = createTestApp({ projectMap, spawnProcess: assert.fail });
  const response = await post(app, { project: "unknown", task: "Do work" });

  assert.equal(response.status, 400);
  assert.deepEqual(response.bodyJson, { error: "Project not allowed" });
});

test("rejects a missing or non-string task", async (t) => {
  for (const task of [undefined, "", 123]) {
    await t.test(`task: ${String(task)}`, async () => {
      const app = createTestApp({ projectMap, spawnProcess: assert.fail });
      const response = await post(app, { project: "demo", task });

      assert.equal(response.status, 400);
      assert.deepEqual(response.bodyJson, { error: "Task is required" });
    });
  }
});

test("rejects a missing project directory before spawning Codex", async () => {
  const app = createTestApp({
    projectMap,
    spawnProcess: assert.fail,
    directoryExists: () => false,
  });
  const response = await post(app, { project: "demo", task: "Do work" });

  assert.equal(response.status, 400);
  assert.deepEqual(response.bodyJson, {
    error: "Project directory not found",
    project: "demo",
  });
});

test("runs Codex directly on non-Windows platforms", async () => {
  let invocation;
  const times = [1_000, 1_250];
  const spawnProcess = (...args) => {
    invocation = args;
    return createChild({ stdout: "Task complete" });
  };
  let loggedResult;
  const app = createTestApp({
    projectMap,
    spawnProcess,
    platform: "linux",
    clock: () => times.shift(),
    logResponse: async (result) => {
      loggedResult = result;
    },
  });
  const response = await post(app, { project: "demo", task: "Update README" });

  assert.equal(response.status, 200);
  assert.deepEqual(invocation, [
    "codex",
    ["exec", "--sandbox", "workspace-write", "Update README"],
    { cwd: projectPath, shell: false },
  ]);
  assert.deepEqual(response.bodyJson, {
    success: true,
    exitCode: 0,
    project: "demo",
    durationMs: 250,
    output: "Task complete",
    error: "",
  });
  assert.deepEqual(loggedResult, response.bodyJson);
});

test("runs codex.cmd on Windows and sends the task over stdin", async () => {
  let invocation;
  let stdin = "";
  const spawnProcess = (...args) => {
    invocation = args;
    const child = createChild({ stdout: "Task complete" });
    child.stdin.on("data", (chunk) => {
      stdin += chunk.toString();
    });
    return child;
  };
  const app = createTestApp({ projectMap, spawnProcess, platform: "win32" });
  const response = await post(app, {
    project: "demo",
    task: "Update README & do not run this as a shell command",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(invocation, [
    "codex.cmd exec --sandbox workspace-write -",
    { cwd: projectPath, shell: true },
  ]);
  assert.equal(stdin, "Update README & do not run this as a shell command");
  assert.equal(response.bodyJson.success, true);
});

test("returns a server error when Codex cannot be started", async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.emit("error", new Error("spawn codex ENOENT"));
    });
    return child;
  };
  const app = createTestApp({ projectMap, spawnProcess, platform: "linux" });
  const response = await post(app, { project: "demo", task: "Do work" });

  assert.equal(response.status, 500);
  assert.deepEqual(response.bodyJson, {
    success: false,
    project: "demo",
    durationMs: 0,
    output: "",
    error: "Unable to start Codex: spawn codex ENOENT",
  });
});

test("returns stderr and a failed status for a nonzero Codex exit", async () => {
  const spawnProcess = () =>
    createChild({ stderr: "Codex failed", exitCode: 2 });
  const app = createTestApp({ projectMap, spawnProcess, platform: "linux" });
  const response = await post(app, { project: "demo", task: "Fail" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.bodyJson, {
    success: false,
    exitCode: 2,
    project: "demo",
    durationMs: 0,
    output: "",
    error: "Codex failed",
  });
});
