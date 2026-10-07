// Client for a running DeepSeek Harness web server (`dsh web`).
// Jobs started through it run inside that process, so they appear live in the
// browser UI, grouped under their Workspace.
//
// Auth: `dsh web` prints a URL carrying a per-process launch token. GET /?token=...
// answers 303 with a signed 30-day cookie, which dsh-cli caches in
// ~/.dsho/web-auth.json (mode 0600). The cookie survives server restarts because
// dsh signs it with a durable secret.
// Remote calls: POST /api/<namespace>/<method> with a client-request envelope.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cfg } from './config.mjs'
import { dshCommand } from './dsh.mjs'
import { home, logsDir } from './paths.mjs'
import { DshoError, pidAlive, readJson, sleep } from './util.mjs'

const REQUEST_TIMEOUT_MS = 20000
const authFile = () => join(home(), 'web-auth.json')
export const tokenUrlFile = () => join(home(), 'web-token-url')

/** Places a token URL may come from, most explicit first. */
function tokenUrlCandidates() {
  const files = [
    process.env.DSHO_WEB_TOKEN_FILE,
    tokenUrlFile(),
    // Launcher scripts that keep the last `dsh web` URL in the XDG cache.
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'deepseek-harness', 'last-url'),
  ].filter(Boolean)
  const urls = process.env.DSHO_WEB_TOKEN_URL ? [process.env.DSHO_WEB_TOKEN_URL] : []
  for (const file of files) {
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8').trim()
    if (raw.startsWith('http')) urls.push(raw)
  }
  return urls
}

/** Candidate token URLs for the configured origin, most explicit first. */
function tokenUrls() {
  const base = cfg('webUrl')?.replace(/\/+$/, '')
  const urls = tokenUrlCandidates()
  return base ? urls.filter((u) => new URL(u).origin === base) : urls
}

/** Remember a token URL printed by `dsh web` (dsho ui login / ui start). */
export function saveTokenUrl(url) {
  const parsed = new URL(url)
  if (!parsed.searchParams.get('token')) throw new DshoError('The URL carries no ?token= parameter', 2, 'copy the full URL that `dsh web` prints')
  mkdirSync(home(), { recursive: true })
  writeFileSync(tokenUrlFile(), parsed.href + '\n', { mode: 0o600 })
  return parsed.origin
}

export function baseUrl() {
  const configured = cfg('webUrl')
  if (configured) return configured.replace(/\/+$/, '')
  const t = tokenUrls()[0]
  if (t) return new URL(t).origin
  return 'http://127.0.0.1:3080'
}

