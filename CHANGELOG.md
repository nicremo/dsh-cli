# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
