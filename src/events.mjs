// Fold the `dsh --profile headless --json` event stream into job progress and
// render it as a compact timeline for `dsho logs`.
import { excerpt } from './util.mjs'

export function initialState() {
  return {
    sessionId: null,
    cwd: null,
    steps: 0,
    toolCalls: 0,
    lastTool: null,
    lastText: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    final: null,
    turnEnd: null,
    error: null,
  }
}

export function parseLines(text) {
  const events = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Partial or foreign lines are ignored; the runner keeps the raw file.
    }
  }
  return events
}

export function fold(state, ev) {
  const s = state
  switch (ev?.type) {
    case 'session':
      s.sessionId = ev.sessionId ?? s.sessionId
      s.cwd = ev.cwd ?? s.cwd
      break
    case 'status':
      if (ev.phase === 'step_end') {
        s.steps += 1
        if (ev.usage) {
          s.usage.inputTokens += ev.usage.inputTokens ?? 0
          s.usage.outputTokens += ev.usage.outputTokens ?? 0
          s.usage.cacheReadTokens += ev.usage.cacheReadTokens ?? 0
        }
      } else if (ev.phase === 'turn_end') {
        s.turnEnd = ev.reason?.kind ?? 'unknown'
        if (s.turnEnd !== 'completed') {
          s.error = [ev.reason?.code, ev.reason?.message].filter(Boolean).join(': ') || s.turnEnd
        }
      }
      break
    case 'tool_call':
      s.toolCalls += 1
      s.lastTool = ev.tool ?? null
      break
    case 'text':
      if (ev.text) s.lastText = ev.text
      break
    case 'final':
      s.final = ev.text ?? ''
      break
    case 'error':
      s.error = ev.message ?? 'unknown error'
      break
  }
  return s
}

/** One readable line describing what a tool call does. */
export function describeInput(input) {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input)
  if (input.command) return input.command
  if (input.queries) return [].concat(input.queries).join(' | ')
  if (input.query) return input.query
  if (input.url) return input.url
  if (input.urls) return [].concat(input.urls).join(' ')
  if (input.file_path || input.path) return input.file_path ?? input.path
  if (input.pattern) return input.pattern
  if (input.prompt) return input.prompt
  return JSON.stringify(input)
}

export function timeline(events, { full = false } = {}) {
  const lines = []
  const short = full ? 600 : 140
  for (const ev of events) {
    switch (ev.type) {
      case 'session':
        lines.push(`session: ${ev.sessionId}`)
        break
      case 'thinking':
        if (full && ev.text) lines.push(`thinking: ${excerpt(ev.text, short)}`)
        break
      case 'tool_call':
        lines.push(`→ ${ev.tool}: ${excerpt(describeInput(ev.input), short)}`)
        break
      case 'tool_result': {
        const ok = ev.status === 'completed'
        const body = excerpt(typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? ''), full ? 400 : 100)
        lines.push(ok ? `  ✓ ${body}` : `  ✗ ${ev.status}: ${body}`)
        break
      }
      case 'text':
        if (ev.text) lines.push(`text: ${full ? ev.text : excerpt(ev.text, 200)}`)
        break
      case 'status':
        if (ev.phase === 'turn_end') {
          const r = ev.reason ?? {}
          lines.push(`turn_end: ${[r.kind, r.code, r.message].filter(Boolean).join(' / ')}`)
        }
        break
      case 'error':
        lines.push(`error: ${ev.message}`)
        break
      case 'final':
        lines.push(`final: ${full ? ev.text : excerpt(ev.text, 300)}`)
        break
    }
  }
  return lines
}
