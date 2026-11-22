// `dsho skill install` is tested through the CLI in setup.test.mjs. This file
// holds the one case that needs a file system that refuses links: a canonical
// copy on a Windows network share, where junctions do not work, for skill install and
// for the curated skill folder of dsho setup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { FAKE_DSH, isolateProcess } from './helpers.mjs'

const dirs = isolateProcess()
const { installSkill } = await import('../src/skills.mjs')

test('skill install copies when Windows cannot create a junction', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  mkdirSync(join(dirs.userHome, '.claude'))
  t.mock.method(fs, 'symlinkSync', () => {
    throw Object.assign(new Error('Local volumes are required'), { code: 'EPERM' })
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const res = installSkill({ agents: ['claude'] })
  const target = join(dirs.userHome, '.claude', 'skills', 'dsh-orchestration')
  assert.equal(res.canonical, join(dirs.userHome, '.agents', 'skills', 'dsh-orchestration'))
  assert.equal(res.rows[1].action, 'copied')
  assert.ok(!lstatSync(target).isSymbolicLink())
  assert.ok(existsSync(join(target, 'SKILL.md')))
})

test('setup copies a curated skill it cannot link, refreshes the copy and removes it when deselected', async (t) => {
  const { setupProfile } = await import('../src/profile.mjs')
  // setup validates the profile with dsh: use the fake, never an installed dsh.
  const previousCmd = process.env.DSHO_DSH_CMD
  process.env.DSHO_DSH_CMD = FAKE_DSH
  t.after(() => {
    if (previousCmd === undefined) delete process.env.DSHO_DSH_CMD
    else process.env.DSHO_DSH_CMD = previousCmd
  })
  // The profile exists already, so setup does not need dsh to scaffold it.
  mkdirSync(join(dirs.dshHome, 'profiles', 'orchestra'), { recursive: true })
  writeFileSync(join(dirs.dshHome, 'profiles', 'orchestra', 'package.json'), '{}')
  const pool = join(dirs.userHome, '.agents', 'skills')
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(pool, name), { recursive: true })
    writeFileSync(join(pool, name, 'SKILL.md'), `# ${name} v1\n`)
  }
  // Like a skill pool on a network share: every link attempt is refused.
  t.mock.method(fs, 'symlinkSync', () => {
    throw Object.assign(new Error('Local volumes are required'), { code: 'EPERM' })
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const curated = join(dirs.dshHome, 'skills-orchestra')

  assert.deepEqual(setupProfile({ skills: 'alpha,beta', mcp: 'none', llm: false }).skills, ['alpha', 'beta'])
  assert.ok(!lstatSync(join(curated, 'alpha')).isSymbolicLink(), 'a copy, not a link')
  assert.equal(readFileSync(join(curated, 'alpha', 'SKILL.md'), 'utf8'), '# alpha v1\n')

  // A later setup refreshes the copy from the pool and drops a deselected one.
  writeFileSync(join(pool, 'alpha', 'SKILL.md'), '# alpha v2\n')
  assert.deepEqual(setupProfile({ skills: 'alpha', mcp: 'none', llm: false }).skills, ['alpha'])
  assert.equal(readFileSync(join(curated, 'alpha', 'SKILL.md'), 'utf8'), '# alpha v2\n')
  assert.deepEqual(readdirSync(curated), ['alpha'])
  assert.ok(existsSync(join(pool, 'beta', 'SKILL.md')), 'the pool itself is untouched')

  // Something the user put into the folder by hand is never removed.
  mkdirSync(join(curated, 'mine'))
  setupProfile({ skills: 'alpha', mcp: 'none', llm: false })
  assert.ok(existsSync(join(curated, 'mine')))
})
