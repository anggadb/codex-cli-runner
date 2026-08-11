const express = require("express");
const { spawn } = require("child_process");

const projects = {
  "resume-web": "D:\\Projects\\your-folder-path",
};

function createApp({ projectMap = projects, spawnProcess = spawn } = {}) {
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

    if (!task || typeof task !== "string") {
      return res.status(400).json({
        error: "Task is required",
      });
    }

  // IMPORTANT:
  // spawn() passes arguments directly to Codex.
  // We're NOT constructing a CMD command from Telegram input.
    const child = spawnProcess(
      "codex",
      ["exec", "--sandbox", "workspace-write", task],
      {
        cwd: projectPath,
        shell: false,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      res.json({
        success: code === 0,
        exitCode: code,
        project,
        output: stdout,
        error: stderr,
      });
    });
  });

  return app;
}

if (require.main === module) {
  createApp().listen(3001, "127.0.0.1", () => {
    console.log("Codex runner listening on http://127.0.0.1:3001");
  });
}

module.exports = { createApp };
