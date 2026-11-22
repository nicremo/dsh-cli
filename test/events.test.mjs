import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fold, initialState, parseLines, timeline } from '../src/events.mjs'
import { credentialEnv, modelSelection, resolveModel, spawnSpec } from '../src/dsh.mjs'

// Keep the user's ~/.dsho/config.json out of these tests.
process.env.DSHO_HOME = mkdtempSync(join(tmpdir(), 'dsho-events-'))

const real = readFileSync(new URL('./fixtures/real-run.jsonl', import.meta.url), 'utf8')

test('fold summarizes a real dsh run', () => {
  const events = parseLines(real)
  const s = events.reduce(fold, initialState())
  assert.equal(s.sessionId, 'session-70cd87b2-556c-4077-a6e6-0061ed62c942')
  assert.equal(s.steps, 6)
  assert.equal(s.toolCalls, 6)
  assert.equal(s.lastTool, 'bash')
  assert.equal(s.turnEnd, 'completed')
  assert.match(s.final, /^OK/)
  assert.ok(s.usage.inputTokens > 50000)
  assert.ok(s.usage.cacheReadTokens > 0)
})

test('fold records error turn ends', () => {
  const s = [
    { type: 'session', sessionId: 's1', cwd: '/x' },
    { type: 'status', phase: 'turn_end', reason: { kind: 'error', code: 'rate_limit', message: 'Too many requests' } },
  ].reduce(fold, initialState())
  assert.equal(s.turnEnd, 'error')
  assert.match(s.error, /Too many requests/)
})

test('parseLines skips broken lines', () => {
  assert.equal(parseLines('{"type":"final","text":"a"}\nnot json\n\n').length, 1)
})

test('timeline shows tool calls compactly', () => {
  const lines = timeline(parseLines(real))
  assert.ok(lines.some((l) => l.includes('web_search') && l.includes('Node.js current LTS version')))
  assert.ok(lines.some((l) => l.includes('bash') && l.includes('curl -sI https://example.com')))
  assert.ok(lines.some((l) => l.includes('write') && l.includes('result.md')))
  assert.ok(lines.at(-1).startsWith('final'))
  assert.ok(!lines.some((l) => l.startsWith('thinking')))
  assert.ok(timeline(parseLines(real), { full: true }).some((l) => l.startsWith('thinking')))
})

test('resolveModel maps short names', () => {
  assert.equal(resolveModel('flash'), 'deepseek-flash')
  assert.equal(resolveModel('pro'), 'deepseek-v4-pro')
  assert.equal(resolveModel('v4-flash'), 'deepseek-v4-flash')
  assert.equal(resolveModel('vision'), 'deepseek-v4-flash-vision-exp')
  assert.equal(resolveModel('deepseek-custom'), 'deepseek-custom')
})

test('spawnSpec honours DSHO_DSH_CMD and session ids', () => {
  process.env.DSHO_DSH_CMD = '/bin/fake'
  try {
    const spec = spawnSpec({ sessionId: 'session-1', jobDir: '/tmp' })
    assert.equal(spec.cmd, '/bin/fake')
    assert.deepEqual(spec.args, ['--json', '--session-id', 'session-1', '-'])
  } finally {
    delete process.env.DSHO_DSH_CMD
  }
})

