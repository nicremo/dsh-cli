// Runs one job: spawns headless dsh in the job's workspace, streams the event
// log to disk, keeps job.json current and maps the outcome to a status.
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDshSettings, resolveModel, spawnSpec } from './dsh.mjs'
import { fold, initialState } from './events.mjs'
import { home, jobDir, logsDir } from './paths.mjs'
import { createJob, readJobRaw, TERMINAL, updateJob } from './store.mjs'
import { DshoError, nowIso, pidAlive, sleep } from './util.mjs'
import * as web from './web.mjs'

const BIN = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
const KILL_GRACE_MS = 5000
const PROGRESS_WRITE_MS = 1000
const WEB_POLL_MS = Number(process.env.DSHO_WEB_POLL_MS || 2000)
const WEB_OUTAGE_MS = 120000

/** Live dsh child processes of this process, for signal forwarding. */
export const activeChildren = new Map()

export const cancelMarker = (id) => join(jobDir(id), 'cancel')
const taskFile = (id) => join(jobDir(id), 'task.md')

/** Create a job and store the exact task text dsh will receive. */
export function createRunnableJob(fields, taskText) {
  const job = createJob(fields)
  writeFileSync(taskFile(job.id), taskText)
  return job
}

export function readTask(id) {
  return existsSync(taskFile(id)) ? readFileSync(taskFile(id), 'utf8') : ''
}

function killGroup(pid, signal) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

function stderrTail(file) {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !/statectl failed/.test(l))
    .slice(-6)
    .join('\n')
    .slice(-800)
}

/** Request cancellation; the owning runner notices and records `cancelled`. */
export function cancelJob(id) {
  const job = readJobRaw(id)
  if (!job) throw new DshoError(`Job ${id} not found`, 3)
  if (TERMINAL.has(job.status)) return false
  writeFileSync(cancelMarker(id), nowIso())
  if (job.status === 'running' && job.dshPid) killGroup(job.dshPid, 'SIGTERM')
  if (!job.ownerPid || !pidAlive(job.ownerPid)) {
    updateJob(id, { status: 'cancelled', endedAt: nowIso() })
  }
  return true
}

/** Run a job on its backend: `web` (inside the DSH UI server) or `headless`. */
export async function runJob(id) {
  const job = readJobRaw(id)
  if (!job) throw new DshoError(`Job ${id} not found`, 3)
  return job.backend === 'web' ? runWeb(id) : runHeadless(id)
}

