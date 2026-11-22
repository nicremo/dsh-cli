// Single jobs on the headless backend, tested through the dsho CLI process:
// stdout (text and --json), exit codes, and the stored state a second dsho
// process reads. dsh itself is test/fake-dsh.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { IS_WINDOWS, killTree, pidAlive, sandbox, sleep, until, inSandbox } from './helpers.mjs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('dsho CLI, headless jobs', { concurrency: 8 }, () => {
  // ------------------------------------------------------------- run ----

  test('run --wait --json returns the answer and the finished job', inSandbox(async (s) => {
    const dir = join(s.ws, 'one')
    const r = await s.run(['run', '-C', dir, '--wait', '--json', 'Say hello'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.err, '')
    assert.equal(r.json.ok, true)
    assert.equal(r.json.result, 'FAKE-RESULT: Say hello')
    assert.equal(r.json.timedOut, false)
    const job = r.json.job
    assert.match(job.id, /^j-[0-9a-z]+$/)
    assert.match(job.sessionId, /^session-fake-/)
    assert.deepEqual(
      { status: job.status, backend: job.backend, cwd: job.cwd, outDir: job.outDir, exitCode: job.exitCode, error: job.error, prompt: job.prompt, batch: job.batch, parent: job.parent },
      { status: 'done', backend: 'headless', cwd: dir, outDir: dir, exitCode: 0, error: null, prompt: 'Say hello', batch: null, parent: null },
    )
    // The fake reports two steps of 100/20/50 tokens and one tool call.
    assert.deepEqual({ steps: job.progress.steps, toolCalls: job.progress.toolCalls, lastTool: job.progress.lastTool }, { steps: 2, toolCalls: 1, lastTool: 'bash' })
    assert.deepEqual(job.usage, { inputTokens: 200, outputTokens: 40, cacheReadTokens: 100 })
    assert.equal(job.resultFile, join(s.home, 'jobs', job.id, 'result.md'))
    assert.equal(readFileSync(job.resultFile, 'utf8'), 'FAKE-RESULT: Say hello')
    assert.ok(job.durationMs >= 0)

    // dsh was started once, in the workspace, with the task on stdin.
    const starts = s.dshLog().filter((e) => e.event === 'start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].cwd, dir)
    assert.deepEqual(starts[0].args, ['--json', '--approval-policy', 'never', '-'])
    assert.equal(readFileSync(join(s.home, 'jobs', job.id, 'task.md'), 'utf8').split('\n')[0], `Working folder for this task: ${dir}`)

    // A new -C folder becomes a workspace.
    assert.equal(JSON.parse(readFileSync(join(dir, '.dsho-workspace'), 'utf8')).kind, 'general')
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /Kind: general/)
  }))

  test('run -C on an existing folder leaves it untouched', inSandbox(async (s) => {
    const dir = join(s.ws, 'project')
    mkdirSync(dir)
    writeFileSync(join(dir, 'README.md'), 'mine')
    const r = await s.run(['run', '-C', dir, '-w', '--json', 'In place'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json.job.cwd, dir)
    assert.ok(!existsSync(join(dir, '.dsho-workspace')))
    assert.ok(!existsSync(join(dir, 'AGENTS.md')))
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'mine')
  }))

  test('run without -C creates a dated workspace and never reuses one', inSandbox(async (s) => {
    const [a, b] = [await s.run(['run', '-w', '--json', 'Auto folder!']), await s.run(['run', '-w', '--json', 'Auto folder!'])]
    assert.equal(a.code, 0, a.err)
    assert.equal(dirname(a.json.job.cwd), join(s.ws, 'auto'))
    assert.match(basename(a.json.job.cwd), /^\d{4}-\d\d-\d\d-auto-folder$/)
    assert.ok(existsSync(join(a.json.job.cwd, '.dsho-workspace')))
    assert.equal(b.json.job.cwd, `${a.json.job.cwd}-2`)
  }))

  test('the task can come from stdin or a file, leading dashes and all', inSandbox(async (s) => {
    const stdin = await s.run(['run', '-C', join(s.ws, 'stdin'), '-w', '--json', '-'], { input: '--starts with dashes\nsecond line' })
    assert.equal(stdin.code, 0, stdin.err)
    assert.equal(stdin.json.result, 'FAKE-RESULT: --starts with dashes')
    assert.equal(stdin.json.job.prompt, '--starts with dashes\nsecond line')
    const file = join(s.ws, 'task.md')
    writeFileSync(file, 'Task from a file\nwith details\n')
    const fromFile = await s.run(['run', '-C', join(s.ws, 'file'), '-w', '--json', '-f', file])
    assert.equal(fromFile.json.result, 'FAKE-RESULT: Task from a file')
  }))

  test('run returns at once; wait, result, logs and files read the job from another process', inSandbox(async (s) => {
    const dir = join(s.ws, 'two')
    const start = await s.run(['run', '-C', dir, '--json', 'Write a file WRITE note.txt SLEEP 0.3'])
    assert.equal(start.code, 0, start.err)
    assert.ok(['queued', 'running'].includes(start.json.job.status), start.json.job.status)
    assert.equal(start.json.job.resultFile, null)
    const id = start.json.job.id

    const wait = await s.run(['wait', id, '--timeout', '30s', '--json'])
    assert.equal(wait.code, 0, wait.out)
    assert.equal(wait.json.timedOut, false)
    assert.deepEqual(wait.json.summary, { status: 'done', counts: { done: 1 }, total: 1 })
    assert.equal(wait.json.jobs[0].result, 'FAKE-RESULT: Write a file WRITE note.txt SLEEP 0.3')

    const result = await s.run(['result', id])
    assert.equal(result.code, 0)
    assert.equal(result.out, 'FAKE-RESULT: Write a file WRITE note.txt SLEEP 0.3\n')
    const withFiles = await s.run(['result', id, '--files', '--json'])
    // The workspace AGENTS.md was written for this job as well.
    assert.deepEqual(withFiles.json.files.map((f) => f.path).sort(), ['AGENTS.md', 'note.txt'])

    const logs = await s.run(['logs', id])
    assert.deepEqual(logs.out.trimEnd().split('\n'), [
      `session: ${wait.json.jobs[0].sessionId}`,
      '→ bash: echo hallo',
      '  ✓ hallo',
      'text: FAKE-RESULT: Write a file WRITE note.txt SLEEP 0.3',
      'turn_end: completed',
      'final: FAKE-RESULT: Write a file WRITE note.txt SLEEP 0.3',
    ])
    assert.match((await s.run(['logs', id, '--full'])).out, /^thinking: Fake thinking$/m)
    assert.deepEqual((await s.run(['logs', id, '-n', '2', '--json'])).json, {
      ok: true,
      job: id,
      lines: ['turn_end: completed', 'final: FAKE-RESULT: Write a file WRITE note.txt SLEEP 0.3'],
    })
    const raw = (await s.run(['logs', id, '--raw', '-n', '100'])).out.trimEnd().split('\n').map((l) => JSON.parse(l))
    assert.equal(raw[0].type, 'session')
    assert.equal(raw.at(-1).type, 'final')

    const files = await s.run(['files', id, '--json'])
    assert.equal(files.json.jobs.length, 1)
    assert.equal(files.json.jobs[0].cwd, dir)
    assert.deepEqual(files.json.jobs[0].files.map((f) => f.path).sort(), ['AGENTS.md', 'note.txt'])

    const status = await s.run(['status', id])
    assert.match(status.out, new RegExp(`^Job ${id}  \\[done\\]`))
    assert.match(status.out, /Progress:  2 steps, 1 tool calls, last bash/)
    assert.match(status.out, /Tokens:    in 200, out 40, cache 100/)
  }))

  // -------------------------------------------------------- continue ----

  test('continue resumes the dsh session in the same folder without a new work-folder header', inSandbox(async (s) => {
    const dir = join(s.ws, 'follow')
    const first = await s.run(['run', '-C', dir, '-w', '--json', 'Begin'])
    const sid = first.json.job.sessionId
    const next = await s.run(['continue', first.json.job.id, 'Keep going', '-w', '--json'])
    assert.equal(next.code, 0, next.err)
    assert.equal(next.json.result, `FAKE-RESULT: Keep going (resumed ${sid})`)
    assert.deepEqual(
      { parent: next.json.job.parent, cwd: next.json.job.cwd, sessionId: next.json.job.sessionId, status: next.json.job.status },
      { parent: first.json.job.id, cwd: dir, sessionId: sid, status: 'done' },
    )
    const second = s.dshLog().filter((e) => e.event === 'start')[1]
    assert.deepEqual(second.args, ['--json', '--session-id', sid, '--approval-policy', 'never', '-'])
    assert.equal(second.cwd, dir, 'dsh only accepts a session id from the same folder')
    assert.equal(readFileSync(join(s.home, 'jobs', next.json.job.id, 'task.md'), 'utf8'), 'Keep going')
    assert.equal((await s.run(['result', first.json.job.id])).out, 'FAKE-RESULT: Begin\n', 'the parent keeps its own answer')
  }))

  test('continue refuses a running job (4), a missing follow-up (2) and a job without session (1)', inSandbox(async (s, t) => {
    // The dsh binary does not exist: the job fails before any session is created.
    const broken = await s.run(['run', '-C', join(s.ws, 'broken'), '-w', '--json', 'x'])
    assert.equal(broken.json.job.status, 'failed')
    assert.match(broken.json.job.error, /spawn failed/)
    assert.equal(broken.json.job.sessionId, null)
    const noSession = await s.run(['continue', broken.json.job.id, 'again', '--json'])
    assert.equal(noSession.code, 1)
    assert.equal(noSession.json.ok, false)

    const live = sandbox(t)
    const job = await live.startRunning(['-C', join(live.ws, 'busy'), 'Busy SLEEP 30'])
    const busy = await live.run(['continue', job.id, 'more', '--json'])
    assert.equal(busy.code, 4)
    assert.deepEqual(busy.json, { ok: false, error: `Job ${job.id} is still running`, code: 4, hint: `dsho wait ${job.id}` })
    await live.run(['cancel', job.id])
    const noText = await live.run(['continue', job.id, '--json'])
    assert.equal(noText.code, 2)
  }, (t) => sandbox(t, { DSHO_DSH_CMD: join(import.meta.dirname, 'does-not-exist', 'dsh') })))

  // -------------------------------------------------- failure states ----

  test('a failed turn: exit 1, status failed, error from dsh, stderr in logs --stderr', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'fail'), '-w', '--json', 'Please FAIL'])
    assert.equal(r.code, 1)
    assert.equal(r.json.ok, true, 'the command worked, the job failed')
    assert.deepEqual({ status: r.json.job.status, exitCode: r.json.job.exitCode, error: r.json.job.error }, { status: 'failed', exitCode: 1, error: 'fake: Fake failure' })
    const id = r.json.job.id
    assert.equal((await s.run(['result', id])).code, 1)
    const wait = await s.run(['wait', id, '--json'])
    assert.equal(wait.code, 1)
    assert.deepEqual(wait.json.summary, { status: 'failed', counts: { failed: 1 }, total: 1 })
    assert.equal(wait.json.jobs[0].result, null)
    assert.match((await s.run(['logs', id, '--stderr'])).out, /dsh: fake: Fake failure/)
    const text = await s.run(['status', id])
    assert.match(text.out, /\[failed\]/)
    assert.match(text.out, /Error:     fake: Fake failure/)
  }))

  test('dsh dying without a turn end is a failed job that carries its stderr', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'crash'), '-w', '--json', 'Please CRASH'])
    assert.equal(r.code, 1)
    assert.deepEqual({ status: r.json.job.status, exitCode: r.json.job.exitCode, error: r.json.job.error }, { status: 'failed', exitCode: 3, error: 'dsh: fake: crashed hard' })
    assert.equal(r.json.result, null)
  }))

  test('output of dsh that is not JSON does not disturb the job', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'noise'), '-w', '--json', 'Loud NOISE'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json.result, 'FAKE-RESULT: Loud NOISE')
    assert.equal(r.json.job.progress.steps, 2)
    assert.match((await s.run(['logs', r.json.job.id, '--raw', '-n', '100'])).out, /^npm warn this line is not JSON$/m)
  }))

  test('a job over its time limit is killed and reported as timeout', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'slow'), '-t', '1s', '-w', '--json', 'Slow SLEEP 30'])
    assert.equal(r.code, 1)
    assert.deepEqual({ status: r.json.job.status, error: r.json.job.error }, { status: 'timeout', error: 'timed out after 1s' })
    const { pid } = s.dshLog().find((e) => e.event === 'start')
    await until(() => !pidAlive(pid), { what: 'the dsh process to be gone' })
  }))

  // ----------------------------------------------------- wait, cancel ----

  test('wait --timeout exits 4 while the job runs on; result says 4; cancel stops it', inSandbox(async (s) => {
    const job = await s.startRunning(['-C', join(s.ws, 'long'), 'Long task SLEEP 30'])
    // --timeout 0 checks once and returns at once instead of waiting forever.
    const peek = await s.run(['wait', job.id, '--timeout', '0', '--json'])
    assert.equal(peek.code, 4)
    assert.equal(peek.json.timedOut, true)
    const wait = await s.run(['wait', job.id, '--timeout', '1s', '--json'])
    assert.equal(wait.code, 4)
    assert.equal(wait.json.ok, true)
    assert.equal(wait.json.timedOut, true)
    assert.equal(wait.json.jobs[0].status, 'running')
    assert.equal(wait.json.summary.status, 'running')
    const result = await s.run(['result', job.id, '--json'])
    assert.equal(result.code, 4)
    assert.deepEqual(result.json, { ok: false, error: `Job ${job.id} is still running`, code: 4, hint: `dsho wait ${job.id}` })

    const cancel = await s.run(['cancel', job.id, '--json'])
    assert.equal(cancel.code, 0, cancel.err)
    assert.equal(cancel.json.cancelled, 1)
    assert.equal(cancel.json.jobs[0].status, 'cancelled')
    await until(() => !pidAlive(job.dshPid), { what: 'the dsh process to be gone' })
    await until(() => !pidAlive(job.ownerPid), { what: 'the runner to exit' })

    // Cancelled is final: nothing more to cancel, waiting reports a failure, no answer.
    assert.equal((await s.run(['cancel', job.id, '--json'])).json.cancelled, 0)
    assert.equal((await s.run(['wait', job.id])).code, 1)
    const after = await s.run(['result', job.id])
    assert.equal(after.code, 1)
    assert.match(after.out, /status cancelled/)
  }))

  test('run --wait --max-wait gives up with exit 4 and leaves the job running', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'maxwait'), '-w', '--max-wait', '1s', '--json', 'Long SLEEP 30'])
    assert.equal(r.code, 4)
    assert.equal(r.json.timedOut, true)
    assert.equal(r.json.result, null)
    assert.equal((await s.run(['status', r.json.job.id, '--json'])).json.job.status, 'running')
  }))

  test('wait --any returns as soon as the first job is finished', inSandbox(async (s) => {
    const slow = await s.startRunning(['-C', join(s.ws, 'slow'), 'Slow SLEEP 30'])
    const fast = await s.run(['run', '-C', join(s.ws, 'fast'), '--json', 'Fast'])
    const r = await s.run(['wait', slow.id, fast.json.job.id, '--any', '--timeout', '20s', '--json'])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.json.timedOut, false)
    assert.deepEqual(r.json.jobs.map((j) => j.status), ['running', 'done'])
  }))

  test('a job whose runner died is reported as lost', inSandbox(async (s) => {
    const job = await s.startRunning(['-C', join(s.ws, 'orphan'), 'Orphan SLEEP 30'])
    killTree(job.ownerPid)
    killTree(job.dshPid)
    await until(() => !pidAlive(job.ownerPid), { what: 'the runner to be gone' })
    const status = await s.run(['status', job.id, '--json'])
    assert.equal(status.code, 0)
    assert.deepEqual({ status: status.json.job.status, error: status.json.job.error }, { status: 'lost', error: 'owner process exited before the job finished' })
    const wait = await s.run(['wait', job.id, '--timeout', '5s', '--json'])
    assert.equal(wait.code, 1, 'lost is final and counts as failed')
    assert.deepEqual((await s.run(['ls', '--running', '--json'])).json.jobs, [])
  }))

  // ------------------------------------------------ references, lists ----

  test('references: id, unique prefix, @id, name, last; ambiguous is a usage error', inSandbox(async (s) => {
    const a = (await s.run(['run', '-C', join(s.ws, 'a'), '--name', 'alpha', '-w', '--json', 'A'])).json.job.id
    const b = (await s.run(['run', '-C', join(s.ws, 'b'), '--name', 'beta', '-w', '--json', 'B'])).json.job.id
    const resolved = async (ref) => (await s.run(['status', ref, '--json'])).json.job?.id
    assert.equal(await resolved(a), a)
    assert.equal(await resolved(a.slice(0, -1)), a)
    assert.equal(await resolved(`@${b}`), b)
    assert.equal(await resolved('alpha'), a)
    assert.equal(await resolved('last'), b)
    const ambiguous = await s.run(['status', 'j-', '--json'])
    assert.equal(ambiguous.code, 2)
    assert.match(ambiguous.json.error, /ambiguous/)
  }))

  test('status and ls: empty state, then newest first, limits and the running filter', inSandbox(async (s) => {
    const empty = await s.run(['status', '--json'])
    assert.deepEqual(empty.json, { ok: true, webUi: null, running: [], recent: [], batches: [] })
    assert.match((await s.run(['status'])).out, /No jobs yet/)
    assert.equal((await s.run(['ls'])).out, 'No jobs.\n')
    assert.equal((await s.run(['ls', '--batches'])).out, 'No batches.\n')

    const a = (await s.run(['run', '-C', join(s.ws, 'a'), '-w', '--json', 'First'])).json.job.id
    const b = (await s.run(['run', '-C', join(s.ws, 'b'), '-w', '--json', 'Second FAIL'])).json.job.id
    const c = (await s.startRunning(['-C', join(s.ws, 'c'), 'Third SLEEP 30'])).id
    const ids = async (args) => (await s.run(['ls', '--json', ...args])).json.jobs.map((j) => j.id)
    assert.deepEqual(await ids([]), [c, b, a])
    assert.deepEqual(await ids(['-n', '2']), [c, b])
    assert.deepEqual(await ids(['--running']), [c])
    const status = await s.run(['status', '--json'])
    assert.deepEqual(status.json.running.map((j) => j.id), [c])
    assert.deepEqual(status.json.recent.map((j) => [j.id, j.status]), [[b, 'failed'], [a, 'done']])
    const text = (await s.run(['ls'])).out.split('\n')
    assert.match(text[0], /^JOB\s+STATUS\s+TIME\s+TOOLS\s+NAME\s+ANSWER \/ ERROR$/)
    assert.match(text[3], new RegExp(`^${a}\\s+done\\s+\\d+s\\s+1\\s+first\\s+FAKE-RESULT: First$`))
  }))

  // ---------------------------------------------- errors and exit codes ----

  test('usage errors exit 2 with { ok: false, error, code, hint } and start nothing', inSandbox(async (s) => {
    const cases = [
      ['frobnicate'],
      ['run'],
      ['run', '--bogus', 'x'],
      ['run', '--template', 'nope', 'x'],
      ['run', '--template', 'materials', '--kind', 'nope', 'x'],
      ['run', '--effort', 'silly', 'x'],
      ['run', '--backend', 'nope', 'x'],
      ['run', '-t', 'soon', 'x'],
      ['batch'],
      ['batch', '--task', 'a', '-p', '0'],
      ['batch', '--task', 'a', '-p', 'many'],
      ['batch', '--task', 'a', '--template', 'materials'],
      ['research'],
      ['research', '--depth', 'nope', 'q'],
      ['materials'],
      ['materials', '--kinds', 'nope', 'brief'],
      ['wait'],
      ['result'],
      ['logs'],
      ['files'],
      ['cancel'],
      ['continue'],
      ['ws', 'init'],
      ['ws'],
      ['skill'],
      ['capture'],
      ['run', '--access', 'root', 'x'],
      ['run', '-b', 'web', '--access', 'read-only', 'x'],
      ['config', 'frob'],
      ['config', 'set', 'bogus', 'v'],
      ['config', 'set', 'dshBin'],
      ['config', 'unset'],
    ]
    const results = await Promise.all(cases.map((args) => s.run([...args, '--json'])))
    for (const [i, r] of results.entries()) {
      const label = `dsho ${cases[i].join(' ')}`
      assert.equal(r.code, 2, `${label}: ${r.out}${r.err}`)
      assert.ok(r.json, `${label} printed no JSON: ${r.out}`)
      assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error', 'hint', 'ok'], label)
      assert.equal(r.json.ok, false, label)
      assert.equal(r.json.code, 2, label)
      assert.ok(typeof r.json.error === 'string' && r.json.error.length > 3, label)
      assert.ok(r.json.hint === null || typeof r.json.hint === 'string', label)
    }
    assert.deepEqual((await s.run(['ls', '--json'])).json.jobs, [])
    assert.deepEqual(s.dshLog(), [])
    // A rejected option creates nothing on disk either.
    assert.equal((await s.run(['run', '-C', join(s.ws, 'never'), '-t', 'soon', 'x'])).code, 2)
    assert.equal(existsSync(join(s.ws, 'never')), false)

    // Text mode: the message goes to stderr, stdout stays clean for pipes.
    const text = await s.run(['run', '--bogus', 'x'])
    assert.equal(text.code, 2)
    assert.equal(text.out, '')
    assert.match(text.err, /^dsho: Unknown option '--bogus'\n {2}hint: dsho <command> --help lists the options\n$/)
  }))

  test('unknown references exit 3', inSandbox(async (s) => {
    const cases = [
      ['status', 'nope'],
      ['result', 'nope'],
      ['logs', 'nope'],
      ['files', 'nope'],
      ['cancel', 'nope'],
      ['wait', 'nope'],
      ['continue', 'nope', 'more'],
      ['ls', '--batch', 'nope'],
      ['status', 'last'],
      ['status', 'last-batch'],
      ['collect'],
    ]
    const results = await Promise.all(cases.map((args) => s.run([...args, '--json'])))
    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 3, `dsho ${cases[i].join(' ')}: ${r.out}${r.err}`)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.code, 3)
    }
    assert.deepEqual(results[0].json, { ok: false, error: 'Nothing found for "nope"', code: 3, hint: 'dsho ls lists jobs, dsho ls --batches lists batches' })
  }))

  test('help and version exit 0', inSandbox(async (s) => {
    assert.equal((await s.run(['--version'])).out, `${PKG.version}\n`)
    const usage = await s.run([])
    assert.equal(usage.code, 0)
    assert.match(usage.out, /Exit: 0 ok, 1 job failed, 2 usage, 3 not found, 4 wait timeout or not finished, 5 environment/)
    for (const args of [['help'], ['--help'], ['help', 'run'], ['run', '--help'], ['batch', '-h'], ['wait', '--help'], ['config', '--help'], ['guide']]) {
      const r = await s.run(args)
      assert.equal(r.code, 0, args.join(' '))
      assert.ok(r.out.length > 50, args.join(' '))
    }
    assert.match((await s.run(['wait', '--help'])).out, /Exit 0 all done, 1 something failed, 4 timeout reached/)
    assert.deepEqual(s.dshLog(), [])
  }))

  test('--access picks the dsh permission preset; workers never wait for approvals', inSandbox(async (s) => {
    const presets = { 'read-only': 'read-only', 'workspace-write': 'workspace-write', full: 'danger-full-access' }
    for (const [access, preset] of Object.entries(presets)) {
      const r = await s.run(['run', '-C', join(s.ws, access), '--access', access, '-w', '--json', `Sandbox ${access}`])
      assert.equal(r.code, 0, r.out + r.err)
      const start = s.dshLog().find((e) => e.event === 'start' && e.task === `Sandbox ${access}`)
      assert.deepEqual(start.args, ['--json', '--permission-mode', preset, '--approval-policy', 'never', '-'])
    }
    // continue keeps the sandbox of the job it continues.
    const parent = (await s.run(['status', 'last', '--json'])).json.job
    await s.run(['continue', parent.id, '-w', '--json', 'Sandbox follow-up'])
    const follow = s.dshLog().find((e) => e.event === 'start' && e.task === 'Sandbox follow-up')
    assert.ok(follow.args.includes('danger-full-access'), follow.args.join(' '))
    // continue --access changes the sandbox for the follow-up only.
    const narrowed = await s.run(['continue', parent.id, '--access', 'read-only', '-w', '--json', 'Sandbox narrowed'])
    assert.equal(narrowed.code, 0, narrowed.out + narrowed.err)
    const narrow = s.dshLog().find((e) => e.event === 'start' && e.task === 'Sandbox narrowed')
    assert.deepEqual(narrow.args.slice(narrow.args.indexOf('--permission-mode'), narrow.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'read-only'])
    assert.equal((await s.run(['continue', parent.id, '--access', 'root', 'x', '--json'])).code, 2)
  }))

  // ------------------------------------------------------ open issues ----

  test('issue #10: logs --stderr --json prints JSON', inSandbox(async (s) => {
    const r = await s.run(['run', '-C', join(s.ws, 'fail'), '-w', '--json', 'Please FAIL'])
    const logs = await s.run(['logs', r.json.job.id, '--stderr', '--json'])
    assert.equal(logs.code, 0)
    assert.ok(logs.json, `not JSON: ${logs.out}`)
    assert.equal(logs.json.ok, true)
    assert.match(JSON.stringify(logs.json), /dsh: fake: Fake failure/)
  }))

  test('a process that holds job.json open does not kill the runner (EPERM on rename, Windows)', async (t) => {
    const s = sandbox(t)
    const job = await s.startRunning(['-C', join(s.ws, 'watched'), 'Watched SLEEP 1'])
    // Another process (a second dsho, an editor, a virus scanner) keeps opening job.json
    // for a moment, as every reader does. Windows refuses to rename over an open file.
    const file = join(s.home, 'jobs', job.id, 'job.json')
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      let fd = null
      try {
        fd = openSync(file, 'r')
      } catch {
        // The writer is replacing the file this instant.
      }
      await sleep(120)
      if (fd != null) closeSync(fd)
      await sleep(20)
    }
    const wait = await s.run(['wait', job.id, '--timeout', '10s', '--json'])
    assert.equal(wait.json.jobs[0].status, 'done', wait.json.jobs[0].error)
    assert.equal(wait.json.jobs[0].result, 'FAKE-RESULT: Watched SLEEP 1')
  })

  test('issue #7: a dsh that ignores SIGTERM does not outlive its terminated runner', { skip: IS_WINDOWS && 'Windows ends the process tree unconditionally' }, inSandbox(async (s) => {
    const job = await s.startRunning(['-C', join(s.ws, 'stubborn'), 'Stubborn IGNORE-SIGTERM SLEEP 60'])
    process.kill(job.ownerPid, 'SIGTERM')
    await until(() => !pidAlive(job.ownerPid), { timeoutMs: 12000, what: 'the runner to exit' })
    // The runner is gone, so nobody is left to escalate: dsh has to be dead by now.
    await until(() => !pidAlive(job.dshPid), { timeoutMs: 1000, what: 'the dsh process to be gone once its runner has exited' })
  }))
})

