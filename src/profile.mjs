// `dsho setup` and `dsho doctor`. The dedicated dsh profile "orchestra" is the
// shipped headless profile plus research MCP servers copied from another
// profile (default: web) and a small curated skill set, which keeps the worker
// prompt smaller, faster and cheaper than the full skill pool.
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { cfg } from './config.mjs'
import { activeProfile, dshCommand, readDshSettings, resolveDsh, which } from './dsh.mjs'
import { agentsSkillsDir, curatedSkillsDir, dshHome, home, PROFILE, profileDir } from './paths.mjs'
import { DshoError } from './util.mjs'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
/** MCP servers that help research and material workers. */
export const RESEARCH_MCP = /firecrawl|brave|context7|exa\b|tavily|perplexity|jina|serper|searx|kagi/i
export const CURATED_SKILLS = [
  'firecrawl',
  'firecrawl-search',
  'firecrawl-scrape',
  'firecrawl-crawl',
  'firecrawl-map',
  'firecrawl-download',
  'download-anything',
  'playwright',
  'agent-reach',
  'crawl4ai',
  'independent-research',
  'research-lookup',
  'image-optimization',
]

/** Row filter for `--mcp research|all|none|id,id`. */
export function mcpFilter(mode = 'research') {
  if (mode === 'none') return () => false
  if (mode === 'all') return () => true
  if (mode === 'research') return (row) => RESEARCH_MCP.test(`${row.id} ${row.config?.serverName ?? ''}`)
  const wanted = new Set(mode.split(',').map((s) => s.trim()).filter(Boolean))
  return (row) => wanted.has(row.id) || wanted.has(row.config?.serverName)
}

/** Schema that round-trips dsh's `!!js` expression scalars unchanged. */
function schemaWithJs() {
  class JsExpr {
    constructor(src) {
      this.src = src
    }
  }
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (src) => new JsExpr(src),
    instanceOf: JsExpr,
    represent: (obj) => obj.src,
  })
  return yaml.DEFAULT_SCHEMA.extend([jsType])
}

/** MCP client insert rows of a dsh patch file that pass `filter`. Values are never printed. */
export function extractRows(patchText, filter) {
  const schema = schemaWithJs()
  const doc = yaml.load(patchText, { schema }) ?? []
  const rows = []
  for (const entry of Array.isArray(doc) ? doc : []) {
    for (const row of entry?.insert ?? []) if (row?.name === MCP_CLIENT && filter(row)) rows.push(row)
  }
  return { rows, dump: (value) => yaml.dump(value, { schema, lineWidth: -1, noRefs: true }) }
}

export function renderPatch({ rows, dump, skillsDir, sourceProfile }) {
  const header = `# Managed by dsh-cli (dsho setup). The next \`dsho setup\` overwrites this file.
# MCP rows are copied from the "${sourceProfile}" profile.
#
# A curated skill folder instead of the full pool keeps the worker prompt small;
# the .dsho-workspace marker lets workers in batch subfolders load the workspace AGENTS.md.
`
  const base = []
  if (skillsDir) base.push({ id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: [skillsDir], watch: false } })
  base.push({ id: 'agent-instructions', config: { maxBytes: 65536, projectRootMarkers: ['.git', '.dsho-workspace'] } })
  if (rows.length) base.push({ insert: rows })
  return header + '\n' + dump(base)
}

function linkSkills(names) {
  const dir = curatedSkillsDir()
  mkdirSync(dir, { recursive: true })
  const linked = []
  for (const name of names) {
    const source = join(agentsSkillsDir(), name)
    const target = join(dir, name)
    if (!existsSync(source)) continue
    let present = false
    try {
      lstatSync(target)
      present = true
    } catch {
      // Missing link.
    }
    if (!present) symlinkSync(source, target)
    linked.push(name)
  }
  return { dir, linked }
}

const tail = (text) => (text || '').split('\n').filter(Boolean).slice(-3).join(' ')

/**
 * Create or refresh the "orchestra" dsh profile.
 * @param options.mcp - research (default), all, none, or a comma list of row ids / server names.
 * @param options.from - profile whose MCP rows are copied (default web).
 * @param options.skills - comma list of skills, "all" for the full pool, or undefined for the curated set.
 */
