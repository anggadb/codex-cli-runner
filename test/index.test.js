import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp, getProjectMap } from "../index.js";
import { normalizeDecision } from "../src/codex/decisions.js";

const projectPath = process.cwd();
const projectMap = { demo: projectPath };

function createFakeCodexServer(overrides = {}) {
  return {
    child: null,
    pendingApprovals: new Map(),
    turns: new Map(),
    listPendingApprovals: () => [],
    resolveApproval: async (approvalId, decision) => ({ approvalId, decision, resolved: true }),
    runTurn: async () => ({
      taskId: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      output: "Task complete",
      diff: "",
      commands: [],
      errors: [],
      approvalCount: 0,
      approvalWaitMs: 0,
      turnError: null,
    }),
    ...overrides,
  };
}

function createTestApp(options = {}) {
  return createApp({
    projectMap,
    codexServer: createFakeCodexServer(),
    logResponse: async () => {},
    clock: () => 0,
    ...options,
  });
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

async function request(app, pathname, { method = "GET", body, headers = {} } = {}) {
  let result;
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    result = { status: response.status, body: await response.json() };
  });
  return result;
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

test("normalizes only supported approval decisions", () => {
  assert.equal(normalizeDecision("accept"), "accept");
  assert.equal(normalizeDecision("acceptForSession"), "acceptForSession");
  assert.equal(normalizeDecision("approve"), null);
});

test("reports app-server health", async () => {
  const codexServer = createFakeCodexServer({
    child: { killed: false },
    pendingApprovals: new Map([["approval-1", {}]]),
    turns: new Map([["turn-1", {}]]),
  });
  const response = await request(createTestApp({ codexServer }), "/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    codexAppServerRunning: true,
    pendingApprovals: 1,
    activeTurns: 1,
  });
});

test("validates project aliases, directories, and tasks", async (t) => {
  await t.test("unknown project", async () => {
    const response = await request(createTestApp(), "/codex", {
      method: "POST",
      body: { project: "unknown", task: "Do work" },
    });
    assert.deepEqual(response, { status: 400, body: { error: "Project not allowed" } });
  });

  await t.test("missing directory", async () => {
    const response = await request(createTestApp({ directoryExists: () => false }), "/codex", {
      method: "POST",
      body: { project: "demo", task: "Do work" },
    });
    assert.deepEqual(response, {
      status: 400,
      body: { error: "Project directory not found", project: "demo" },
    });
  });

  await t.test("blank task", async () => {
    const response = await request(createTestApp(), "/codex", {
      method: "POST",
      body: { project: "demo", task: "   " },
    });
    assert.deepEqual(response, { status: 400, body: { error: "Task is required" } });
  });
});

test("runs a Codex turn, formats timing, and logs the response", async () => {
  const times = [1_000, 1_400];
  let invocation;
  let logged;
  const codexServer = createFakeCodexServer({
    runTurn: async (input) => {
      invocation = input;
      return {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        output: "Done",
        diff: "diff",
        commands: [{ command: ["npm", "test"], status: "completed" }],
        errors: [],
        approvalCount: 1,
        approvalWaitMs: 150,
        turnError: null,
      };
    },
  });
  const app = createTestApp({
    codexServer,
    clock: () => times.shift(),
    logResponse: async (result) => {
      logged = result;
    },
  });
  const response = await request(app, "/codex", {
    method: "POST",
    body: { project: "demo", task: "  Update README  " },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(invocation, { project: "demo", projectPath, task: "Update README" });
  assert.equal(response.body.durationMs, 400);
  assert.equal(response.body.codexActiveMs, 250);
  assert.equal(response.body.approvalWaitMs, 150);
  assert.deepEqual(logged, {
    task: "Update README",
    approvalPolicy: "on-request",
    ...response.body,
  });
  assert.equal(response.body.task, undefined);
});

test("logs and returns Codex turn failures", async () => {
  let logged;
  const codexServer = createFakeCodexServer({
    runTurn: async () => {
      throw new Error("Codex unavailable");
    },
  });
  const response = await request(
    createTestApp({ codexServer, logResponse: async (result) => (logged = result) }),
    "/codex",
    { method: "POST", body: { project: "demo", task: "Do work" } }
  );

  assert.equal(response.status, 500);
  assert.equal(response.body.error, "Codex unavailable");
  assert.deepEqual(logged, {
    task: "Do work",
    approvalPolicy: "on-request",
    ...response.body,
  });
  assert.equal(response.body.task, undefined);
});

test("protects and resolves approval endpoints", async () => {
  const codexServer = createFakeCodexServer({
    listPendingApprovals: () => [{ approvalId: "approval-1" }],
  });
  const app = createTestApp({ codexServer, approvalSecret: "secret" });

  const unauthorized = await request(app, "/approvals");
  assert.equal(unauthorized.status, 401);

  const listed = await request(app, "/approvals", {
    headers: { "X-Approval-Secret": "secret" },
  });
  assert.deepEqual(listed.body, { approvals: [{ approvalId: "approval-1" }] });

  const resolved = await request(app, "/approvals/approval-1", {
    method: "POST",
    headers: { "X-Approval-Secret": "secret" },
    body: { decision: "accept" },
  });
  assert.deepEqual(resolved.body, {
    approvalId: "approval-1",
    decision: "accept",
    resolved: true,
  });
});
