// Shared test plumbing. Every test gets its own sandbox: private state, home,
// dsh home and workspace folders, and an environment that cannot reach the
// developer's real ~/.dsho, ~/.dsh, ~/.agents or ~/.claude.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
export const FAKE_DSH = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url))
export const IS_WINDOWS = process.platform === 'win32'

/** Variables of the developer's shell that would change what dsho does. */
const LEAKY = /^(DSHO_|DSH_|XDG_CACHE_HOME$|CLAUDE_CONFIG_DIR$|CODEX_HOME$|DEEPSEEK_API_KEY$|OPENROUTER_API_KEY$|FAKE_DSH_)/

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!LEAKY.test(key)) env[key] = value
  return { ...env, ...extra }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until fn returns something truthy; fails with `what` after the deadline. */
export async function until(fn, { timeoutMs = 10000, intervalMs = 40, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(intervalMs)
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** A temp folder that is removed when the test ends. */
export function tempDir(t, prefix = 'dsho-tmp-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Pid of a process that has already exited. */
export function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
}

/** End a process and everything below it, at once. */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return
  if (IS_WINDOWS) {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Already gone, or not a group leader.
    }
  }
}

/**
 * Install the fake dsh the way a real one is installed: an npm .cmd shim on Windows,
 * an executable launcher elsewhere. Returns the path for DSHO_DSH_BIN or PATH.
 */
export function installFakeDshBinary(dir) {
  mkdirSync(dir, { recursive: true })
  if (IS_WINDOWS) {
    const file = join(dir, 'dsh.cmd')
    writeFileSync(file, `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%"  "${FAKE_DSH}" %*\r\n`)
    return file
  }
  const file = join(dir, 'dsh')
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DSH}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

const readJsonSafe = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Run `dsho <args>` to completion. `json` is the parsed stdout when it is JSON. */
export function dsho(env, args, { input = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`dsho ${args.join(' ')} did not exit within ${timeoutMs} ms\n${out}\n${err}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c) => (err += c))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      let json = null
      try {
        json = JSON.parse(out)
      } catch {
        // Text output.
      }
      resolve({ code, out, err, json })
    })
  })
}

/**
 * A private dsho world for one test. Removed when the test ends, together with
 * every runner or fake dsh process that is still alive.
 */
export function sandbox(t, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsho-test-'))
  const dirs = { root, userHome: join(root, 'home'), home: join(root, 'dsho'), dshHome: join(root, 'dsh'), ws: join(root, 'ws') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const fakeLog = join(root, 'fake-dsh.log')
  const env = cleanEnv({
    HOME: dirs.userHome,
    USERPROFILE: dirs.userHome, // os.homedir() on Windows
    DSHO_HOME: dirs.home,
    DSH_HOME: dirs.dshHome,
    DSH_AGENTS_HOME: join(dirs.userHome, '.agents'),
    DSHO_WORKSPACES: join(dirs.ws, 'auto'),
    DSHO_DSH_CMD: FAKE_DSH,
    DSHO_BACKEND: 'headless',
    // Nothing listens here and no token is stored for it, so no request is ever sent.
    DSHO_WEB_URL: 'http://127.0.0.1:9',
    FAKE_DSH_LOG: fakeLog,
    ...extraEnv,
  })

  const jobFile = (id) => readJsonSafe(join(dirs.home, 'jobs', id, 'job.json'))
  const stored = (kind) => {
    const dir = join(dirs.home, kind)
    return existsSync(dir) ? readdirSync(dir).map((id) => readJsonSafe(join(dir, id, kind === 'jobs' ? 'job.json' : 'batch.json'))).filter(Boolean) : []
  }
  /** What the fake dsh processes of this sandbox logged: start and end with pid, argv, cwd. */
  const dshLog = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

  /** Stored jobs and runner logs, for the message of a test that gave up waiting. */
  const diagnostics = () => {
    const logDir = join(dirs.home, 'logs')
    const logs = existsSync(logDir) ? readdirSync(logDir).map((name) => `--- ${name}\n${readFileSync(join(logDir, name), 'utf8')}`) : []
    const jobs = stored('jobs').map((j) => `${j.id} ${j.status} owner ${j.ownerPid} (${pidAlive(j.ownerPid) ? 'alive' : 'dead'}) dsh ${j.dshPid} ${j.error ?? ''}`)
    return ['jobs:', ...jobs, 'runner logs:', ...logs].join('\n')
  }

  t.after(() => {
    // Only processes of unfinished work: a finished job's pid may belong to someone else by now.
    for (const job of stored('jobs')) {
      if (job.status === 'queued' || job.status === 'running') {
        killTree(job.ownerPid)
        killTree(job.dshPid)
      }
    }
    for (const batch of stored('batches')) if (!batch.endedAt) killTree(batch.ownerPid)
    const log = dshLog()
    const ended = new Set(log.filter((e) => e.event === 'end').map((e) => e.pid))
    for (const e of log) if (e.event === 'start' && !ended.has(e.pid)) killTree(e.pid)
    // DSHO_TEST_KEEP=1 keeps the sandbox (state, runner logs) for a post-mortem.
    if (process.env.DSHO_TEST_KEEP) return
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // A process that is just exiting can still hold a file on Windows.
    }
  })

  const run = (args, opts) => dsho(env, args, opts)

  return {
    ...dirs,
    env,
    run,
    /** until() that reports the stored state and the runner logs when it gives up. */
    until: (fn, opts) =>
      until(fn, opts).catch((err) => {
        throw new Error(`${err.message}\n${diagnostics()}`)
      }),
    jobFile,
    dshLog,
    /** Start a job and wait until its dsh process is up. Returns the stored job. */
    async startRunning(args) {
      const known = new Set(dshLog().map((e) => e.pid))
      const start = await run(['run', '--json', ...args])
      if (start.code !== 0) throw new Error(`run failed: ${start.out}${start.err}`)
      const id = start.json.job.id
      // Watch the fake's own log, not job.json: the runner is rewriting that file right now.
      const booted = await this.until(() => dshLog().find((e) => e.event === 'start' && !known.has(e.pid)), { what: `the dsh process of job ${id}` })
      return this.until(() => (jobFile(id)?.dshPid === booted.pid ? jobFile(id) : null), { intervalMs: 150, what: `job ${id} to record its dsh process` })
    },
  }
}

/** Run a test body in a fresh sandbox (temp home, fake dsh) that is removed afterwards. */
export function inSandbox(body, world = sandbox) {
  return async (t) => body(await world(t), t)
}

/**
 * For the few tests that import src/ modules directly: point this process at a
 * private home before any dsho code reads the environment. Returns the folders.
 */
export function isolateProcess() {
  for (const key of Object.keys(process.env)) if (LEAKY.test(key)) delete process.env[key]
  const root = mkdtempSync(join(tmpdir(), 'dsho-unit-'))
  const dirs = { root, userHome: join(root, 'home'), home: join(root, 'dsho'), dshHome: join(root, 'dsh') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  Object.assign(process.env, { HOME: dirs.userHome, USERPROFILE: dirs.userHome, DSHO_HOME: dirs.home, DSH_HOME: dirs.dshHome })
  process.on('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  })
  return dirs
}
