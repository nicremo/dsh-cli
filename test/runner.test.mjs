import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fakeDsh = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url))
let ws
before(() => {
  process.env.DSHO_HOME = mkdtempSync(join(tmpdir(), 'dsho-runner-'))
  process.env.DSHO_DSH_CMD = fakeDsh
  process.env.FAKE_DSH_LOG = join(process.env.DSHO_HOME, 'fake.log')
  ws = mkdtempSync(join(tmpdir(), 'dsho-ws-'))
})

const store = await import('../src/store.mjs')
const { createRunnableJob, runJob, cancelJob } = await import('../src/runner.mjs')
const { runBatch } = await import('../src/supervisor.mjs')

test('runJob completes, stores result, session and events', async () => {
  const job = createRunnableJob({ prompt: 'Hello world', cwd: join(ws, 'a') }, 'Hello world\nWRITE out.txt')
  const done = await runJob(job.id)
  assert.equal(done.status, 'done')
  assert.equal(done.exitCode, 0)
  assert.match(done.sessionId, /^session-fake-/)
  assert.equal(done.progress.toolCalls, 1)
  assert.equal(done.usage.inputTokens, 200)
  assert.equal(readFileSync(join(process.env.DSHO_HOME, 'jobs', job.id, 'result.md'), 'utf8'), 'FAKE-RESULT: Hello world')
  assert.ok(existsSync(join(ws, 'a', 'out.txt')))
  assert.ok(readFileSync(join(process.env.DSHO_HOME, 'jobs', job.id, 'events.jsonl'), 'utf8').includes('"type":"final"'))
})

test('runJob resumes a session when resume is set', async () => {
  const job = createRunnableJob({ prompt: 'follow', cwd: join(ws, 'a'), resume: 'session-fake-abc' }, 'follow')
  const done = await runJob(job.id)
  assert.equal(done.sessionId, 'session-fake-abc')
  assert.match(readFileSync(join(process.env.DSHO_HOME, 'jobs', job.id, 'result.md'), 'utf8'), /resumed session-fake-abc/)
})

test('runJob marks failures', async () => {
  const job = createRunnableJob({ prompt: 'broken', cwd: ws }, 'broken FAIL')
  const done = await runJob(job.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.exitCode, 1)
  assert.match(done.error, /Fake failure/)
})

test('runJob enforces the timeout', async () => {
  const job = createRunnableJob({ prompt: 'slow', cwd: ws, timeoutSec: 1 }, 'slow SLEEP 10')
  const t0 = Date.now()
  const done = await runJob(job.id)
  assert.equal(done.status, 'timeout')
  assert.ok(Date.now() - t0 < 8000)
})

test('cancelJob stops a running job', async () => {
  const job = createRunnableJob({ prompt: 'cancel me', cwd: ws }, 'cancel me SLEEP 10')
  const running = runJob(job.id)
  await new Promise((r) => setTimeout(r, 700))
  cancelJob(job.id)
  const done = await running
  assert.equal(done.status, 'cancelled')
})

test('runBatch respects the parallel limit', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    createRunnableJob({ prompt: `batch ${i}`, cwd: join(ws, `b${i}`), index: i + 1 }, `batch-${i} SLEEP 0.6`),
  )
  const batch = store.createBatch({ name: 'test-batch', root: ws, parallel: 3, jobs: jobs.map((j) => j.id) })
  for (const j of jobs) store.updateJob(j.id, { batch: batch.id })
  await runBatch(batch.id, { staggerMs: 0 })
  const states = jobs.map((j) => store.readJob(j.id).status)
  assert.deepEqual(states, Array(6).fill('done'))
  const log = readFileSync(process.env.FAKE_DSH_LOG, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((e) => e.task.startsWith('batch-'))
  let active = 0
  let peak = 0
  for (const e of log.sort((a, b) => a.t - b.t || (a.event === 'end' ? -1 : 1))) {
    active += e.event === 'start' ? 1 : -1
    peak = Math.max(peak, active)
  }
  assert.ok(peak <= 3, `peak ${peak}`)
  assert.ok(peak >= 2, `peak ${peak}`)
  assert.ok(store.readBatch(batch.id).endedAt)
})
