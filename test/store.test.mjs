// Pure helpers behind the CLI (durations, slugs, ids, batch status) plus the one
// store behaviour that needs a frozen clock. Everything else about stored jobs
// is tested through the CLI in cli.test.mjs and batch.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deadPid, isolateProcess } from './helpers.mjs'

const dirs = isolateProcess()
const util = await import('../src/util.mjs')
const store = await import('../src/store.mjs')

test('parseDuration reads s, m, h, fractions and bare seconds; anything else is a usage error', () => {
  assert.equal(util.parseDuration('90s'), 90)
  assert.equal(util.parseDuration('20m'), 1200)
  assert.equal(util.parseDuration('1h'), 3600)
  assert.equal(util.parseDuration('1.5h'), 5400)
  assert.equal(util.parseDuration('300'), 300)
  assert.equal(util.parseDuration(' 2 M '), 120)
  assert.equal(util.parseDuration('0'), 0)
  for (const bad of ['soon', '', '-5', '5d', '1h30m', 'm']) {
    assert.throws(() => util.parseDuration(bad), (e) => e.code === 2 && /Invalid duration/.test(e.message), `"${bad}"`)
  }
})

test('slug keeps letters of every script, drops punctuation, limits length, never ends on a dash', () => {
  assert.equal(util.slug('Größte KI-Trends 2026: Überblick!'), 'größte-ki-trends-2026-überblick')
  assert.equal(util.slug('日本語 のテスト'), '日本語-のテスト')
  assert.equal(util.slug('a'.repeat(100), 10), 'aaaaaaaaaa')
  assert.equal(util.slug('abc def ghi', 8), 'abc-def')
  assert.equal(util.slug('  --Hello--  '), 'hello')
  assert.equal(util.slug('???'), 'task')
  assert.equal(util.slug('../../etc/passwd'), 'etc-passwd')
})

test('fmtDuration and excerpt format compactly', () => {
  assert.equal(util.fmtDuration(45_000), '45s')
  assert.equal(util.fmtDuration(83_000), '1m 23s')
  assert.equal(util.fmtDuration(3_720_000), '1h 02m')
  assert.equal(util.fmtDuration(0), '0s')
  assert.equal(util.fmtDuration(null), '-')
  assert.equal(util.excerpt('one\n  two\tthree'), 'one two three')
  assert.equal(util.excerpt('abcdefghij', 5), 'abcd…')
  assert.equal(util.excerpt(null), '')
})

test('expandHome expands only a leading ~ segment, with either slash', () => {
  assert.equal(homedir(), dirs.userHome, 'the test runs in its own home')
  assert.equal(util.expandHome('~'), dirs.userHome)
  assert.equal(util.expandHome('~/a/b'), join(dirs.userHome, 'a', 'b'))
  assert.equal(util.expandHome('~\\a'), join(dirs.userHome, 'a'))
  assert.equal(util.expandHome('~user/a'), '~user/a')
  assert.equal(util.expandHome('a/~/b'), 'a/~/b')
  assert.equal(util.expandHome(null), null)
})

test('newId: prefixed, and an id of a later millisecond sorts after an earlier one', (t) => {
  // No uniqueness claim: ids of one millisecond differ only in four random characters.
  for (let i = 0; i < 50; i++) assert.match(util.newId('j'), /^j-[0-9a-z]{13}$/)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') })
  const early = util.newId('b')
  t.mock.timers.tick(1)
  assert.ok(util.newId('b') > early)
})

test('pidAlive: this process yes, an exited process and nonsense no', () => {
  assert.equal(util.pidAlive(process.pid), true)
  assert.equal(util.pidAlive(deadPid()), false)
  for (const bad of [undefined, null, 0, -1, 1.5, '12']) assert.equal(util.pidAlive(bad), false, String(bad))
})

test('writeJsonAtomic replaces the file and leaves no temp files behind', () => {
  const file = join(dirs.home, 'x', 'a.json')
  util.writeJsonAtomic(file, { a: 1 })
  util.writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(util.readJson(file), { a: 2 })
  assert.deepEqual(readdirSync(join(dirs.home, 'x')), ['a.json'])
  assert.equal(util.readJson(join(dirs.home, 'missing.json'), null), null)
})

test('summarizeJobs folds job states into one batch status', () => {
  const summary = (...statuses) => store.summarizeJobs(statuses.map((status) => ({ status })))
  assert.deepEqual(summary(), { status: 'empty', counts: {}, total: 0 })
  assert.deepEqual(summary('done', 'done'), { status: 'done', counts: { done: 2 }, total: 2 })
  assert.equal(summary('done', 'queued').status, 'running')
  assert.equal(summary('failed', 'running').status, 'running')
  assert.equal(summary('done', 'failed').status, 'partial')
  assert.equal(summary('done', 'cancelled', 'timeout').status, 'partial')
  assert.equal(summary('cancelled', 'cancelled').status, 'cancelled')
  assert.equal(summary('failed', 'timeout', 'lost').status, 'failed')
  assert.equal(summary('cancelled', 'failed').status, 'failed')
})

test('issue #9: "last" is the job created last, also when ids share a millisecond', (t) => {
  // A frozen clock: every job below is created in the same millisecond, as in a fast batch.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') })
  for (let i = 1; i <= 12; i++) {
    const job = store.createJob({ prompt: `job ${i}`, cwd: dirs.root })
    assert.equal(store.resolveRef('last').id, job.id, `after creating job ${i}`)
  }
})

test('ids never run ahead of the wall clock, so ids of different processes stay comparable', (t) => {
  // Later than every id this process made so far (the clock must not run backwards).
  const T = Date.now() + 86_400_000
  t.mock.timers.enable({ apis: ['Date'], now: T })
  const burst = Array.from({ length: 40 }, () => util.newId('j'))
  assert.deepEqual([...burst].sort(), burst, 'a burst in one millisecond keeps its order')
  t.mock.timers.setTime(T + 1)
  // What any process creates one millisecond later must sort after the whole burst.
  const next = util.newId('j')
  assert.equal(next.slice(2, 2 + (T + 1).toString(36).length), (T + 1).toString(36), 'time part is the wall clock')
  assert.ok(burst.every((id) => id < next))
})

test('"last" follows the creation time, not an id clock that ran ahead in another process', () => {
  const newer = store.createJob({ prompt: 'newer', cwd: dirs.root })
  // Another dsho process wrote this job earlier, but its id clock had run ahead during
  // a burst of job creation, so its id sorts above the newer one.
  const ahead = `j-${'z'.repeat(12)}`
  util.writeJsonAtomic(join(dirs.home, 'jobs', ahead, 'job.json'), { ...newer, id: ahead, prompt: 'older, id ahead', createdAt: '2000-01-01T00:00:00.000Z' })
  assert.ok(ahead > newer.id, 'precondition: the older job has the higher id')
  assert.equal(store.resolveRef('last').id, newer.id)
})
