// Locating and launching DeepSeek Harness (dsh).
//
// Resolution order:
//   1. DSHO_DSH_CMD   a replacement executable that takes `--json [--session-id id] -` (tests)
//   2. dshRepo        a source checkout, launched through its own tsx (DSHO_DSH_REPO or config)
//   3. dshBin or `dsh` on PATH (DSHO_DSH_BIN or config; npm i -g @deepseek-ai/dsh)
//   4. ~/deepseek-harness as a source checkout
//
// Source launches need TSX_TSCONFIG_PATH pointing at the checkout's tsconfig;
// without it tsx resolves stale lib/ builds whenever the cwd is outside the repo.
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { cfg } from './config.mjs'
import { dshHome, PROFILE, profileDir } from './paths.mjs'
import { DshoError } from './util.mjs'

const MODEL_ALIASES = {
  flash: 'deepseek-flash',
  'v4-flash': 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
  'v4-pro': 'deepseek-v4-pro',
  vision: 'deepseek-v4-flash-vision-exp',
}
export const EFFORTS = ['off', 'low', 'high', 'max']

export function resolveModel(model) {
  if (!model) return null
  return MODEL_ALIASES[model] ?? model
}

/** First executable named `name` on PATH, or null. */
export function which(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not in this PATH entry.
    }
  }
  return null
}

function sourceLaunch(repo) {
  return {
    kind: 'source',
    where: repo,
    cmd: process.execPath,
    prefix: ['--import', pathToFileURL(join(repo, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href, join(repo, 'apps', 'cli', 'src', 'bin.ts')],
    env: { TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json') },
  }
}

const isCheckout = (repo) => existsSync(join(repo, 'apps', 'cli', 'src', 'bin.ts')) && existsSync(join(repo, 'node_modules', 'tsx'))

/** How to start dsh on this machine, or null when it is not installed. */
export function resolveDsh() {
  if (process.env.DSHO_DSH_CMD) return { kind: 'custom', where: process.env.DSHO_DSH_CMD, cmd: process.env.DSHO_DSH_CMD, prefix: [], env: {} }
  const repo = cfg('dshRepo')
  if (repo) return sourceLaunch(repo)
  const bin = cfg('dshBin') || which('dsh')
  if (bin) return { kind: 'binary', where: bin, cmd: bin, prefix: [], env: {} }
  const fallback = join(homedir(), 'deepseek-harness')
  if (isCheckout(fallback)) return sourceLaunch(fallback)
  return null
}

export function requireDsh() {
  const dsh = resolveDsh()
  if (!dsh) {
    throw new DshoError('DeepSeek Harness (dsh) not found', 5, 'npm install -g @deepseek-ai/dsh, or dsho config set dshBin|dshRepo <path>')
  }
  return dsh
}

/** Full command line for `dsh <args>`. */
export function dshCommand(args) {
  const dsh = requireDsh()
  return { cmd: dsh.cmd, args: [...dsh.prefix, ...args], env: { ...process.env, ...dsh.env }, dsh }
}

export function readDshSettings() {
  const file = join(dshHome(), 'settings.yaml')
  if (!existsSync(file)) return {}
  return yaml.load(readFileSync(file, 'utf8')) ?? {}
}

export function activeProfile() {
  return existsSync(join(profileDir(PROFILE), 'package.json')) ? PROFILE : 'headless'
}

/** Per-job settings copy with a different default model; returns the patch path. */
function writeSettingsOverride(jobDir, { model, effort }) {
  if (effort && !EFFORTS.includes(effort)) {
    throw new DshoError(`Invalid effort "${effort}". Allowed: ${EFFORTS.join(', ')}`, 2)
  }
  const settings = readDshSettings()
  const current = settings['agent-default-model'] ?? {}
  const reasoningEffort = effort ?? current.reasoningEffort
  settings['agent-default-model'] = {
    provider: current.provider ?? 'deepseek-official',
    model: resolveModel(model) ?? current.model ?? 'deepseek-flash',
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
  const settingsPath = join(jobDir, 'settings.yaml')
  // JSON is valid YAML, so the dsh settings loader reads it unchanged.
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  const patchPath = join(jobDir, 'settings.patch.yml')
  writeFileSync(patchPath, `# dsh-cli: per-job settings with a model override\n- id: settings\n  config:\n    path: ${JSON.stringify(settingsPath)}\n    watch: false\n`)
  return patchPath
}

/**
 * Command, args and env for one headless run. The task always goes through
 * stdin (positional `-`), so leading dashes and long prompts are safe.
 */
export function spawnSpec({ sessionId, model, effort, jobDir }) {
  const tail = ['--json', ...(sessionId ? ['--session-id', sessionId] : []), '-']
  const dsh = requireDsh()
  if (dsh.kind === 'custom') return { cmd: dsh.cmd, args: tail, env: { ...process.env }, profile: 'custom' }
  const profile = activeProfile()
  const args = [...dsh.prefix, '--profile', profile]
  if (model || effort) args.push('--patch', writeSettingsOverride(jobDir, { model, effort }))
  args.push(...tail)
  return { cmd: dsh.cmd, args, env: { ...process.env, ...dsh.env, DSHO_JOB: '1' }, profile }
}
