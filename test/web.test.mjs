// Web UI backend, tested at two seams: the dsho CLI process on one side and the
// DSH web server's HTTP API (test/fake-web.mjs) on the other.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeWeb } from './fake-web.mjs'
import { IS_WINDOWS, pidAlive, sandbox, until, inSandbox } from './helpers.mjs'
import { translate } from '../src/web.mjs'

// The `session/page` contract the everyday tests run against. Switch to 'structured'
// (DSH 0.2.2+) once issue #3 is fixed; the two contract tests below cover both either way.
const CONTRACT = process.env.DSHO_TEST_WEB_CONTRACT ?? 'structured'

/** A fake web UI plus a sandbox whose dsho talks to it. */
async function webWorld(t, { cursorContract = CONTRACT, env = {} } = {}) {
  const fake = await startFakeWeb({ cursorContract })
  let box
  try {
    box = sandbox(t, { DSHO_WEB_URL: fake.base, DSHO_WEB_TOKEN_URL: fake.tokenUrl, DSHO_WEB_POLL_MS: '50', DSHO_BACKEND: 'auto', ...env })
  } finally {
    // Registered after the sandbox cleanup, so runners die before their server does.
    t.after(() => fake.close())
  }
  return { fake, ...box }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('web backend', { concurrency: 6 }, () => {
  test('run registers the folder as workspace, opens a named session, prompts once and stores the answer', inSandbox(async (w) => {
    const dir = join(w.ws, 'one')
    const r = await w.run(['run', '-C', dir, '-w', '--json', '--name', 'My web job', 'Hello web TOOL'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.ok, true)
    const job = r.json.job
    assert.equal(job.status, 'done')
    assert.equal(job.backend, 'web')
    assert.equal(r.json.result, 'WEB-RESULT: Hello web TOOL')
    assert.deepEqual(job.web, { workspaceId: 'ws-1', workspaceTitle: 'one', baseUrl: w.fake.base })
    assert.deepEqual({ steps: job.progress.steps, toolCalls: job.progress.toolCalls, lastTool: job.progress.lastTool }, { steps: 2, toolCalls: 1, lastTool: 'bash' })
    assert.deepEqual(job.usage, { inputTokens: 30, outputTokens: 13, cacheReadTokens: 16 })

    // What the server was asked to do.
    const session = w.fake.sessions.get(job.sessionId)
    assert.equal(session.title, 'My web job')
    assert.equal(session.cwd, dir)
    assert.equal(session.model, null, 'no model call without -m, --effort or configured provider')
    const flow = w.fake.calls.filter((c) => c.method !== 'session/page')
    assert.deepEqual(flow.map((c) => c.method), ['workspace/create', 'session/create', 'session/rename', 'session/prompt'])
    for (const c of w.fake.calls) {
      assert.equal(c.type, 'client-request')
      assert.equal(c.path, `/api/${c.method}`)
    }
    assert.deepEqual(flow[0].args, { request: { path: dir } })
    assert.deepEqual(flow[1].args, { request: { workspaceId: 'ws-1' } })
    const prompt = flow[3].args.request
    assert.equal(prompt.mode, 'queue')
    assert.match(prompt.requestId, UUID)
    assert.deepEqual(prompt.content, [{ type: 'text', text: readFileSync(join(w.home, 'jobs', job.id, 'task.md'), 'utf8') }])
    assert.ok(prompt.content[0].text.startsWith(`Working folder for this task: ${dir}\n`))
    assert.ok(prompt.content[0].text.endsWith('\n\nHello web TOOL'))
    assert.deepEqual(w.dshLog(), [], 'no headless dsh was started')

    // The translated log reads like a headless one.
    const logs = await w.run(['logs', job.id])
    assert.match(logs.out, /→ bash: echo web/)
    assert.match(logs.out, /✓ web/)
    assert.match(logs.out, /turn_end: completed/)
    assert.match(logs.out, /final: WEB-RESULT: Hello web TOOL/)
  }, webWorld))

  test('a web batch becomes one workspace with one named session per job', inSandbox(async (w) => {
    const root = join(w.ws, 'research')
    const r = await w.run(['research', 'Question A', 'Question B', '-C', root, '-w', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.summary.status, 'done')
    assert.equal(w.fake.workspaces.size, 1)
    assert.equal([...w.fake.workspaces.values()][0].path, root)
    assert.deepEqual(
      r.json.jobs.map((j) => ({ cwd: j.cwd, outDir: j.outDir, title: w.fake.sessions.get(j.sessionId).title })),
      [
        { cwd: root, outDir: join(root, '01-question-a'), title: '01 · Research: Question A' },
        { cwd: root, outDir: join(root, '02-question-b'), title: '02 · Research: Question B' },
      ],
    )
    assert.notEqual(r.json.jobs[0].sessionId, r.json.jobs[1].sessionId)
    for (const job of r.json.jobs) {
      // The sessions share the workspace cwd, so the prompt has to name the job's own folder.
      const sent = w.fake.callsFor(job.sessionId).find((c) => c.method === 'session/prompt').args.request.content[0].text
      assert.ok(sent.startsWith(`Working folder for this task: ${job.outDir}\n`))
    }
  }, webWorld))

  test('continue prompts the same web session again', inSandbox(async (w) => {
    const first = await w.run(['run', '-C', join(w.ws, 'follow'), '-w', '--json', 'Begin'])
    assert.equal(first.code, 0, first.err + first.out)
    const next = await w.run(['continue', first.json.job.id, 'Carry on', '-w', '--json'])
    assert.equal(next.code, 0, next.err + next.out)
    assert.equal(next.json.job.sessionId, first.json.job.sessionId)
    assert.equal(next.json.job.parent, first.json.job.id)
    assert.equal(next.json.result, 'WEB-RESULT: Carry on')
    assert.equal(w.fake.calls.filter((c) => c.method === 'session/create').length, 1)
    const prompts = w.fake.callsFor(first.json.job.sessionId).filter((c) => c.method === 'session/prompt')
    assert.deepEqual(prompts.map((c) => c.args.request.content[0].text.split('\n').at(-1)), ['Begin', 'Carry on'])
    // The first job's answer is still its own.
    assert.equal((await w.run(['result', first.json.job.id])).out.trim(), 'WEB-RESULT: Begin')
  }, webWorld))

  test('-m and --effort select the model on the web session', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'model'), '-m', 'pro', '--effort', 'high', '-w', '--json', 'Model test'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.deepEqual(w.fake.sessions.get(r.json.job.sessionId).model, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  }, webWorld))

  test('cancel aborts the running web turn', inSandbox(async (w) => {
    const start = await w.run(['run', '-C', join(w.ws, 'abort'), '--json', 'Long SLEEP 30'])
    assert.equal(start.code, 0, start.err + start.out)
    const id = start.json.job.id
    await until(() => w.fake.calls.some((c) => c.method === 'session/prompt'), { what: 'the prompt to reach the web UI' })
    const c = await w.run(['cancel', id, '--json'])
    assert.equal(c.code, 0, c.err)
    assert.equal(c.json.cancelled, 1)
    assert.equal(c.json.jobs[0].status, 'cancelled')
    const sessionId = c.json.jobs[0].sessionId
    assert.equal(w.fake.callsFor(sessionId).filter((x) => x.method === 'session/cancel').length, 1)
    assert.equal(w.fake.sessions.get(sessionId).running, null, 'the turn is over on the server')
  }, webWorld))

  test('a web job that exceeds its time limit is cancelled on the server and reported as timeout', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'slow'), '-t', '1s', '-w', '--json', 'Slow SLEEP 30'])
    assert.equal(r.code, 1, r.err + r.out)
    assert.equal(r.json.job.status, 'timeout')
    assert.equal(r.json.job.error, 'timed out after 1s')
    assert.equal(w.fake.callsFor(r.json.job.sessionId).filter((x) => x.method === 'session/cancel').length, 1)
  }, webWorld))

  test('a failed web turn makes a failed job with the server error', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'failure'), '-w', '--json', 'Please FAIL'])
    assert.equal(r.code, 1)
    assert.equal(r.json.ok, true, 'the command worked, the job failed')
    assert.equal(r.json.job.status, 'failed')
    assert.equal(r.json.job.error, 'fake: Web failure')
  }, webWorld))

  test('more events than one page holds are all collected', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'pages'), '-w', '--json', 'Busy TOOLS 30'])
    assert.equal(r.code, 0, r.err + r.out)
    // 30 tool calls commit at once: about 150 events, several pages of 40.
    assert.equal(r.json.job.progress.toolCalls, 30)
    assert.equal(r.json.job.progress.steps, 31)
    assert.equal(r.json.result, 'WEB-RESULT: Busy TOOLS 30')
    assert.ok(w.fake.calls.some((c) => c.method === 'session/page' && c.args.request.beforeSeq != null), 'older pages were requested')
  }, webWorld))

  test('--backend headless runs a separate dsh even when the UI is up', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'headless'), '-b', 'headless', '-w', '--json', 'anything'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.job.backend, 'headless')
    assert.equal(r.json.result, 'FAKE-RESULT: anything')
    assert.deepEqual(w.fake.calls, [])
  }, webWorld))

  test('UI down: --backend web fails with exit 5, auto falls back to headless', inSandbox(async (w) => {
    await w.fake.close()
    const forced = await w.run(['run', '-C', join(w.ws, 'forced'), '-b', 'web', '--json', 'x'])
    assert.equal(forced.code, 5)
    assert.deepEqual(forced.json, { ok: false, error: `DSH web UI at ${w.fake.base} is not reachable`, code: 5, hint: 'dsho ui start, or use --backend headless' })
    assert.ok(!existsSync(join(w.home, 'jobs')), 'no job was created')
    const auto = await w.run(['run', '-C', join(w.ws, 'auto'), '-w', '--json', 'fallback'])
    assert.equal(auto.code, 0, auto.err + auto.out)
    assert.equal(auto.json.job.backend, 'headless')
    assert.equal(auto.json.result, 'FAKE-RESULT: fallback')
  }, webWorld))

  // No token in the environment: only `ui login` can make the UI usable.
  test('ui login stores the token URL for later commands and rejects bad ones', inSandbox(async (w) => {
    const before = await w.run(['run', '-C', join(w.ws, 'a'), '-b', 'web', '--json', 'x'])
    assert.equal(before.code, 5)

    const wrong = await w.run(['ui', 'login', `${w.fake.base}/?token=WRONG`, '--json'])
    assert.equal(wrong.code, 5)
    assert.equal(wrong.json.ok, false)
    const noToken = await w.run(['ui', 'login', `${w.fake.base}/`, '--json'])
    assert.equal(noToken.code, 2)
    assert.equal(noToken.json.code, 2)
    assert.equal((await w.run(['ui', 'login'])).code, 2)

    const good = await w.run(['ui', 'login', w.fake.tokenUrl, '--json'])
    assert.equal(good.code, 0, good.err + good.out)
    assert.deepEqual(good.json, { ok: true, url: w.fake.base })
    const after = await w.run(['run', '-C', join(w.ws, 'b'), '-w', '--json', 'Logged in'])
    assert.equal(after.code, 0, after.err + after.out)
    assert.equal(after.json.job.backend, 'web')
    const status = await w.run(['status', '--json'])
    assert.equal(status.json.webUi, w.fake.base)
  }, (t) => webWorld(t, { env: { DSHO_WEB_TOKEN_URL: '' } })))

  test('an expired cookie is renewed from the token URL', inSandbox(async (w) => {
    const first = await w.run(['run', '-C', join(w.ws, 'c1'), '-w', '--json', 'One'])
    assert.equal(first.code, 0, first.err + first.out)
    w.fake.expireCookies()
    const second = await w.run(['run', '-C', join(w.ws, 'c2'), '-w', '--json', 'Two'])
    assert.equal(second.code, 0, second.err + second.out)
    assert.equal(second.json.job.backend, 'web')
    assert.equal(second.json.result, 'WEB-RESULT: Two')
  }, webWorld))

  test('ui --print names the workspace and session of a job without opening a browser', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'look'), '--name', 'Find me', '-w', '--json', 'x'])
    const ui = await w.run(['ui', r.json.job.id, '--print', '--json'])
    assert.equal(ui.code, 0, ui.err)
    assert.deepEqual(ui.json, { ok: true, url: w.fake.base, where: 'workspace "look", session "Find me"' })
  }, webWorld))

  // ------------------------------------------------- session/page contracts ----

  test('a job completes against the legacy session/page contract (DSH before 0.2.2)', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'old'), '-w', '--json', 'Old server TOOL'])
    assert.equal(r.json.job.status, 'done', r.json.job.error)
    assert.equal(r.json.result, 'WEB-RESULT: Old server TOOL')
  }, (t) => webWorld(t, { cursorContract: 'legacy' })))

  test('issue #3: a job completes against the structured session/page contract (DSH 0.2.2+)', inSandbox(async (w) => {
    const r = await w.run(['run', '-C', join(w.ws, 'new'), '-w', '--json', 'New server TOOL'])
    assert.equal(r.json.job.status, 'done', r.json.job.error)
    assert.equal(r.json.result, 'WEB-RESULT: New server TOOL')
    assert.equal(r.json.job.progress.toolCalls, 1)
    assert.equal(r.code, 0)
  }, (t) => webWorld(t, { cursorContract: 'structured' })))

  // ------------------------------------------------------- open issues ----

  test('issue #5: a later turn in the same session does not overwrite the job result', inSandbox(async (w) => {
    // INTRUDER: someone else's queued prompt runs right behind ours; both turns are
    // committed before dsho polls again.
    const r = await w.run(['run', '-C', join(w.ws, 'shared'), '-w', '--json', 'Mine INTRUDER'])
    assert.equal(r.json.job.status, 'done', r.json.job.error)
    assert.equal(r.json.result, 'WEB-RESULT: Mine INTRUDER')
    assert.equal(readFileSync(join(w.home, 'jobs', r.json.job.id, 'result.md'), 'utf8'), 'WEB-RESULT: Mine INTRUDER')
  }, webWorld))

  test('a prompt whose answer was lost is not run again headless (it may be running in the UI)', inSandbox(async (w) => {
    w.fake.faults.set('session/prompt', 'drop')
    const r = await w.run(['run', '-C', join(w.ws, 'lost-answer'), '-w', '--json', 'Lost answer'])
    assert.equal(r.code, 1, r.out + r.err)
    assert.equal(r.json.job.status, 'failed')
    assert.equal(r.json.job.backend, 'web')
    assert.equal(w.fake.calls.filter((c) => c.method === 'session/prompt').length, 1)
    assert.deepEqual(w.dshLog(), [], 'no headless worker for a task that may already run in the UI')
  }, webWorld))

  test('a malformed answer to a prompt the UI may have queued is not run again headless', inSandbox(async (w) => {
    w.fake.faults.set('session/prompt', 'malformed')
    const r = await w.run(['run', '-C', join(w.ws, 'malformed'), '-w', '--json', 'Malformed answer'])
    assert.equal(r.code, 1, r.out + r.err)
    assert.equal(r.json.job.backend, 'web')
    assert.match(r.json.job.error, /malformed answer/)
    assert.deepEqual(w.dshLog(), [], 'no headless worker for a task that may already run in the UI')
  }, webWorld))

  test('a prompt the UI rejected runs headless instead (auto backend)', inSandbox(async (w) => {
    w.fake.faults.set('session/prompt', 'reject')
    const r = await w.run(['run', '-C', join(w.ws, 'rejected'), '-w', '--json', 'Rejected prompt'])
    assert.equal(r.code, 0, r.out + r.err)
    assert.equal(r.json.job.backend, 'headless')
    assert.equal(r.json.result, 'FAKE-RESULT: Rejected prompt')
    assert.match(w.jobFile(r.json.job.id).fallbackFrom.error, /fake rejected session\/prompt/)
  }, webWorld))

  test('SIGTERM while the web job is still being set up cancels it before the task is sent', { skip: IS_WINDOWS && 'Windows cannot deliver SIGTERM to a handler' }, inSandbox(async (w) => {
    w.fake.faults.set('session/create', { delayMs: 1500 })
    const start = await w.run(['run', '-C', join(w.ws, 'setup-stop'), '--json', 'Never sent'])
    const id = start.json.job.id
    await until(() => w.fake.calls.some((c) => c.method === 'session/create'), { what: 'the session to be requested' })
    const { ownerPid } = w.jobFile(id)
    process.kill(ownerPid, 'SIGTERM')
    await until(() => !pidAlive(ownerPid), { timeoutMs: 8000, what: 'the runner to exit' })
    assert.equal(w.jobFile(id).status, 'cancelled')
    assert.equal(w.fake.calls.filter((c) => c.method === 'session/prompt').length, 0, 'the task never reached the UI')
    assert.deepEqual(w.dshLog(), [], 'and it did not run headless either')
  }, webWorld))

  test('issue #6: SIGTERM to the runner of a web job cancels the turn on the server', { skip: IS_WINDOWS && 'Windows cannot deliver SIGTERM to a handler' }, inSandbox(async (w) => {
    const start = await w.run(['run', '-C', join(w.ws, 'term'), '--json', 'Long SLEEP 30'])
    const id = start.json.job.id
    await until(() => w.fake.calls.some((c) => c.method === 'session/prompt'), { what: 'the prompt to reach the web UI' })
    const { ownerPid, sessionId } = w.jobFile(id)
    process.kill(ownerPid, 'SIGTERM')
    await until(() => !pidAlive(ownerPid), { timeoutMs: 8000, what: 'the runner to exit' })
    assert.equal(w.fake.callsFor(sessionId).filter((c) => c.method === 'session/cancel').length, 1, 'session/cancel was sent')
    assert.equal(w.fake.sessions.get(sessionId).running, null, 'no turn keeps running without its runner')
  }, webWorld))
})

