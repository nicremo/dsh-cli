// dsh-cli command line: parsing, command handlers, text and JSON output.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { collectBatch, fmtBytes, jobDuration, jobResult, listFiles } from './collect.mjs'
import { cfg, CONFIG_KEYS, readConfig, setConfig } from './config.mjs'
import { activeProfile, EFFORTS, resolveModel } from './dsh.mjs'
import { parseLines, timeline } from './events.mjs'
import { GUIDE } from './guide.mjs'
import { defaultWorkspaceRoot, jobDir } from './paths.mjs'
import { doctor, findPython, setupProfile } from './profile.mjs'
import { cancelJob, createRunnableJob, installSignalForwarding, runJob, spawnDetached } from './runner.mjs'
import { installSkill } from './skills.mjs'
import {
  ACTIVE, createBatch, listBatches, listJobs, readBatch, readJob, resolveRef, summarizeJobs, TERMINAL, updateBatch, updateJob,
} from './store.mjs'
import { cancelBatch, runBatch } from './supervisor.mjs'
import { DEPTHS, MATERIAL_KINDS, materialsPrompt, researchPrompt, TEMPLATES, workdirHeader, workspaceAgentsMd } from './templates.mjs'
import { DshoError, excerpt, fmtDuration, parseDuration, sleep, slug } from './util.mjs'
import * as web from './web.mjs'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const CAPTURE_PY = fileURLToPath(new URL('../capture/capture.py', import.meta.url))
const WORKSPACE_MARKER = '.dsho-workspace'

// ---------------------------------------------------------------- output ----

let JSON_MODE = false
const print = (text = '') => process.stdout.write(text.endsWith('\n') ? text : text + '\n')

function emit(data, text) {
  if (JSON_MODE) print(JSON.stringify({ ok: true, ...data }, null, 2))
  else if (text != null) print(typeof text === 'function' ? text() : text)
}

const clock = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 8) : '-')
const ago = (iso) => (iso ? `${fmtDuration(Date.now() - Date.parse(iso))} ago` : '-')
const pad = (s, n) => String(s ?? '').padEnd(n)
const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0))
const modelLabel = (job) => (job.model || job.effort ? `${resolveModel(job.model) ?? 'default'}${job.effort ? ` / ${job.effort}` : ''}` : 'default from ~/.dsh/settings.yaml')

// --------------------------------------------------------------- parsing ----

const COMMON = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}
const RUN_OPTS = {
  cwd: { type: 'string', short: 'C' },
  name: { type: 'string' },
  model: { type: 'string', short: 'm' },
  effort: { type: 'string' },
  timeout: { type: 'string', short: 't' },
  wait: { type: 'boolean', short: 'w' },
  'max-wait': { type: 'string' },
  backend: { type: 'string', short: 'b' },
}

const BACKENDS = ['auto', 'web', 'headless']

/** auto: the DSH web UI when it is running (live and grouped there), else headless. */
async function resolveBackend(values) {
  const wanted = values.backend ?? cfg('backend') ?? 'auto'
  if (!BACKENDS.includes(wanted)) throw new DshoError(`--backend must be one of ${BACKENDS.join(', ')}`, 2)
  if (wanted === 'headless') return 'headless'
  const up = await web.available()
  if (wanted === 'web' && !up) throw new DshoError(`DSH web UI at ${web.baseUrl()} is not reachable`, 5, 'dsho ui start, or use --backend headless')
  return up ? 'web' : 'headless'
}

const backendLine = (backend, cwd, width = 11) =>
  backend === 'web'
    ? `  ${'DSH UI:'.padEnd(width)}live at ${web.baseUrl()}, workspace "${basename(cwd)}"`
    : `  ${'Backend:'.padEnd(width)}headless (DSH web UI not reachable; the session shows up as "Ungrouped" there)`

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options: { ...COMMON, ...options }, allowPositionals: true, strict: true })
  } catch (err) {
    throw new DshoError(err.message.replace(/\. To specify a positional argument.*$/s, ''), 2, 'dsho <command> --help lists the options')
  }
}

function readStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function taskFrom(positionals, { file } = {}) {
  if (file) return readFileSync(resolve(file), 'utf8')
  if (positionals.length === 1 && positionals[0] === '-') return readStdin()
  if (positionals.length) return positionals.join(' ')
  return readStdin()
}

function validateModelOpts(values) {
  if (values.effort && !EFFORTS.includes(values.effort)) throw new DshoError(`--effort must be one of ${EFFORTS.join(', ')}`, 2)
  return { model: values.model ?? null, effort: values.effort ?? null }
}

const timeoutSec = (values, fallback = 1800) => (values.timeout ? parseDuration(values.timeout) : fallback)
const dateStamp = () => new Date().toISOString().slice(0, 10)
const expandHome = (p) => p.replace(/^~(?=$|\/)/, homedir())

