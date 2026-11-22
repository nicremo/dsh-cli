#!/usr/bin/env node
// Stand-in for the dsh binary at the two places dsho calls it.
//
// 1. Headless run: `dsh [--profile p] [--patch f] --json [--session-id id] -`, task on stdin.
//    Markers in the task text drive the behaviour:
//      SLEEP <s>        wait s seconds before answering
//      WRITE <file>     create <file> in the working directory
//      SOURCE <url>     add <url> to sources.json in the working directory (repeatable)
//      MANIFEST <file>  create <file> and list it in manifest.json
//      NOISE            print a line that is not JSON to stdout
//      FAIL             end the turn with an error and exit 1
//      CRASH            die with exit code 3 and no turn end
//      IGNORE-SIGTERM   survive SIGTERM (only SIGKILL ends the process)
// 2. Profile calls of `dsho setup`: `dsh --profile p [--from-default-profile t] --dump-config`.
//    Scaffolds $DSH_HOME/profiles/p/package.json like dsh does; FAKE_DSH_REJECT_CONFIG=1 makes
//    dsh refuse the profile.
//
// Every call is appended to $FAKE_DSH_LOG (event, pid, argv, cwd) for process and argv checks.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)

// What dsho hands to its workers through the environment.
const env = Object.fromEntries(['DSHO_JOB', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'].map((k) => [k, process.env[k] ?? null]))
let firstLine = ''
const log = (event) => {
  if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ event, t: Date.now(), pid: process.pid, task: firstLine, args, cwd: process.cwd(), env }) + '\n')
}

if (args.includes('--dump-config')) {
  log('config')
  if (process.env.FAKE_DSH_REJECT_CONFIG) {
    console.error('dsh: fake: invalid profile configuration')
    process.exit(1)
  }
  if (arg('--from-default-profile')) {
    const dir = join(process.env.DSH_HOME, 'profiles', arg('--profile'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n')
  }
  process.stdout.write('[]\n')
  process.exit(0)
}

const resumed = arg('--session-id')
const sessionId = resumed ?? `session-fake-${randomUUID()}`

let task = ''
for await (const chunk of process.stdin) task += chunk
// dsho prepends a work-folder header; the answer echoes the task itself.
const body = task.replace(/^Working folder for this task:[^\n]*\n[^\n]*\n\n/, '')
firstLine = body.trim().split('\n')[0]

if (/IGNORE-SIGTERM/.test(task)) process.on('SIGTERM', () => {})

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
if (/\bNOISE\b/.test(task)) process.stdout.write('npm warn this line is not JSON\n')

const sleep = /SLEEP (\d+(?:\.\d+)?)/.exec(task)
if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1]) * 1000))

for (const m of task.matchAll(/WRITE (\S+)/g)) writeFileSync(m[1], `written by fake-dsh: ${firstLine}\n`)
const sources = [...task.matchAll(/SOURCE (\S+)/g)].map((m) => ({ url: m[1], title: `Title of ${m[1]}` }))
if (sources.length) writeFileSync('sources.json', JSON.stringify(sources))
const manifest = [...task.matchAll(/MANIFEST (\S+)/g)].map((m) => ({ file: m[1], kind: 'screenshot' }))
for (const item of manifest) writeFileSync(item.file, 'binary')
if (manifest.length) writeFileSync('manifest.json', JSON.stringify(manifest))

if (/\bCRASH\b/.test(task)) {
  console.error('dsh: fake: crashed hard')
  log('end')
  process.exit(3)
}

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
