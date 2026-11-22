# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-22

Windows support and compatibility with DeepSeek Harness 0.2.2. Tested on Windows 11 with
dsh 0.2.2-rc.5; CI covers Ubuntu, macOS and Windows on Node 22 and 24.

### Added
- Windows support (thanks to @apohl23-oss, #11): `dshBin` can be a `.cmd` shim (npm or the DeepSeek Harness desktop app); `which` tries `.exe`/`.cmd`/`.bat`; workers run without console windows; `cancel` ends the whole process tree through `System32\taskkill.exe`; skills are linked with junctions (no admin rights) and copied where a junction cannot reach. `dsho capture` stops hanging pages with `taskkill`, finds `python`/`py`, and prints UTF-8 on every console; `~\` paths expand like `~/`.
- `--access read-only|workspace-write|full` (config key `access`) picks the dsh sandbox for headless workers. Workers always run with `--approval-policy never`, so they no longer stall on approval prompts: actions the sandbox forbids are rejected and the model is told so (#1).
- An auto-selected web job falls back to headless when the DSH web UI fails before the task is sent.
- `provider` and `model` config keys (`DSHO_PROVIDER`, `DSHO_MODEL`) for the provider route and the default model of every job, shared by the headless and web backends; with `openrouter`, short DeepSeek names map to `deepseek/<id>` catalog ids (#11).
- `setup` copies the model provider settings (`llm-pi-ai`, `agent-default-model`) from the source profile into `orchestra`; `--no-llm` opts out (#11).
- Headless workers receive provider keys that the desktop or web app stored under `refs` in `~/.dsh/.credentials.yaml` (the environment wins) (#11).
- `ws init --force` replaces an existing `AGENTS.md` and keeps the previous one as `AGENTS.md.bak`.
- CI runs on Windows too; `.gitattributes` keeps LF line endings in every checkout.

### Fixed
- Web backend with dsh 0.2.2: the session cursor comes from the structured history API instead of an error message, which blocked every web job (#3).
- dsh 0.2.2 error reasons (`reason.error.code/message`) show up in `status`, `logs` and `result` instead of a bare "error"; an error turn's empty answer no longer hides the error.
- A later turn in the same web session can no longer overwrite an earlier job's `result.md` (#5).
- SIGTERM/SIGINT to a runner cancels its web turns and lets headless workers reach the SIGKILL escalation before it exits; jobs end as `cancelled` instead of `lost`, and a stopped batch starts no queued jobs (#6, #7).
- `setup --skills` removes links of an earlier selection from the curated skill folder (#8).
- `last` picks the newest job also when several jobs were created in the same millisecond (#9).
- `logs --stderr --json` prints a JSON object (#10).
- `ws init` no longer overwrites an existing `AGENTS.md` (#2).
- Install instructions: dsh-cli installs from GitHub (`npm install -g github:nicremo/dsh-cli`) until it is published on npm (#4).
- `npm test` runs on Windows (cmd.exe kept the single quotes of the test glob and ran no tests) (#11).

## [0.1.0] - 2026-10-07

### Added
- `run`, `batch`, `research` and `materials` to start DeepSeek Harness jobs in workspace folders, alone or as parallel batches.
- Web backend: jobs run as sessions inside a running DSH web UI (one workspace per batch, named sessions), with `ui start`, `ui login` and `ui`.
- Headless backend with the `orchestra` profile created by `setup` (research MCP servers copied from another profile, curated skills).
- `status`, `ls`, `wait`, `result`, `logs`, `files`, `continue`, `cancel`, `collect` with text and `--json` output and stable exit codes.
- `capture shot|scroll`: Playwright screenshots and frame-stepped 1080p scroll videos with cookie, overlay and ad handling plus a watchdog.
- `skill install`: the `dsh-orchestration` Agent Skill for Claude Code, Codex, OpenCode, Pi and other harnesses.
- `config`, `doctor`, `guide`, `ws init`.

[0.2.0]: https://github.com/nicremo/dsh-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nicremo/dsh-cli/releases/tag/v0.1.0
