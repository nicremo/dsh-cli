// Persistent settings in ~/.dsho/config.json. Environment variables win over
// the file, so CI and one-off calls can still override everything.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { home } from './paths.mjs'
import { DshoError, readJson, writeJsonAtomic } from './util.mjs'

export const CONFIG_KEYS = {
  dshRepo: { env: 'DSHO_DSH_REPO', help: 'path to a dsh source checkout (wins over dshBin)' },
  dshBin: { env: 'DSHO_DSH_BIN', help: 'path to the dsh executable' },
  webUrl: { env: 'DSHO_WEB_URL', help: 'origin of the DSH web UI, e.g. http://127.0.0.1:3080' },
  backend: { env: 'DSHO_BACKEND', help: 'auto | web | headless' },
  workspaces: { env: 'DSHO_WORKSPACES', help: 'root folder for new workspaces (default ~/dsh-workspaces)' },
  python: { env: 'DSHO_PYTHON', help: 'python with playwright for dsho capture' },
}

const file = () => join(home(), 'config.json')
const expand = (v) => (typeof v === 'string' ? v.replace(/^~(?=$|\/)/, homedir()) : v)

export function readConfig() {
  return readJson(file(), {}) ?? {}
}

/** Effective value: environment first, then config.json. */
export function cfg(key) {
  const def = CONFIG_KEYS[key]
  return expand(process.env[def.env] || readConfig()[key] || null)
}

export function setConfig(key, value) {
  if (!CONFIG_KEYS[key]) throw new DshoError(`Unknown config key "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`, 2)
  const next = { ...readConfig() }
  if (value == null) delete next[key]
  else next[key] = value
  writeJsonAtomic(file(), next)
  return next
}
