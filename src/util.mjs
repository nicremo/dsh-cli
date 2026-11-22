// Small shared helpers: ids, durations, slugs, JSON files, processes.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Expand a leading `~` (`~`, `~/x`, and `~\x` on Windows) to the home directory. */
export function expandHome(value) {
  if (typeof value !== 'string') return value
  const m = /^~(?:$|[\\/](.*))/s.exec(value)
  return m ? (m[1] ? join(homedir(), m[1]) : homedir()) : value
}

/** Error carrying a process exit code (2 usage, 3 not found, 4 timeout, 5 environment). */
export class DshoError extends Error {
  constructor(message, code = 1, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

let lastIdTime = 0

/**
 * Time-ordered short id, e.g. `j-mgf3k2ab7x9`. The time part never repeats within a
 * process (a batch creates many jobs in one millisecond), so ids sort in creation
 * order and `last` is unambiguous.
 */
export function newId(prefix) {
  const time = Math.max(Date.now(), lastIdTime + 1)
  lastIdTime = time
  const rand = [...randomBytes(4)].map((b) => B36[b % 36]).join('')
  return `${prefix}-${time.toString(36)}${rand}`
}

/** Parse `90s`, `20m`, `1.5h` or bare seconds into seconds. */
export function parseDuration(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(String(text))
  if (!m) throw new DshoError(`Invalid duration "${text}". Examples: 90s, 20m, 1h`, 2)
  const factor = { s: 1, m: 60, h: 3600 }[(m[2] || 's').toLowerCase()]
  return Math.round(Number(m[1]) * factor)
}

/** Filesystem-friendly slug that keeps letters of every script, umlauts included. */
export function slug(text, max = 40) {
  const s = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || 'task'
}

/** Errors Windows raises while another process has the file open (reader, writer, virus scanner). */
const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const SHARING_RETRY_MS = 2000

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn`, retrying while the file is briefly locked by another process. Job and batch
 * files are rewritten by the launching command and the runner at the same time; on
 * Windows a rename onto (or a read of) a file the other process holds fails with EPERM.
 */
function withSharingRetry(fn) {
  const deadline = Date.now() + SHARING_RETRY_MS
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return fn()
    } catch (err) {
      if (!SHARING_ERRORS.has(err.code) || Date.now() >= deadline) throw err
      sleepSync(delay)
    }
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  try {
    withSharingRetry(() => renameSync(tmp, file))
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function readJson(file, fallback = undefined) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(withSharingRetry(() => readFileSync(file, 'utf8')))
    } catch (err) {
      if (err.code === 'ENOENT') return fallback
      // A parse error means a torn read; try again.
      if (attempt === 2) throw err
    }
  }
  return fallback
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-'
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export const nowIso = () => new Date().toISOString()

/** Single-line excerpt for compact listings. */
export function excerpt(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
