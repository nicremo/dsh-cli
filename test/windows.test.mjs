import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCmdShim, spawnSpec, which } from '../src/dsh.mjs'

// Real shim shapes, shortened: npm's generated .cmd and the DeepSeek Harness desktop launcher
const NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
)\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r
`
const DESKTOP_SHIM = `@echo off\r
setlocal DisableDelayedExpansion\r
set "ELECTRON_RUN_AS_NODE=1"\r
"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\lib\\cli.js" %*\r
exit /b %errorlevel%\r
`

test('resolveCmdShim runs an npm shim script through node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsho-shim-'))
  writeFileSync(join(dir, 'dsh.cmd'), NPM_SHIM)
  const shim = resolveCmdShim(join(dir, 'dsh.cmd'))
  assert.equal(shim.cmd, process.execPath)
  assert.deepEqual(shim.prefix, [join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')])
  assert.deepEqual(shim.env, {})
})

test('resolveCmdShim keeps the runtime, flags and env of the desktop launcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsho-desktop-'))
  const bin = join(root, 'resources', 'runtime', 'cli', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(root, 'DeepSeek Harness.exe'), '')
  writeFileSync(join(bin, 'dsh.cmd'), DESKTOP_SHIM)
  const shim = resolveCmdShim(join(bin, 'dsh.cmd'))
  assert.equal(shim.cmd, join(root, 'DeepSeek Harness.exe'))
  assert.deepEqual(shim.prefix, ['--expose-internals', join(root, 'resources', 'app.asar', 'dsh', 'lib', 'cli.js')])
  assert.deepEqual(shim.env, { ELECTRON_RUN_AS_NODE: '1' })
})

test('resolveCmdShim returns null for an unknown shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsho-shim-'))
  writeFileSync(join(dir, 'dsh.cmd'), '@echo off\r\nsomething.exe %*\r\n')
  assert.equal(resolveCmdShim(join(dir, 'dsh.cmd')), null)
})

test('DSHO_DSH_CMD may be a script that runs through node', () => {
  const previous = process.env.DSHO_DSH_CMD
  process.env.DSHO_DSH_CMD = join(tmpdir(), 'fake-dsh.mjs')
  try {
    const spec = spawnSpec({ sessionId: 'session-1', jobDir: tmpdir() })
    assert.equal(spec.cmd, process.execPath)
    assert.deepEqual(spec.args, [process.env.DSHO_DSH_CMD, '--json', '--session-id', 'session-1', '-'])
  } finally {
    if (previous === undefined) delete process.env.DSHO_DSH_CMD
    else process.env.DSHO_DSH_CMD = previous
  }
})

test('which finds .cmd shims through PATHEXT on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsho-path-'))
  writeFileSync(join(dir, 'dsh.cmd'), NPM_SHIM)
  const path = process.env.PATH
  process.env.PATH = dir
  try {
    assert.equal(which('dsh'), join(dir, 'dsh.cmd'))
  } finally {
    process.env.PATH = path
  }
})

test('which prefers .exe over .cmd on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsho-path-'))
  writeFileSync(join(dir, 'dsh.cmd'), NPM_SHIM)
  writeFileSync(join(dir, 'dsh.exe'), '')
  const path = process.env.PATH
  process.env.PATH = dir
  try {
    assert.equal(which('dsh'), join(dir, 'dsh.exe'))
  } finally {
    process.env.PATH = path
  }
})
