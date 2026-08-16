import express from "express";
import { existsSync } from "node:fs";

import { CodexAppServer } from "../codex/app-server.js";
import { DEFAULT_PROJECTS } from "../config.js";
import { writeCodexLog } from "../logger.js";

export function createApp({
  projectMap = DEFAULT_PROJECTS,
  directoryExists = existsSync,
  logResponse = writeCodexLog,
  clock = Date.now,
  codexServer = new CodexAppServer({ clock }),
  approvalSecret = process.env.APPROVAL_SECRET || "",
} = {}) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      success: true,
      codexAppServerRunning: Boolean(codexServer.child && !codexServer.child.killed),
      pendingApprovals: codexServer.pendingApprovals.size,
      activeTurns: codexServer.turns.size,
    });
  });

  app.get("/approvals", requireApprovalSecret(approvalSecret), (_req, res) => {
    res.json({ approvals: codexServer.listPendingApprovals() });
  });

  app.post(
    "/approvals/:approvalId",
    requireApprovalSecret(approvalSecret),
    async (req, res) => {
      try {
        const result = await codexServer.resolveApproval(
          req.params.approvalId,
          req.body?.decision
        );
        res.json(result);
      } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
      }
    }
  );

  app.post("/codex", async (req, res) => {
    const { project, task } = req.body;
    const projectPath = projectMap[project];

    if (!projectPath) return res.status(400).json({ error: "Project not allowed" });
    if (!directoryExists(projectPath)) {
      return res.status(400).json({ error: "Project directory not found", project });
    }
    if (!task || typeof task !== "string" || !task.trim()) {
      return res.status(400).json({ error: "Task is required" });
    }

    const normalizedTask = task.trim();
    const approvalPolicy = codexServer.approvalPolicy || "on-request";
    const startedAt = clock();
    try {
      const turn = await codexServer.runTurn({ project, projectPath, task: normalizedTask });
      const durationMs = Math.max(0, clock() - startedAt);
      const result = formatTurnResult({ project, turn, durationMs });
      await safelyLog(logResponse, { task: normalizedTask, approvalPolicy, ...result });
      res.json(result);
    } catch (error) {
      const result = {
        success: false,
        project,
        durationMs: Math.max(0, clock() - startedAt),
        output: "",
        error: error.message,
      };
      await safelyLog(logResponse, { task: normalizedTask, approvalPolicy, ...result });
      res.status(500).json(result);
    }
  });

  return app;
}

export function requireApprovalSecret(secret) {
  return (req, res, next) => {
    if (secret && req.get("X-Approval-Secret") !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}

export function formatTurnResult({ project, turn, durationMs }) {
  return {
    success: turn.status === "completed",
    project,
    taskId: turn.taskId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    status: turn.status,
    durationMs,
    codexActiveMs: Math.max(0, durationMs - turn.approvalWaitMs),
    approvalWaitMs: turn.approvalWaitMs,
    approvalCount: turn.approvalCount,
    output: turn.output,
    diff: turn.diff,
    commands: turn.commands,
    error: turn.turnError || (turn.errors.length ? turn.errors.join("\n") : ""),
  };
}

async function safelyLog(logResponse, result) {
  try {
    await logResponse(result);
  } catch (error) {
    console.error("Unable to write Codex log:", error);
  }
}
