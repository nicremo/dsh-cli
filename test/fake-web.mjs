// In-process stand-in for the DSH web server (`dsh web`): the token-for-cookie
// login and the unary Remote API calls dsho makes.
//
// startFakeWeb({ cursorContract }) picks the `session/page` contract:
//   'legacy'      DSH before 0.2.2. A throughSeq beyond the newest event fails with
//                 "session page through seq N is past cursor M"; answers carry no cursor.
//   'structured'  DSH 0.2.2 and later. Without throughSeq the answer is
//                 { cursor, records, hasMore }; a throughSeq beyond the newest event fails
//                 with "session history cut N exceeds M".
//
// Prompts queue per session (mode "queue"): one turn at a time, in order.
// Prompt markers:
//   SLEEP <s>   the turn takes s seconds
//   FAIL        the turn ends with an error
//   TOOL        one bash tool call before the answer
//   TOOLS <n>   n bash tool calls, committed at once (more events than one page holds)
//   INTRUDER    another client's prompt is queued behind this turn and its whole turn
//               commits in the same instant this turn ends
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { basename } from 'node:path'

export const TOKEN = 'T'

export async function startFakeWeb({ cursorContract = 'legacy' } = {}) {
  if (!['legacy', 'structured'].includes(cursorContract)) throw new Error(`unknown cursorContract ${cursorContract}`)
  const calls = []
  const workspaces = new Map()
  const sessions = new Map()
  const timers = new Set()
  let nextId = 1
  let cookieGeneration = 1
  const cookieValue = () => `dsh-auth-fake=v${cookieGeneration}`

  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }
  const append = (s, type, data) => s.events.push({ type, seq: s.events.length, time: Date.now(), data })
  const firstLine = (text) => text.replace(/^Working folder for this task:[^\n]*\n[^\n]*\n\n/, '').trim().split('\n')[0]

  function toolCall(s, turn, step, n) {
    const callId = `c${n}`
    append(s, 'assistant/message', { turn, step, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 }, message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash' }] } })
    append(s, 'tool/call', { turn, step, callId, name: 'bash', arguments: '{"command":"echo web"}' })
    append(s, 'tool/result', { turn, step, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'web\n' }] }] } })
    append(s, 'step/end', { turn, step })
  }

  function openTurn(s, { requestId, text }) {
    const turn = ++s.turns
    append(s, 'turn/start', { turn })
    append(s, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } })
    append(s, 'step/start', { turn, step: 1 })
    return turn
  }

  function answer(s, turn, step, text) {
    append(s, 'assistant/message', { turn, step, usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 9 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: `WEB-RESULT: ${firstLine(text)}` }] } })
    append(s, 'step/end', { turn, step })
    append(s, 'turn/end', { turn, reason: { kind: 'completed' } })
  }

  /** Start the next queued prompt of a session unless a turn is running. */
  function pump(s) {
    if (s.running || !s.queue.length) return
    const prompt = s.queue.shift()
    const body = prompt.text
    s.running = { turn: null, timer: null, prompt }
    // The prompt call returns before the user message is committed.
    s.running.timer = later(20, () => {
      const turn = (s.running.turn = openTurn(s, prompt))
      let step = 1
      const tools = /\bTOOLS (\d+)/.exec(body) ? Number(/\bTOOLS (\d+)/.exec(body)[1]) : /\bTOOL\b/.test(body) ? 1 : 0
      for (let n = 1; n <= tools; n++) {
        toolCall(s, turn, step, n)
        append(s, 'step/start', { turn, step: ++step })
      }
      const delay = Number(/SLEEP (\d+(?:\.\d+)?)/.exec(body)?.[1] ?? 0) * 1000
      s.running.timer = later(delay, () => {
        if (/\bFAIL\b/.test(body)) append(s, 'turn/end', { turn, reason: { kind: 'error', code: 'fake', message: 'Web failure' } })
        else answer(s, turn, step, body)
        s.running = null
        if (/\bINTRUDER\b/.test(body)) {
          const other = { requestId: randomUUID(), text: 'typed by someone else in the browser' }
          answer(s, openTurn(s, other), 1, other.text)
        }
        pump(s)
      })
    })
  }

  const session = (id) => {
    const s = sessions.get(id)
    if (!s) throw { code: 'session/not-found', message: `unknown session ${id}` }
    return s
  }

  const handlers = {
    'workspace/create': ({ request }) => {
      let ws = [...workspaces.values()].find((w) => w.path === request.path)
      const created = !ws
      if (!ws) {
        ws = { workspaceId: `ws-${nextId++}`, path: request.path, title: basename(request.path), sessionIds: [], createdAt: '', updatedAt: '' }
        workspaces.set(ws.workspaceId, ws)
      }
      return { workspace: ws, created }
    },
    'session/create': ({ request }) => {
      const ws = workspaces.get(request.workspaceId)
      if (!ws) throw { code: 'workspace/not-found', message: `unknown workspace ${request.workspaceId}` }
      const sessionId = `session-web-${nextId++}`
      const s = { sessionId, cwd: ws.path, title: null, events: [], turns: 0, queue: [], running: null, model: null }
      append(s, 'permission/preset', { preset: 'danger-full-access' })
      sessions.set(sessionId, s)
      ws.sessionIds.push(sessionId)
      return { sessionId, agentPreset: 'dev' }
    },
    'session/rename': ({ request }) => {
      session(request.sessionId).title = request.title
      return { title: request.title, seq: 1 }
    },
    'session/selectModel': ({ request }) => {
      const { sessionId, ...selection } = request
      session(sessionId).model = selection
      return { selected: selection }
    },
    'session/prompt': ({ request }) => {
      const s = session(request.sessionId)
      s.queue.push({ requestId: request.requestId, text: request.content[0].text })
      pump(s)
      return { accepted: true }
    },
    'session/cancel': ({ request }) => {
      const s = session(request.sessionId)
      if (s.running) {
        clearTimeout(s.running.timer)
        timers.delete(s.running.timer)
        append(s, 'turn/end', { turn: s.running.turn ?? openTurn(s, s.running.prompt), reason: { kind: 'aborted' } })
        s.running = null
        pump(s)
      }
      return { accepted: true }
    },
    'session/page': ({ request }) => {
      const s = session(request.address.sessionId)
      const cursor = s.events.length - 1
      const through = request.throughSeq ?? cursor
      if (through > cursor) {
        throw {
          code: 'gateway/bad-request',
          message: cursorContract === 'legacy' ? `session page through seq ${through} is past cursor ${cursor}` : `session history cut ${through} exceeds ${cursor}`,
        }
      }
      // Newest first page; older pages through beforeSeq.
      const eligible = s.events.filter((e) => e.seq <= through && (request.beforeSeq == null || e.seq < request.beforeSeq))
      const page = eligible.slice(-(request.maxMessages ?? 40))
      const records = page.map((event) => ({ type: 'event', event }))
      const hasMore = page.length < eligible.length
      return cursorContract === 'legacy' ? { records, hasMore } : { cursor, records, hasMore }
    },
  }

  const server = createServer((req, res) => {
    const authed = req.headers.cookie?.includes(cookieValue())
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x')
      if (url.searchParams.get('token') === TOKEN) {
        res.writeHead(303, { location: '/', 'set-cookie': `${cookieValue()}; Path=/; HttpOnly; Max-Age=2592000` })
        return res.end()
      }
      res.writeHead(authed ? 200 : 401)
      return res.end('ui')
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (!authed) {
        res.writeHead(401)
        return res.end()
      }
      const msg = JSON.parse(raw)
      calls.push({ method: msg.method, path: req.url, type: msg.type, args: msg.payload.args })
      let result
      try {
        if (!handlers[msg.method]) throw { code: 'gateway/not-found', message: `unknown method ${msg.method}` }
        result = { ok: true, value: handlers[msg.method](msg.payload.args) }
      } catch (error) {
        result = { ok: false, error: { code: error.code ?? 'internal', message: error.message } }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: msg.rpcId, result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    tokenUrl: `${base}/?token=${TOKEN}`,
    calls,
    workspaces,
    sessions,
    /** Calls that name the given session, in order. */
    callsFor: (sessionId) => calls.filter((c) => (c.args.request?.sessionId ?? c.args.request?.address?.sessionId) === sessionId),
    /** Invalidate every cookie handed out so far (a server whose signing secret changed). */
    expireCookies: () => void cookieGeneration++,
    close: () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