// --------------------------------------------------- event translation ----
// Pure mapping from durable web Session events to the headless event vocabulary.

describe('translate', () => {
  test('tool calls carry parsed JSON arguments, or the raw text when it is not JSON', () => {
    assert.deepEqual(translate({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }, {}), [
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } },
    ])
    assert.deepEqual(translate({ type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"command":' } }, {}), [
      { type: 'tool_call', callId: 'c2', tool: 'bash', input: '{"command":' },
    ])
  })

  test('tool results join text parts and report errors as failed', () => {
    const ok = { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }] } } }
    assert.deepEqual(translate(ok, {}), [{ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a\n[image]\nb' }])
    const failed = { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] }] } } }
    assert.deepEqual(translate(failed, {}), [{ type: 'tool_result', callId: 'c9', status: 'failed', result: 'boom' }])
  })

  test('a turn becomes thinking, text, step usage and a final answer taken from the last text', () => {
    const ctx = {}
    const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 }
    const out = [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'the prompt is not an answer' }] } },
      { type: 'assistant/message', data: { usage, message: { content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'draft' }] } } },
      { type: 'step/end', data: { turn: 3, step: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ].flatMap((ev) => translate(ev, ctx))
    assert.deepEqual(out, [
      { type: 'status', phase: 'turn_start', turn: 3 },
      { type: 'thinking', text: 'hm' },
      { type: 'text', text: 'draft' },
      { type: 'status', phase: 'step_end', turn: 3, step: 1, usage },
      { type: 'text', text: 'answer' },
      { type: 'status', phase: 'turn_end', turn: 3, reason: { kind: 'completed' } },
      { type: 'final', text: 'answer' },
    ])
  })

  test('a turn without any assistant text ends with an empty final answer', () => {
    const ctx = {}
    translate({ type: 'turn/start', data: { turn: 1 } }, ctx)
    assert.deepEqual(translate({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }, ctx).at(-1), { type: 'final', text: '' })
  })
})
