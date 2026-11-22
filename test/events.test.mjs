// Folding the headless `dsh --json` event stream into job progress and into
// the `dsho logs` timeline. The fixture is the recorded output of a real dsh run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describeInput, fold, initialState, parseLines, timeline } from '../src/events.mjs'

const real = readFileSync(new URL('./fixtures/real-run.jsonl', import.meta.url), 'utf8')
const run = (events) => events.reduce(fold, initialState())

test('fold summarizes a real dsh run', () => {
  const s = run(parseLines(real))
  assert.equal(s.sessionId, 'session-70cd87b2-556c-4077-a6e6-0061ed62c942')
  assert.equal(s.cwd, '/tmp/dsh-cli-demo/ws1')
  assert.equal(s.steps, 6)
  assert.equal(s.toolCalls, 6)
  assert.equal(s.lastTool, 'bash')
  assert.equal(s.turnEnd, 'completed')
  assert.equal(s.error, null)
  assert.match(s.final, /^OK/)
  assert.ok(s.usage.inputTokens > 50000)
  assert.ok(s.usage.cacheReadTokens > 0)
})

test('fold adds up the usage of every step and counts tool calls', () => {
  const s = run([
    { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'tool_call', callId: 'a', tool: 'web_search', input: {} },
    { type: 'tool_call', callId: 'b', tool: 'write', input: {} },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 7, outputTokens: 3 } },
    { type: 'status', phase: 'step_end' },
    { type: 'text', text: 'draft' },
    { type: 'final', text: 'answer' },
  ])
  assert.deepEqual(
    { steps: s.steps, toolCalls: s.toolCalls, lastTool: s.lastTool, usage: s.usage, final: s.final, turnEnd: s.turnEnd },
    { steps: 3, toolCalls: 2, lastTool: 'write', usage: { inputTokens: 107, outputTokens: 23, cacheReadTokens: 50 }, final: 'answer', turnEnd: null },
  )
})

test('fold keeps the reason of a turn that did not complete', () => {
  const failed = run([{ type: 'status', phase: 'turn_end', reason: { kind: 'error', code: 'rate_limit', message: 'Too many requests' } }])
  assert.deepEqual([failed.turnEnd, failed.error], ['error', 'rate_limit: Too many requests'])
  const aborted = run([{ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } }])
  assert.deepEqual([aborted.turnEnd, aborted.error], ['aborted', 'aborted'])
  assert.equal(run([{ type: 'error', message: 'model not found' }]).error, 'model not found')
  assert.equal(run([{ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }]).error, null)
})

test('fold ignores events it does not know', () => {
  assert.deepEqual(run([null, {}, { type: 'brand-new-event', steps: 99 }]), initialState())
})

test('parseLines skips blank and broken lines', () => {
  assert.deepEqual(parseLines('{"type":"final","text":"a"}\nnot json\n\n{"type":"te'), [{ type: 'final', text: 'a' }])
})

test('timeline of the real run: tool calls with their main argument, the answer last, thinking only with full', () => {
  const lines = timeline(parseLines(real))
  assert.equal(lines[0], 'session: session-70cd87b2-556c-4077-a6e6-0061ed62c942')
  assert.ok(lines.includes('→ web_search: Node.js current LTS version'))
  assert.ok(lines.some((l) => l.startsWith('→ bash: curl -sI https://example.com')))
  assert.ok(lines.some((l) => l.startsWith('→ write: ') && l.includes('result.md')))
  assert.ok(lines.at(-1).startsWith('final: OK'))
  assert.ok(!lines.some((l) => l.startsWith('thinking')))
  assert.ok(timeline(parseLines(real), { full: true }).some((l) => l.startsWith('thinking: The user wants three simple steps')))
})

test('timeline marks failed tool results and shortens long output unless full', () => {
  const events = [
    { type: 'tool_result', callId: 'a', status: 'completed', result: 'fine' },
    { type: 'tool_result', callId: 'b', status: 'failed', result: 'exit 1' },
    { type: 'tool_result', callId: 'c', status: 'completed', result: { rows: 2 } },
    { type: 'status', phase: 'turn_end', reason: { kind: 'error', code: 'fake', message: 'broke' } },
    { type: 'error', message: 'boom' },
    { type: 'text', text: 'x'.repeat(500) },
  ]
  const lines = timeline(events)
  assert.deepEqual(lines.slice(0, 5), ['  ✓ fine', '  ✗ failed: exit 1', '  ✓ {"rows":2}', 'turn_end: error / fake / broke', 'error: boom'])
  assert.equal(lines[5], `text: ${'x'.repeat(199)}…`)
  assert.equal(timeline(events, { full: true })[5], `text: ${'x'.repeat(500)}`)
})

test('describeInput picks the argument a reader cares about', () => {
  assert.equal(describeInput({ command: 'ls -la', description: 'List' }), 'ls -la')
  assert.equal(describeInput({ queries: ['a', 'b'] }), 'a | b')
  assert.equal(describeInput({ query: 'q' }), 'q')
  assert.equal(describeInput({ url: 'https://example.com' }), 'https://example.com')
  assert.equal(describeInput({ urls: ['https://a', 'https://b'] }), 'https://a https://b')
  assert.equal(describeInput({ file_path: '/x/report.md', content: 'long' }), '/x/report.md')
  assert.equal(describeInput({ pattern: '*.md' }), '*.md')
  assert.equal(describeInput({ other: 1 }), '{"other":1}')
  assert.equal(describeInput('raw text'), 'raw text')
  assert.equal(describeInput(null), '')
})
