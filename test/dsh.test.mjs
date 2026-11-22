// Model names and the dsh command line. How an installed binary is launched is
// tested end to end in setup.test.mjs; Windows shims in windows.test.mjs. What is
// left here are pure mappings and the one launch that cannot run in a test:
// a dsh source checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolateProcess } from './helpers.mjs'

const dirs = isolateProcess()
const { modelSelection, resolveModel, spawnSpec } = await import('../src/dsh.mjs')

/** Set environment variables for one test. */
function withEnv(t, vars) {
  for (const [key, value] of Object.entries(vars)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => (previous === undefined ? delete process.env[key] : (process.env[key] = previous)))
  }
}

test('resolveModel maps short names and passes full ids through', () => {
  assert.equal(resolveModel('flash'), 'deepseek-flash')
  assert.equal(resolveModel('pro'), 'deepseek-v4-pro')
  assert.equal(resolveModel('v4-pro'), 'deepseek-v4-pro')
  assert.equal(resolveModel('v4-flash'), 'deepseek-v4-flash')
  assert.equal(resolveModel('vision'), 'deepseek-v4-flash-vision-exp')
  assert.equal(resolveModel('deepseek-custom'), 'deepseek-custom')
  assert.equal(resolveModel(null), null)
})

test('resolveModel uses catalog ids on OpenRouter and leaves other vendors alone', () => {
  assert.equal(resolveModel('v4-flash', 'openrouter'), 'deepseek/deepseek-v4-flash')
  assert.equal(resolveModel('pro', 'openrouter'), 'deepseek/deepseek-v4-pro')
  assert.equal(resolveModel('flash', 'openrouter'), '~deepseek/deepseek-flash-latest')
  assert.equal(resolveModel('vision', 'openrouter'), 'deepseek/deepseek-v4-flash-vision-exp')
  assert.equal(resolveModel('deepseek/deepseek-v3.2', 'openrouter'), 'deepseek/deepseek-v3.2')
  assert.equal(resolveModel('kimi-k2', 'openrouter'), 'kimi-k2')
  assert.equal(resolveModel('moonshotai/kimi-k2', 'openrouter'), 'moonshotai/kimi-k2')
  assert.equal(resolveModel('v4-flash', 'deepseek-official'), 'deepseek-v4-flash')
})

test('modelSelection: the job wins over dsho config, which wins over dsh settings, which win over the defaults', (t) => {
  const settings = { 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' } }
  assert.deepEqual(modelSelection({}, {}), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(modelSelection({}, settings), { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.deepEqual(modelSelection({ model: 'flash', effort: 'low' }, settings), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })

  withEnv(t, { DSHO_PROVIDER: 'openrouter', DSHO_MODEL: 'v4-flash' })
  assert.deepEqual(modelSelection({}, settings), { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' })
  assert.deepEqual(modelSelection({ model: 'pro' }, {}), { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' })
})

test('a dsh source checkout is launched through its own tsx and tsconfig', (t) => {
  const repo = join(dirs.root, 'dsh-checkout')
  withEnv(t, { DSHO_DSH_REPO: repo })
  const spec = spawnSpec({ sessionId: 'session-1', jobDir: dirs.root })
  assert.equal(spec.cmd, process.execPath)
  assert.deepEqual(spec.args, [
    '--import',
    pathToFileURL(join(repo, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
    join(repo, 'apps', 'cli', 'src', 'bin.ts'),
    '--profile',
    'headless',
    '--json',
    '--session-id',
    'session-1',
    '--approval-policy',
    'never',
    '-',
  ])
  assert.equal(spec.env.TSX_TSCONFIG_PATH, join(repo, 'tsconfig.json'))
  assert.equal(spec.env.DSHO_JOB, '1')
})
