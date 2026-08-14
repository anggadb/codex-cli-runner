const express = require("express");
const { spawn } = require("child_process");
const { existsSync } = require("fs");
const { mkdir, writeFile } = require("fs/promises");
const { randomUUID } = require("crypto");
const path = require("path");

const projects = {
  "resume-web": "D:\\Projects\\your-folder-path",
};

function getProjectMap(value = process.env.PROJECTS_JSON) {
  if (!value) return projects;

  const projectMap = JSON.parse(value);
  if (!projectMap || Array.isArray(projectMap) || typeof projectMap !== "object") {
    throw new TypeError("PROJECTS_JSON must be a JSON object");
  }

  return projectMap;
}

async function writeCodexLog(result, logDirectory = path.join(__dirname, "logs")) {
  const timestamp = new Date().toISOString();
  const filename = `${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const entry = { timestamp, ...result };

  await mkdir(logDirectory, { recursive: true });
  await writeFile(
    path.join(logDirectory, filename),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8"
  );
}

function createApp({
  projectMap = projects,
  spawnProcess = spawn,
  platform = process.platform,
  directoryExists = existsSync,
  logResponse = writeCodexLog,
  clock = Date.now,
} = {}) {
  const app = express();
  app.use(express.json());

  app.post("/codex", (req, res) => {
    const { project, task } = req.body;

    // Validate project alias
    const projectPath = projectMap[project];

    if (!projectPath) {
      return res.status(400).json({
        error: "Project not allowed",
      });
    }

    if (!directoryExists(projectPath)) {
      return res.status(400).json({
        error: "Project directory not found",
        project,
      });
    }

    if (!task || typeof task !== "string") {
      return res.status(400).json({
        error: "Task is required",
      });
    }

    const isWindows = platform === "win32";
    const startedAt = clock();
    const child = isWindows
      ? spawnProcess("codex.cmd exec --sandbox workspace-write -", {
          cwd: projectPath,
          shell: true,
        })
      : spawnProcess(
          "codex",
          ["exec", "--sandbox", "workspace-write", task],
          { cwd: projectPath, shell: false }
        );

    // A .cmd executable requires the Windows command processor. Keep the
    // untrusted task out of that command line and send it over stdin instead.
    if (isWindows) {
      child.stdin.on("error", () => {});
      child.stdin.end(task);
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", async (error) => {
      if (settled) return;
      settled = true;

      const result = {
        success: false,
        project,
        durationMs: Math.max(0, clock() - startedAt),
        output: stdout,
        error: `Unable to start Codex: ${error.message}`,
      };

      try {
        await logResponse(result);
      } catch (logError) {
        console.error("Unable to write Codex log:", logError);
      }

      res.status(500).json(result);
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;

      const result = {
        success: code === 0,
        exitCode: code,
        project,
        durationMs: Math.max(0, clock() - startedAt),
        output: stdout,
        error: stderr,
      };

      try {
        await logResponse(result);
      } catch (logError) {
        console.error("Unable to write Codex log:", logError);
      }

      res.json(result);
    });
  });

  return app;
}

if (require.main === module) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3001);

  createApp({ projectMap: getProjectMap() }).listen(port, host, () => {
    console.log(`Codex runner listening on http://${host}:${port}`);
  });
}

module.exports = { createApp, getProjectMap, writeCodexLog };
