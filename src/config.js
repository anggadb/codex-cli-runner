export const DEFAULT_PROJECTS = { "resume-web": "D:\\Projects\\your-folder-path" };

export function getProjectMap(value = process.env.PROJECTS_JSON) {
  if (!value) return DEFAULT_PROJECTS;
  const projectMap = JSON.parse(value);
  if (!projectMap || Array.isArray(projectMap) || typeof projectMap !== "object") {
    throw new TypeError("PROJECTS_JSON must be a JSON object");
  }
  return projectMap;
}

export function getRuntimeConfig(env = process.env) {
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3001),
    approvalSecret: env.APPROVAL_SECRET || "",
  };
}

export function getCodexConfig(env = process.env) {
  return {
    approvalWebhookUrl: env.N8N_APPROVAL_WEBHOOK_URL || "",
    runnerPublicUrl: env.RUNNER_PUBLIC_URL || "",
    approvalSecret: env.APPROVAL_SECRET || "",
    approvalPolicy: env.CODEX_APPROVAL_POLICY || "on-request",
    approvalTimeoutMs: Number(env.APPROVAL_TIMEOUT_MS || 15 * 60 * 1000),
    taskTimeoutMs: Number(env.TASK_TIMEOUT_MS || 45 * 60 * 1000),
  };
}
