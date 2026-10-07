import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fold, initialState, parseLines, timeline } from '../src/events.mjs'
import { resolveModel, spawnSpec } from '../src/dsh.mjs'

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
    assert.equal(spec.args[2], '/opt/dsh-checkout/apps/cli/src/bin.ts')
    assert.equal(spec.env.TSX_TSCONFIG_PATH, '/opt/dsh-checkout/tsconfig.json')
  } finally {
    delete process.env.DSHO_DSH_REPO
  }
})
