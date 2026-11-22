// `dsho skill install` is tested through the CLI in setup.test.mjs. This file
// holds the one case that needs a file system that refuses links: a canonical
// copy on a Windows network share, where junctions do not work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { isolateProcess } from './helpers.mjs'

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
