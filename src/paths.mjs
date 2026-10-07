// Filesystem locations. Every getter reads the environment lazily so tests
// and callers can redirect state with DSHO_HOME, DSH_HOME and DSHO_DSH_REPO.
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Name of the dsh profile that dsho manages and boots. */
export const PROFILE = 'orchestra'

export const home = () => process.env.DSHO_HOME || join(homedir(), '.dsho')
export const jobsDir = () => join(home(), 'jobs')
export const jobDir = (id) => join(jobsDir(), id)
export const batchesDir = () => join(home(), 'batches')
export const batchDir = (id) => join(batchesDir(), id)
export const logsDir = () => join(home(), 'logs')

export const dshRepo = () => process.env.DSHO_DSH_REPO || join(homedir(), 'deepseek-harness')
export const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
export const profileDir = (name = PROFILE) => join(dshHome(), 'profiles', name)
export const curatedSkillsDir = () => join(dshHome(), 'skills-orchestra')
export const agentsSkillsDir = () => join(process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'), 'skills')

/** Default root for workspaces created without an explicit -C. */
export const defaultWorkspaceRoot = () => process.env.DSHO_WORKSPACES || join(homedir(), 'dsh-workspaces')
