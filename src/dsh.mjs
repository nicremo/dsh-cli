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
import { delimiter, dirname, join, resolve, sep } from 'node:path'
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

// Provider routes that list DeepSeek models as "deepseek/<id>" (OpenRouter-style catalogs)
const VENDOR_PREFIXED = new Set(['openrouter'])

export function resolveModel(model, provider) {
  if (!model) return null
  const id = MODEL_ALIASES[model] ?? model
  if (!VENDOR_PREFIXED.has(provider) || id.includes('/')) return id
  // The rolling aliases are "~deepseek/deepseek-flash-latest" there, versioned models "deepseek/<id>"
  return /^deepseek-(flash|pro)$/.test(id) ? `~deepseek/${id}-latest` : `deepseek/${id}`
}

/** First executable named `name` on PATH, or null. On Windows also tries the PATHEXT extensions. */
export function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not in this PATH entry.
      }
    }
  }
  return null
}

/**
 * Windows: Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and a
 * shell would re-parse every argument. Read the shim instead and launch its script directly.
 * Handles npm shims (`"%_prog%" "%dp0%\node_modules\...\bin.js" %*`) and the DeepSeek Harness
 * desktop shim (`"%~dp0..\DeepSeek Harness.exe" --expose-internals "%~dp0..\cli.js" %*`
 * with ELECTRON_RUN_AS_NODE=1). Returns null when the shim has an unknown shape.
 */
export function resolveCmdShim(file) {
  const dir = dirname(file)
  const text = readFileSync(file, 'utf8')
  // Backslashes become the platform separator, so the parser is testable on every OS
  const expand = (s) => resolve(s.replace(/%~dp0|%dp0%/gi, dir + sep).replace(/\\/g, sep))
  const line = text.split(/\r?\n/).find((l) => /\.[cm]?js"/i.test(l))
  if (!line) return null
  const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => ({ value: m[1], index: m.index }))
  const script = quoted.find((q) => /\.[cm]?js$/i.test(q.value))
  if (!script) return null
  const exe = quoted.find((q) => q.index < script.index && /\.exe$/i.test(q.value) && existsSync(expand(q.value)))
  const flags = exe ? line.slice(exe.index + exe.value.length + 2, script.index).match(/--[\w-]+/g) ?? [] : []
  return {
    cmd: exe ? expand(exe.value) : process.execPath,
    prefix: [...flags, expand(script.value)],
    env: /ELECTRON_RUN_AS_NODE=1/i.test(text) ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  }
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
  if (process.env.DSHO_DSH_CMD) {
    // Scripts go through node: Windows cannot execute a .mjs file directly.
    const custom = process.env.DSHO_DSH_CMD
    const script = /\.[cm]?js$/i.test(custom)
    return { kind: 'custom', where: custom, cmd: script ? process.execPath : custom, prefix: script ? [custom] : [], env: {} }
  }
  const repo = cfg('dshRepo')
  if (repo) return sourceLaunch(repo)
  const bin = cfg('dshBin') || which('dsh')
  if (bin && process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const shim = resolveCmdShim(bin)
    if (shim) return { kind: 'binary', where: bin, ...shim }
  }
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

/**
 * API keys that the dsh desktop or web app stored under `refs` in ~/.dsh/.credentials.yaml.
 * Headless dsh reads provider keys only from the environment, so workers get them there.
 * Variables already set in the environment win; values are never printed.
 */
export function credentialEnv() {
  const file = join(dshHome(), '.credentials.yaml')
  if (!existsSync(file)) return {}
  try {
    const refs = yaml.load(readFileSync(file, 'utf8'))?.refs ?? {}
    return Object.fromEntries(
      Object.entries(refs).filter(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string' && value && !process.env[key]),
    )
  } catch {
    return {}
  }
}

export function readDshSettings() {
  const file = join(dshHome(), 'settings.yaml')
  if (!existsSync(file)) return {}
  return yaml.load(readFileSync(file, 'utf8')) ?? {}
}

export function activeProfile() {
  return existsSync(join(profileDir(PROFILE), 'package.json')) ? PROFILE : 'headless'
}

/** Provider, model and effort for one job: dsho config `provider`/`model` win over ~/.dsh/settings.yaml. */
export function modelSelection({ model, effort }, settings = readDshSettings()) {
  const current = settings['agent-default-model'] ?? {}
  const reasoningEffort = effort ?? current.reasoningEffort
  const provider = cfg('provider') ?? current.provider ?? 'deepseek-official'
  return {
    provider,
    model: resolveModel(model ?? cfg('model'), provider) ?? resolveModel(current.model, provider) ?? resolveModel('flash', provider),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

/** Per-job settings copy with a different default model; returns the patch path. */
function writeSettingsOverride(jobDir, { model, effort }) {
  if (effort && !EFFORTS.includes(effort)) {
    throw new DshoError(`Invalid effort "${effort}". Allowed: ${EFFORTS.join(', ')}`, 2)
  }
  const settings = readDshSettings()
  settings['agent-default-model'] = modelSelection({ model, effort }, settings)
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
  if (dsh.kind === 'custom') return { cmd: dsh.cmd, args: [...dsh.prefix, ...tail], env: { ...process.env }, profile: 'custom' }
  const profile = activeProfile()
  const args = [...dsh.prefix, '--profile', profile]
  // A configured provider or model needs the per-job settings even without -m or --effort
  if (model || effort || cfg('provider') || cfg('model')) args.push('--patch', writeSettingsOverride(jobDir, { model, effort }))
  args.push(...tail)
  return { cmd: dsh.cmd, args, env: { ...credentialEnv(), ...process.env, ...dsh.env, DSHO_JOB: '1' }, profile }
}
