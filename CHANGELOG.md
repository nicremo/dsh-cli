# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `setup` copies the model provider settings (`llm-pi-ai`, `agent-default-model`) from the source profile into `orchestra`; `--no-llm` opts out.
- `provider` and `model` config keys (`DSHO_PROVIDER`, `DSHO_MODEL`) for the provider route and the default model of every job, shared by the headless and web backends; with `openrouter`, short DeepSeek names map to `deepseek/<id>` catalog ids and other ids pass through unchanged.
- Headless workers receive provider keys that the desktop or web app stored under `refs` in `~/.dsh/.credentials.yaml` (the environment wins).

### Fixed
- Windows: `dshBin` can be a `.cmd` shim (npm or the DeepSeek Harness desktop app); `which` tries `.exe`/`.cmd`/`.bat`; workers run without console windows; `cancel` ends the whole process tree through `System32\taskkill.exe` and never signals a PID again once the worker has exited; skills are linked with junctions, which need no admin rights, and copied where a junction cannot reach (network shares).
- Tests run on Windows (no hard-coded `/` paths, CRLF checkouts, isolated home directory).

## [0.1.0] - 2026-10-07

### Added
- `run`, `batch`, `research` and `materials` to start DeepSeek Harness jobs in workspace folders, alone or as parallel batches.
- Web backend: jobs run as sessions inside a running DSH web UI (one workspace per batch, named sessions), with `ui start`, `ui login` and `ui`.
- Headless backend with the `orchestra` profile created by `setup` (research MCP servers copied from another profile, curated skills).
- `status`, `ls`, `wait`, `result`, `logs`, `files`, `continue`, `cancel`, `collect` with text and `--json` output and stable exit codes.
- `capture shot|scroll`: Playwright screenshots and frame-stepped 1080p scroll videos with cookie, overlay and ad handling plus a watchdog.
- `skill install`: the `dsh-orchestration` Agent Skill for Claude Code, Codex, OpenCode, Pi and other harnesses.
- `config`, `doctor`, `guide`, `ws init`.

[0.1.0]: https://github.com/nicremo/dsh-cli/releases/tag/v0.1.0
