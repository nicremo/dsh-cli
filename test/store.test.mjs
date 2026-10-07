import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

before(() => {
  process.env.DSHO_HOME = mkdtempSync(join(tmpdir(), 'dsho-store-'))
})

const util = await import('../src/util.mjs')
const store = await import('../src/store.mjs')

test('newId has prefix and is unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => util.newId('j')))
  assert.equal(ids.size, 500)
  for (const id of ids) assert.match(id, /^j-[0-9a-z]{10,}$/)
})

test('parseDuration accepts s, m, h and bare seconds', () => {
  assert.equal(util.parseDuration('90s'), 90)
  assert.equal(util.parseDuration('20m'), 1200)
  assert.equal(util.parseDuration('1h'), 3600)
  assert.equal(util.parseDuration('1.5h'), 5400)
  assert.equal(util.parseDuration('300'), 300)
  assert.throws(() => util.parseDuration('soon'), /duration/)
})

test('slug keeps umlauts, drops punctuation, limits length', () => {
  assert.equal(util.slug('Größte KI-Trends 2026: Überblick!'), 'größte-ki-trends-2026-überblick')
  assert.equal(util.slug('a'.repeat(100), 10), 'aaaaaaaaaa')
  assert.equal(util.slug('???'), 'task')
})

test('writeJsonAtomic and readJson roundtrip', () => {
  const file = join(process.env.DSHO_HOME, 'x', 'a.json')
  util.writeJsonAtomic(file, { a: 1 })
  assert.deepEqual(util.readJson(file), { a: 1 })
  assert.equal(util.readJson(join(process.env.DSHO_HOME, 'missing.json'), null), null)
})

test('pidAlive detects own and dead pids', () => {
  assert.equal(util.pidAlive(process.pid), true)
  assert.equal(util.pidAlive(999999), false)
  assert.equal(util.pidAlive(undefined), false)
})

test('fmtDuration formats compactly', () => {
  assert.equal(util.fmtDuration(45_000), '45s')
  assert.equal(util.fmtDuration(83_000), '1m 23s')
  assert.equal(util.fmtDuration(3_720_000), '1h 02m')
})

test('createJob, updateJob, readJob', () => {
  const job = store.createJob({ prompt: 'hello', cwd: '/tmp' })
  assert.equal(job.status, 'queued')
  assert.ok(existsSync(join(process.env.DSHO_HOME, 'jobs', job.id, 'job.json')))
  store.updateJob(job.id, { status: 'running', ownerPid: process.pid })
  store.updateJob(job.id, (j) => ({ ...j, progress: { steps: 2 } }))
  const read = store.readJob(job.id)
  assert.equal(read.status, 'running')
  assert.equal(read.progress.steps, 2)
  assert.equal(JSON.parse(readFileSync(join(process.env.DSHO_HOME, 'jobs', job.id, 'job.json'), 'utf8')).status, 'running')
})

test('readJob reports lost when the owner died', () => {
  const job = store.createJob({ prompt: 'x', cwd: '/tmp' })
  store.updateJob(job.id, { status: 'running', ownerPid: 999999 })
  assert.equal(store.readJob(job.id).status, 'lost')
})

test('resolveRef: exact, prefix, last, name, missing', () => {
  const a = store.createJob({ prompt: 'a', cwd: '/tmp', name: 'alpha-recherche' })
  const b = store.createBatch({ name: 'meine-batch', root: '/tmp', parallel: 2, jobs: [a.id] })
  assert.deepEqual(store.resolveRef(a.id), { kind: 'job', id: a.id })
  assert.deepEqual(store.resolveRef(a.id.slice(0, -2)), { kind: 'job', id: a.id })
  assert.deepEqual(store.resolveRef('last'), { kind: 'job', id: a.id })
  assert.deepEqual(store.resolveRef('last-batch'), { kind: 'batch', id: b.id })
  assert.deepEqual(store.resolveRef(b.id), { kind: 'batch', id: b.id })
  assert.deepEqual(store.resolveRef('alpha-recherche'), { kind: 'job', id: a.id })
  assert.deepEqual(store.resolveRef('meine-batch'), { kind: 'batch', id: b.id })
  assert.throws(() => store.resolveRef('gibtsnicht'), (e) => e.code === 3)
})

test('listJobs filters by batch and sorts newest first', () => {
  const b = store.createBatch({ name: 'filter', root: '/tmp', parallel: 1, jobs: [] })
  const j1 = store.createJob({ prompt: '1', cwd: '/tmp', batch: b.id, index: 1 })
  const j2 = store.createJob({ prompt: '2', cwd: '/tmp', batch: b.id, index: 2 })
  const list = store.listJobs({ batch: b.id })
  assert.deepEqual(list.map((j) => j.id).sort(), [j1.id, j2.id].sort())
  assert.deepEqual(store.listJobs({ batch: b.id, order: 'index' }).map((j) => j.id), [j1.id, j2.id])
})
