// Batches (batch, research, materials, collect) through the dsho CLI process,
// with test/fake-dsh.mjs as dsh. The supervisor is the real detached process.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidAlive, until, withRenameRace } from './helpers.mjs'

/** Highest number of fake dsh processes alive at the same time. */
function peakConcurrency(log) {
  const events = log.filter((e) => e.event === 'start' || e.event === 'end').sort((a, b) => a.t - b.t || (a.event === 'end' ? -1 : 1))
  let active = 0
  let peak = 0
  for (const e of events) {
    active += e.event === 'start' ? 1 : -1
    peak = Math.max(peak, active)
  }
  return peak
}

describe('dsho CLI, batches', { concurrency: 8 }, () => {
  test('batch -f: one job and one folder per task, readable as a whole afterwards', withRenameRace(async (s) => {
    const file = join(s.ws, 'tasks.txt')
    const root = join(s.ws, 'batch')
    writeFileSync(file, '# comment\nTask one\nTask two WRITE a.txt\n\nTask three\n')
    const r = await s.run(['batch', '-f', file, '-p', '2', '-C', root, '--name', 'testrun', '--wait', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.ok, true)
    assert.deepEqual(r.json.summary, { status: 'done', counts: { done: 3 }, total: 3 })
    assert.deepEqual(
      { name: r.json.batch.name, root: r.json.batch.root, parallel: r.json.batch.parallel, template: r.json.batch.template },
      { name: 'testrun', root, parallel: 2, template: 'raw' },
    )
    assert.deepEqual(
      r.json.jobs.map((j) => ({ index: j.index, name: j.name, cwd: j.cwd, status: j.status, result: j.result, batch: j.batch })),
      [
        { index: 1, name: '01-task-one', cwd: join(root, '01-task-one'), status: 'done', result: 'FAKE-RESULT: Task one', batch: r.json.batch.id },
        { index: 2, name: '02-task-two-write-a-txt', cwd: join(root, '02-task-two-write-a-txt'), status: 'done', result: 'FAKE-RESULT: Task two WRITE a.txt', batch: r.json.batch.id },
        { index: 3, name: '03-task-three', cwd: join(root, '03-task-three'), status: 'done', result: 'FAKE-RESULT: Task three', batch: r.json.batch.id },
      ],
    )
    // Each dsh ran in its own folder; only the batch root is a workspace.
    assert.deepEqual(s.dshLog().filter((e) => e.event === 'start').map((e) => e.cwd).sort(), r.json.jobs.map((j) => j.cwd))
    assert.ok(existsSync(join(root, '02-task-two-write-a-txt', 'a.txt')))
    assert.ok(existsSync(join(root, '.dsho-workspace')))
    assert.ok(!existsSync(join(root, '01-task-one', '.dsho-workspace')))

    // The same batch seen by later commands, addressed by name, id or last-batch.
    const id = r.json.batch.id
    const status = await s.run(['status', 'testrun'])
    assert.match(status.out, new RegExp(`^Batch ${id}  \\[done\\]  testrun  3/3 done\\n`))
    assert.match(status.out, /\n {2}02 j-\S+\s+done\s+\S+\s+1\s+02-task-two-write-a-txt\s+FAKE-RESULT: Task two WRITE a\.txt\n/)
    const viaLast = await s.run(['status', 'last-batch', '--json'])
    assert.equal(viaLast.json.batch.id, id)
    assert.deepEqual(viaLast.json.jobs.map((j) => j.index), [1, 2, 3])
    assert.deepEqual((await s.run(['ls', '--batch', id, '--json'])).json.jobs.map((j) => j.name), ['01-task-one', '02-task-two-write-a-txt', '03-task-three'])
    assert.deepEqual((await s.run(['ls', '--batches', '--json'])).json.batches.map((b) => [b.id, b.name, b.status, b.total, b.counts]), [[id, 'testrun', 'done', 3, { done: 3 }]])
    const result = await s.run(['result', id])
    assert.equal(result.code, 0)
    assert.deepEqual(result.out.match(/FAKE-RESULT: Task \w+/g), ['FAKE-RESULT: Task one', 'FAKE-RESULT: Task two', 'FAKE-RESULT: Task three'])
    assert.equal((await s.run(['files', id, '--json'])).json.jobs.length, 3)
    assert.equal((await s.run(['wait', id, '--json'])).code, 0)
    const logs = await s.run(['logs', id, '--json'])
    assert.equal(logs.code, 2, 'logs wants one job')
    assert.equal(logs.json.code, 2)
  }))

  test('tasks come from ---blocks, .json, .jsonl, --task, positionals or stdin', withRenameRace(async (s) => {
    const started = async (args, opts) => {
      const r = await s.run(['batch', '--json', ...args], opts)
      assert.equal(r.code, 0, r.err + r.out)
      return r.json
    }
    const blocks = join(s.ws, 'blocks.txt')
    writeFileSync(blocks, 'First block\nwith a second line\n---\n# not a comment here\nSecond block\n')
    assert.deepEqual((await started(['-f', blocks, '-C', join(s.ws, 'b1')])).jobs.map((j) => j.prompt), ['First block\nwith a second line', '# not a comment here\nSecond block'])

    const json = join(s.ws, 'tasks.json')
    writeFileSync(json, JSON.stringify(['Plain string', { task: 'Object task', name: 'My Name' }]))
    assert.deepEqual((await started(['-f', json, '-C', join(s.ws, 'b2')])).jobs.map((j) => [j.name, j.title, j.prompt]), [
      ['01-plain-string', '01 · Plain string', 'Plain string'],
      ['02-my-name', '02 · My Name', 'Object task'],
    ])

    const jsonl = join(s.ws, 'tasks.jsonl')
    writeFileSync(jsonl, '{"task":"Cheap one"}\n\n{"task":"Hard one","model":"pro","effort":"max"}\n')
    const perTask = await started(['-f', jsonl, '-m', 'flash', '--effort', 'low', '-C', join(s.ws, 'b3')])
    assert.deepEqual(perTask.jobs.map((j) => [j.model, j.effort]), [['flash', 'low'], ['pro', 'max']])

    const inline = await started(['--task', 'From flag', 'From positional', '-C', join(s.ws, 'b4')])
    assert.deepEqual(inline.jobs.map((j) => j.prompt), ['From flag', 'From positional'])
    assert.equal(inline.batch.parallel, 2, 'default: all at once')

    const piped = await started(['-C', join(s.ws, 'b5')], { input: 'Piped one\n# skipped\nPiped two\n' })
    assert.deepEqual(piped.jobs.map((j) => j.prompt), ['Piped one', 'Piped two'])

    const many = await started([...Array.from({ length: 12 }, (_, i) => ['--task', `T${i + 1} SLEEP 30`]).flat(), '-C', join(s.ws, 'b6')])
    assert.equal(many.batch.parallel, 10, 'default parallelism is capped at 10')
    assert.equal(many.jobs.length, 12)
    await s.run(['cancel', many.batch.id])
  }))

  test('a batch with a failure is partial (exit 1); collect merges answers, sources and manifests', withRenameRace(async (s) => {
    const root = join(s.ws, 'mix')
    const file = join(s.ws, 'tasks.jsonl')
    writeFileSync(
      file,
      [
        { name: 'alpha', task: 'Alpha SOURCE https://a.example/x SOURCE https://shared.example/ MANIFEST shot.png' },
        { name: 'beta', task: 'Beta SOURCE https://shared.example/ MANIFEST clip.mp4' },
        { name: 'gamma', task: 'Gamma FAIL' },
      ].map((l) => JSON.stringify(l)).join('\n'),
    )
    const r = await s.run(['batch', '-f', file, '-C', root, '--name', 'mixed', '-w', '--json'])
    assert.equal(r.code, 1, 'one job failed')
    assert.deepEqual(r.json.summary, { status: 'partial', counts: { done: 2, failed: 1 }, total: 3 })
    const [alpha, beta, gamma] = r.json.jobs
    const text = await s.run(['status', r.json.batch.id])
    assert.match(text.out, /\[partial\]  mixed  2\/3 done, 1 failed/)
    assert.equal((await s.run(['result', r.json.batch.id])).code, 1)

    const col = await s.run(['collect', 'mixed', '--json'])
    assert.equal(col.code, 0, col.err)
    assert.deepEqual(col.json, {
      ok: true,
      batch: r.json.batch.id,
      status: 'partial',
      counts: { done: 2, failed: 1 },
      index: join(root, 'INDEX.md'),
      manifest: join(root, 'manifest.json'),
      sources: join(root, 'sources.json'),
      materialFiles: 2,
      sourceCount: 2,
    })
    const index = readFileSync(join(root, 'INDEX.md'), 'utf8')
    assert.match(index, /^# mixed\n/)
    assert.match(index, /status partial \(done 2, failed 1\) · 3 jobs/)
    assert.match(index, /## 01 · 01-alpha \(done, \d+s\)\n\n- Job: `j-\S+`\n- Folder: `01-alpha`\n- Task: Alpha SOURCE/)
    assert.match(index, /FAKE-RESULT: Alpha SOURCE/)
    assert.match(index, /## 03 · 03-gamma \(failed, \d+s\)[^#]*- Error: fake: Fake failure[^#]*_No final answer\._/)
    // Each URL once, credited to the first job that found it; files relative to the batch root.
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8')).map((x) => [x.url, x.job]),
      [['https://a.example/x', alpha.id], ['https://shared.example/', alpha.id]],
    )
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), [
      { file: join('01-alpha', 'shot.png'), kind: 'screenshot', job: alpha.id },
      { file: join('02-beta', 'clip.mp4'), kind: 'screenshot', job: beta.id },
    ])

    const elsewhere = join(s.ws, 'custom-index.md')
    assert.equal((await s.run(['collect', r.json.batch.id, '-o', elsewhere, '--json'])).json.index, elsewhere)
    assert.match(readFileSync(elsewhere, 'utf8'), /^# mixed\n/)
    assert.match((await s.run(['collect'])).out, /^INDEX written: /, 'collect defaults to the last batch')
    const notABatch = await s.run(['collect', gamma.id, '--json'])
    assert.equal(notABatch.code, 2)
  }))

  test('--parallel 1 runs the jobs one after the other, in order', withRenameRace(async (s) => {
    const r = await s.run(['batch', '--task', 'A SLEEP 0.2', '--task', 'B SLEEP 0.2', '--task', 'C SLEEP 0.2', '-p', '1', '-C', join(s.ws, 'seq'), '-w', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    const log = s.dshLog()
    assert.deepEqual(log.map((e) => `${e.event} ${e.task[0]}`), ['start A', 'end A', 'start B', 'end B', 'start C', 'end C'])
    assert.equal(peakConcurrency(log), 1)
  }))

  test('--parallel 2 keeps two jobs running at a time, never more', withRenameRace(async (s) => {
    const tasks = ['A', 'B', 'C', 'D'].flatMap((name) => ['--task', `${name} SLEEP 1.5`])
    const r = await s.run(['batch', ...tasks, '-p', '2', '-C', join(s.ws, 'par'), '-w', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.deepEqual(r.json.summary.counts, { done: 4 })
    // The second worker starts 400 ms after the first, so two 1.5 s jobs overlap by about a second.
    assert.equal(peakConcurrency(s.dshLog()), 2)
  }))

  test('cancel on a batch stops the running jobs and never starts the queued ones', withRenameRace(async (s) => {
    const tasks = ['A', 'B', 'C', 'D'].flatMap((name) => ['--task', `${name} SLEEP 30`])
    const start = await s.run(['batch', ...tasks, '-p', '2', '-C', join(s.ws, 'stop'), '--json'])
    assert.equal(start.code, 0, start.err + start.out)
    const id = start.json.batch.id
    await s.until(() => s.dshLog().filter((e) => e.event === 'start').length === 2, { what: 'two dsh processes to run' })
    const during = await s.run(['status', id, '--json'])
    assert.deepEqual(during.json.summary, { status: 'running', counts: { running: 2, queued: 2 }, total: 4 })

    const cancel = await s.run(['cancel', id, '--json'])
    assert.equal(cancel.code, 0, cancel.err)
    // The count is what this call stopped itself: the supervisor may already have
    // cancelled the queued jobs after seeing the batch marker (2 to 4).
    assert.ok(cancel.json.cancelled >= 2 && cancel.json.cancelled <= 4, `cancelled ${cancel.json.cancelled}`)
    assert.deepEqual(cancel.json.jobs.map((j) => j.status), ['cancelled', 'cancelled', 'cancelled', 'cancelled'])

    const supervisor = JSON.parse(readFileSync(join(s.home, 'batches', id, 'batch.json'), 'utf8')).ownerPid
    await until(() => !pidAlive(supervisor), { what: 'the batch supervisor to exit' })
    const log = s.dshLog()
    assert.deepEqual(log.map((e) => `${e.event} ${e.task[0]}`).sort(), ['start A', 'start B'], 'C and D never started')
    for (const e of log) await until(() => !pidAlive(e.pid), { what: `dsh ${e.pid} to be gone` })
    const after = await s.run(['status', id, '--json'])
    assert.deepEqual(after.json.summary, { status: 'cancelled', counts: { cancelled: 4 }, total: 4 })
    assert.ok(after.json.batch.endedAt)
    assert.equal((await s.run(['wait', id])).code, 1)
  }))

  test('research: one job per question with the research prompt, depth and focus', withRenameRace(async (s) => {
    const root = join(s.ws, 'rs')
    const r = await s.run(['research', 'What is A?', 'What is B?', '-C', root, '--depth', 'quick', '--focus', 'Only EU sources', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json.batch.template, 'research')
    assert.deepEqual(r.json.jobs.map((j) => [j.name, j.title, j.prompt, j.template]), [
      ['01-what-is-a', '01 · Research: What is A?', 'What is A?', 'research'],
      ['02-what-is-b', '02 · Research: What is B?', 'What is B?', 'research'],
    ])
    const task = readFileSync(join(s.home, 'jobs', r.json.jobs[0].id, 'task.md'), 'utf8')
    assert.ok(task.startsWith(`Working folder for this task: ${join(root, '01-what-is-a')}\n`))
    assert.match(task, /## Research question\nWhat is A\?\n/)
    assert.match(task, /Depth quick: 3 to 5 good sources/)
    assert.match(task, /Additional instruction: Only EU sources/)
    assert.match(task, /`report\.md`/)
    assert.match(task, /`sources\.json`/)
    assert.doesNotMatch(task, /What is B\?/)
    assert.equal(JSON.parse(readFileSync(join(root, '.dsho-workspace'), 'utf8')).kind, 'research')
  }))

  test('materials: one job per kind; URLs only reach the kinds that capture pages', withRenameRace(async (s) => {
    const r = await s.run(['materials', 'Electric cars in Germany', '--kinds', 'screenshots,stock-video', '--url', 'https://example.com', '--count', '3', '-C', join(s.ws, 'mat'), '--json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json.batch.template, 'materials')
    assert.deepEqual(r.json.jobs.map((j) => j.name), ['01-screenshots', '02-stock-video'])
    const task = (job) => readFileSync(join(s.home, 'jobs', job.id, 'task.md'), 'utf8')
    assert.match(task(r.json.jobs[0]), /dsho capture shot/)
    assert.match(task(r.json.jobs[0]), /https:\/\/example\.com/)
    assert.match(task(r.json.jobs[0]), /Electric cars in Germany/)
    assert.doesNotMatch(task(r.json.jobs[1]), /https:\/\/example\.com/)
    const fallback = await s.run(['materials', 'Topic', '-C', join(s.ws, 'mat2'), '--json'])
    assert.deepEqual(fallback.json.jobs.map((j) => j.name), ['01-screenshots', '02-scroll', '03-articles', '04-stock-video'])
  }))
})
