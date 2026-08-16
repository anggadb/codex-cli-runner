import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexAppServer } from "../src/codex/app-server.js";

test("starts codex.cmd through a fixed Windows shell command", () => {
  let invocation;
  const expectedChild = {};
  const server = new CodexAppServer({
    platform: "win32",
    spawnProcess: (...args) => {
      invocation = args;
      return expectedChild;
    },
  });

  assert.equal(server._spawnAppServer(), expectedChild);
  assert.deepEqual(invocation, [
    "codex.cmd app-server --listen stdio://",
    { shell: true, stdio: ["pipe", "pipe", "pipe"] },
  ]);
});

test("resolves an approval using its original JSON-RPC id and records wait time", async () => {
  let written = "";
  const server = new CodexAppServer({ clock: () => 175 });
  server.child = {
    killed: false,
    stdin: {
      writable: true,
      write: (value) => {
        written += value;
      },
    },
  };

  const timeout = setTimeout(() => {}, 60_000);
  server.pendingApprovals.set("approval-1", {
    approvalId: "approval-1",
    rpcId: "rpc-9",
    taskId: "task-1",
    turnId: "turn-1",
    timeout,
  });
  const turn = {
    approvalWaitMs: 25,
    approvalStartedAt: new Map([["approval-1", 100]]),
  };
  server.turns.set("turn-1", turn);

  const result = await server.resolveApproval("approval-1", "accept");

  assert.deepEqual(result, {
    approvalId: "approval-1",
    taskId: "task-1",
    decision: "accept",
    resolved: true,
  });
  assert.deepEqual(JSON.parse(written), {
    id: "rpc-9",
    result: { decision: "accept" },
  });
  assert.equal(turn.approvalWaitMs, 100);
  assert.equal(server.pendingApprovals.size, 0);
});

test("uses the schema-specific sandbox variants for thread and turn requests", async () => {
  const requests = [];
  const server = new CodexAppServer();
  server.start = async () => {};
  server._request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };

  const resultPromise = server.runTurn({
    project: "demo",
    projectPath: "C:\\Projects\\demo",
    task: "Update README",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].method, "thread/start");
  assert.equal(requests[0].params.approvalPolicy, "on-request");
  assert.equal(requests[0].params.sandbox, "workspace-write");
  assert.equal(requests[1].method, "turn/start");
  assert.equal(requests[1].params.approvalPolicy, "on-request");
  assert.equal(requests[1].params.sandboxPolicy.type, "workspaceWrite");

  server._handleNotification("turn/completed", {
    turn: { id: "turn-1", status: "completed" },
  });
  await resultPromise;
});

test("cleans up and records webhook delivery failures before cancelling approval", async () => {
  let written = "";
  const server = new CodexAppServer({ clock: () => 250 });
  server.child = {
    killed: false,
    stdin: {
      writable: true,
      write: (value) => {
        written += value;
      },
    },
  };
  const turn = {
    errors: [],
    approvalWaitMs: 0,
    approvalStartedAt: new Map(),
  };
  server.turns.set("turn-1", turn);
  const timeout = setTimeout(() => {}, 60_000);
  server.pendingApprovals.set("approval-1", {
    approvalId: "approval-1",
    rpcId: "rpc-10",
    taskId: "task-1",
    turnId: "turn-1",
    timeout,
  });
  turn.approvalStartedAt.set("approval-1", 100);

  await server._cancelApprovalRequest(
    { id: "rpc-10" },
    new Error("n8n approval webhook returned HTTP 500")
  );

  assert.equal(server.pendingApprovals.size, 0);
  assert.equal(turn.approvalWaitMs, 150);
  assert.deepEqual(turn.errors, [
    "Approval delivery failed: n8n approval webhook returned HTTP 500",
  ]);
  assert.deepEqual(JSON.parse(written), {
    id: "rpc-10",
    result: { decision: "cancel" },
  });
});
