# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. You will get an answer within a few days.

## Scope and design notes

- dsh-cli starts DeepSeek Harness workers that can run shell commands. Their permissions come from your dsh configuration, not from dsh-cli.
- `dsho setup` copies MCP server definitions (which may contain API keys) from one dsh profile into another on the same machine. The target file is written with mode 0600 and the values are never printed.
- The DSH web UI cookie is cached in `~/.dsho/web-auth.json` with mode 0600. dsh-cli only talks to the configured local origin.
- dsh-cli sends no telemetry.
