// Runs one job: spawns headless dsh in the job's workspace, streams the event
// log to disk, keeps job.json current and maps the outcome to a status.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cfg } from './config.mjs'
import { modelSelection, spawnSpec } from './dsh.mjs'
import { fold, initialState } from './events.mjs'
import { batchDir, home, jobDir, logsDir } from './paths.mjs'
import { createJob, readJobRaw, TERMINAL, updateJob } from './store.mjs'
import { DshoError, nowIso, pidAlive, sleep } from './util.mjs'
import * as web from './web.mjs'

const BIN = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
const KILL_GRACE_MS = 5000
const CANCEL_POLL_MS = 500
const PROGRESS_WRITE_MS = 1000
const WEB_POLL_MS = Number(process.env.DSHO_WEB_POLL_MS || 2000)
const WEB_OUTAGE_MS = 120000
const WEB_STOP_WAIT_MS = 15000
/** Upper bound for a graceful shutdown after SIGTERM/SIGINT before the runner exits anyway. */
const SHUTDOWN_LIMIT_MS = Number(process.env.DSHO_SHUTDOWN_MS || 25000)

/** Live dsh child processes of this process, for signal forwarding. */
export const activeChildren = new Map()
/** Web jobs this process is driving right now (job id → session id). */
const activeWebJobs = new Map()

export const cancelMarker = (id) => join(jobDir(id), 'cancel')
export const batchCancelMarker = (id) => join(batchDir(id), 'cancel')
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
  if (process.platform === 'win32') {
    // No process groups on Windows: end the whole tree (dsh starts its own children).
    // Absolute path: a bare name would also be looked up in the cwd, which may be a workspace.
    const taskkill = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
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

/**
 * Run a job on its backend: `web` (inside the DSH UI server) or `headless`.
 * A job that chose the web UI only through `--backend auto` falls back to headless
 * when the UI fails before the task was sent (server gone, incompatible API).
 */
export async function runJob(id) {
  const job = readJobRaw(id)
  if (!job) throw new DshoError(`Job ${id} not found`, 3)
  if (job.backend !== 'web') return runHeadless(id)
  const result = await runWeb(id)
  if (result?.fallback && job.backendChoice === 'auto' && !job.resume) {
    updateJob(id, (j) => ({
      ...j,
      backend: 'headless',
      // Web sessions of a batch share the batch folder; headless workers run in their own.
      cwd: j.outDir ?? j.cwd,
      status: 'queued',
      error: null,
      endedAt: null,
      fallbackFrom: { backend: 'web', error: result.fallback },
    }))
    return runHeadless(id)
  }
  return result.job
}

/** Store the final answer; an error turn's empty text must not hide the error. */
function writeResult(dir, state, status) {
  if (state.final == null) return
  if (status !== 'done' && !state.final.trim()) return
  writeFileSync(join(dir, 'result.md'), state.final)
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
    spec = spawnSpec({ sessionId: job.resume, model: job.model, effort: job.effort, access: job.access, jobDir: dir })
  } catch (err) {
    return updateJob(id, { status: 'failed', error: err.message, endedAt: nowIso() })
  }

  const errFd = openSync(stderrPath, 'a')
  const child = spawn(spec.cmd, spec.args, {
    cwd: job.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', errFd],
    detached: true,
    windowsHide: true,
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

  // Once the child has exited its PID may belong to another process: never signal it again.
  // The runner stays alive until the child is gone, so the SIGKILL escalation always runs.
  const exited = () => child.exitCode !== null || child.signalCode !== null
  let stopping = false
  const stop = () => {
    if (stopping || exited()) return
    stopping = true
    killGroup(child.pid, 'SIGTERM')
    setTimeout(() => {
      if (!exited()) killGroup(child.pid, 'SIGKILL')
    }, KILL_GRACE_MS)
  }
  const timeoutMs = (job.timeoutSec ?? 1800) * 1000
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  const cancelPoll = setInterval(() => {
    if (existsSync(cancelMarker(id))) stop()
  }, CANCEL_POLL_MS)

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

  let status
  if (existsSync(cancelMarker(id))) status = 'cancelled'
  else if (timedOut) status = 'timeout'
  else if (exitCode === 0 && state.turnEnd === 'completed') status = 'done'
  else status = 'failed'
  writeResult(dir, state, status)

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

/** Sleep up to `ms`, waking early when the job gets a cancel marker. */
async function pause(ms, id) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(cancelMarker(id))) return
    await sleep(Math.min(200, until - Date.now()))
  }
}

