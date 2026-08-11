# Codex CLI Runner

A small local HTTP bridge that lets tools such as [n8n](https://n8n.io/) submit tasks to the [Codex CLI](https://developers.openai.com/codex/cli/). The server maps a trusted project alias to an allowlisted directory and starts `codex exec` there with workspace-write sandboxing enabled.

## How it works

1. A client sends a project alias and task to `POST /codex`.
2. The server resolves the alias from the local `projects` allowlist.
3. It runs `codex exec --sandbox workspace-write <task>` in that project directory.
4. When Codex exits, the server returns its standard output, standard error, and exit code as JSON.

The Codex process is invoked with `spawn()` and `shell: false`, so the submitted task is passed as a single process argument instead of being interpolated into a shell command.

## Requirements

- Node.js 18 or newer
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

Edit the `projects` object in `index.js` so every public alias points to a directory Codex is allowed to modify:

```js
const projects = {
  "resume-web": "D:\\Projects\\resume-web",
  "backend": "D:\\Projects\\backend-api",
};
```

Start the server:

```powershell
node index.js
```

The API listens on `http://127.0.0.1:3001`. Binding to `127.0.0.1` keeps it accessible only from the local machine.

## API

### `POST /codex`

Request body:

```json
{
  "project": "resume-web",
  "task": "Add a print-friendly stylesheet and verify the existing build"
}
```

Example request with curl:

```powershell
curl.exe -X POST http://127.0.0.1:3001/codex `
  -H "Content-Type: application/json" `
  -d '{"project":"resume-web","task":"Add a print-friendly stylesheet"}'
```

Example successful response:

```json
{
  "success": true,
  "exitCode": 0,
  "project": "resume-web",
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
  "project": "resume-web",
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