/** Exchange a token URL for the cookie; `only` restricts the attempt to one URL. */
export async function exchangeToken({ only } = {}) {
  for (const t of only ? [only] : tokenUrls()) {
    if (new URL(t).origin !== baseUrl()) continue
    let res
    try {
      res = await fetch(t, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    } catch {
      return null
    }
    const setCookie = res.headers.get('set-cookie')
    if (res.status !== 303 || !setCookie) continue
    const cookie = setCookie.split(';')[0]
    mkdirSync(home(), { recursive: true })
    writeFileSync(authFile(), JSON.stringify({ origin: baseUrl(), cookie, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    return cookie
  }
  return null
}

async function cookie({ refresh = false } = {}) {
  if (!refresh) {
    const cached = readJson(authFile(), null)
    if (cached?.origin === baseUrl() && cached.cookie) return cached.cookie
  }
  return exchangeToken()
}

/** Remote error carrying the server's error code. */
export class WebError extends DshoError {
  constructor(method, error) {
    super(`DSH web ${method}: ${error?.message ?? 'error'}`, 1)
    this.remoteCode = error?.code
    this.details = error?.details
  }
}

/**
 * Call one unary Remote method. `args` maps parameter names to values, e.g.
 * `{ request: { sessionId } }`.
 */
export async function call(method, args, { retryAuth = true } = {}) {
  const c = await cookie()
  if (!c) throw new DshoError('Cannot authenticate against the DSH web UI (no valid token)', 5, 'dsho ui start, or dsho ui login <url printed by dsh web>')
  let res
  try {
    res = await fetch(`${baseUrl()}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new DshoError(`DSH web UI at ${baseUrl()} is not reachable: ${err.cause?.code ?? err.message}`, 5, 'dsho ui start')
  }
  if (res.status === 401 && retryAuth) {
    await cookie({ refresh: true })
    return call(method, args, { retryAuth: false })
  }
  if (res.status !== 200) throw new DshoError(`DSH web ${method}: HTTP ${res.status}`, 5)
  const body = await res.json()
  if (!body?.result?.ok) throw new WebError(method, body?.result?.error)
  return body.result.value
}

/** True when the DSH web server answers an authenticated request. */
export async function available() {
  try {
    const c = await cookie()
    if (!c) return false
    let res = await fetch(`${baseUrl()}/`, { headers: { cookie: c }, redirect: 'manual', signal: AbortSignal.timeout(2500) })
    if (res.status === 401) {
      const fresh = await cookie({ refresh: true })
      if (!fresh) return false
      res = await fetch(`${baseUrl()}/`, { headers: { cookie: fresh }, redirect: 'manual', signal: AbortSignal.timeout(2500) })
    }
    return res.status === 200
  } catch {
    return false
  }
}

/** Register (or adopt) the Workspace for an existing directory. */
export async function ensureWorkspace(path) {
  const value = await call('workspace/create', { request: { path } })
  return value.workspace
}

export async function createSession(workspaceId) {
  return call('session/create', { request: { workspaceId } })
}

export async function renameSession(sessionId, title) {
  return call('session/rename', { request: { sessionId, title: title.slice(0, 120) } })
}

export async function selectModel(sessionId, selection) {
  return call('session/selectModel', { request: { sessionId, ...selection } })
}

export async function prompt(sessionId, text) {
  const requestId = randomUUID()
  await call('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
  return requestId
}

export async function cancelSession(sessionId) {
  return call('session/cancel', { request: { sessionId } })
}

const address = (sessionId) => ({ kind: 'session', sessionId })

/** Newest committed event seq of a Session. */
export async function cursor(sessionId) {
  try {
    await call('session/page', { request: { address: address(sessionId), throughSeq: 2147483647, maxMessages: 1 } })
  } catch (err) {
    const m = /past cursor (\d+)/.exec(err.message)
    if (m) return Number(m[1])
    throw err
  }
  throw new DshoError('DSH web: cannot determine the session cursor', 1)
}

/** All events with seq in (afterSeq, throughSeq], oldest first. */
export async function eventsSince(sessionId, afterSeq, throughSeq) {
  if (throughSeq <= afterSeq) return []
  const out = []
  let beforeSeq
  for (let guard = 0; guard < 50; guard++) {
    const page = await call('session/page', {
      request: { address: address(sessionId), throughSeq, maxMessages: 40, ...(beforeSeq != null ? { beforeSeq } : {}) },
    })
    const events = page.records.filter((r) => r.type === 'event').map((r) => r.event)
    out.push(...events.filter((e) => e.seq > afterSeq))
    const oldest = events.reduce((min, e) => Math.min(min, e.seq), Infinity)
    if (!page.hasMore || !events.length || oldest <= afterSeq + 1) break
    beforeSeq = oldest
  }
  const seen = new Set()
  return out.filter((e) => (seen.has(e.seq) ? false : seen.add(e.seq))).sort((a, b) => a.seq - b.seq)
}

function toolResultText(content) {
  return (content ?? [])
    .flatMap((part) => (part.type === 'tool-result' ? part.content ?? [] : [part]))
    .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : ''))
    .join('\n')
}

/**
 * Translate durable web Session events into the headless `--json` event
 * vocabulary, so job state, logs and results work the same for both backends.
 * `ctx` carries `lastUsage` and `turnTexts` across calls.
 */
export function translate(ev, ctx) {
  const d = ev.data ?? {}
  switch (ev.type) {
    case 'turn/start':
      ctx.turnTexts = []
      return [{ type: 'status', phase: 'turn_start', turn: d.turn }]
    case 'step/start':
      return [{ type: 'status', phase: 'step_start', turn: d.turn, step: d.step }]
    case 'assistant/message': {
      ctx.lastUsage = d.usage ?? null
      const out = []
      for (const part of d.message?.content ?? []) {
        if (part.type === 'reasoning' && part.text) out.push({ type: 'thinking', text: part.text })
        if (part.type === 'text' && part.text) {
          out.push({ type: 'text', text: part.text })
          ctx.turnTexts = [...(ctx.turnTexts ?? []), part.text]
        }
      }
      return out
    }
    case 'tool/call': {
      let input = d.arguments
      try {
        input = JSON.parse(d.arguments)
      } catch {
        // Keep raw argument text when it is not JSON.
      }
      return [{ type: 'tool_call', callId: d.callId, tool: d.name, input }]
    }
    case 'tool/result': {
      const parts = d.message?.content ?? []
      const failed = parts.some((p) => p.isError || p.error)
      return [{ type: 'tool_result', callId: d.message?.source?.callId ?? parts[0]?.toolCallId, status: failed ? 'failed' : 'completed', result: toolResultText(parts) }]
    }
    case 'step/end':
      return [{ type: 'status', phase: 'step_end', turn: d.turn, step: d.step, usage: ctx.lastUsage ?? undefined }]
    case 'turn/end':
      return [
        { type: 'status', phase: 'turn_end', turn: d.turn, reason: d.reason },
        { type: 'final', text: (ctx.turnTexts ?? []).at(-1) ?? '' },
      ]
    default:
      return []
  }
}

/** Seq of the user message carrying our prompt request id, if committed. */
export function promptSeq(events, requestId) {
  const hit = events.find((e) => e.type === 'user/message' && e.data?.source?.rpcId === requestId)
  return hit?.seq ?? null
}

/**
 * Start `dsh web` detached, wait for the token URL it prints, remember it and
 * exchange it for the cookie. The server keeps running after dsh-cli exits.
 */
export async function startServer({ port = 3080, timeoutMs = 120000 } = {}) {
  const { cmd, args, env } = dshCommand(['web', '--port', String(port), '--no-open'])
  mkdirSync(logsDir(), { recursive: true })
  const logFile = join(logsDir(), 'dsh-web.log')
  const fd = openSync(logFile, 'w')
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], env, cwd: homedir() })
  closeSync(fd)
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    const text = readFileSync(logFile, 'utf8')
    const match = /dsh web: (https?:\/\/[^\s)]+token=[^\s)]+)/.exec(text)
    if (match) {
      process.env.DSHO_WEB_URL = new URL(match[1]).origin
      saveTokenUrl(match[1])
      await exchangeToken()
      return { url: new URL(match[1]).origin, pid: child.pid, log: logFile }
    }
    if (!pidAlive(child.pid)) {
      throw new DshoError(`dsh web exited early: ${text.trim().split('\n').slice(-3).join(' ')}`, 5, `full log: ${logFile}`)
    }
  }
  throw new DshoError(`dsh web printed no URL within ${timeoutMs / 1000}s`, 5, `log: ${logFile}`)
}
