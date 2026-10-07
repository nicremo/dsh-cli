# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Setup

```sh
git clone https://github.com/nicremo/dsh-cli && cd dsh-cli
npm install
npm test
```

The test suite uses a fake `dsh` (`test/fake-dsh.mjs`) and a fake DSH web server (`test/fake-web.mjs`). It never talks to a real DeepSeek Harness, never reads your `~/.dsho` and needs no API key. Run it before every pull request.

## Guidelines

- Node 22.19 or newer, ESM only, `node:` prefixes for builtins, no new runtime dependencies without a good reason.
- Every command keeps three promises: it never blocks on input, it supports `--json`, and it uses the documented exit codes.
- Keep logic in `src/` deterministic and testable; add a test for every bug fix and every new flag.
- Never print or log secrets. Profile files that may contain API keys are written with mode 0600.
- User-facing text is English, short and concrete.
- Update `README.md`, `src/guide.mjs`, `skills/dsh-orchestration/SKILL.md` and `CHANGELOG.md` when behaviour changes.

## Pull requests

1. Fork and create a branch (`feat/...`, `fix/...`, `docs/...`).
2. Keep commits focused, messages in the form `feat: ...`, `fix: ...`, `docs: ...`.
3. Describe what changed and how you tested it.

## Reporting bugs

Open an issue with your OS, Node version, `dsho --version`, the output of `dsho doctor` and the failing command with `--json` output. Remove any tokens or private paths first.
