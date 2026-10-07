// Small shared helpers: ids, durations, slugs, JSON files, processes.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Error carrying a process exit code (2 usage, 3 not found, 4 timeout, 5 environment). */
export class DshoError extends Error {
  constructor(message, code = 1, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Time-ordered short id, e.g. `j-mgf3k2ab7x9`. */
export function newId(prefix) {
  const rand = [...randomBytes(4)].map((b) => B36[b % 36]).join('')
  return `${prefix}-${Date.now().toString(36)}${rand}`
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

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readJson(file, fallback = undefined) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return fallback
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