async function runHeadless(id) {
  let job = readJobRaw(id)
  if (!job) throw new DshoError(`Job ${id} not found`, 3)
  if (TERMINAL.has(job.status)) return job
  if (existsSync(cancelMarker(id))) return updateJob(id, { status: 'cancelled', endedAt: nowIso() })

  const dir = jobDir(id)
  const eventsPath = join(dir, 'events.jsonl')
  const stderrPath = join(dir, 'stderr.log')
  mkdirSync(job.cwd, { recursive: true })
  if (job.outDir) mkdirSync(job.outDir, { recursive: true })

  let spec
  try {
    spec = spawnSpec({ sessionId: job.resume, model: job.model, effort: job.effort, jobDir: dir })
  } catch (err) {
    return updateJob(id, { status: 'failed', error: err.message, endedAt: nowIso() })
  }

  const errFd = openSync(stderrPath, 'a')
  const child = spawn(spec.cmd, spec.args, {
    cwd: job.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', errFd],
    detached: true,
  })
  closeSync(errFd)
  activeChildren.set(id, child)

  job = updateJob(id, {
    status: 'running',
    ownerPid: process.pid,
    dshPid: child.pid ?? null,
    profile: spec.profile,
    startedAt: nowIso(),
  })

  const state = initialState()
  let lastWrite = 0
  let timedOut = false
  const flush = (force = false) => {
    const now = Date.now()
    if (!force && now - lastWrite < PROGRESS_WRITE_MS) return
    lastWrite = now
    updateJob(id, (j) => ({
      ...j,
      sessionId: state.sessionId ?? j.sessionId,
      progress: { steps: state.steps, toolCalls: state.toolCalls, lastTool: state.lastTool, lastActivityAt: nowIso() },
      usage: { ...state.usage },
    }))
  }

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    appendFileSync(eventsPath, chunk)
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        fold(state, ev)
        flush(ev.type === 'session' || ev.type === 'final')
      } catch {
        // Non-JSON output stays in events.jsonl only.
      }
    }
  })

  child.stdin.on('error', () => {})
  child.stdin.end(readTask(id))

  const timeoutMs = (job.timeoutSec ?? 1800) * 1000
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid, 'SIGTERM')
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref()
  }, timeoutMs)
  const cancelPoll = setInterval(() => {
    if (existsSync(cancelMarker(id))) {
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref()
    }
  }, 500)

  const exitCode = await new Promise((resolve) => {
    child.on('error', (err) => {
      appendFileSync(stderrPath, `dsho: spawn failed: ${err.message}\n`)
      resolve(-1)
    })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : -1)))
  })
  clearTimeout(timer)
  clearInterval(cancelPoll)
  activeChildren.delete(id)

  if (buffer.trim()) {
    try {
      fold(state, JSON.parse(buffer))
    } catch {
      // Trailing partial line.
    }
  }
  if (state.final != null) writeFileSync(join(dir, 'result.md'), state.final)

  let status
  if (existsSync(cancelMarker(id))) status = 'cancelled'
  else if (timedOut) status = 'timeout'
  else if (exitCode === 0 && state.turnEnd === 'completed') status = 'done'
  else status = 'failed'

  let error = null
  if (status === 'timeout') error = `timed out after ${job.timeoutSec}s`
  else if (status === 'failed') error = state.error || stderrTail(stderrPath) || `dsh exited with code ${exitCode}`

  return updateJob(id, (j) => ({
    ...j,
    status,
    exitCode,
    turnEnd: state.turnEnd,
    error,
    sessionId: state.sessionId ?? j.sessionId,
    endedAt: nowIso(),
    progress: { steps: state.steps, toolCalls: state.toolCalls, lastTool: state.lastTool, lastActivityAt: nowIso() },
    usage: { ...state.usage },
  }))
}

function finishState(state, { cancelled, timedOut, job, extraError }) {
  let status
  if (cancelled) status = 'cancelled'
  else if (timedOut) status = 'timeout'
  else if (state.turnEnd === 'completed') status = 'done'
  else status = 'failed'
  let error = null
  if (status === 'timeout') error = `timed out after ${job.timeoutSec}s`
  else if (status === 'failed') error = extraError || state.error || 'turn ended without completing'
  return { status, error }
}

/**
 * Run a job inside the running DSH web server: register the Workspace, create
 * (or reuse) the Session, send the task, then poll the durable Session log and
 * translate it into events.jsonl until the turn that answers our prompt ends.
 */
