# Codex CLI Runner

A local HTTP bridge that lets tools such as [n8n](https://n8n.io/) submit tasks to the [Codex CLI](https://developers.openai.com/codex/cli/). It maintains a Codex app-server session, maps trusted project aliases to allowlisted directories, and forwards command or file-change approval requests to n8n.

## Project structure

```text
index.js                    ESM entry point and public exports
src/config.js               Environment and project-map configuration
src/logger.js               JSON execution log writer
src/server.js               Process startup and graceful shutdown
src/codex/app-server.js     Codex JSON-RPC session and approval lifecycle
src/codex/decisions.js      Approval decision validation
src/http/create-app.js      Express routes and response formatting
test/index.test.js          HTTP and service-boundary tests
```

The HTTP layer depends on a `codexServer` interface rather than creating child processes inside route handlers. This keeps route tests isolated from the installed Codex CLI and centralizes persistent JSON-RPC state in one service.

## How it works

1. A client sends a project alias and task to `POST /codex`.
2. The server resolves the alias from the local `projects` allowlist.
3. A persistent Codex app-server starts a thread and turn in that directory with workspace-write sandboxing.
4. Approval requests are sent to the configured n8n webhook and remain pending until `/approvals/:approvalId` receives a decision.
5. When the turn completes, the server returns the output, diff, commands, approval timing, and execution timing as JSON.

On Windows, the runner starts `codex.cmd app-server`; on macOS, Linux, and Docker it starts `codex app-server` directly.

## Requirements

- Node.js 24 or newer (modern ECMAScript 2026 baseline)
- npm
- Codex CLI installed and available as `codex` on `PATH`
- Codex CLI authenticated and ready to run

Verify the prerequisites:

```powershell
node --version
npm --version
codex --version
```

## Setup

Clone the repository and install its dependencies:

```powershell
git clone https://github.com/anggadb/codex-cli-runner.git
cd codex-cli-runner
npm install
```

Set `PROJECTS_JSON` in `.env` so every public alias points to an absolute directory that Codex is allowed to modify. For example, on Windows:

```dotenv
PROJECTS_JSON={"my-website":"C:\\path\\to\\my-website","my-api":"C:\\path\\to\\my-api"}
```

The directory must already exist. The runner returns `Project directory not found` when an alias points to a missing path.

On macOS or Linux, use absolute POSIX paths instead:

```dotenv
PROJECTS_JSON={"my-website":"/path/to/my-website","my-api":"/path/to/my-api"}
```

Start the server:

```powershell
npm start
```

`npm start` loads `.env` when the file exists. Variables already present in the process environment take precedence. The API listens on `http://127.0.0.1:3001` by default, which keeps it accessible only from the local machine.

## Docker

Copy the example environment file and edit its host paths:

```powershell
Copy-Item .env.example .env
```

- `PROJECT_PATH` is the host project directory exposed to Codex.
- `CODEX_HOME_PATH` is the host Codex configuration directory containing your existing authentication.
- `PROJECTS_JSON` maps API aliases to paths inside the container. Its paths must match the volume targets in `compose.yaml`.
- `PORT` controls the host port; Compose publishes it on `127.0.0.1` only.

Build and start the service:

```powershell
docker compose up --build -d
docker compose logs -f codex-runner
```

Confirm that Codex is installed inside the container:

```powershell
docker compose exec codex-runner codex --version
```

Stop the service with `docker compose down`. To allow more projects, add a volume for each host directory and add its container path to `PROJECTS_JSON`.

## Execution logs

Every completed Codex turn writes a separate JSON file to `logs/`. Each entry contains its timestamp, identifiers, project alias, submitted task, status, timing, output, diff, commands, approval metrics, and any error. The task is stored in the log only and is not added to the HTTP response.

The `logs/` directory is ignored by Git. Docker Compose mounts the same host directory at `/app/logs`, so container logs persist locally without being included in the image or repository.

## API

### `POST /codex`

Request body:

```json
{
  "project": "my-website",
  "task": "Add a print-friendly stylesheet and verify the existing build"
}
```

Example request with curl:

```powershell
curl.exe -X POST http://127.0.0.1:3001/codex `
  -H "Content-Type: application/json" `
  -d '{"project":"my-website","task":"Add a print-friendly stylesheet"}'
```

Example successful response:

```json
{
  "success": true,
  "project": "my-website",
  "taskId": "...",
  "threadId": "...",
  "turnId": "...",
  "status": "completed",
  "durationMs": 1250,
  "output": "...Codex output...",
  "diff": "",
  "commands": [],
  "error": ""
}
```

Validation failures return HTTP `400`:

```json
{
  "error": "Project not allowed"
}
```

```json
{
  "error": "Task is required"
}
```

Codex execution failures are represented by `success: false` with details in `error`.

## n8n configuration

Use an **HTTP Request** node with:

- Method: `POST`
- URL: `http://127.0.0.1:3001/codex`
- Body Content Type: `JSON`
- Body:

```json
{
  "project": "my-website",
  "task": "={{ $json.task }}"
}
```

If n8n runs in Docker, `127.0.0.1` refers to the n8n container rather than the host. The server binding and n8n URL will need to be adjusted for that network topology, with authentication added before exposing the service beyond localhost.

## Security notes

- Keep the server bound to localhost unless you add authentication, authorization, rate limiting, and transport security.
- Only add trusted directories to the `projects` allowlist.
- Treat anyone who can call this endpoint as able to instruct Codex to modify allowlisted workspaces.
- `workspace-write` limits Codex through its sandbox, but tasks can still make substantial changes inside the selected workspace.
- Output is buffered in memory and the HTTP request remains open until Codex exits. This implementation is best suited to short, local automation jobs.

## Current limitations

- Only one synchronous request/response workflow is provided; there is no queue or job status endpoint.
- There is no request-size policy beyond Express defaults, cancellation endpoint, or output-size limit.
- Child-process startup errors are not currently returned through a dedicated handler.

## License

[ISC](https://opensource.org/license/isc-license-txt)