/** True when dir or an ancestor already is a dsh-cli workspace. */
function insideWorkspace(dir) {
  let current = resolve(dir)
  while (true) {
    if (existsSync(join(current, WORKSPACE_MARKER))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** Create dir and, unless it already sits in a workspace, mark it as one. */
function ensureWorkspace(dir, { kind = 'general', description, force = false } = {}) {
  const abs = resolve(dir)
  mkdirSync(abs, { recursive: true })
  if (!force && insideWorkspace(abs)) return { path: abs, created: false }
  writeFileSync(join(abs, WORKSPACE_MARKER), JSON.stringify({ kind, createdAt: new Date().toISOString() }) + '\n')
  const agents = join(abs, 'AGENTS.md')
  if (force || !existsSync(agents)) writeFileSync(agents, workspaceAgentsMd({ name: basename(abs), kind, description }))
  return { path: abs, created: true }
}

/** -C wins; an existing directory stays untouched, a new one becomes a workspace. */
function resolveWorkspace(cwdOpt, fallbackName, kind) {
  if (cwdOpt) {
    const abs = resolve(expandHome(cwdOpt))
    if (!existsSync(abs)) ensureWorkspace(abs, { kind })
    return abs
  }
  const abs = join(cfg('workspaces') || defaultWorkspaceRoot(), `${dateStamp()}-${fallbackName}`)
  let candidate = abs
  for (let i = 2; existsSync(candidate); i++) candidate = `${abs}-${i}`
  ensureWorkspace(candidate, { kind })
  return candidate
}

// ------------------------------------------------------------ job views ----

function jobView(job) {
  return {
    id: job.id,
    name: job.name,
    title: job.title ?? null,
    status: job.status,
    backend: job.backend ?? 'headless',
    batch: job.batch,
    index: job.index,
    template: job.template,
    prompt: job.prompt,
    cwd: job.cwd,
    outDir: job.outDir ?? job.cwd,
    web: job.web ?? null,
    sessionId: job.sessionId,
    model: job.model,
    effort: job.effort,
    parent: job.parent,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: jobDuration(job),
    progress: job.progress,
    usage: job.usage,
    exitCode: job.exitCode,
    error: job.error,
    resultFile: existsSync(join(jobDir(job.id), 'result.md')) ? join(jobDir(job.id), 'result.md') : null,
    eventsFile: join(jobDir(job.id), 'events.jsonl'),
  }
}

function jobDetailText(job) {
  const p = job.progress ?? {}
  const u = job.usage ?? {}
  const lines = [
    `Job ${job.id}  [${job.status}]  ${job.title ?? job.name ?? ''}`,
    `  Task:      ${excerpt(job.prompt, 140)}`,
    `  Workspace: ${job.cwd}`,
  ]
  if (job.outDir && job.outDir !== job.cwd) lines.push(`  Folder:    ${job.outDir}`)
  lines.push(
    `  Backend:   ${job.backend === 'web' ? `web, live in the DSH UI${job.web?.workspaceTitle ? ` (workspace "${job.web.workspaceTitle}")` : ''}` : 'headless'}`,
    `  Session:   ${job.sessionId ?? '-'}`,
    `  Model:     ${modelLabel(job)}`,
    `  Runtime:   ${fmtDuration(jobDuration(job))} (created ${clock(job.createdAt)}${job.startedAt ? `, started ${clock(job.startedAt)}` : ''}${job.endedAt ? `, ended ${clock(job.endedAt)}` : ''})`,
    `  Progress:  ${p.steps ?? 0} steps, ${p.toolCalls ?? 0} tool calls${p.lastTool ? `, last ${p.lastTool}` : ''}${p.lastActivityAt && ACTIVE.has(job.status) ? `, active ${ago(p.lastActivityAt)}` : ''}`,
    `  Tokens:    in ${kTokens(u.inputTokens)}, out ${kTokens(u.outputTokens)}, cache ${kTokens(u.cacheReadTokens)}`,
  )
  if (job.batch) lines.push(`  Batch:     ${job.batch} (#${job.index})`)
  if (job.parent) lines.push(`  Follows:   ${job.parent}`)
  if (job.error) lines.push(`  Error:     ${excerpt(job.error, 300)}`)
  if (job.status === 'done') lines.push(`  Result:    dsho result ${job.id}`)
  else if (ACTIVE.has(job.status)) lines.push(`  Wait:      dsho wait ${job.id}    Live: dsho logs ${job.id} -f`)
  return lines.join('\n')
}

function jobRow(job) {
  const tail = job.status === 'done' ? excerpt(jobResult(job.id), 60) : job.error ? excerpt(job.error, 60) : job.progress?.lastTool ? `→ ${job.progress.lastTool}` : ''
  return `${pad(job.id, 16)} ${pad(job.status, 9)} ${pad(fmtDuration(jobDuration(job)), 8)} ${pad(job.progress?.toolCalls ?? 0, 5)} ${pad(excerpt(job.name ?? job.prompt, 28), 28)} ${tail}`
}
const JOB_HEADER = `${pad('JOB', 16)} ${pad('STATUS', 9)} ${pad('TIME', 8)} ${pad('TOOLS', 5)} ${pad('NAME', 28)} ANSWER / ERROR`

function batchView(batch) {
  const jobs = listJobs({ batch: batch.id, order: 'index' })
  return { batch, jobs, summary: summarizeJobs(jobs) }
}

function batchText({ batch, jobs, summary }) {
  const c = summary.counts
  const parts = [`${c.done ?? 0}/${summary.total} done`]
  if (c.running) parts.push(`${c.running} running`)
  if (c.queued) parts.push(`${c.queued} queued`)
  for (const k of ['failed', 'timeout', 'cancelled', 'lost']) if (c[k]) parts.push(`${c[k]} ${k}`)
  const backend = jobs[0]?.backend === 'web' ? `web UI workspace "${jobs[0].web?.workspaceTitle ?? basename(batch.root)}"` : 'headless'
  return [
    `Batch ${batch.id}  [${summary.status}]  ${batch.name ?? ''}  ${parts.join(', ')}`,
    `  Root:     ${batch.root}`,
    `  Parallel: ${batch.parallel} · template: ${batch.template} · ${backend} · created ${clock(batch.createdAt)}`,
    '',
    `   # ${JOB_HEADER}`,
    ...jobs.map((j) => `  ${String(j.index ?? '').padStart(2, '0')} ${jobRow(j)}`),
    '',
    summary.status === 'running' ? `Wait: dsho wait ${batch.id}` : `Summarize: dsho collect ${batch.id}`,
  ].join('\n')
}

// --------------------------------------------------------------- waiting ----

function refJobs(ref) {
  if (ref.kind === 'job') return [readJob(ref.id)]
  return listJobs({ batch: ref.id, order: 'index' })
}

async function waitFor(refs, { timeoutMs, any = false } = {}) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity
  const tty = process.stderr.isTTY && !JSON_MODE
  while (true) {
    const jobs = refs.flatMap(refJobs).filter(Boolean)
    const finished = jobs.filter((j) => TERMINAL.has(j.status))
    const done = any ? finished.length > 0 : finished.length === jobs.length
    if (done) return { jobs, timedOut: false }
    if (Date.now() >= deadline) return { jobs, timedOut: true }
    if (tty) process.stderr.write(`\r${finished.length}/${jobs.length} done ...   `)
    await sleep(1000)
  }
}

function waitOutcome(jobs, timedOut) {
  const failed = jobs.filter((j) => ['failed', 'timeout', 'cancelled', 'lost'].includes(j.status))
  return { exitCode: timedOut ? 4 : failed.length ? 1 : 0, failed }
}

// ---------------------------------------------------------------- start ----

function startJob(fields, taskText, { header = true } = {}) {
  const job = createRunnableJob(fields, header ? workdirHeader(fields.outDir ?? fields.cwd) + taskText : taskText)
  const pid = spawnDetached(['__run-job', job.id])
  updateJob(job.id, (j) => (j.ownerPid ? j : { ...j, ownerPid: pid }))
  return readJob(job.id)
}

function startBatch({ name, root, parallel, template, tasks, timeoutSec: tSec, model, effort, backend }) {
  const batch = createBatch({ name, root, parallel, template, jobs: [] })
  const width = Math.max(2, String(tasks.length).length)
  const jobs = tasks.map((t, i) => {
    const nn = String(i + 1).padStart(width, '0')
    const jobName = `${nn}-${t.slug ?? slug(t.prompt, 32)}`
    const outDir = join(root, jobName)
    return createRunnableJob(
      {
        name: jobName,
        title: `${nn} · ${t.title ?? excerpt(t.prompt, 70)}`,
        batch: batch.id,
        index: i + 1,
        template: t.template ?? template,
        prompt: t.prompt,
        backend,
        // Web sessions of one batch share the batch workspace directory.
        cwd: backend === 'web' ? root : outDir,
        outDir,
        model: t.model ?? model,
        effort: t.effort ?? effort,
        timeoutSec: t.timeoutSec ?? tSec,
      },
      workdirHeader(outDir) + t.text,
    )
  })
  updateBatch(batch.id, { jobs: jobs.map((j) => j.id) })
  const pid = spawnDetached(['__run-batch', batch.id])
  updateBatch(batch.id, (b) => (b.ownerPid ? b : { ...b, ownerPid: pid }))
  for (const j of jobs) updateJob(j.id, (cur) => (cur.ownerPid ? cur : { ...cur, ownerPid: pid }))
  return readBatch(batch.id)
}

async function finishStart(ref, values, startedText) {
  if (!values.wait) {
    const data = ref.kind === 'job' ? { job: jobView(readJob(ref.id)) } : { batch: readBatch(ref.id), jobs: listJobs({ batch: ref.id, order: 'index' }).map(jobView) }
    emit(data, startedText)
    return 0
  }
  const { jobs, timedOut } = await waitFor([ref], { timeoutMs: values['max-wait'] ? parseDuration(values['max-wait']) * 1000 : undefined })
  if (process.stderr.isTTY && !JSON_MODE) process.stderr.write('\r')
  const { exitCode } = waitOutcome(jobs, timedOut)
  if (ref.kind === 'job') {
    const job = jobs[0]
    const result = jobResult(job.id)
    emit({ job: jobView(job), result, timedOut }, () =>
      timedOut
        ? `${jobDetailText(job)}\n\nMax wait reached; the job keeps running.`
        : `# ${job.id} · ${job.status} · ${fmtDuration(jobDuration(job))} · ${job.cwd}\n\n${result ?? job.error ?? '(no answer)'}`,
    )
  } else {
    const view = batchView(readBatch(ref.id))
    emit({ batch: view.batch, summary: view.summary, jobs: view.jobs.map((j) => ({ ...jobView(j), result: jobResult(j.id) })), timedOut }, () => batchText(view))
  }
  return exitCode
}

// -------------------------------------------------------------- commands ----

const BACKEND_HELP = `  -b, --backend <b>     auto (default): inside the running DSH web UI, else headless;
                        web forces the UI, headless a separate dsh process`

const HELP = {
  run: `dsho run <task...|-> [options]
  Starts one dsh job in the background and returns its id at once.
  -C, --cwd <dir>       workspace folder (default: a new folder under ~/dsh-workspaces)
  -f, --file <file>     read the task from a file ("-" or no text: stdin)
      --template <t>    raw (default), research, materials
      --depth <d>       research: quick, standard, deep
      --kind <k>        materials: ${Object.keys(MATERIAL_KINDS).join(', ')}
      --url <url>       materials: mandatory URL (repeatable)
      --name <name>     display name (also the session title in the UI)
  -m, --model <m>       flash, pro, v4-flash, vision or a full model id
      --effort <e>      ${EFFORTS.join(', ')}
  -t, --timeout <dur>   job time limit (default 30m)
  -w, --wait            block until done and print the answer
      --max-wait <dur>  with --wait: give up waiting after this long (exit 4)
${BACKEND_HELP}`,
  batch: `dsho batch [-f file|-] [--task <t>]... [options]
  Starts many jobs in parallel. Every job gets its own folder <root>/<nn-name>/.
  -f, --file <file>     one task per line (# = comment), blocks separated by a line "---",
                        .json (array) or .jsonl ({task,name,model,effort,template})
      --task <t>        a task inline (repeatable)
  -C, --cwd <root>      batch folder (default: ~/dsh-workspaces/<date>-<name>)
  -p, --parallel <n>    concurrent jobs (default: all, at most 10)
      --template, --depth, --name, -m, --effort, -t, -w, --max-wait, -b as for run
  In the web UI the batch folder becomes a workspace and every job a named session.`,
  research: `dsho research <question> [<question>...] [options]
  One research job per question, all in parallel. Workers write report.md and sources.json.
  -f, --file <file>     questions from a file (as for batch)
      --depth <d>       quick, standard (default), deep
      --focus <text>    extra instruction for every worker
  -C, -p, --name, -m, --effort, -t, -w, --max-wait, -b as for batch`,
  materials: `dsho materials <brief...> [options]
  Gathers material, one parallel job per kind. Output: files plus manifest.json per kind.
      --kinds <list>    comma list of ${Object.keys(MATERIAL_KINDS).join(', ')}
                        (default: screenshots,scroll,articles,stock-video)
      --url <url>       mandatory URLs for screenshots, scroll, articles (repeatable)
      --count <n>       target count per kind (default 6)
  -C, -p, --name, -m, --effort, -t, -w, --max-wait, -b as for batch`,
  status: `dsho status [ref]
  Without ref: active and recent jobs plus batches. With ref: job or batch details.
  ref: job id, batch id, unique prefix, name, last, last-batch`,
  ls: `dsho ls [-n N] [--running] [--batch ref] [--batches]
  Lists jobs (newest first) or, with --batches, the batches.`,
  wait: `dsho wait <ref>... [--timeout <dur>] [--any]
  Blocks until all (or with --any the first) are finished.
  Exit 0 all done, 1 something failed, 4 timeout reached (jobs keep running).`,
  result: `dsho result <ref> [--files]
  Final answer of a job; for a batch every answer in order.`,
  logs: `dsho logs <job> [-n N] [-f] [--full] [--raw] [--stderr]
  Timeline of tool calls and answers. -f follows live until the job ends.`,
  files: `dsho files <ref> [--all]
  Files the job created or changed in its folder (--all: every file).`,
  continue: `dsho continue <job> <follow-up...|-> [-w] [-t dur] [--max-wait dur]
  Continues the job's dsh session with a follow-up task (same folder, same session).`,
  cancel: `dsho cancel <ref>
  Cancels a job or every unfinished job of a batch.`,
  collect: `dsho collect <batch> [-o file]
  Writes <root>/INDEX.md (all answers, files, errors) and merges manifest.json and
  sources.json of all jobs.`,
  ws: `dsho ws init <dir> [--kind research|materials|general] [--description text]
  Creates a workspace: folder, marker .dsho-workspace and an AGENTS.md with conventions.`,
  capture: `dsho capture shot <url> -o <file.png> [--full] [--width 1440] [--height 900] [--wait 2] [--selector css]
dsho capture scroll <url> -o <file.mp4> [--duration 12] [--width 1920] [--height 1080] [--fps 30] [--speed 450]
  Deterministic captures with Playwright (bundled Chromium). Prints JSON.
  Default: dismiss cookie banners, hide overlays, block ad networks, WebGL off.
  --no-dismiss, --keep-overlays, --allow-ads, --hide <css> (repeatable), --dark, --scale 2 (shot)
  --max-time <s> hard limit (default: shot 90, scroll 180 plus 12 per second of video)`,
  ui: `dsho ui [ref] [--print]          open the DSH web UI; with ref name the workspace and sessions
dsho ui start [--port 3080]      start \`dsh web\` in the background and log in
dsho ui login <url>              remember the token URL that \`dsh web\` printed`,
  skill: `dsho skill install [--agents claude,codex,pi] [--copy]
  Installs the dsh-orchestration skill into ~/.agents/skills (read by OpenCode and others)
  and links it into Claude Code, Codex and Pi when they are installed.`,
  setup: `dsho setup [--mcp research|all|none|<ids>] [--from web] [--skills a,b|all] [--no-skill]
  One-time setup: creates the dsh profile "orchestra" for headless jobs (MCP servers copied
  from another profile, curated skills) and installs the agent skill.`,
  config: `dsho config                       show settings
dsho config set <key> <value>      e.g. dsho config set dshRepo ~/deepseek-harness
dsho config unset <key>
  Keys: ${Object.entries(CONFIG_KEYS).map(([k, v]) => `${k} (${v.help})`).join('; ')}
  Environment variables (DSHO_*) win over config.json.`,
  doctor: `dsho doctor
  Checks Node, dsh, profile, settings, web UI, Playwright, ffmpeg and yt-dlp.`,
  guide: `dsho guide
  The full manual for agents (workflows, recipes, rules).`,
}

const USAGE = `dsh-cli ${VERSION} · run DeepSeek Harness sessions from any agent harness

Start
  run <task>             one job in the background (-w waits for the answer)
  batch -f tasks.txt     many jobs in parallel, one folder each
  research <q>...        parallel research workers (report.md, sources.json)
  materials <brief>      gather material: screenshots, scroll videos, articles, stock

Watch
  status [ref]           overview or details        ls      list jobs
  wait <ref>...          block until done           logs    timeline (-f live)
  result <ref>           final answer(s)            files   created files

Steer
  continue <job> <text>  continue the session       cancel  stop jobs
  collect <batch>        write INDEX.md and merge manifests

Tools
  ws init <dir>          create a workspace         capture shot|scroll   captures
  ui [start|login]       DSH web UI                 skill install   agent skill
  setup                  one-time setup             doctor  check the environment
  config [set|unset]     persistent settings
  guide                  manual for agents

Backend: when the DSH web UI runs (dsh web / dsho ui start), jobs run there as sessions,
live and with one workspace per batch. Otherwise each job runs in its own headless dsh.

Global: --json (machine readable), -h (help per command)
Exit: 0 ok, 1 job failed, 2 usage, 3 not found, 4 wait timeout or not finished, 5 environment`

async function cmdRun(argv) {
  const { values, positionals } = parse(argv, {
    ...RUN_OPTS,
    file: { type: 'string', short: 'f' },
    template: { type: 'string' },
    depth: { type: 'string' },
    kind: { type: 'string' },
    url: { type: 'string', multiple: true },
    count: { type: 'string' },
  })
  if (values.help) return print(HELP.run), 0
  const template = values.template ?? 'raw'
  if (!TEMPLATES.includes(template)) throw new DshoError(`--template must be one of ${TEMPLATES.join(', ')}`, 2)
  const prompt = taskFrom(positionals, { file: values.file }).trim()
  if (!prompt) throw new DshoError('No task given', 2, 'dsho run "task" or echo "task" | dsho run -')
  const { model, effort } = validateModelOpts(values)
  let text = prompt
  if (template === 'research') text = researchPrompt(prompt, { depth: values.depth ?? 'standard' })
  if (template === 'materials') {
    const kind = values.kind ?? 'screenshots'
    if (!MATERIAL_KINDS[kind]) throw new DshoError(`--kind must be one of ${Object.keys(MATERIAL_KINDS).join(', ')}`, 2)
    text = materialsPrompt(prompt, { kind, urls: values.url ?? [], count: Number(values.count ?? 6) })
  }
  const backend = await resolveBackend(values)
  const name = values.name ?? slug(prompt, 32)
  const cwd = resolveWorkspace(values.cwd, name, template === 'raw' ? 'general' : template)
  const title = values.name ?? excerpt(prompt, 70)
  const job = startJob({ name, title, template, prompt, cwd, outDir: cwd, backend, model, effort, timeoutSec: timeoutSec(values) }, text)
  return finishStart({ kind: 'job', id: job.id }, values, () =>
    [
      `Job ${job.id} started (${backend === 'web' ? 'in the DSH web UI' : `headless, dsh profile ${activeProfile()}`})`,
      `  Workspace: ${cwd}`,
      backendLine(backend, cwd),
      `  Wait:      dsho wait ${job.id} --timeout 9m`,
      `  Result:    dsho result ${job.id}`,
      `  Live:      dsho logs ${job.id} -f`,
    ].join('\n'),
  )
}

function parseTaskFile(file) {
  const raw = file === '-' ? readStdin() : readFileSync(resolve(file), 'utf8')
  const ext = file.toLowerCase().split('.').pop()
  const norm = (t) => (typeof t === 'string' ? { prompt: t } : { ...t, prompt: t.task ?? t.prompt })
  if (ext === 'json') return JSON.parse(raw).map(norm)
  if (ext === 'jsonl') return raw.split('\n').filter((l) => l.trim()).map((l) => norm(JSON.parse(l)))
  if (/^---\s*$/m.test(raw)) return raw.split(/^---\s*$/m).map((b) => b.trim()).filter(Boolean).map((prompt) => ({ prompt }))
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((prompt) => ({ prompt }))
}

async function batchCommon(values, tasks, { template, defaultName, kind }) {
  if (!tasks.length) throw new DshoError('No tasks given', 2, 'dsho batch -f tasks.txt or --task "..." repeated')
  for (const t of tasks) if (!t.prompt?.trim()) throw new DshoError('Empty task in the list', 2)
  const { model, effort } = validateModelOpts(values)
  const parallel = values.parallel ? Number(values.parallel) : Math.min(tasks.length, 10)
  if (!Number.isInteger(parallel) || parallel < 1) throw new DshoError('--parallel must be a positive number', 2)
  const backend = await resolveBackend(values)
  const name = values.name ?? defaultName
  const root = resolveWorkspace(values.cwd, slug(name, 40), kind)
  const batch = startBatch({ name, root, parallel, template, tasks, timeoutSec: timeoutSec(values), model, effort, backend })
  return finishStart({ kind: 'batch', id: batch.id }, values, () =>
    [
      `Batch ${batch.id} started: ${tasks.length} jobs, ${parallel} in parallel (${backend === 'web' ? 'in the DSH web UI' : `headless, dsh profile ${activeProfile()}`})`,
      `  Root:     ${root}`,
      backendLine(backend, root, 10),
      ...listJobs({ batch: batch.id, order: 'index' }).map((j) => `  ${j.id}  ${j.name}`),
      `  Status:   dsho status ${batch.id}`,
      `  Wait:     dsho wait ${batch.id} --timeout 9m`,
      `  Then:     dsho collect ${batch.id}  (writes ${join(root, 'INDEX.md')})`,
    ].join('\n'),
  )
}

const BATCH_OPTS = {
  ...RUN_OPTS,
  file: { type: 'string', short: 'f' },
  parallel: { type: 'string', short: 'p' },
}

async function cmdBatch(argv) {
  const { values, positionals } = parse(argv, { ...BATCH_OPTS, task: { type: 'string', multiple: true }, template: { type: 'string' }, depth: { type: 'string' } })
  if (values.help) return print(HELP.batch), 0
  const template = values.template ?? 'raw'
  if (!TEMPLATES.includes(template) || template === 'materials') throw new DshoError('--template for batch: raw or research (material: dsho materials)', 2)
  let tasks = [...(values.file ? parseTaskFile(values.file) : []), ...(values.task ?? []).map((prompt) => ({ prompt })), ...positionals.map((prompt) => ({ prompt }))]
  if (!tasks.length && !process.stdin.isTTY) tasks = parseTaskFile('-')
  tasks = tasks.map((t) => ({
    ...t,
    slug: t.name ? slug(t.name, 32) : undefined,
    title: t.name ?? undefined,
    text: (t.template ?? template) === 'research' ? researchPrompt(t.prompt, { depth: values.depth ?? 'standard' }) : t.prompt,
  }))
  return batchCommon(values, tasks, { template, defaultName: `batch-${slug(tasks[0]?.prompt ?? 'tasks', 24)}`, kind: 'general' })
}

async function cmdResearch(argv) {
  const { values, positionals } = parse(argv, { ...BATCH_OPTS, depth: { type: 'string' }, focus: { type: 'string' } })
  if (values.help) return print(HELP.research), 0
  const depth = values.depth ?? 'standard'
  if (!DEPTHS.includes(depth)) throw new DshoError(`--depth must be one of ${DEPTHS.join(', ')}`, 2)
  let questions = [...(values.file ? parseTaskFile(values.file) : []), ...positionals.map((prompt) => ({ prompt }))]
  if (!questions.length && !process.stdin.isTTY) questions = parseTaskFile('-')
  const tasks = questions.map((q) => ({ ...q, title: `Research: ${excerpt(q.name ?? q.prompt, 70)}`, text: researchPrompt(q.prompt, { depth, extra: values.focus }) }))
  return batchCommon(values, tasks, { template: 'research', defaultName: `research-${slug(questions[0]?.prompt ?? '', 28)}`, kind: 'research' })
}

async function cmdMaterials(argv) {
  const { values, positionals } = parse(argv, { ...BATCH_OPTS, kinds: { type: 'string' }, url: { type: 'string', multiple: true }, count: { type: 'string' } })
  if (values.help) return print(HELP.materials), 0
  const brief = taskFrom(positionals, { file: values.file }).trim()
  if (!brief) throw new DshoError('No brief given', 2, 'dsho materials "topic, purpose, style"')
  const kinds = (values.kinds ?? 'screenshots,scroll,articles,stock-video').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of kinds) if (!MATERIAL_KINDS[k]) throw new DshoError(`Unknown kind "${k}". Allowed: ${Object.keys(MATERIAL_KINDS).join(', ')}`, 2)
  const count = Number(values.count ?? 6)
  const urls = values.url ?? []
  const tasks = kinds.map((kind) => ({
    prompt: `${MATERIAL_KINDS[kind]}: ${brief}`,
    slug: kind,
    title: `Material ${kind}: ${excerpt(brief, 50)}`,
    text: materialsPrompt(brief, { kind, urls: ['screenshots', 'scroll', 'articles'].includes(kind) ? urls : [], count }),
  }))
  return batchCommon(values, tasks, { template: 'materials', defaultName: `material-${slug(brief, 28)}`, kind: 'materials' })
}

async function cmdStatus(argv) {
  const { values, positionals } = parse(argv, {})
  if (values.help) return print(HELP.status), 0
  if (positionals[0]) {
    const ref = resolveRef(positionals[0])
    if (ref.kind === 'job') {
      const job = readJob(ref.id)
      emit({ job: jobView(job) }, jobDetailText(job))
    } else {
      const view = batchView(readBatch(ref.id))
      emit({ batch: view.batch, summary: view.summary, jobs: view.jobs.map(jobView) }, batchText(view))
    }
    return 0
  }
  const jobs = listJobs({ limit: 200 })
  const running = jobs.filter((j) => ACTIVE.has(j.status))
  const recent = jobs.filter((j) => !ACTIVE.has(j.status)).slice(0, 8)
  const batches = listBatches({ limit: 5 }).map((b) => ({ ...b, summary: summarizeJobs(listJobs({ batch: b.id })) }))
  const uiUp = await web.available()
  emit({ webUi: uiUp ? web.baseUrl() : null, running: running.map(jobView), recent: recent.map(jobView), batches: batches.map((b) => ({ id: b.id, name: b.name, root: b.root, status: b.summary.status, counts: b.summary.counts, createdAt: b.createdAt })) }, () => {
    const out = [`dsh-cli · ${running.length} active · new jobs run ${uiUp ? `in the DSH web UI ${web.baseUrl()}` : `headless (profile ${activeProfile()})`}`]
    if (running.length) out.push('', 'Active', `  ${JOB_HEADER}`, ...running.map((j) => `  ${jobRow(j)}`))
    if (recent.length) out.push('', 'Recent', `  ${JOB_HEADER}`, ...recent.map((j) => `  ${jobRow(j)}`))
    if (batches.length) {
      out.push('', 'Batches')
      for (const b of batches) out.push(`  ${pad(b.id, 16)} ${pad(b.summary.status, 9)} ${pad(`${b.summary.counts.done ?? 0}/${b.summary.total}`, 7)} ${pad(clock(b.createdAt), 9)} ${b.name ?? ''}`)
    }
    if (!jobs.length) out.push('', 'No jobs yet. Start with dsho run "task", or read dsho guide')
    return out.join('\n')
  })
  return 0
}

async function cmdLs(argv) {
  const { values } = parse(argv, { n: { type: 'string', short: 'n' }, running: { type: 'boolean' }, batch: { type: 'string' }, batches: { type: 'boolean' } })
  if (values.help) return print(HELP.ls), 0
  const limit = Number(values.n ?? 20)
  if (values.batches) {
    const batches = listBatches({ limit }).map((b) => ({ ...b, summary: summarizeJobs(listJobs({ batch: b.id })) }))
    emit({ batches: batches.map((b) => ({ id: b.id, name: b.name, root: b.root, status: b.summary.status, counts: b.summary.counts, total: b.summary.total, createdAt: b.createdAt })) }, () =>
      batches.map((b) => `${pad(b.id, 16)} ${pad(b.summary.status, 9)} ${pad(`${b.summary.counts.done ?? 0}/${b.summary.total}`, 7)} ${pad(b.createdAt.replace('T', ' ').slice(0, 16), 17)} ${b.name ?? ''}  ${b.root}`).join('\n') || 'No batches.',
    )
    return 0
  }
  let jobs = listJobs({ batch: values.batch ? resolveRef(values.batch).id : undefined, order: values.batch ? 'index' : undefined })
  if (values.running) jobs = jobs.filter((j) => ACTIVE.has(j.status))
  jobs = jobs.slice(0, limit)
  emit({ jobs: jobs.map(jobView) }, () => (jobs.length ? [JOB_HEADER, ...jobs.map(jobRow)].join('\n') : 'No jobs.'))
  return 0
}

async function cmdWait(argv) {
  const { values, positionals } = parse(argv, { timeout: { type: 'string', short: 't' }, any: { type: 'boolean' } })
  if (values.help) return print(HELP.wait), 0
  if (!positionals.length) throw new DshoError('wait needs at least one reference', 2)
  const refs = positionals.map(resolveRef)
  const { jobs, timedOut } = await waitFor(refs, { timeoutMs: values.timeout ? parseDuration(values.timeout) * 1000 : undefined, any: values.any })
  if (process.stderr.isTTY && !JSON_MODE) process.stderr.write('\r')
  const { exitCode } = waitOutcome(jobs, timedOut)
  emit({ timedOut, summary: summarizeJobs(jobs), jobs: jobs.map((j) => ({ ...jobView(j), result: j.status === 'done' ? jobResult(j.id) : null })) }, () => {
    const lines = [timedOut ? 'Timeout reached, unfinished jobs keep running.' : 'Done.', JOB_HEADER, ...jobs.map(jobRow)]
    if (!timedOut) {
      const single = jobs.length === 1 && jobs[0].status === 'done'
      const batch = refs.find((r) => r.kind === 'batch')
      lines.push('', single ? `Answer: dsho result ${jobs[0].id}` : batch ? `Summarize: dsho collect ${batch.id}` : 'Answers: dsho result <job>')
    } else lines.push('', `Keep waiting: dsho wait ${refs.map((r) => r.id).join(' ')} --timeout 9m`)
    return lines.join('\n')
  })
  return exitCode
}

async function cmdResult(argv) {
  const { values, positionals } = parse(argv, { files: { type: 'boolean' } })
  if (values.help) return print(HELP.result), 0
  const ref = resolveRef(positionals[0])
  const jobs = refJobs(ref)
  if (ref.kind === 'job') {
    const job = jobs[0]
    if (ACTIVE.has(job.status)) throw new DshoError(`Job ${job.id} is still ${job.status}`, 4, `dsho wait ${job.id}`)
    const result = jobResult(job.id)
    const dir = job.outDir ?? job.cwd
    const files = values.files ? listFiles(dir, { sinceMs: Date.parse(job.createdAt) - 2000 }) : undefined
    emit({ job: jobView(job), result, files }, () => {
      const parts = [result ?? `(no answer) status ${job.status}${job.error ? `: ${job.error}` : ''}`]
      if (files) parts.push('', `Files in ${dir}:`, ...files.map((f) => `  ${f.path} (${fmtBytes(f.bytes)})`))
      return parts.join('\n')
    })
    return job.status === 'done' ? 0 : 1
  }
  emit({ jobs: jobs.map((j) => ({ ...jobView(j), result: jobResult(j.id) })) }, () =>
    jobs.map((j) => `## ${j.title ?? j.name ?? j.id} [${j.status}] (${j.id})\n\n${jobResult(j.id) ?? j.error ?? '(no answer)'}\n`).join('\n'),
  )
  return jobs.every((j) => j.status === 'done') ? 0 : 1
}

async function cmdLogs(argv) {
  const { values, positionals } = parse(argv, { n: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' }, full: { type: 'boolean' }, raw: { type: 'boolean' }, stderr: { type: 'boolean' } })
  if (values.help) return print(HELP.logs), 0
  const ref = resolveRef(positionals[0])
  if (ref.kind !== 'job') throw new DshoError('logs needs a job, not a batch', 2, `dsho status ${ref.id} lists the jobs of the batch`)
  const dir = jobDir(ref.id)
  if (values.stderr) {
    const file = join(dir, 'stderr.log')
    print(existsSync(file) ? readFileSync(file, 'utf8') : '(empty)')
    return 0
  }
  const eventsFile = join(dir, 'events.jsonl')
  const read = () => (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '')
  const render = (text) => (values.raw ? text.split('\n').filter(Boolean) : timeline(parseLines(text), { full: values.full }))
  const limit = Number(values.n ?? (values.follow ? 15 : 40))
  let lines = render(read())
  if (JSON_MODE && !values.follow) {
    emit({ job: ref.id, lines: lines.slice(-limit) })
    return 0
  }
  print(lines.slice(-limit).join('\n') || '(no events yet)')
  if (!values.follow) return 0
  let shown = lines.length
  while (true) {
    await sleep(1000)
    lines = render(read())
    if (lines.length > shown) {
      print(lines.slice(shown).join('\n'))
      shown = lines.length
    }
    const job = readJob(ref.id)
    if (TERMINAL.has(job.status)) {
      print(`[${job.id} ${job.status} after ${fmtDuration(jobDuration(job))}]`)
      return job.status === 'done' ? 0 : 1
    }
  }
}

async function cmdFiles(argv) {
  const { values, positionals } = parse(argv, { all: { type: 'boolean' } })
  if (values.help) return print(HELP.files), 0
  const ref = resolveRef(positionals[0])
  const jobs = refJobs(ref)
  const data = jobs.map((j) => ({ job: j.id, cwd: j.outDir ?? j.cwd, files: listFiles(j.outDir ?? j.cwd, { sinceMs: values.all ? 0 : Date.parse(j.createdAt) - 2000 }) }))
  emit({ jobs: data }, () =>
    data.map((d) => [`${d.job}  ${d.cwd}`, ...(d.files.length ? d.files.map((f) => `  ${pad(fmtBytes(f.bytes), 10)} ${f.path}`) : ['  (no files)'])].join('\n')).join('\n\n'),
  )
  return 0
}

async function cmdContinue(argv) {
  const { values, positionals } = parse(argv, { wait: RUN_OPTS.wait, timeout: RUN_OPTS.timeout, 'max-wait': RUN_OPTS['max-wait'], file: { type: 'string', short: 'f' } })
  if (values.help) return print(HELP.continue), 0
  const [refText, ...rest] = positionals
  const ref = resolveRef(refText)
  if (ref.kind !== 'job') throw new DshoError('continue needs a job', 2)
  const parent = readJob(ref.id)
  if (ACTIVE.has(parent.status)) throw new DshoError(`Job ${parent.id} is still running`, 4, `dsho wait ${parent.id}`)
  if (!parent.sessionId) throw new DshoError(`Job ${parent.id} has no session id, it cannot be continued`, 1)
  const prompt = taskFrom(rest, { file: values.file }).trim()
  if (!prompt) throw new DshoError('No follow-up task given', 2)
  const backend = parent.backend ?? 'headless'
  if (backend === 'web' && !(await web.available())) {
    throw new DshoError('The session lives in the DSH web UI, which is not reachable right now', 5, 'dsho ui start')
  }
  const job = startJob(
    { name: `${parent.name ?? parent.id}+`, title: parent.title, template: 'raw', prompt, backend, cwd: parent.cwd, outDir: parent.outDir ?? parent.cwd, web: parent.web, model: parent.model, effort: parent.effort, timeoutSec: timeoutSec(values, parent.timeoutSec), parent: parent.id, resume: parent.sessionId },
    prompt,
    { header: false },
  )
  return finishStart({ kind: 'job', id: job.id }, values, `Job ${job.id} continues session ${parent.sessionId} (workspace ${parent.cwd})\n  Wait: dsho wait ${job.id} --timeout 9m`)
}

async function cmdCancel(argv) {
  const { values, positionals } = parse(argv, {})
  if (values.help) return print(HELP.cancel), 0
  const ref = resolveRef(positionals[0])
  const n = ref.kind === 'job' ? (cancelJob(ref.id) ? 1 : 0) : cancelBatch(ref.id)
  const { jobs } = await waitFor([ref], { timeoutMs: 8000 })
  emit({ cancelled: n, jobs: jobs.map(jobView) }, () => [`${n} job(s) cancelled.`, JOB_HEADER, ...jobs.map(jobRow)].join('\n'))
  return 0
}

async function cmdCollect(argv) {
  const { values, positionals } = parse(argv, { output: { type: 'string', short: 'o' } })
  if (values.help) return print(HELP.collect), 0
  const ref = resolveRef(positionals[0] ?? 'last-batch')
  if (ref.kind !== 'batch') throw new DshoError('collect needs a batch', 2)
  const res = collectBatch(ref.id, { output: values.output ? resolve(values.output) : undefined })
  emit(res, () =>
    [
      `INDEX written:  ${res.index}`,
      res.manifest ? `Manifest:       ${res.manifest} (${res.materialFiles} files)` : null,
      res.sources ? `Sources:        ${res.sources} (${res.sourceCount} URLs)` : null,
      `Status: ${res.status} ${JSON.stringify(res.counts)}`,
    ].filter(Boolean).join('\n'),
  )
  return 0
}

async function cmdWs(argv) {
  const [sub, ...rest] = argv
  const { values, positionals } = parse(rest, { kind: { type: 'string' }, description: { type: 'string' } })
  if (values.help || sub !== 'init') {
    print(HELP.ws)
    return sub === 'init' || values.help || sub === '--help' || sub === '-h' ? 0 : 2
  }
  if (!positionals[0]) throw new DshoError('ws init needs a folder', 2)
  const res = ensureWorkspace(resolve(expandHome(positionals[0])), { kind: values.kind ?? 'general', description: values.description, force: true })
  emit({ workspace: res.path, agentsMd: join(res.path, 'AGENTS.md') }, `Workspace ready: ${res.path}\n  Start: dsho run -C ${res.path} "task"`)
  return 0
}

async function cmdCapture(argv) {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    print(HELP.capture)
    return argv.length ? 0 : 2
  }
  const { python, playwright } = findPython()
  if (!playwright) throw new DshoError('Python Playwright not found', 5, 'pip install playwright && python3 -m playwright install chromium, or set DSHO_PYTHON')
  const res = spawnSync(python, [CAPTURE_PY, ...argv.filter((a) => a !== '--json')], { stdio: 'inherit' })
  if (res.error) throw new DshoError(`cannot start ${python}: ${res.error.message}`, 5)
  return res.status ?? 1
}

function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawnSync(opener, [url], { stdio: 'ignore' })
}

async function cmdUi(argv) {
  const [sub, ...rest] = argv
  if (sub === 'start') {
    const { values } = parse(rest, { port: { type: 'string' } })
    if (values.help) return print(HELP.ui), 0
    if (await web.available()) {
      emit({ url: web.baseUrl(), started: false }, `DSH web UI already running at ${web.baseUrl()}`)
      return 0
    }
    const res = await web.startServer({ port: Number(values.port ?? 3080) })
    emit({ url: res.url, started: true, pid: res.pid, log: res.log }, `DSH web UI started at ${res.url} (pid ${res.pid}); jobs now run there.\n  Log: ${res.log}`)
    return 0
  }
  if (sub === 'login') {
    const { values, positionals } = parse(rest, {})
    if (values.help || !positionals[0]) return print(HELP.ui), values.help ? 0 : 2
    const origin = web.saveTokenUrl(positionals[0])
    process.env.DSHO_WEB_URL = origin
    const ok = (await web.exchangeToken({ only: positionals[0] })) != null
    if (!ok) throw new DshoError(`the token was not accepted by ${origin}`, 5, 'copy the newest URL printed by dsh web')
    emit({ url: origin }, `Logged in to the DSH web UI at ${origin}; the cookie stays valid for 30 days.`)
    return 0
  }
  const { values, positionals } = parse(argv, { print: { type: 'boolean' } })
  if (values.help) return print(HELP.ui), 0
  if (!(await web.available())) throw new DshoError(`DSH web UI at ${web.baseUrl()} is not running`, 5, 'dsho ui start')
  let where = null
  if (positionals[0]) {
    const ref = resolveRef(positionals[0])
    const jobs = refJobs(ref)
    const first = jobs[0]
    if (first?.backend !== 'web') where = 'This job ran headless: look under "Ungrouped".'
    else where = `workspace "${first.web?.workspaceTitle ?? basename(first.cwd)}", session${jobs.length > 1 ? 's' : ''} ${jobs.map((j) => `"${j.title ?? j.name}"`).join(', ')}`
  }
  if (!values.print) openInBrowser(web.baseUrl())
  emit({ url: web.baseUrl(), where }, [`DSH web UI: ${web.baseUrl()}${values.print ? '' : ' (opened in the browser)'}`, where ? `  Look for: ${where}` : null].filter(Boolean).join('\n'))
  return 0
}

async function cmdSkill(argv) {
  const [sub, ...rest] = argv
  const { values } = parse(rest, { agents: { type: 'string' }, copy: { type: 'boolean' } })
  if (values.help || sub !== 'install') {
    print(HELP.skill)
    return sub === 'install' || values.help ? 0 : 2
  }
  const res = installSkill({ agents: values.agents?.split(',').map((a) => a.trim()), copy: values.copy })
  emit(res, () => [`Skill dsh-orchestration installed: ${res.canonical}`, ...res.rows.slice(1).map((r) => `  ${pad(r.agent, 8)} ${r.action}: ${r.path}`)].join('\n'))
  return 0
}

async function cmdSetup(argv) {
  const { values } = parse(argv, { mcp: { type: 'string' }, from: { type: 'string' }, skills: { type: 'string' }, 'no-skill': { type: 'boolean' } })
  if (values.help) return print(HELP.setup), 0
  const profile = setupProfile({ mcp: values.mcp ?? 'research', from: values.from ?? 'web', skills: values.skills })
  const skill = values['no-skill'] ? null : installSkill({})
  const up = await web.available()
  emit({ profile, skill, webUi: up ? web.baseUrl() : null }, () =>
    [
      `dsh profile "${profile.profile}" ready: ${profile.profileDir}`,
      `  MCP servers: ${profile.mcpServers.join(', ') || 'none'}`,
      `  Skills:      ${profile.skillsDir ? `${profile.skills.length} curated in ${profile.skillsDir}` : 'dsh defaults'}`,
      ...profile.notes.map((n) => `  Note:        ${n}`),
      skill ? `Agent skill installed: ${skill.canonical}` : null,
      ...(skill ? skill.rows.slice(1).map((r) => `  ${pad(r.agent, 8)} ${r.action}`) : []),
      up ? `DSH web UI found at ${web.baseUrl()}: jobs will run there.` : 'DSH web UI not running: jobs run headless. Start it with dsho ui start to watch them live.',
    ].filter(Boolean).join('\n'),
  )
  return 0
}

async function cmdDoctor(argv) {
  const { values } = parse(argv, {})
  if (values.help) return print(HELP.doctor), 0
  const checks = doctor()
  const up = await web.available()
  checks.push({ name: 'web-ui', ok: up, optional: true, detail: up ? `${web.baseUrl()} reachable: jobs run live in the DSH UI` : `${web.baseUrl()} not reachable: jobs run headless (dsho ui start)` })
  const ok = checks.every((c) => c.ok || c.optional)
  emit({ healthy: ok, checks }, () => checks.map((c) => `${c.ok ? '✓' : c.optional ? '!' : '✗'} ${pad(c.name, 12)} ${c.detail}`).join('\n'))
  return ok ? 0 : 5
}

async function cmdConfig(argv) {
  const [sub, key, ...rest] = argv.filter((a) => a !== '--json')
  if (sub === '-h' || sub === '--help') return print(HELP.config), 0
  if (sub === 'set') {
    if (!key || !rest.length) throw new DshoError('usage: dsho config set <key> <value>', 2)
    setConfig(key, rest.join(' '))
  } else if (sub === 'unset') {
    if (!key) throw new DshoError('usage: dsho config unset <key>', 2)
    setConfig(key, null)
  } else if (sub) throw new DshoError(`Unknown config subcommand "${sub}"`, 2, 'dsho config --help')
  const stored = readConfig()
  const effective = Object.fromEntries(Object.keys(CONFIG_KEYS).map((k) => [k, cfg(k)]))
  emit({ stored, effective }, () => Object.keys(CONFIG_KEYS).map((k) => `${pad(k, 11)} ${effective[k] ?? '-'}${process.env[CONFIG_KEYS[k].env] ? `  (from ${CONFIG_KEYS[k].env})` : ''}`).join('\n'))
  return 0
}

const COMMANDS = {
  config: cmdConfig,
  run: cmdRun,
  batch: cmdBatch,
  research: cmdResearch,
  materials: cmdMaterials,
  status: cmdStatus,
  ls: cmdLs,
  list: cmdLs,
  wait: cmdWait,
  result: cmdResult,
  logs: cmdLogs,
  files: cmdFiles,
  continue: cmdContinue,
  cancel: cmdCancel,
  collect: cmdCollect,
  ws: cmdWs,
  capture: cmdCapture,
  ui: cmdUi,
  skill: cmdSkill,
  setup: cmdSetup,
  doctor: cmdDoctor,
}

export async function main(argv) {
  JSON_MODE = argv.includes('--json')
  const [cmd, ...rest] = argv
  try {
    if (cmd === '__run-job' || cmd === '__run-batch') {
      installSignalForwarding()
      if (cmd === '__run-job') await runJob(rest[0])
      else await runBatch(rest[0])
      return 0
    }
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
      const topic = cmd === 'help' ? rest[0] : null
      print(topic && HELP[topic] ? HELP[topic] : USAGE)
      return 0
    }
    if (cmd === '--version' || cmd === '-V' || cmd === 'version') return print(VERSION), 0
    if (cmd === 'guide') return print(GUIDE), 0
    const handler = COMMANDS[cmd]
    if (!handler) throw new DshoError(`Unknown command "${cmd}"`, 2, 'dsho help')
    return await handler(rest)
  } catch (err) {
    const code = err instanceof DshoError ? err.code : 1
    if (JSON_MODE) print(JSON.stringify({ ok: false, error: err.message, code, hint: err.hint ?? null }))
    else {
      process.stderr.write(`dsho: ${err.message}\n`)
      if (err.hint) process.stderr.write(`  hint: ${err.hint}\n`)
      if (!(err instanceof DshoError) && process.env.DSHO_DEBUG) process.stderr.write(`${err.stack}\n`)
    }
    return code
  }
}
