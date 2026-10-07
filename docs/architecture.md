# Architecture

dsh-cli is a small Node ESM program without a daemon. Every command reads and writes plain JSON under `~/.dsho/` (or `DSHO_HOME`), so any agent can inspect state with ordinary file tools.

## Modules

| File | Responsibility |
|---|---|
| `bin/dsho.mjs` | entry point for `dsho` and `dsh-cli` |
| `src/cli.mjs` | argument parsing (`node:util.parseArgs`), command handlers, text and JSON output, exit codes |
| `src/store.mjs` | jobs and batches as JSON files, reference resolution (`last`, prefixes, names), `lost` detection |
| `src/runner.mjs` | runs one job on its backend; detached re-invocation (`__run-job`, `__run-batch`) |
| `src/supervisor.mjs` | runs a batch with a fixed pool of workers |
| `src/dsh.mjs` | finds dsh (binary, source checkout, override) and builds the headless command line |
| `src/web.mjs` | client for the DSH web UI HTTP API, token and cookie handling, event translation |
| `src/events.mjs` | folds the headless `--json` event stream into progress, usage and a timeline |
| `src/templates.mjs` | worker prompts for research and material jobs, workspace `AGENTS.md` |
| `src/collect.mjs` | merges batch results into `INDEX.md`, `manifest.json`, `sources.json` |
| `src/profile.mjs` | `setup` (the `orchestra` profile) and `doctor` |
| `src/skills.mjs` | installs the bundled Agent Skill |
| `src/config.mjs` | `~/.dsho/config.json` with environment overrides |
| `capture/capture.py` | Playwright screenshots and frame-stepped scroll videos |

## Lifecycle of a job

1. A start command (`run`, `batch`, `research`, `materials`, `continue`) resolves the backend (`auto` picks the web UI when it answers an authenticated request), creates the workspace folder and writes `job.json` plus `task.md` (the exact prompt, prefixed with the job's working folder).
2. It spawns itself detached (`dsho __run-job <id>` or `__run-batch <id>`, own session, stdio to `~/.dsho/logs/`) and returns. The owner pid is stored on the job; a queued or running job whose owner died is reported as `lost`.
3. The runner executes the job on its backend and keeps `job.json` current (status, session id, steps, tool calls, token usage). Cancellation is a marker file (`cancel`) in the job folder, so no two processes race on `job.json`.
4. The final answer lands in `result.md`; the status becomes `done`, `failed`, `timeout` or `cancelled`.

Batches use one supervisor process with a pool of `--parallel` workers; the first wave is staggered by 400 ms so parallel headless boots do not race on npm caches.

## Headless backend

`dsh --profile orchestra --json [--session-id <id>] -` in the job folder, task on stdin. stdout is appended to `events.jsonl` and folded into progress; stderr goes to `stderr.log`. A model override writes a per-job copy of `~/.dsh/settings.yaml` and passes `--patch` with a `settings` row that points at it. `continue` passes `--session-id`, which dsh only accepts from the same working folder.

## Web UI backend

The DSH web UI exposes unary Remote methods over HTTP: `POST /api/<namespace>/<method>` with the envelope

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/create", "payload": { "args": { "request": { } } } }
```

and answers `{ "type": "server-response", "rpcId", "result": { "ok": true, "value" } }`. Authentication: the URL printed by `dsh web` carries a launch token; `GET /?token=...` answers 303 with a signed cookie valid for 30 days.

A web job calls:

1. `workspace/create { path }`: registers the workspace folder or returns the existing workspace for it.
2. `session/create { workspaceId }`: a session inside that workspace (its cwd is the workspace folder, so batch jobs share it and get their own subfolder through the prompt).
3. `session/rename { sessionId, title }` and, for `-m` / `--effort`, `session/selectModel`.
4. `session/prompt { requestId, sessionId, mode: "queue", content: [{ type: "text", text }] }`.
5. Polling: the newest event sequence number comes from `session/page` (the error "past cursor N" names it), then `session/page { address, throughSeq, beforeSeq }` returns the new events. The user message whose `source.rpcId` equals the request id marks the start of our turn; the next `turn/end` ends the job.
6. `session/cancel { sessionId }` for cancellation and time limits.

Durable session events (`assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end`) are translated into the headless vocabulary (`text`, `tool_call`, `tool_result`, `status`, `final`), so `logs`, `status` and `result` do not care which backend ran a job.

Streaming methods such as `session/follow` need the UI's WebSocket carrier, which is why dsh-cli polls.

## Captures

`capture shot` loads the page in Playwright's bundled Chromium (never the installed Chrome), dismisses consent dialogs in the page and in consent iframes, closes modal overlays, hides fixed layers that cover the content, blocks known ad networks by URL pattern and disables WebGL. `capture scroll` scrolls the page once to trigger lazy loading, then renders one JPEG per frame at an exact scroll position (ease in and out, speed capped) and encodes H.264 with ffmpeg. A watchdog kills the driver and the browser process group when a page hangs.

## Tests

`npm test` runs `node:test` suites against a fake `dsh` (`test/fake-dsh.mjs`, behaviour driven by markers like `SLEEP 5`, `FAIL`, `WRITE file`) and an in-process fake web UI (`test/fake-web.mjs`). Tests isolate `DSHO_HOME`, force the headless backend where needed and never reach a real DSH installation.
