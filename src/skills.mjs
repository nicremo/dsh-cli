// `dsho skill install`: puts the bundled dsh-orchestration skill where agent
// harnesses look for skills. The canonical copy goes to ~/.agents/skills (the
// open Agent Skills location, also read by OpenCode); Claude Code, Codex and Pi
// get a symlink to it when their config folder exists.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentsSkillsDir } from './paths.mjs'
import { DshoError } from './util.mjs'

export const SKILL_NAME = 'dsh-orchestration'
const BUNDLED = fileURLToPath(new URL(`../skills/${SKILL_NAME}`, import.meta.url))
const MARKER = '.installed-by-dsh-cli'
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export function agentTargets() {
  const h = homedir()
  const claude = process.env.CLAUDE_CONFIG_DIR || join(h, '.claude')
  const codex = process.env.CODEX_HOME || join(h, '.codex')
  return [
    { agent: 'claude', parent: claude, dir: join(claude, 'skills') },
    { agent: 'codex', parent: codex, dir: join(codex, 'skills') },
    { agent: 'pi', parent: join(h, '.pi', 'agent'), dir: join(h, '.pi', 'agent', 'skills') },
  ]
}

function entryKind(path) {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return 'link'
    return existsSync(join(path, MARKER)) ? 'ours' : 'foreign'
  } catch {
    return 'missing'
  }
}

/**
 * Install or refresh the skill.
 * @param options.agents - agent names to link (default: every agent whose config folder exists).
 * @param options.copy - copy instead of symlinking into agent folders.
 * @returns the canonical path and one row per agent.
 */
export function installSkill({ agents, copy = false } = {}) {
  if (!existsSync(join(BUNDLED, 'SKILL.md'))) throw new DshoError(`bundled skill missing at ${BUNDLED}`, 5)
  const canonical = join(agentsSkillsDir(), SKILL_NAME)
  const kind = entryKind(canonical)
  if (kind === 'foreign') {
    throw new DshoError(`${canonical} exists and was not installed by dsh-cli`, 1, 'move it away, then run dsho skill install again')
  }
  if (kind === 'link') rmSync(canonical)
  if (kind === 'ours') rmSync(canonical, { recursive: true, force: true })
  mkdirSync(agentsSkillsDir(), { recursive: true })
  cpSync(BUNDLED, canonical, { recursive: true })
  writeFileSync(join(canonical, MARKER), `dsh-cli ${VERSION}\n`)

  const wanted = agents ? new Set(agents) : null
  const rows = [{ agent: 'agents (OpenCode, shared)', path: canonical, action: 'installed' }]
  for (const t of agentTargets()) {
    if (wanted && !wanted.has(t.agent)) continue
    if (!wanted && !existsSync(t.parent)) {
      rows.push({ agent: t.agent, path: t.dir, action: 'skipped (not installed)' })
      continue
    }
    const target = join(t.dir, SKILL_NAME)
    const existing = entryKind(target)
    if (existing === 'foreign') {
      rows.push({ agent: t.agent, path: target, action: 'skipped (a different skill with this name exists)' })
      continue
    }
    if (existing === 'link') rmSync(target)
    if (existing === 'ours') rmSync(target, { recursive: true, force: true })
    mkdirSync(t.dir, { recursive: true })
    if (copy) {
      cpSync(canonical, target, { recursive: true })
      rows.push({ agent: t.agent, path: target, action: 'copied' })
    } else {
      symlinkSync(canonical, target)
      rows.push({ agent: t.agent, path: target, action: 'linked' })
    }
  }
  return { canonical, rows }
}
