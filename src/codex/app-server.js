import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { normalizeDecision } from "./decisions.js";

export const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export class CodexAppServer {
  constructor({
    spawnProcess = spawn,
    platform = process.platform,
    fetchImpl = fetch,
    approvalWebhookUrl = process.env.N8N_APPROVAL_WEBHOOK_URL || "",
    runnerPublicUrl = process.env.RUNNER_PUBLIC_URL || "",
    approvalSecret = process.env.APPROVAL_SECRET || "",
    approvalPolicy = process.env.CODEX_APPROVAL_POLICY || "on-request",
    approvalTimeoutMs = Number(process.env.APPROVAL_TIMEOUT_MS || 15 * 60 * 1000),
    taskTimeoutMs = Number(process.env.TASK_TIMEOUT_MS || 45 * 60 * 1000),
    clock = Date.now,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.fetchImpl = fetchImpl;
    this.approvalWebhookUrl = approvalWebhookUrl;
    this.runnerPublicUrl = runnerPublicUrl.replace(/\/+$/, "");
    this.approvalSecret = approvalSecret;
    this.approvalPolicy = approvalPolicy;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.taskTimeoutMs = taskTimeoutMs;
    this.clock = clock;

    this.child = null;
    this.lineReader = null;
    this.readyPromise = null;
    this.requestSequence = 0;
    this.pendingRequests = new Map();
    this.turns = new Map();
    this.pendingApprovals = new Map();
  }

  async start() {
    if (this.child && !this.child.killed && this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const child = this._spawnAppServer();
      let initialized = false;
      this.child = child;
      this.lineReader = readline.createInterface({ input: child.stdout });

      const fail = (error) => {
        if (!initialized) reject(error);
        this._failAll(error);
      };

      child.on("error", fail);
      child.on("close", (code, signal) => {
        this.child = null;
        this.readyPromise = null;
        fail(new Error(`Codex app-server exited (code=${code}, signal=${signal || "none"})`));
      });
      child.stderr.on("data", (data) => {
        const message = data.toString().trim();
        if (message) console.error(`[codex app-server] ${message}`);
      });
      this.lineReader.on("line", (line) => this._parseLine(line));

      this._initialize()
        .then(() => {
          initialized = true;
          resolve();
        })
        .catch(reject);
    });

    return this.readyPromise;
  }

  _spawnAppServer() {
    const options = { shell: this.platform === "win32", stdio: ["pipe", "pipe", "pipe"] };
    if (this.platform === "win32") {
      return this.spawnProcess("codex.cmd app-server --listen stdio://", options);
    }
    return this.spawnProcess("codex", ["app-server", "--listen", "stdio://"], options);
  }

  async _initialize() {
    await this._request("initialize", {
      clientInfo: {
        name: "n8n_codex_runner",
        title: "n8n Codex Runner",
        version: "1.0.0",
      },
    });
    this._send({ method: "initialized", params: {} });
  }

  _parseLine(line) {
    if (!line.trim()) return;
    try {
      this._handleMessage(JSON.parse(line));
    } catch (error) {
      console.error("Ignoring invalid Codex app-server output:", error.message);
    }
  }

  _nextRequestId() {
    this.requestSequence += 1;
    return `runner-${this.requestSequence}`;
  }

  _send(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params = {}) {
    const id = this._nextRequestId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      try {
        this._send({ method, id, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  _handleMessage(message) {
    if (message.id !== undefined && !message.method) {
      this._handleResponse(message);
      return;
    }
    if (message.id !== undefined && APPROVAL_METHODS.has(message.method)) {
      this._handleApprovalRequest(message).catch((error) => {
        console.error("Unable to handle Codex approval request:", error);
        this._cancelApprovalRequest(message, error).catch((cancelError) => {
          console.error("Unable to cancel failed Codex approval request:", cancelError);
        });
      });
      return;
    }
    if (message.method) this._handleNotification(message.method, message.params || {});
  }

  _handleResponse(message) {
    const pending = this.pendingRequests.get(String(message.id));
    if (!pending) return;
    this.pendingRequests.delete(String(message.id));
    if (message.error) {
      pending.reject(
        new Error(`${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`)
      );
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(method, params) {
    if (method === "item/completed") return this._recordCompletedItem(params);
    if (method === "turn/diff/updated") {
      const state = this.turns.get(params.turnId);
      if (state) state.diff = params.diff || "";
      return;
    }
    if (method === "error") {
      for (const state of this.turns.values()) {
        if (state.threadId === params.threadId) {
          state.errors.push(params.error?.message || "Unknown Codex error");
        }
      }
      return;
    }
    if (method === "turn/completed") this._completeTurn(params.turn || {});
  }

  _recordCompletedItem(params) {
    const item = params.item;
    const state = this.turns.get(params.turnId || item?.turnId);
    if (!state || !item) return;

    if (item.type === "agentMessage" && item.text) {
      state.agentMessages.push(item.text);
    } else if (item.type === "commandExecution") {
      state.commands.push({
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      });
    }
  }

  _completeTurn(turn) {
    const state = this.turns.get(turn.id);
    if (!state) return;
    clearTimeout(state.timeout);
    this.turns.delete(turn.id);
    state.resolve({
      taskId: state.taskId,
      threadId: state.threadId,
      turnId: turn.id,
      status: turn.status,
      output: state.agentMessages.join("\n\n").trim(),
      diff: state.diff,
      commands: state.commands,
      errors: state.errors,
      approvalCount: state.approvalCount,
      approvalWaitMs: state.approvalWaitMs,
      turnError: turn.error || null,
    });
  }

  async _handleApprovalRequest(message) {
    const params = message.params || {};
    const approvalId = randomUUID();
    const turnState = this.turns.get(params.turnId);
    const approval = {
      approvalId,
      rpcId: message.id,
      method: message.method,
      taskId: turnState?.taskId || null,
      project: turnState?.project || null,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason || null,
      command: params.command || null,
      cwd: params.cwd || null,
      grantRoot: params.grantRoot || null,
      availableDecisions: params.availableDecisions || null,
      requestedAt: this.clock(),
      timeout: null,
    };

    if (turnState) {
      turnState.approvalCount += 1;
      turnState.approvalStartedAt.set(approvalId, approval.requestedAt);
    }
    approval.timeout = setTimeout(() => {
      this.resolveApproval(approvalId, "cancel").catch((error) => {
        console.error("Unable to auto-cancel expired approval:", error);
      });
    }, this.approvalTimeoutMs);
    this.pendingApprovals.set(approvalId, approval);

    if (!this.approvalWebhookUrl) {
      await this.resolveApproval(approvalId, "cancel");
      return;
    }

    const response = await this.fetchImpl(this.approvalWebhookUrl, {
      method: "POST",
      headers: this._approvalHeaders(),
      body: JSON.stringify(this._approvalPayload(approval)),
    });
    if (!response.ok) throw new Error(`n8n approval webhook returned HTTP ${response.status}`);
  }

  async _cancelApprovalRequest(message, error) {
    const approval = Array.from(this.pendingApprovals.values()).find(
      (candidate) => candidate.rpcId === message.id
    );

    if (approval) {
      const turnState = this.turns.get(approval.turnId);
      if (turnState) {
        turnState.errors.push(`Approval delivery failed: ${error.message}`);
      }
      await this.resolveApproval(approval.approvalId, "cancel");
      return;
    }

    this._send({ id: message.id, result: { decision: "cancel" } });
  }

  _approvalHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this.approvalSecret) headers["X-Approval-Secret"] = this.approvalSecret;
    return headers;
  }

  _approvalPayload(approval) {
    return {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      project: approval.project,
      type:
        approval.method === "item/commandExecution/requestApproval" ? "command" : "fileChange",
      reason: approval.reason,
      command: approval.command,
      cwd: approval.cwd,
      grantRoot: approval.grantRoot,
      availableDecisions: approval.availableDecisions,
      approveUrl: this.runnerPublicUrl
        ? `${this.runnerPublicUrl}/approvals/${approval.approvalId}`
        : null,
    };
  }

  async resolveApproval(approvalId, decision) {
    const normalized = normalizeDecision(decision);
    if (!normalized) {
      throw createHttpError(
        400,
        "decision must be one of: accept, acceptForSession, decline, cancel"
      );
    }
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) throw createHttpError(404, "Approval not found or already resolved");

    clearTimeout(approval.timeout);
    this.pendingApprovals.delete(approvalId);
    this._recordApprovalWait(approval);
    this._send({ id: approval.rpcId, result: { decision: normalized } });
    return { approvalId, taskId: approval.taskId, decision: normalized, resolved: true };
  }

  _recordApprovalWait(approval) {
    const state = this.turns.get(approval.turnId);
    const startedAt = state?.approvalStartedAt.get(approval.approvalId);
    if (!state || startedAt === undefined) return;
    state.approvalWaitMs += Math.max(0, this.clock() - startedAt);
    state.approvalStartedAt.delete(approval.approvalId);
  }

  listPendingApprovals() {
    return Array.from(this.pendingApprovals.values()).map((approval) => ({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      project: approval.project,
      type:
        approval.method === "item/commandExecution/requestApproval" ? "command" : "fileChange",
      reason: approval.reason,
      command: approval.command,
      cwd: approval.cwd,
      requestedAt: approval.requestedAt,
    }));
  }

  async runTurn({ project, projectPath, task }) {
    await this.start();
    const taskId = randomUUID();
    const threadResult = await this._request("thread/start", {
      cwd: projectPath,
      approvalPolicy: this.approvalPolicy,
      sandbox: "workspace-write",
      serviceName: "n8n_codex_runner",
    });
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error("Codex thread/start did not return a thread id");

    const turnResult = await this._request("turn/start", {
      threadId,
      input: [{ type: "text", text: task }],
      cwd: projectPath,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [projectPath],
        networkAccess: false,
      },
    });
    const turnId = turnResult?.turn?.id;
    if (!turnId) throw new Error("Codex turn/start did not return a turn id");

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turns.delete(turnId);
        this._request("turn/interrupt", { threadId, turnId }).catch(() => {});
        reject(new Error(`Codex task timed out after ${this.taskTimeoutMs}ms`));
      }, this.taskTimeoutMs);

      this.turns.set(turnId, {
        taskId,
        project,
        threadId,
        turnId,
        startedAt: this.clock(),
        agentMessages: [],
        commands: [],
        diff: "",
        errors: [],
        approvalCount: 0,
        approvalWaitMs: 0,
        approvalStartedAt: new Map(),
        timeout,
        resolve,
        reject,
      });
    });
  }

  _failAll(error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    for (const state of this.turns.values()) {
      clearTimeout(state.timeout);
      state.reject(error);
    }
    this.turns.clear();
    for (const approval of this.pendingApprovals.values()) clearTimeout(approval.timeout);
    this.pendingApprovals.clear();
  }

  async stop() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.readyPromise = null;
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
