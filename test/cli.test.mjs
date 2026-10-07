import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url))
let env
let ws

before(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsho-cli-'))
  ws = mkdtempSync(join(tmpdir(), 'dsho-cli-ws-'))
  // Never reach the real DSH web UI from tests.
  env = { ...process.env, DSHO_HOME: home, DSHO_DSH_CMD: FAKE, DSHO_WORKSPACES: join(ws, 'auto'), DSHO_BACKEND: 'headless', DSHO_WEB_URL: 'http://127.0.0.1:9' }
})

function dsho(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input: opts.input ?? '', timeout: 60000 })
  let json = null
  if (args.includes('--json')) {
    try {
      json = JSON.parse(res.stdout)
    } catch {
      // Non-JSON output is reported by the assertion that needs it.
    }
  }
  return { code: res.status, out: res.stdout, err: res.stderr, json }
}

test('run --wait --json returns the final answer', () => {
  const r = dsho(['run', '-C', join(ws, 'one'), '--wait', '--json', 'Say hello'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.result, 'FAKE-RESULT: Say hello')
  assert.equal(r.json.job.status, 'done')
  assert.equal(r.json.job.cwd, join(ws, 'one'))
  assert.ok(existsSync(join(ws, 'one', 'AGENTS.md')), 'new -C dir becomes a workspace')
})

test('run without -C creates an auto workspace', () => {
  const r = dsho(['run', '-w', '--json', 'Auto folder'])
  assert.equal(r.code, 0, r.err)
  assert.ok(r.json.job.cwd.startsWith(join(ws, 'auto')))
  assert.ok(existsSync(join(r.json.job.cwd, '.dsho-workspace')))
})

test('async run, wait, result, logs, files, continue', () => {
  const start = dsho(['run', '-C', join(ws, 'two'), '--json', 'Write a file WRITE note.txt'])
  assert.equal(start.code, 0, start.err)
  const id = start.json.job.id
  assert.match(id, /^j-/)
  const wait = dsho(['wait', id, '--timeout', '30s', '--json'])
  assert.equal(wait.code, 0, wait.out)
  assert.equal(wait.json.jobs[0].status, 'done')
  const result = dsho(['result', id])
  assert.equal(result.out.trim(), 'FAKE-RESULT: Write a file WRITE note.txt')
  const logs = dsho(['logs', id])
  assert.match(logs.out, /→ bash: echo hallo/)
  assert.match(logs.out, /final: FAKE-RESULT/)
  const files = dsho(['files', id, '--json'])
  assert.ok(files.json.jobs[0].files.some((f) => f.path === 'note.txt'))
  const cont = dsho(['continue', id, 'Keep going', '-w', '--json'])
  assert.equal(cont.code, 0, cont.err)
  assert.match(cont.json.result, /resumed session-fake-/)
  assert.equal(cont.json.job.parent, id)
  assert.equal(cont.json.job.cwd, join(ws, 'two'))
})

test('batch from file runs in parallel subfolders and collects', () => {
  const file = join(ws, 'tasks.txt')
  writeFileSync(file, '# comment\nTask one\nTask two WRITE a.txt\n\nTask three\n')
  const r = dsho(['batch', '-f', file, '-p', '2', '-C', join(ws, 'batch'), '--name', 'testrun', '--wait', '--json'])
  assert.equal(r.code, 0, r.err + r.out)
  assert.equal(r.json.summary.status, 'done')
  assert.equal(r.json.jobs.length, 3)
  assert.equal(r.json.jobs[0].cwd, join(ws, 'batch', '01-task-one'))
  assert.ok(existsSync(join(ws, 'batch', '02-task-two-write-a-txt', 'a.txt')))
  const status = dsho(['status', 'testrun'])
  assert.match(status.out, /Batch b-.*\[done\].*3\/3 done/)
  const col = dsho(['collect', 'testrun', '--json'])
  assert.equal(col.code, 0, col.err)
  const index = readFileSync(join(ws, 'batch', 'INDEX.md'), 'utf8')
  assert.match(index, /# testrun/)
  assert.match(index, /01 · 01-task-one \(done/)
  assert.match(index, /FAKE-RESULT: Task three/)
})

test('research wraps questions in the research template', () => {
  const r = dsho(['research', 'What is A?', 'What is B?', '-C', join(ws, 'rs'), '--depth', 'quick', '-w', '--json'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.json.jobs.length, 2)
  const id = r.json.jobs[0].id
  const task = readFileSync(join(env.DSHO_HOME, 'jobs', id, 'task.md'), 'utf8')
  assert.match(task, /report\.md/)
  assert.match(task, /Depth quick/)
  assert.match(task, /What is A\?/)
})

test('materials creates one job per kind', () => {
  const r = dsho(['materials', 'Electric cars in Germany', '--kinds', 'screenshots,stock-video', '--url', 'https://example.com', '-C', join(ws, 'mat'), '--json'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.json.jobs.map((j) => j.name), ['01-screenshots', '02-stock-video'])
  const shotTask = readFileSync(join(env.DSHO_HOME, 'jobs', r.json.jobs[0].id, 'task.md'), 'utf8')
  assert.match(shotTask, /dsho capture shot/)
  assert.match(shotTask, /https:\/\/example\.com/)
  const stockTask = readFileSync(join(env.DSHO_HOME, 'jobs', r.json.jobs[1].id, 'task.md'), 'utf8')
  assert.doesNotMatch(stockTask, /https:\/\/example\.com/)
  assert.equal(dsho(['wait', r.json.batch.id, '--timeout', '30s']).code, 0)
})

test('cancel stops a sleeping job', () => {
  const start = dsho(['run', '-C', join(ws, 'cancel'), '--json', 'Long task SLEEP 20'])
  const id = start.json.job.id
  spawnSync('sleep', ['1.5'])
  const c = dsho(['cancel', id, '--json'])
  assert.equal(c.code, 0, c.err)
  assert.equal(c.json.jobs[0].status, 'cancelled')
})

test('failures, timeouts and usage errors map to exit codes', () => {
  const fail = dsho(['run', '-C', join(ws, 'fail'), '-w', 'Please FAIL'])
  assert.equal(fail.code, 1)
  const slow = dsho(['run', '-C', join(ws, 'slow'), '--json', 'SLEEP 5'])
  const wait = dsho(['wait', slow.json.job.id, '--timeout', '1s'])
  assert.equal(wait.code, 4)
  assert.equal(dsho(['result', slow.json.job.id]).code, 4)
  dsho(['cancel', slow.json.job.id])
  assert.equal(dsho(['run']).code, 2)
  assert.equal(dsho(['run', '--bogus', 'x']).code, 2)
  assert.equal(dsho(['status', 'j-gibtsnicht']).code, 3)
  const missing = dsho(['status', 'gibtsnicht', '--json'])
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.code, 3)
})

test('stdin task with dash', () => {
  const r = dsho(['run', '-C', join(ws, 'stdin'), '-w', '--json', '-'], { input: '--starts with dashes\nsecond line' })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.json.result, 'FAKE-RESULT: --starts with dashes')
})

test('ws init writes marker and AGENTS.md', () => {
  const r = dsho(['ws', 'init', join(ws, 'new'), '--kind', 'research', '--json'])
  assert.equal(r.code, 0, r.err)
  assert.ok(existsSync(join(ws, 'new', '.dsho-workspace')))
  assert.match(readFileSync(join(ws, 'new', 'AGENTS.md'), 'utf8'), /Kind: research/)
})

test('status overview and ls', () => {
  const s = dsho(['status'])
  assert.equal(s.code, 0)
  assert.match(s.out, /Recent/)
  const ls = dsho(['ls', '--json'])
  assert.ok(ls.json.jobs.length >= 5)
  const lb = dsho(['ls', '--batches'])
  assert.match(lb.out, /testrun/)
})
