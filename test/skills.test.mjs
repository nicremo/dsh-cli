import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home
before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsho-skill-'))
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  delete process.env.DSH_AGENTS_HOME
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, '.codex'))
})

const { installSkill } = await import('../src/skills.mjs')

test('installs the canonical copy and links detected agents', () => {
  const res = installSkill({})
  const canonical = join(home, '.agents', 'skills', 'dsh-orchestration')
  assert.equal(res.canonical, canonical)
  assert.match(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), /^---\nname: dsh-orchestration/)
  assert.ok(lstatSync(join(home, '.claude', 'skills', 'dsh-orchestration')).isSymbolicLink())
  assert.ok(lstatSync(join(home, '.codex', 'skills', 'dsh-orchestration')).isSymbolicLink())
  assert.ok(!existsSync(join(home, '.pi')))
  assert.equal(res.rows.find((r) => r.agent === 'pi').action, 'skipped (not installed)')
})

test('reinstalling refreshes, copy mode copies', () => {
  const res = installSkill({ agents: ['claude'], copy: true })
  const target = join(home, '.claude', 'skills', 'dsh-orchestration')
  assert.ok(!lstatSync(target).isSymbolicLink())
  assert.ok(existsSync(join(target, 'SKILL.md')))
  assert.equal(res.rows.length, 2)
})

test('a foreign skill with the same name is left alone', () => {
  const foreign = join(home, '.codex', 'skills', 'dsh-orchestration')
  rmSync(foreign, { recursive: true, force: true })
  mkdirSync(foreign)
  writeFileSync(join(foreign, 'SKILL.md'), 'mine')
  const res = installSkill({ agents: ['codex'] })
  assert.match(res.rows[1].action, /skipped/)
  assert.equal(readFileSync(join(foreign, 'SKILL.md'), 'utf8'), 'mine')
})
