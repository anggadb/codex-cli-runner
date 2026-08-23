import { CodexAppServer } from "./codex/app-server.js";
import { getCodexConfig, getProjectMap, getRuntimeConfig } from "./config.js";
import { createApp } from "./http/create-app.js";

export function startServer({ env = process.env, codexServer } = {}) {
  const { host, port, logsSecret } = getRuntimeConfig(env);
  const appServer = codexServer ?? new CodexAppServer(getCodexConfig(env));

  appServer.start().catch((error) => {
    console.error("Unable to start Codex app-server:", error);
  });

  const app = createApp({
    projectMap: getProjectMap(env.PROJECTS_JSON),
    codexServer: appServer,
    approvalSecret: env.APPROVAL_SECRET || "",
    logsSecret,
  });
  const server = app.listen(port, host, () => {
    console.log(`Codex runner listening on http://${host}:${port}`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    server.close();
    await appServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, codexServer: appServer, server, shutdown };
}
