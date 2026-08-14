# Codex CLI Runner

A small local HTTP bridge that lets tools such as [n8n](https://n8n.io/) submit tasks to the [Codex CLI](https://developers.openai.com/codex/cli/). The server maps a trusted project alias to an allowlisted directory and starts `codex exec` there with workspace-write sandboxing enabled.

## How it works

1. A client sends a project alias and task to `POST /codex`.
2. The server resolves the alias from the local `projects` allowlist.
3. It runs `codex exec --sandbox workspace-write <task>` in that project directory.
4. When Codex exits, the server returns its standard output, standard error, and exit code as JSON.

On macOS and Linux, the Codex process is invoked with `spawn()` and `shell: false`, so the submitted task is passed as a single process argument instead of being interpolated into a shell command.

On Windows, the runner invokes `codex.cmd` through the Windows command processor. The task itself is sent through standard input so it is not interpolated into the shell command.

## Requirements

- Node.js 22 or newer
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

Edit the `projects` object in `index.js` so every public alias points to an absolute directory that Codex is allowed to modify. For example, on Windows:

```js
const projects = {
  "my-website": "C:\\path\\to\\my-website",
  "my-api": "C:\\path\\to\\my-api",
};
```

The directory must already exist. The runner returns `Project directory not found` when an alias points to a missing path.

On macOS or Linux, use absolute POSIX paths instead:

```js
const projects = {
  "my-website": "/path/to/my-website",
  "my-api": "/path/to/my-api",
};
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

Every completed Codex process writes a separate JSON file to `logs/`, including successful results, nonzero exits, and process-start errors. Each entry contains the timestamp, project alias, success status, total runtime in `durationMs`, standard output, standard error, and exit code when available.

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
  "exitCode": 0,
  "project": "my-website",
  "output": "...Codex output...",
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

Codex execution failures are represented by `success: false`, a nonzero `exitCode`, and details in `error`. The current server returns that result with HTTP `200` after the child process exits.

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

- Project paths, host, and port are configured directly in `index.js`.
- Only one synchronous request/response workflow is provided; there is no queue or job status endpoint.
- No timeout, request-size policy beyond Express defaults, cancellation, or output-size limit is configured.
- Child-process startup errors are not currently returned through a dedicated handler.
- No automated tests are included yet.

## License

[ISC](https://opensource.org/license/isc-license-txt)