async function runWeb(id) {
  let job = readJobRaw(id)
  if (TERMINAL.has(job.status)) return job
  if (existsSync(cancelMarker(id))) return updateJob(id, { status: 'cancelled', endedAt: nowIso() })
  const dir = jobDir(id)
  const eventsPath = join(dir, 'events.jsonl')
  mkdirSync(job.cwd, { recursive: true })
  if (job.outDir) mkdirSync(job.outDir, { recursive: true })
  job = updateJob(id, { status: 'running', ownerPid: process.pid, startedAt: nowIso() })

  const state = initialState()
  const ctx = {}
  let lastWrite = 0
  const record = (events) => {
    for (const ev of events) {
      appendFileSync(eventsPath, JSON.stringify(ev) + '\n')
      fold(state, ev)
    }
    const now = Date.now()
    if (events.length && now - lastWrite >= PROGRESS_WRITE_MS) {
      lastWrite = now
      updateJob(id, (j) => ({
        ...j,
        progress: { steps: state.steps, toolCalls: state.toolCalls, lastTool: state.lastTool, lastActivityAt: nowIso() },
        usage: { ...state.usage },
      }))
    }
  }

  let cancelled = false
  let timedOut = false
  let extraError = null
  let sessionId = job.resume ?? null
  try {
    if (!sessionId) {
      const workspace = await web.ensureWorkspace(job.cwd)
      sessionId = (await web.createSession(workspace.workspaceId)).sessionId
      updateJob(id, { sessionId, web: { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, baseUrl: web.baseUrl() } })
      if (job.title) {
        try {
          await web.renameSession(sessionId, job.title)
        } catch {
          // The title is cosmetic; the generated title stays.
        }
      }
    } else {
      updateJob(id, { sessionId, web: { baseUrl: web.baseUrl(), ...(job.web ?? {}) } })
    }
    if (job.model || job.effort) {
      const current = readDshSettings()['agent-default-model'] ?? {}
      const reasoningEffort = job.effort ?? current.reasoningEffort
      await web.selectModel(sessionId, {
        provider: current.provider ?? 'deepseek-official',
        model: resolveModel(job.model) ?? current.model ?? 'deepseek-flash',
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
    }
    record([{ type: 'session', sessionId, cwd: job.cwd }])
    let lastSeq = await web.cursor(sessionId)
    const requestId = await web.prompt(sessionId, readTask(id))
    const deadline = Date.now() + (job.timeoutSec ?? 1800) * 1000
    let mySeq = null
    let outageSince = null
    let stopRequestedAt = null
    while (true) {
      await sleep(WEB_POLL_MS)
      if (!stopRequestedAt && (existsSync(cancelMarker(id)) || Date.now() > deadline)) {
        if (existsSync(cancelMarker(id))) cancelled = true
        else timedOut = true
        stopRequestedAt = Date.now()
        try {
          await web.cancelSession(sessionId)
        } catch {
          // The turn may already be over; the poll below settles it.
        }
      }
      if (stopRequestedAt && Date.now() - stopRequestedAt > 15000) break
      let events
      try {
        const cur = await web.cursor(sessionId)
        events = await web.eventsSince(sessionId, lastSeq, cur)
        lastSeq = cur
        outageSince = null
      } catch (err) {
        outageSince ??= Date.now()
        if (Date.now() - outageSince > WEB_OUTAGE_MS) throw new DshoError(`DSH web UI unreachable for 2 minutes: ${err.message}`, 1)
        continue
      }
      if (mySeq == null) {
        mySeq = web.promptSeq(events, requestId)
        if (mySeq == null) continue
      }
      const ours = events.filter((e) => e.seq >= mySeq)
      record(ours.flatMap((e) => web.translate(e, ctx)))
      if (ours.some((e) => e.type === 'turn/end')) break
    }
  } catch (err) {
    extraError = err.message
  }

  if (state.final != null) writeFileSync(join(dir, 'result.md'), state.final)
  const { status, error } = finishState(state, { cancelled, timedOut, job, extraError })
  return updateJob(id, (j) => ({
    ...j,
    status,
    exitCode: status === 'done' ? 0 : 1,
    turnEnd: state.turnEnd,
    error,
    sessionId: sessionId ?? j.sessionId,
    endedAt: nowIso(),
    progress: { steps: state.steps, toolCalls: state.toolCalls, lastTool: state.lastTool, lastActivityAt: nowIso() },
    usage: { ...state.usage },
  }))
}

/** Forward termination to running dsh children and record them as cancelled. */
export function installSignalForwarding() {
  const stop = (signal) => {
    for (const [id, child] of activeChildren) {
      try {
        writeFileSync(cancelMarker(id), `${nowIso()} ${signal}`)
      } catch {
        // Job dir may be gone.
      }
      killGroup(child.pid, 'SIGTERM')
    }
    setTimeout(() => process.exit(130), activeChildren.size ? 1500 : 0)
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGHUP', () => {})
}

/** Re-invoke dsho detached (own session) for `__run-job` or `__run-batch`. */
export function spawnDetached(args) {
  mkdirSync(logsDir(), { recursive: true })
  const log = openSync(join(logsDir(), `${args[1] ?? 'runner'}.log`), 'a')
  const child = spawn(process.execPath, [BIN, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
    cwd: home(),
  })
  closeSync(log)
  child.unref()
  return child.pid
}
