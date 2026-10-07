#!/usr/bin/env node
// Stand-in for `dsh --profile orchestra --json [--session-id id] -`.
// Behaviour is driven by markers in the task text:
//   SLEEP <s>     wait s seconds before answering
//   WRITE <file>  create <file> in the working directory
//   FAIL          end the turn with an error and exit 1
// Each start and end is appended to $FAKE_DSH_LOG for concurrency checks.
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const sidIndex = args.indexOf('--session-id')
const resumed = sidIndex >= 0 ? args[sidIndex + 1] : null
const sessionId = resumed ?? `session-fake-${randomUUID()}`

let task = ''
for await (const chunk of process.stdin) task += chunk
// dsho prepends a work-folder header; the answer echoes the task itself.
const body = task.replace(/^Working folder for this task:[^\n]*\n[^\n]*\n\n/, '')
const firstLine = body.trim().split('\n')[0]

const log = (event) => {
  if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ event, t: Date.now(), pid: process.pid, task: firstLine }) + '\n')
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 170 }

log('start')
emit({ type: 'session', sessionId, cwd: process.cwd() })
emit({ type: 'status', phase: 'turn_start', turn: 1 })
emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
emit({ type: 'thinking', text: 'Fake thinking' })
emit({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'echo hallo', description: 'Say hello' } })
emit({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'hallo\n' })
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage })

const sleep = /SLEEP (\d+(?:\.\d+)?)/.exec(task)
if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1]) * 1000))

for (const m of task.matchAll(/WRITE (\S+)/g)) writeFileSync(m[1], `written by fake-dsh: ${firstLine}\n`)

if (/\bFAIL\b/.test(task)) {
  console.error('dsh: fake: Fake failure')
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', code: 'fake', message: 'Fake failure' } })
  emit({ type: 'final', text: '' })
  log('end')
  process.exit(1)
}

const answer = `FAKE-RESULT: ${firstLine}${resumed ? ` (resumed ${resumed})` : ''}`
emit({ type: 'status', phase: 'step_start', turn: 1, step: 2 })
emit({ type: 'text', text: answer })
emit({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage })
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
emit({ type: 'final', text: answer })
log('end')
