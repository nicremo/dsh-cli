// Everything around jobs, through the dsho CLI process: setup, doctor, config,
// workspaces, the agent skill and how an installed dsh binary is launched.
// Each test owns a sandboxed home, so nothing reaches ~/.dsho, ~/.dsh, ~/.agents or ~/.claude.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeDshBinary, sandbox, withRenameRace } from './helpers.mjs'

const MCP = "'@deepseek-ai/dsh-mcp-client'"
/** A "web" profile patch as the dsh desktop app writes it; all values are fake. */
const WEB_PATCH = `- insert:
    - id: mcp-supabase
      name: ${MCP}
      config:
        serverName: supabase
        env:
          SUPABASE_ACCESS_TOKEN: test-other-secret
    - id: mcp-firecrawl
      name: ${MCP}
      config:
        serverName: firecrawl
        env:
          FIRECRAWL_API_KEY: test-not-a-real-key
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: openrouter
    model: deepseek/deepseek-v4-flash
`

function withWebProfile(s) {
  mkdirSync(join(s.dshHome, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(s.dshHome, 'profiles', 'web', 'cordis.patch.yml'), WEB_PATCH)
}

function withPoolSkills(s, names) {
  for (const name of names) {
    mkdirSync(join(s.userHome, '.agents', 'skills', name), { recursive: true })
    writeFileSync(join(s.userHome, '.agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
}

describe('dsho CLI, setup and environment', { concurrency: 8 }, () => {
  // ----------------------------------------------------------- setup ----

  test('setup lets dsh scaffold the orchestra profile, copies research MCP servers, model settings and curated skills', withRenameRace(async (s) => {
    withWebProfile(s)
    withPoolSkills(s, ['firecrawl', 'playwright', 'unrelated-skill'])
    const r = await s.run(['setup', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    const profileDir = join(s.dshHome, 'profiles', 'orchestra')
    const skillsDir = join(s.dshHome, 'skills-orchestra')
    assert.deepEqual(r.json.profile, {
      profile: 'orchestra',
      profileDir,
      mcpServers: ['firecrawl'],
      llm: ['openrouter/deepseek/deepseek-v4-flash'],
      skillsDir,
      skills: ['firecrawl', 'playwright'],
      notes: [],
    })
    assert.equal(r.json.webUi, null)
    assert.equal(r.json.skill.canonical, join(s.userHome, '.agents', 'skills', 'dsh-orchestration'))

    // dsh was asked to create the profile from its headless template, then to validate it.
    assert.deepEqual(s.dshLog().map((e) => e.args), [
      ['--profile', 'orchestra', '--from-default-profile', 'headless', '--dump-config'],
      ['--profile', 'orchestra', '--dump-config'],
    ])
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /serverName: firecrawl/)
    assert.match(patch, /FIRECRAWL_API_KEY: test-not-a-real-key/)
    assert.match(patch, /provider: openrouter/)
    assert.doesNotMatch(patch, /supabase/, 'only research servers are copied')
    assert.ok(patch.includes(skillsDir) || patch.includes(JSON.stringify(skillsDir).slice(1, -1)), 'the curated skill folder is configured')
    assert.doesNotMatch(r.out, /test-not-a-real-key/, 'copied secrets are never printed')
    assert.deepEqual(readdirSync(skillsDir).sort(), ['firecrawl', 'playwright'])
    assert.ok(existsSync(join(skillsDir, 'firecrawl', 'SKILL.md')), 'the link resolves')

    // Second run: the profile exists, dsh only validates.
    const again = await s.run(['setup', '--json'])
    assert.equal(again.code, 0, again.err + again.out)
    assert.deepEqual(s.dshLog().slice(2).map((e) => e.args), [['--profile', 'orchestra', '--dump-config']])
    assert.match((await s.run(['setup'])).out, /^dsh profile "orchestra" ready: /)
  }))

  test('setup --mcp none --no-llm --no-skill copies nothing and says what is missing', withRenameRace(async (s) => {
    withWebProfile(s)
    const r = await s.run(['setup', '--mcp', 'none', '--no-llm', '--no-skill', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.deepEqual(r.json.profile.mcpServers, [])
    assert.deepEqual(r.json.profile.llm, [])
    assert.deepEqual(r.json.profile.skills, [])
    assert.equal(r.json.skill, null)
    assert.equal(r.json.profile.notes.length, 1)
    assert.match(r.json.profile.notes[0], /none of the curated skills exist/)
    assert.ok(!existsSync(join(s.userHome, '.agents', 'skills', 'dsh-orchestration')))
    assert.doesNotMatch(readFileSync(join(s.dshHome, 'profiles', 'orchestra', 'cordis.patch.yml'), 'utf8'), /firecrawl|openrouter/)
  }))

  test('setup fails with exit 5 when dsh rejects the profile', withRenameRace(async (s) => {
    const r = await s.run(['setup', '--no-skill', '--json'])
    assert.equal(r.code, 5)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 5)
    assert.match(r.json.error, /invalid profile configuration/)
  }, (t) => sandbox(t, { FAKE_DSH_REJECT_CONFIG: '1' })))

  test('issue #8: setup --skills drops the links of an earlier selection', { todo: 'issue #8' }, withRenameRace(async (s) => {
    withPoolSkills(s, ['alpha', 'beta'])
    const first = await s.run(['setup', '--skills', 'alpha,beta', '--no-skill', '--json'])
    assert.deepEqual(first.json.profile.skills, ['alpha', 'beta'])
    const second = await s.run(['setup', '--skills', 'alpha', '--no-skill', '--json'])
    assert.equal(second.code, 0, second.err + second.out)
    assert.deepEqual(second.json.profile.skills, ['alpha'])
    assert.deepEqual(readdirSync(join(s.dshHome, 'skills-orchestra')), ['alpha'], 'workers load every skill in this folder')
    assert.ok(existsSync(join(s.userHome, '.agents', 'skills', 'beta', 'SKILL.md')), 'the skill pool itself is untouched')
  }))

  // ------------------------------------------------ launching real dsh ----

  test('an installed dsh binary runs with the headless profile, the per-job model patch and stored provider keys', withRenameRace(async (s) => {
    const bin = installFakeDshBinary(join(s.root, 'bin'))
    Object.assign(s.env, { DSHO_DSH_CMD: '', DSHO_DSH_BIN: bin, OPENROUTER_API_KEY: 'test-from-env' })
    writeFileSync(join(s.dshHome, 'settings.yaml'), 'permission:\n  defaultPreset: danger-full-access\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: max\n')
    writeFileSync(join(s.dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: test-stored-key\n  OPENROUTER_API_KEY: test-stored-other\n  not-an-env-name: x\n')

    const plain = await s.run(['run', '-C', join(s.ws, 'plain'), '-w', '--json', 'Plain'])
    assert.equal(plain.code, 0, plain.err + plain.out)
    assert.equal(plain.json.result, 'FAKE-RESULT: Plain')
    const tuned = await s.run(['run', '-C', join(s.ws, 'tuned'), '-m', 'pro', '--effort', 'high', '-w', '--json', 'Tuned'])
    assert.equal(tuned.code, 0, tuned.err + tuned.out)

    const [first, second] = s.dshLog().filter((e) => e.event === 'start')
    assert.deepEqual(first.args, ['--profile', 'headless', '--json', '-'])
    // Workers get stored keys through the environment; a key that is already set wins.
    assert.deepEqual(first.env, { DSHO_JOB: '1', DEEPSEEK_API_KEY: 'test-stored-key', OPENROUTER_API_KEY: 'test-from-env' })
    const jobDir = join(s.home, 'jobs', tuned.json.job.id)
    assert.deepEqual(second.args, ['--profile', 'headless', '--patch', join(jobDir, 'settings.patch.yml'), '--json', '-'])
    // The patch points dsh at a settings copy with the other model; the rest stays.
    assert.ok(readFileSync(join(jobDir, 'settings.patch.yml'), 'utf8').includes(JSON.stringify(join(jobDir, 'settings.yaml'))))
    const settings = JSON.parse(readFileSync(join(jobDir, 'settings.yaml'), 'utf8'))
    assert.deepEqual(settings['agent-default-model'], { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    assert.equal(settings.permission.defaultPreset, 'danger-full-access')

    // Once the orchestra profile exists, jobs use it.
    assert.equal((await s.run(['setup', '--no-skill', '--json'])).code, 0)
    await s.run(['run', '-C', join(s.ws, 'after'), '-w', '--json', 'After setup'])
    assert.deepEqual(s.dshLog().filter((e) => e.event === 'start')[2].args, ['--profile', 'orchestra', '--json', '-'])

    // A configured provider and model apply to every job without -m.
    Object.assign(s.env, { DSHO_PROVIDER: 'openrouter', DSHO_MODEL: 'v4-flash' })
    const routed = await s.run(['run', '-C', join(s.ws, 'routed'), '-w', '--json', 'Routed'])
    const routedSettings = JSON.parse(readFileSync(join(s.home, 'jobs', routed.json.job.id, 'settings.yaml'), 'utf8'))
    assert.deepEqual(routedSettings['agent-default-model'], { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' })
  }))

  // ---------------------------------------------------------- doctor ----

  test('doctor exits 5 while something mandatory is missing and 0 once it is there', withRenameRace(async (s) => {
    const sick = await s.run(['doctor', '--json'])
    assert.equal(sick.code, 5)
    assert.equal(sick.json.ok, true)
    assert.equal(sick.json.healthy, false)
    assert.deepEqual(sick.json.checks.map((c) => c.name), ['node', 'dsh', 'profile', 'permissions', 'model', 'credentials', 'playwright', 'ffmpeg', 'ffprobe', 'yt-dlp', 'state', 'web-ui'])
    assert.deepEqual(sick.json.checks.filter((c) => !c.ok && !c.optional).map((c) => c.name), ['credentials'])
    for (const c of sick.json.checks) assert.deepEqual(Object.keys(c).sort(), ['detail', 'name', 'ok', 'optional'])

    writeFileSync(join(s.dshHome, '.credentials.yaml'), 'version: 1\nrefs: {}\n')
    const well = await s.run(['doctor', '--json'])
    assert.equal(well.code, 0, well.out)
    assert.equal(well.json.healthy, true)
    assert.match((await s.run(['doctor'])).out, /^✓ node /m)
  }))

  // ---------------------------------------------------------- config ----

  test('config set, unset and show; environment variables win over config.json', withRenameRace(async (s) => {
    const set = await s.run(['config', 'set', 'model', 'v4-flash', '--json'])
    assert.equal(set.code, 0, set.err)
    assert.deepEqual(set.json.stored, { model: 'v4-flash' })
    assert.equal(set.json.effective.model, 'v4-flash')
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8')), { model: 'v4-flash' })

    // DSHO_WORKSPACES comes from the sandbox environment and beats the stored value.
    await s.run(['config', 'set', 'workspaces', join(s.ws, 'from-config')])
    const shown = await s.run(['config', '--json'])
    assert.equal(shown.json.stored.workspaces, join(s.ws, 'from-config'))
    assert.equal(shown.json.effective.workspaces, join(s.ws, 'auto'))
    assert.match((await s.run(['config'])).out, /^workspaces\s+.*auto {2}\(from DSHO_WORKSPACES\)$/m)

    const unset = await s.run(['config', 'unset', 'model', '--json'])
    assert.deepEqual(unset.json.stored, { workspaces: join(s.ws, 'from-config') })
    assert.equal(unset.json.effective.model, null)
  }))

  test('stored config drives later commands: workspace root with ~ and the backend', withRenameRace(async (s) => {
    delete s.env.DSHO_WORKSPACES
    delete s.env.DSHO_BACKEND
    await s.run(['config', 'set', 'workspaces', '~/my-workspaces'])
    await s.run(['config', 'set', 'backend', 'headless'])
    const r = await s.run(['run', '-w', '--json', 'Where am I'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.job.backend, 'headless')
    assert.ok(r.json.job.cwd.startsWith(join(s.userHome, 'my-workspaces') + (process.platform === 'win32' ? '\\' : '/')), r.json.job.cwd)

    // backend web is honoured too: the UI is not there, so starting fails as an environment error.
    await s.run(['config', 'set', 'backend', 'web'])
    const web = await s.run(['run', '--json', 'x'])
    assert.equal(web.code, 5)
    assert.equal(web.json.code, 5)
    // ... unless the command line says otherwise.
    assert.equal((await s.run(['run', '-b', 'headless', '-w', '--json', 'x'])).code, 0)
  }))

  // ------------------------------------------------------- workspaces ----

  test('ws init creates the folder, the marker and an AGENTS.md describing it', withRenameRace(async (s) => {
    const dir = join(s.ws, 'deep', 'new')
    const r = await s.run(['ws', 'init', dir, '--kind', 'research', '--description', 'Battery market 2026', '--json'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json, { ok: true, workspace: dir, agentsMd: join(dir, 'AGENTS.md') })
    assert.equal(JSON.parse(readFileSync(join(dir, '.dsho-workspace'), 'utf8')).kind, 'research')
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.match(agents, /Kind: research/)
    assert.match(agents, /Battery market 2026/)
    assert.equal((await s.run(['ws'])).code, 2)
    assert.equal((await s.run(['ws', '--help'])).code, 0)
  }))

  test('a job started below a workspace does not turn its subfolder into another workspace', withRenameRace(async (s) => {
    const root = join(s.ws, 'project')
    await s.run(['ws', 'init', root])
    const r = await s.run(['run', '-C', join(root, 'sub', 'task'), '-w', '--json', 'Nested'])
    assert.equal(r.code, 0, r.err)
    assert.ok(!existsSync(join(root, 'sub', 'task', '.dsho-workspace')))
    assert.ok(!existsSync(join(root, 'sub', 'task', 'AGENTS.md')))
  }))

  test('issue #2: ws init keeps an existing AGENTS.md', { todo: 'issue #2' }, withRenameRace(async (s) => {
    const dir = join(s.ws, 'mine')
    mkdirSync(dir)
    writeFileSync(join(dir, 'AGENTS.md'), '# My own instructions\n')
    await s.run(['ws', 'init', dir, '--json'])
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# My own instructions\n')
  }))

  // ------------------------------------------------------ agent skill ----

  test('skill install puts the skill into ~/.agents/skills and links the agents that are installed', withRenameRace(async (s) => {
    mkdirSync(join(s.userHome, '.claude'))
    mkdirSync(join(s.userHome, '.codex'))
    const canonical = join(s.userHome, '.agents', 'skills', 'dsh-orchestration')
    const r = await s.run(['skill', 'install', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.canonical, canonical)
    assert.deepEqual(r.json.rows.map((row) => [row.agent, row.action, row.path]), [
      ['agents (OpenCode, shared)', 'installed', canonical],
      ['claude', 'linked', join(s.userHome, '.claude', 'skills', 'dsh-orchestration')],
      ['codex', 'linked', join(s.userHome, '.codex', 'skills', 'dsh-orchestration')],
      ['pi', 'skipped (not installed)', join(s.userHome, '.pi', 'agent', 'skills')],
    ])
    assert.match(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), /^---\r?\nname: dsh-orchestration/)
    for (const agent of ['.claude', '.codex']) {
      const link = join(s.userHome, agent, 'skills', 'dsh-orchestration')
      assert.ok(lstatSync(link).isSymbolicLink())
      assert.match(readFileSync(join(link, 'SKILL.md'), 'utf8'), /name: dsh-orchestration/, 'the link resolves')
    }
    assert.ok(!existsSync(join(s.userHome, '.pi')), 'agents that are not installed get no folder')

    // Installing again refreshes in place; --copy with --agents replaces the link by a copy.
    assert.equal((await s.run(['skill', 'install', '--json'])).code, 0)
    const copy = await s.run(['skill', 'install', '--agents', 'claude', '--copy', '--json'])
    assert.deepEqual(copy.json.rows.map((row) => [row.agent, row.action]), [['agents (OpenCode, shared)', 'installed'], ['claude', 'copied']])
    const copied = join(s.userHome, '.claude', 'skills', 'dsh-orchestration')
    assert.ok(!lstatSync(copied).isSymbolicLink())
    assert.ok(existsSync(join(copied, 'SKILL.md')))
  }))

  test('skill install never replaces a skill of the same name that it did not install', withRenameRace(async (s, t) => {
    const foreign = join(s.userHome, '.codex', 'skills', 'dsh-orchestration')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'SKILL.md'), 'mine')
    const r = await s.run(['skill', 'install', '--json'])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(r.json.rows.find((row) => row.agent === 'codex').action, 'skipped (a different skill with this name exists)')
    assert.equal(readFileSync(join(foreign, 'SKILL.md'), 'utf8'), 'mine')

    // The same in the shared folder is an error: there is nothing left to install.
    const other = sandbox(t)
    const canonical = join(other.userHome, '.agents', 'skills', 'dsh-orchestration')
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(canonical, 'SKILL.md'), 'mine')
    const refused = await other.run(['skill', 'install', '--json'])
    assert.equal(refused.code, 1)
    assert.equal(refused.json.ok, false)
    assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), 'mine')
  }))

  test('skill install honours CLAUDE_CONFIG_DIR and CODEX_HOME', withRenameRace(async (s) => {
    const claude = join(s.root, 'elsewhere', 'claude')
    mkdirSync(claude, { recursive: true })
    Object.assign(s.env, { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(s.root, 'elsewhere', 'codex') })
    const r = await s.run(['skill', 'install', '--json'])
    assert.deepEqual(r.json.rows.slice(1).map((row) => [row.agent, row.action]), [['claude', 'linked'], ['codex', 'skipped (not installed)'], ['pi', 'skipped (not installed)']])
    assert.ok(existsSync(join(claude, 'skills', 'dsh-orchestration', 'SKILL.md')))
  }))
})