test('spawnSpec builds the dsh command with a settings override', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsho-dshhome-'))
  const jobDir = mkdtempSync(join(tmpdir(), 'dsho-job-'))
  writeFileSync(join(dshHome, 'settings.yaml'), 'permission:\n  defaultPreset: danger-full-access\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: max\n')
  process.env.DSH_HOME = dshHome
  process.env.DSHO_DSH_BIN = '/usr/bin/true'
  try {
    const spec = spawnSpec({ model: 'pro', effort: 'high', jobDir })
    assert.equal(spec.cmd, '/usr/bin/true')
    assert.deepEqual(spec.args.slice(0, 2), ['--profile', 'headless'])
    assert.equal(spec.args.at(-1), '-')
    const patchIndex = spec.args.indexOf('--patch')
    assert.ok(patchIndex > 0 && patchIndex < spec.args.indexOf('--json'))
    const settings = JSON.parse(readFileSync(join(jobDir, 'settings.yaml'), 'utf8'))
    assert.deepEqual(settings['agent-default-model'], { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    assert.equal(settings.permission.defaultPreset, 'danger-full-access')
    assert.ok(existsSync(join(jobDir, 'settings.patch.yml')))
    assert.ok(!spawnSpec({ jobDir }).args.includes('--patch'))
  } finally {
    delete process.env.DSH_HOME
    delete process.env.DSHO_DSH_BIN
  }
})

test('a source checkout launches through its own tsx', () => {
  process.env.DSHO_DSH_REPO = '/opt/dsh-checkout'
  try {
    const spec = spawnSpec({ jobDir: mkdtempSync(join(tmpdir(), 'dsho-job-')) })
    assert.equal(spec.cmd, process.execPath)
    assert.equal(spec.args[0], '--import')
    assert.match(spec.args[1], /tsx\/dist\/esm\/index\.mjs$/)
    assert.equal(spec.args[2], join('/opt/dsh-checkout', 'apps', 'cli', 'src', 'bin.ts'))
    assert.equal(spec.env.TSX_TSCONFIG_PATH, join('/opt/dsh-checkout', 'tsconfig.json'))
  } finally {
    delete process.env.DSHO_DSH_REPO
  }
})

test('credentialEnv passes stored provider keys to workers, the environment wins', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsho-creds-'))
  writeFileSync(
    join(dshHome, '.credentials.yaml'),
    'version: 1\nrecords: {}\nrefs:\n  DEEPSEEK_API_KEY: test-not-a-real-key\n  OPENROUTER_API_KEY: test-stored-key\n  not-an-env-name: x\n',
  )
  // Users of this CLI often export these keys; the test must not depend on them
  const saved = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = dshHome
  process.env.OPENROUTER_API_KEY = 'test-from-env'
  process.env.DSHO_DSH_BIN = '/usr/bin/true'
  try {
    assert.deepEqual(credentialEnv(), { DEEPSEEK_API_KEY: 'test-not-a-real-key' })
    const spec = spawnSpec({ jobDir: mkdtempSync(join(tmpdir(), 'dsho-job-')) })
    assert.equal(spec.env.DEEPSEEK_API_KEY, 'test-not-a-real-key')
    assert.equal(spec.env.OPENROUTER_API_KEY, 'test-from-env')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete process.env.DSH_HOME
    delete process.env.DSHO_DSH_BIN
  }
})

test('credentialEnv is empty without a credentials file', () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsho-creds-'))
  try {
    assert.deepEqual(credentialEnv(), {})
  } finally {
    delete process.env.DSH_HOME
  }
})

test('resolveModel maps aliases to OpenRouter catalog ids', () => {
  assert.equal(resolveModel('v4-flash', 'openrouter'), 'deepseek/deepseek-v4-flash')
  assert.equal(resolveModel('pro', 'openrouter'), 'deepseek/deepseek-v4-pro')
  assert.equal(resolveModel('flash', 'openrouter'), '~deepseek/deepseek-flash-latest')
  assert.equal(resolveModel('deepseek/deepseek-v3.2', 'openrouter'), 'deepseek/deepseek-v3.2')
  assert.equal(resolveModel('vision', 'openrouter'), 'deepseek/deepseek-v4-flash-vision-exp')
  assert.equal(resolveModel('v4-flash', 'deepseek-official'), 'deepseek-v4-flash')
})

test('resolveModel leaves models of other vendors alone', () => {
  assert.equal(resolveModel('kimi-k2', 'openrouter'), 'kimi-k2')
  assert.equal(resolveModel('moonshotai/kimi-k2', 'openrouter'), 'moonshotai/kimi-k2')
})

test('provider and model settings drive the per-job settings, -m still wins', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsho-dshhome-'))
  const jobDir = mkdtempSync(join(tmpdir(), 'dsho-job-'))
  process.env.DSH_HOME = dshHome
  process.env.DSHO_DSH_BIN = '/usr/bin/true'
  process.env.DSHO_PROVIDER = 'openrouter'
  process.env.DSHO_MODEL = 'v4-flash'
  try {
    const spec = spawnSpec({ jobDir })
    assert.ok(spec.args.includes('--patch'), 'a configured provider writes the override without -m')
    const settings = JSON.parse(readFileSync(join(jobDir, 'settings.yaml'), 'utf8'))
    assert.deepEqual(settings['agent-default-model'], { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' })
    assert.equal(modelSelection({ model: 'pro' }, {}).model, 'deepseek/deepseek-v4-pro')
  } finally {
    delete process.env.DSH_HOME
    delete process.env.DSHO_DSH_BIN
    delete process.env.DSHO_PROVIDER
    delete process.env.DSHO_MODEL
  }
})