/**
 * Run a job inside the running DSH web server: register the Workspace, create
 * (or reuse) the Session, send the task, then poll the durable Session log and
 * translate it into events.jsonl until the turn that answers our prompt ends.
 * Returns `{ job }`, or `{ fallback: reason }` when the UI failed before the task
 * was sent (the caller may then run the job headless).
 */
async function runWeb(id) {
  let job = readJobRaw(id)
  if (TERMINAL.has(job.status)) return { job }
  if (existsSync(cancelMarker(id))) return { job: updateJob(id, { status: 'cancelled', endedAt: nowIso() }) }
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
  let promptSent = false
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
    if (job.model || job.effort || cfg('provider') || cfg('model')) {
      await web.selectModel(sessionId, modelSelection({ model: job.model, effort: job.effort }))
    }
    let lastSeq = await web.cursor(sessionId)
    record([{ type: 'session', sessionId, cwd: job.cwd }])
    activeWebJobs.set(id, sessionId)
    const requestId = await web.prompt(sessionId, readTask(id))
    promptSent = true
    const deadline = Date.now() + (job.timeoutSec ?? 1800) * 1000
    let mySeq = null
    let outageSince = null
    let stopRequestedAt = null
    while (true) {
      await pause(WEB_POLL_MS, id)
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
      if (stopRequestedAt && Date.now() - stopRequestedAt > WEB_STOP_WAIT_MS) break
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
      // Only our turn: stop at its turn/end, so later turns in the same session
      // (the user typing in the UI, a queued prompt) never reach this job.
      const ours = events.filter((e) => e.seq >= mySeq)
      const end = ours.findIndex((e) => e.type === 'turn/end')
      record((end >= 0 ? ours.slice(0, end + 1) : ours).flatMap((e) => web.translate(e, ctx)))
      if (end >= 0) break
    }
  } catch (err) {
    extraError = err.message
  } finally {
    activeWebJobs.delete(id)
  }

  if (!promptSent && !cancelled && extraError && job.backendChoice === 'auto' && !job.resume) {
    return { job: readJobRaw(id), fallback: extraError }
  }
  const { status, error } = finishState(state, { cancelled, timedOut, job, extraError })
  writeResult(dir, state, status)
  return {
    job: updateJob(id, (j) => ({
      ...j,
      status,
      exitCode: status === 'done' ? 0 : 1,
      turnEnd: state.turnEnd,
      error,
      sessionId: sessionId ?? j.sessionId,
      endedAt: nowIso(),
      progress: { steps: state.steps, toolCalls: state.toolCalls, lastTool: state.lastTool, lastActivityAt: nowIso() },
      usage: { ...state.usage },
    })),
  }
}

let shuttingDown = false
/** True after SIGTERM/SIGINT: running jobs are being cancelled and no new ones start. */
export const isShuttingDown = () => shuttingDown

/**
 * Graceful termination of a runner (`__run-job`, `__run-batch`): mark every running
 * job (and the batch) as cancelled, stop headless children (SIGTERM, SIGKILL after a
 * grace period) and cancel web turns. The job loops notice the markers, record
 * `cancelled` and return; the process then exits on its own. A hard limit ends it
 * anyway if something hangs.
 */
export function installSignalForwarding({ batchId } = {}) {
  const stop = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    const mark = (file) => {
      try {
        writeFileSync(file, `${nowIso()} ${signal}\n`)
      } catch {
        // Folder may be gone.
      }
    }
    if (batchId) mark(batchCancelMarker(batchId))
    for (const id of [...activeChildren.keys(), ...activeWebJobs.keys()]) mark(cancelMarker(id))
    for (const child of activeChildren.values()) killGroup(child.pid, 'SIGTERM')
    for (const sessionId of activeWebJobs.values()) web.cancelSession(sessionId).catch(() => {})
    const hard = setTimeout(() => {
      for (const child of activeChildren.values()) {
        if (child.exitCode === null && child.signalCode === null) killGroup(child.pid, 'SIGKILL')
      }
      process.exit(130)
    }, SHUTDOWN_LIMIT_MS)
    hard.unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => stop('SIGBREAK'))
  else process.on('SIGHUP', () => {})
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
    windowsHide: true,
  })
  closeSync(log)
  child.unref()
  return child.pid
}