export function setupProfile({ mcp = 'research', from = 'web', skills } = {}) {
  const dir = profileDir()
  const notes = []
  mkdirSync(home(), { recursive: true })
  if (!existsSync(join(dir, 'package.json'))) {
    // Let dsh scaffold the profile from its shipped headless template.
    const c = dshCommand(['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'])
    const res = spawnSync(c.cmd, c.args, { env: c.env, cwd: home(), encoding: 'utf8', timeout: 180000 })
    if (res.status !== 0 || !existsSync(join(dir, 'package.json'))) {
      throw new DshoError(`dsh could not create the profile: ${tail(res.stderr)}`, 5)
    }
  }
  let skillsDir = null
  let linked = []
  if (skills !== 'all') {
    ;({ dir: skillsDir, linked } = linkSkills(skills ? skills.split(',').map((s) => s.trim()) : CURATED_SKILLS))
    if (!linked.length) notes.push(`none of the curated skills exist in ${agentsSkillsDir()}; workers run without skills (use --skills all for dsh defaults)`)
  }

  const sourcePatch = join(profileDir(from), 'cordis.patch.yml')
  let rows = []
  let dump
  if (existsSync(sourcePatch)) {
    ;({ rows, dump } = extractRows(readFileSync(sourcePatch, 'utf8'), mcpFilter(mcp)))
    if (!rows.length && mcp !== 'none') notes.push(`no matching MCP servers in the "${from}" profile; workers use the built-in web_search and web_fetch`)
  } else {
    ;({ dump } = extractRows('[]', () => false))
    if (mcp !== 'none') notes.push(`profile "${from}" has no cordis.patch.yml; no MCP servers copied`)
  }
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, renderPatch({ rows, dump, skillsDir, sourceProfile: from }), { mode: 0o600 })
  // Copied MCP rows can carry API keys, so the file stays private.
  chmodSync(patchFile, 0o600)

  // Validate the composed tree without booting it and without printing it.
  const c = dshCommand(['--profile', PROFILE, '--dump-config'])
  const check = spawnSync(c.cmd, c.args, { env: c.env, cwd: home(), encoding: 'utf8', timeout: 180000 })
  if (check.status !== 0) throw new DshoError(`profile written, but dsh rejects it: ${tail(check.stderr)}`, 5)
  return {
    profile: PROFILE,
    profileDir: dir,
    mcpServers: rows.map((r) => r.config?.serverName ?? r.id),
    skillsDir,
    skills: linked,
    notes,
  }
}

let pythonCache
/** A python that can import playwright, for `dsho capture`. */
export function findPython() {
  if (pythonCache) return pythonCache
  const candidates = [cfg('python'), 'python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].filter(Boolean)
  for (const python of candidates) {
    const res = spawnSync(python, ['-c', 'import importlib.metadata as m; print(m.version("playwright"))'], { encoding: 'utf8', timeout: 15000 })
    if (res.status === 0) return (pythonCache = { python, playwright: res.stdout.trim() })
  }
  return (pythonCache = { python: cfg('python') || 'python3', playwright: null })
}

export function doctor() {
  const checks = []
  const add = (name, ok, detail, optional = false) => checks.push({ name, ok: Boolean(ok), detail, optional })

  const [maj, min] = process.versions.node.split('.').map(Number)
  add('node', maj > 22 || (maj === 22 && min >= 19), `v${process.versions.node} (dsh needs ^22.19 or >=24)`)

  const dsh = resolveDsh()
  add('dsh', Boolean(dsh), dsh ? `${dsh.kind}: ${dsh.where}` : 'not found: npm install -g @deepseek-ai/dsh (or dsho config set dshBin|dshRepo <path>)')

  const profile = activeProfile()
  add('profile', profile === PROFILE, profile === PROFILE ? profileDir() : 'orchestra missing, headless jobs use the shipped headless profile (run dsho setup)', true)

  let settings = {}
  try {
    settings = readDshSettings()
  } catch (err) {
    add('settings', false, err.message)
  }
  const preset = settings?.permission?.defaultPreset ?? 'workspace-write (default)'
  const model = settings?.['agent-default-model']
  add('permissions', preset === 'danger-full-access', `permission preset ${preset}${preset === 'danger-full-access' ? '' : ': unattended workers may stall on approval prompts'}`, preset !== 'danger-full-access')
  add('model', Boolean(model), model ? `${model.provider}/${model.model}${model.reasoningEffort ? ` (${model.reasoningEffort})` : ''}` : 'no default model in ~/.dsh/settings.yaml (dsh default applies)', true)
  const hasCreds = existsSync(join(dshHome(), '.credentials.yaml')) || Boolean(process.env.DEEPSEEK_API_KEY)
  add('credentials', hasCreds, hasCreds ? 'dsh credentials present' : 'no dsh credentials: log in once through dsh or set DEEPSEEK_API_KEY')

  if (dsh && dsh.kind !== 'custom') {
    const c = dshCommand(['--profile', profile, '--dump-config'])
    const t0 = Date.now()
    const res = spawnSync(c.cmd, c.args, { env: c.env, cwd: home(), encoding: 'utf8', timeout: 120000 })
    add('dsh-config', res.status === 0, res.status === 0 ? `profile ${profile} composes in ${Date.now() - t0} ms` : tail(res.stderr))
  }

  const py = findPython()
  add('playwright', Boolean(py.playwright), py.playwright ? `Python Playwright ${py.playwright} (${py.python})` : 'not importable: pip install playwright && python3 -m playwright install chromium (needed for dsho capture)', true)
  for (const bin of ['ffmpeg', 'ffprobe', 'yt-dlp']) {
    const path = which(bin)
    add(bin, Boolean(path), path ?? 'not found', true)
  }
  try {
    mkdirSync(home(), { recursive: true })
    accessSync(home(), constants.W_OK)
    add('state', true, home())
  } catch {
    add('state', false, `${home()} is not writable`)
  }
  return checks
}
