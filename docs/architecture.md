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
3. The runner executes the job on its backend and keeps `job.json` current (status, session id, steps, tool calls, token usage). Cancellation is a marker file (`cancel`) in the job folder, so no two processes race on `job.json`. State files are written to a temp file and renamed into place; on Windows the rename (and a read) is retried while another process holds the file open.
4. The final answer lands in `result.md`; the status becomes `done`, `failed`, `timeout` or `cancelled`.

Batches use one supervisor process with a pool of `--parallel` workers; the first wave is staggered by 400 ms so parallel headless boots do not race on npm caches.

SIGTERM or SIGINT to a runner (`__run-job`, `__run-batch`) is a graceful stop: it writes the cancel markers of its running jobs and of the batch, sends SIGTERM to headless dsh processes and `session/cancel` to web turns, and then lets the job loops finish. A headless worker that ignores SIGTERM gets SIGKILL after 5 s, before the runner exits; queued batch jobs are recorded as `cancelled` without starting. After 25 s the runner exits regardless. Windows has no process groups: dsh-cli ends worker trees with `System32\taskkill.exe /T /F`.

An auto-selected web job (`--backend auto`, `backendChoice: "auto"` on the job) that fails before its task reached the UI (server gone, incompatible API) is switched to headless and run again in its own folder; the reason is kept in `fallbackFrom`.

## Headless backend

`dsh --profile orchestra --json [--session-id <id>] [--permission-mode <preset>] --approval-policy never -` in the job folder, task on stdin. Workers run unattended, so approvals are never asked: an action that needs one is rejected and the model is told so. `--access` maps to the permission preset (`read-only`, `workspace-write`, `danger-full-access`); the web API has no unary method to set a session's preset, which is why `--access` implies the headless backend. On Windows, npm's `dsh.cmd` shim is read and its script started with node directly (Node cannot spawn `.cmd` files without a shell). stdout is appended to `events.jsonl` and folded into progress; stderr goes to `stderr.log`. A model override writes a per-job copy of `~/.dsh/settings.yaml` and passes `--patch` with a `settings` row that points at it. `continue` passes `--session-id`, which dsh only accepts from the same working folder.

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
5. Polling: the newest event sequence number is the `cursor` of `session/page { address }` without `throughSeq` (dsh 0.2.2+; older servers named it in the error for an out-of-range `throughSeq`, which stays as a fallback), then `session/page { address, throughSeq, beforeSeq }` returns the new events. The user message whose `source.rpcId` equals the request id marks the start of our turn; events are translated up to and including the next `turn/end`, which ends the job, so later turns in the same session never reach it.
6. `session/cancel { sessionId }` for cancellation and time limits.

Durable session events (`assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end`) are translated into the headless vocabulary (`text`, `tool_call`, `tool_result`, `status`, `final`), so `logs`, `status` and `result` do not care which backend ran a job. Turn end reasons carry `code` and `message` directly (dsh up to 0.2.1) or under `reason.error` (0.2.2); both are understood.

Streaming methods such as `session/follow` need the UI's WebSocket carrier, which is why dsh-cli polls.

## Captures

`capture shot` loads the page in Playwright's bundled Chromium (never the installed Chrome), dismisses consent dialogs in the page and in consent iframes, closes modal overlays, hides fixed layers that cover the content, blocks known ad networks by URL pattern and disables WebGL. `capture scroll` scrolls the page once to trigger lazy loading, then renders one JPEG per frame at an exact scroll position (ease in and out, speed capped) and encodes H.264 with ffmpeg. A watchdog kills the driver and the browser process group when a page hangs (on Windows: `taskkill /T` on each child of the capture process). Scroll locks of modals are lifted with `overflow: visible`; `overflow: auto` on both `html` and `body` would make `body` its own scroll box and `window.scrollTo` a no-op.

## Tests

`npm test` runs `node:test` suites (60 s timeout per test, about 10 s in total) on macOS, Linux and Windows. Tests sit at three seams:

- **The CLI process** (`node bin/dsho.mjs ...`): stdout in text and `--json`, exit codes, and what a second `dsho` process reads from the stored state. `cli.test.mjs`, `batch.test.mjs`, `setup.test.mjs`, `web.test.mjs`.
- **The dsh boundary**: `test/fake-dsh.mjs` stands in for headless dsh (markers in the task like `SLEEP 5`, `FAIL`, `CRASH`, `WRITE file`, `IGNORE-SIGTERM`; it logs argv, cwd and env of every start) and `test/fake-web.mjs` for the DSH web UI HTTP API, with both the structured (0.2.2+) and the legacy `session/page` cursor contract (`DSHO_TEST_WEB_CONTRACT=legacy` switches the default).
- **Pure helpers** with non-trivial logic: `events.test.mjs`, `dsh.test.mjs`, `store.test.mjs`, `profile.test.mjs`, `windows.test.mjs`, `skills.test.mjs`.

`test/helpers.mjs` gives every test its own sandbox: private `DSHO_HOME`, `DSH_HOME`, home directory (`HOME` and `USERPROFILE`), agent skill folders and workspaces, removed afterwards. No test reaches the real `~/.dsho`, `~/.dsh`, `~/.agents`, `~/.claude` or a real DSH installation. Waiting is done by polling for a condition with a deadline, never by fixed sleeps.
