// Manual for calling agents, printed by `dsho guide`. Kept in sync with
// skills/dsh-orchestration/SKILL.md.
export const GUIDE = `# dsh-cli · drive DeepSeek Harness from another agent

dsh-cli (\`dsho\`) starts unattended DeepSeek Harness (dsh) workers in workspace
folders, in parallel and in the background. You, the calling agent, are the
orchestrator: write the tasks, start them, wait, read the results, follow up.
dsh workers are fast and cheap: ideal for research, gathering material,
screenshots, scroll videos, stock footage and summaries of many sources.

## Where jobs run
When the DSH web UI is running (\`dsh web\`, or \`dsho ui start\`), every job runs as a
session inside that server: live in the UI, a batch becomes its own workspace (the
batch folder) and every session gets a readable title ("01 · Research: ...").
The user can watch and step in. Without the UI dsh-cli starts its own headless dsh
process per job (profile "orchestra"); those sessions show up as "Ungrouped".
-b web forces the UI, -b headless forces a process. \`dsho ui <ref>\` names the
workspace and session titles to look for.

## Ground rules
1. Starting is asynchronous. run, batch, research and materials return ids at once.
   Then \`dsho wait <id> --timeout 9m\` (stays under the 10 minute limit of one shell
   call in most harnesses). Exit code 4 means: still running, wait again.
2. Every job has a workspace folder. Without -C dsh-cli creates
   ~/dsh-workspaces/<date>-<name>. With -C <dir> the worker works exactly there.
3. Results are files. The final answer (\`dsho result\`) is short; the substance lives
   in report.md, manifest.json and the material folders.
4. Workers never ask back. Write complete tasks: goal, scope, format, quality bar.
5. Everything has --json. Exit codes: 0 ok, 1 job failed, 2 usage, 3 not found,
   4 wait timed out or not finished yet, 5 environment.

## Recipes

### One task, answer right away (short tasks)
  dsho run -w --max-wait 9m "Summarize the Astro 6 release notes"

### One task in the background in a given folder
  dsho run -C ~/projects/site "Read the README and write todo.md"
  dsho wait last --timeout 9m && dsho result last

### Ten research questions in parallel
  dsho research "Question 1" "Question 2" "Question 3" --depth standard -C ~/dsh-workspaces/topic
  dsho wait last-batch --timeout 9m       # repeat on exit code 4
  dsho collect last-batch                 # writes INDEX.md and sources.json
  Then read <root>/INDEX.md and single report.md files where needed.

### Gather material for a video
  dsho materials "AI agents in small businesses, serious look, English sources" \\
    --kinds screenshots,scroll,articles,stock-video --count 8 -C ~/videos/x/material
  dsho wait last-batch --timeout 9m ; dsho collect last-batch
  Per kind: <root>/<nn-kind>/<kind>/... plus manifest.json (source, licence).

### Any task list
  tasks.txt: one task per line, or multi-line blocks separated by a line "---"
  dsho batch -f tasks.txt -p 8 -C ~/dsh-workspaces/list
  JSONL works too: {"task": "...", "name": "...", "model": "pro", "effort": "high"}

### Follow up (same session, same folder)
  dsho continue <job> "Add three more sources from 2026 and update report.md" -w --max-wait 9m

### Watch and intervene
  dsho status                 overview: active jobs, recent jobs, batches
  dsho status <batch|job>     job table or details with tokens and progress
  dsho logs <job> -n 30       what the worker did (tool calls)
  dsho logs <job> --stderr    dsh error output (headless jobs)
  dsho files <job>            files the job created
  dsho cancel <job|batch>     stop

### Capture without a worker
  dsho capture shot https://example.com -o shot.png --full
  dsho capture scroll https://example.com/post -o scroll.mp4 --duration 12

## Models
Default is the model in ~/.dsh/settings.yaml. Per job or batch: -m pro
(deepseek-v4-pro) for hard analysis, -m v4-flash for volume, --effort off|low|high|max.

## References
last = newest job, last-batch = newest batch, unique id prefixes, job or batch names.
State lives as JSON in ~/.dsho/jobs/<id>/ (job.json, task.md, events.jsonl,
stderr.log, result.md).

## Limits
- Workers only see their folder and the web. No interactive logins.
- dsh usually runs with full access and no sandbox. Keep tasks scoped to the workspace;
  never delegate deletes, deploys, git pushes or anything touching secrets.
- About 5 seconds of start-up per headless job, near zero in the web UI. Bundle tiny tasks.
- Check licences in manifest.json before publishing any material.
`
