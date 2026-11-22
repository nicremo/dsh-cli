import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractEntries, extractRows, LLM_ENTRIES, mcpFilter, renderPatch } from '../src/profile.mjs'

const MCP = "'@deepseek-ai/dsh-mcp-client'"
const WEB_PATCH = `# fixture with fake values only
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('sessions.db')
- insert:
    - id: mcp-supabase
      name: ${MCP}
      config:
        serverName: supabase
        headers:
          Authorization: !!js "'Bearer ' + (process.env.SUPABASE_ACCESS_TOKEN ?? '')"
    - id: mcp-firecrawl
      name: ${MCP}
      config:
        serverName: firecrawl
        command: npx
        args: [-y, firecrawl-mcp]
        env:
          FIRECRAWL_API_KEY: test-not-a-real-key
    - id: mcp-brave-search
      name: ${MCP}
      config:
        serverName: brave-search
        env:
          BRAVE_API_KEY: test-not-a-real-key
    - id: some-other-plugin
      name: '@example/not-an-mcp-client'
      config:
        serverName: firecrawl
- insert:
    - id: mcp-state
      name: ${MCP}
      config:
        serverName: state
`

test('research filter copies only research MCP client rows', () => {
  const { rows } = extractRows(WEB_PATCH, mcpFilter('research'))
  assert.deepEqual(rows.map((r) => r.id), ['mcp-firecrawl', 'mcp-brave-search'])
  assert.equal(rows[0].config.env.FIRECRAWL_API_KEY, 'test-not-a-real-key')
})

test('all, none and explicit lists', () => {
  assert.equal(extractRows(WEB_PATCH, mcpFilter('all')).rows.length, 4)
  assert.equal(extractRows(WEB_PATCH, mcpFilter('none')).rows.length, 0)
  assert.deepEqual(extractRows(WEB_PATCH, mcpFilter('state,mcp-supabase')).rows.map((r) => r.id), ['mcp-supabase', 'mcp-state'])
})

test('renderPatch emits skill, instruction and insert rows that parse back', () => {
  const { rows, dump } = extractRows(WEB_PATCH, mcpFilter('research'))
  const text = renderPatch({ rows, dump, skillsDir: '/x/skills-orchestra', sourceProfile: 'web' })
  assert.match(text, /includeDefaultRoots: false/)
  assert.match(text, /- \/x\/skills-orchestra/)
  assert.match(text, /\.dsho-workspace/)
  assert.equal(extractRows(text, mcpFilter('all')).rows.length, 2)
  assert.doesNotMatch(renderPatch({ rows, dump, skillsDir: null, sourceProfile: 'web' }), /skill-filesystem/)
})

test('!!js scalars survive a copy unchanged', () => {
  const { rows, dump } = extractRows(WEB_PATCH, mcpFilter('mcp-supabase'))
  const text = dump([{ insert: rows }])
  assert.match(text, /!!js .*Bearer/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

const LLM_PATCH = `# fixture with fake values only
- id: ui-settings-general
  config:
    theme: dark
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        baseUrl: !!js "process.env.OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1'"
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: openrouter
    model: ~deepseek/deepseek-v4-flash-latest
`

test('extractEntries picks the model provider entries only', () => {
  assert.deepEqual(extractEntries(LLM_PATCH, LLM_ENTRIES).map((e) => e.id), ['llm-pi-ai', 'agent-default-model'])
  assert.deepEqual(extractEntries('[]', LLM_ENTRIES), [])
})

test('renderPatch carries copied model entries, !!js included', () => {
  const entries = extractEntries(LLM_PATCH, LLM_ENTRIES)
  const { rows, dump } = extractRows(WEB_PATCH, mcpFilter('research'))
  const text = renderPatch({ rows, dump, skillsDir: null, sourceProfile: 'web', entries })
  assert.match(text, /model provider settings \(llm-pi-ai, agent-default-model\)/)
  assert.match(text, /provider: openrouter/)
  assert.match(text, /!!js .*OPENROUTER_BASE/)
  assert.doesNotMatch(text, /\[object Object\]|src:/)
  assert.equal(extractEntries(text, LLM_ENTRIES).length, 2)
  assert.equal(extractRows(text, mcpFilter('all')).rows.length, 2)
})
