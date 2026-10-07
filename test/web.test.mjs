import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeWeb } from './fake-web.mjs'

const BIN = fileURLToPath(new URL('../bin/dsho.mjs', import.meta.url))
let fake
let env
let ws

before(async () => {
  fake = await startFakeWeb()
  const home = mkdtempSync(join(tmpdir(), 'dsho-web-'))
  ws = mkdtempSync(join(tmpdir(), 'dsho-web-ws-'))
  const tokenFile = join(home, 'last-url')
  writeFileSync(tokenFile, `${fake.base}/?token=T\n`)
  env = {
    ...process.env,
    DSHO_HOME: home,
    DSHO_WEB_URL: fake.base,
    DSHO_WEB_TOKEN_FILE: tokenFile,
    DSHO_WEB_POLL_MS: '150',
    DSHO_BACKEND: 'auto',
    DSHO_WORKSPACES: join(ws, 'auto'),
    DSHO_DSH_CMD: '/bin/false',
  }
})
after(() => fake.close())

// Async spawn: the fake server lives in this process and must keep serving.
function dsho(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.stdin.end()
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(out)
      } catch {
        // Text output.
      }
      resolve({ code, out, err, json })
    })
  })
}

test('auto backend runs a job inside the web UI and names the session', async () => {
  const r = await dsho(['run', '-C', join(ws, 'one'), '-w', '--json', '--name', 'My web job', 'Hello web TOOL'])
  assert.equal(r.code, 0, r.err + r.out)
  assert.equal(r.json.job.backend, 'web')
  assert.equal(r.json.result, 'WEB-RESULT: Hello web TOOL')
  assert.equal(r.json.job.web.workspaceTitle, 'one')
  assert.equal(r.json.job.progress.toolCalls, 1)
  assert.equal(r.json.job.usage.inputTokens, 30)
  const session = fake.sessions.get(r.json.job.sessionId)
  assert.equal(session.title, 'My web job')
  assert.equal(session.cwd, join(ws, 'one'))
  const logs = await dsho(['logs', r.json.job.id])
  assert.match(logs.out, /→ bash: echo web/)
  assert.match(logs.out, /final: WEB-RESULT/)
})

test('a web batch becomes one workspace with one session per job', async () => {
  const r = await dsho(['research', 'Question A', 'Question B', '-C', join(ws, 'research'), '-w', '--json'])
  assert.equal(r.code, 0, r.err + r.out)
  assert.equal(r.json.summary.status, 'done')
  const root = join(ws, 'research')
  const wsRow = [...fake.workspaces.values()].find((w) => w.path === root)
  assert.equal(wsRow.sessionIds.length, 2)
  for (const job of r.json.jobs) {
    assert.equal(job.cwd, root)
    assert.ok(job.outDir.startsWith(root + '/0'))
    assert.match(fake.sessions.get(job.sessionId).title, /^0\d · Research: Question/)
    assert.match(readFileSync(join(env.DSHO_HOME, 'jobs', job.id, 'task.md'), 'utf8'), new RegExp(`^Working folder for this task: ${job.outDir}`))
  }
})

test('continue prompts the same web session', async () => {
  const first = await dsho(['run', '-C', join(ws, 'follow'), '-w', '--json', 'Begin'])
  const creates = fake.calls.filter((c) => c.method === 'session/create').length
  const next = await dsho(['continue', first.json.job.id, 'Carry on', '-w', '--json'])
  assert.equal(next.code, 0, next.err + next.out)
  assert.equal(next.json.job.sessionId, first.json.job.sessionId)
  assert.equal(next.json.result, 'WEB-RESULT: Carry on')
  assert.equal(fake.calls.filter((c) => c.method === 'session/create').length, creates)
})

test('model override selects the model on the web session', async () => {
  const r = await dsho(['run', '-C', join(ws, 'model'), '-m', 'pro', '--effort', 'high', '-w', '--json', 'Model test'])
  assert.equal(r.code, 0, r.err + r.out)
  const sel = fake.sessions.get(r.json.job.sessionId).model
  assert.equal(sel.model, 'deepseek-v4-pro')
  assert.equal(sel.reasoningEffort, 'high')
})

test('cancel aborts the web turn', async () => {
  const start = await dsho(['run', '-C', join(ws, 'abort'), '--json', 'Long SLEEP 30'])
  await new Promise((r) => setTimeout(r, 800))
  const c = await dsho(['cancel', start.json.job.id, '--json'])
  assert.equal(c.code, 0, c.err)
  assert.equal(c.json.jobs[0].status, 'cancelled')
  assert.ok(fake.calls.some((x) => x.method === 'session/cancel'))
})

test('failed web turns map to failed jobs', async () => {
  const r = await dsho(['run', '-C', join(ws, 'failure'), '-w', '--json', 'Please FAIL'])
  assert.equal(r.code, 1)
  assert.equal(r.json.job.status, 'failed')
  assert.match(r.json.job.error, /Web failure/)
})

test('backend headless is honoured even when the UI runs', async () => {
  const r = await dsho(['run', '-C', join(ws, 'headless'), '-b', 'headless', '--json', 'anything'])
  assert.equal(r.json.job.backend, 'headless')
  await dsho(['cancel', r.json.job.id])
})

test('ui login stores a token URL and rejects a wrong one', async () => {
  const good = await dsho(['ui', 'login', `${fake.base}/?token=T`, '--json'])
  assert.equal(good.code, 0, good.err + good.out)
  assert.equal(good.json.url, fake.base)
  const bad = await dsho(['ui', 'login', `${fake.base}/?token=WRONG`, '--json'])
  assert.equal(bad.code, 5)
})
