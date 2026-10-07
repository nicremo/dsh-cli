// In-process stand-in for the DSH web server's Remote API, covering the calls
// dsho makes. Prompt markers: SLEEP <s> delays the turn end, FAIL ends it with
// an error, TOOL adds a bash tool call.
import { createServer } from 'node:http'
import { basename } from 'node:path'

export async function startFakeWeb() {
  const calls = []
  const workspaces = new Map()
  const sessions = new Map()
  let nextId = 1
  const append = (s, type, data) => s.events.push({ type, seq: s.events.length, time: Date.now(), data })

  function runTurn(s, requestId, text) {
    const body = text.replace(/^Working folder for this task:[^\n]*\n[^\n]*\n\n/, '')
    const first = body.trim().split('\n')[0]
    s.running = true
    const turn = ++s.turns
    setTimeout(() => {
      append(s, 'turn/start', { turn })
      append(s, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } })
      append(s, 'step/start', { turn, step: 1 })
      if (/\bTOOL\b/.test(body)) {
        append(s, 'assistant/message', { turn, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 }, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash' }] } })
        append(s, 'tool/call', { turn, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo web"}' })
        append(s, 'tool/result', { turn, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'web\n' }] }] } })
        append(s, 'step/end', { turn, step: 1 })
        append(s, 'step/start', { turn, step: 2 })
      }
      const delay = Number(/SLEEP (\d+(?:\.\d+)?)/.exec(body)?.[1] ?? 0) * 1000
      s.pending = setTimeout(() => {
        if (/\bFAIL\b/.test(body)) {
          append(s, 'turn/end', { turn, reason: { kind: 'error', code: 'fake', message: 'Web failure' } })
        } else {
          append(s, 'assistant/message', { turn, step: 2, usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 9 }, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: `WEB-RESULT: ${first}` }] } })
          append(s, 'step/end', { turn, step: 2 })
          append(s, 'turn/end', { turn, reason: { kind: 'completed' } })
        }
        s.running = false
      }, delay)
    }, 100)
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
      const sessionId = `session-web-${nextId++}`
      const s = { sessionId, cwd: ws.path, title: null, events: [], turns: 0, running: false, model: null }
      append(s, 'permission/preset', { preset: 'danger-full-access' })
      sessions.set(sessionId, s)
      ws.sessionIds.push(sessionId)
      return { sessionId, agentPreset: 'dev' }
    },
    'session/rename': ({ request }) => {
      sessions.get(request.sessionId).title = request.title
      return { title: request.title, seq: 1 }
    },
    'session/selectModel': ({ request }) => {
      sessions.get(request.sessionId).model = request
      return { selected: request }
    },
    'session/prompt': ({ request }) => {
      runTurn(sessions.get(request.sessionId), request.requestId, request.content[0].text)
      return { accepted: true }
    },
    'session/cancel': ({ request }) => {
      const s = sessions.get(request.sessionId)
      if (s.running) {
        clearTimeout(s.pending)
        append(s, 'turn/end', { turn: s.turns, reason: { kind: 'aborted' } })
        s.running = false
      }
      return { accepted: true }
    },
    'session/page': ({ request }) => {
      const s = sessions.get(request.address.sessionId)
      const cursor = s.events.length - 1
      if (request.throughSeq > cursor) throw { code: 'gateway/bad-request', message: `session page through seq ${request.throughSeq} is past cursor ${cursor}` }
      const records = s.events
        .filter((e) => e.seq <= request.throughSeq && (request.beforeSeq == null || e.seq < request.beforeSeq))
        .map((event) => ({ type: 'event', event }))
      return { records, hasMore: false }
    },
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x')
      if (url.searchParams.get('token') === 'T') {
        res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fake=ok; Path=/; HttpOnly' })
        return res.end()
      }
      res.writeHead(req.headers.cookie?.includes('dsh-auth-fake=ok') ? 200 : 401)
      return res.end('ui')
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (!req.headers.cookie?.includes('dsh-auth-fake=ok')) {
        res.writeHead(401)
        return res.end()
      }
      const msg = JSON.parse(raw)
      calls.push({ method: msg.method, args: msg.payload.args })
      let result
      try {
        result = { ok: true, value: handlers[msg.method](msg.payload.args) }
      } catch (error) {
        result = { ok: false, error }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: msg.rpcId, result }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, calls, workspaces, sessions, close: () => new Promise((resolve) => server.close(resolve)) }
}
