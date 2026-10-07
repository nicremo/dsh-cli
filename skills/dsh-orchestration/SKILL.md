---
name: dsh-orchestration
description: Delegates light, parallelizable work to a local DeepSeek Harness (dsh) through the dsh-cli command `dsho`. Use it when several research questions should run in parallel, when material has to be gathered (screenshots of blogs and news articles, scroll videos of websites, stock footage, stock photos), when a task can be done fast and cheap by DeepSeek, when a dsh workspace or session should be started, continued, watched or cancelled, or when a single screenshot or scroll video of a URL is needed. Trigger phrases "DSH", "dsh", "DeepSeek Harness", "DeepSeek", "dsho", "dsh-cli", "via DeepSeek", "research in parallel", "10 research tasks", "batch", "gather material", "screenshots of articles", "scroll video", "screen recording of a website", "stock footage", "b-roll", "/dsh-orchestration".
---

# dsh-orchestration: DeepSeek Harness as a worker pool

`dsho` (also installed as `dsh-cli`) starts unattended dsh workers, each in a workspace
folder, alone or as parallel batches. You are the orchestrator: cut the work into tasks,
start them, wait, read the results, check them, follow up.

**Visible in the DSH UI:** when the DSH web UI runs (`dsh web` or `dsho ui start`),
dsh-cli starts every job as a session inside that server. The user sees everything live:
a batch becomes its own workspace (the batch folder) and each session gets a readable
title like "01 · Research: ...". Without the UI dsh-cli runs a headless dsh process per
job (the sessions then show up under "Ungrouped"). If the user wants to watch and the UI
is down, run `dsho ui start` (or ask them to), or pass `-b web` so a missing UI is an
error instead of a silent headless run. `dsho ui <ref>` names the workspace and titles.

dsh workers are fast and cheap, have the search and scraping tools of the user's dsh
setup, bash, files, and (for captures) Python Playwright, ffmpeg and yt-dlp. They never
ask back and only know what the task says.

Full reference at any time: `dsho guide` and `dsho <command> --help`.

## When to delegate, when to do it yourself

| Delegate to dsh | Do it yourself |
|---|---|
| 3 to 20 independent research questions | One quick fact |
| Gathering material: screenshots, scroll videos, articles, stock | Code changes in the current repo that you must review |
| Many similar subtasks (work through a list) | Tasks that need answers from the user |
| Long reading tasks, summaries of many sources | Anything with secrets, logins, payments |

## Workflow (always)

1. **Check the environment** once per session: `dsho doctor`. It also shows whether the
   DSH web UI is reachable (`web-ui`). First time on a machine: `dsho setup`.
2. **Start**, ids come back at once (asynchronous):
   - Research: `dsho research "Question 1" "Question 2" ... --depth quick|standard|deep -C <folder>`
   - Material: `dsho materials "<topic, purpose, style, language>" --kinds screenshots,scroll,articles,stock-video --count 6 -C <folder>`
   - Any list: `dsho batch -f tasks.txt -p 8 -C <folder>`
   - Single task: `dsho run -C <folder> "<task>"`
3. **Wait** without hitting your shell timeout: `dsho wait <id> --timeout 9m`.
   Exit code 4 means still running: call `dsho wait` again. Harnesses with background
   shells (for example Claude Code `run_in_background`) can run the wait there and keep working.
4. **Collect**:
   - Batch: `dsho collect <batch>` writes `<root>/INDEX.md` (every answer, file and error)
     plus merged `manifest.json` and `sources.json`. Read INDEX.md first.
   - Job: `dsho result <job>` (short answer), `dsho files <job>` (created files).
5. **Check**: sample report.md files and screenshots, check videos with `ffprobe` and one
   still, check licences in manifest.json.
6. **Follow up**: `dsho continue <job> "<follow-up>"` continues the same session in the same
   folder. Analyse failures with `dsho logs <job>` and `dsho logs <job> --stderr`.

## Good worker tasks

Workers only see your text. Every task needs:
- **Goal and context**: what the result is for (video, article, decision)
- **Scope**: number of sources or files, time range, language, region
- **Output**: file names and format (research and materials set this automatically)
- **Quality bar**: what a good result looks like, what to exclude

One question per job. Cut big topics into sub-questions so they run in parallel. Instead of
"Research AI agents": one job each for market size, top vendors with prices, case studies,
criticism and risks, outlook.

## Workspaces

- Without `-C` dsh-cli creates `~/dsh-workspaces/<date>-<name>/`. The folder name is the
  workspace name in the UI, so pick readable folders (`-C ~/dsh-workspaces/ai-pricing-2026`).
- Batch layout: `<root>/<nn-name>/` per job, `<root>/INDEX.md` after `collect`. In the UI the
  sessions of a batch share the workspace `<root>`; each worker is told its own subfolder.
- `-C` on an existing folder the UI already knows (for example a repo) attaches the session
  to exactly that workspace.

## Watch and intervene

```
dsho status                  # active jobs, recent jobs, batches
dsho status <batch|job>      # job table or details with tokens and progress
dsho logs <job> -n 30        # the worker's tool calls
dsho logs <job> -f           # follow live (only useful in a background shell)
dsho cancel <job|batch>      # stop
dsho ls --batches            # all batches
```

References: job id, batch id, unique prefix, name, `last`, `last-batch`.
Every command takes `--json`. Exit codes: 0 ok, 1 job failed, 2 usage, 3 not found,
4 wait timeout or not finished, 5 environment.

## Capture directly, without a worker

When the URL is known, this is faster than a worker:

```
dsho capture shot <url> -o shot.png [--full] [--selector "article"] [--scale 2]
dsho capture scroll <url> -o scroll.mp4 [--duration 12] [--speed 450] [--start 600]
```

Cookie banners are dismissed, paywall teasers and newsletter overlays hidden, ad networks
blocked, WebGL off, and a watchdog stops pages that hang. Scroll videos are rendered frame
by frame (1920x1080, 30 fps, H.264), so they take about twice the video length to render.
Opt out with `--no-dismiss`, `--keep-overlays`, `--allow-ads`.

## Models

Default comes from `~/.dsh/settings.yaml`. Per job or batch:
`-m pro` (deepseek-v4-pro for hard analysis), `-m v4-flash`, `--effort off|low|high|max`.

## Limits and rules

- dsh often runs with full access and no sandbox. Keep tasks scoped to the workspace; never
  delegate deletes, deploys, git pushes or anything touching secrets.
- Workers cannot use the user's logged-in browser sessions. Paywalls stay paywalls.
- Headless jobs need about 5 to 10 seconds to start; web UI jobs start at once. Bundle
  tiny tasks instead of starting each alone.
- Material is not automatically usable: check licence and source in manifest.json before
  publishing anything. Screenshots of news sites only as a quote with attribution.
- State lives in `~/.dsho/jobs/<id>/` (job.json, task.md, events.jsonl, stderr.log,
  result.md). The headless dsh profile is `orchestra` (`~/.dsh/profiles/orchestra`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Status `lost` | The runner process died (reboot, kill). Start the job again. |
| `failed` with model or rate-limit errors | `dsho logs <job> --stderr`, retry later or lower `-p` |
| `timeout` | Task too big: split it or raise `-t 60m` |
| Profile `headless` instead of `orchestra` | Run `dsho setup` |
| Jobs do not appear in the UI | `dsho doctor`: check web-ui, run `dsho ui start`, start the job again with `-b web` |
| `continue` says the UI is not reachable | The session lives in the UI: `dsho ui start`, then retry |
| `dsho capture` says Playwright is missing | `pip install playwright && python3 -m playwright install chromium` |
