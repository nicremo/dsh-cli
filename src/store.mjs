// Plain-JSON state for jobs and batches under DSHO_HOME. Every process reads
// and writes these files directly; there is no daemon.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { batchDir, batchesDir, jobDir, jobsDir } from './paths.mjs'
import { DshoError, newId, nowIso, pidAlive, readJson, writeJsonAtomic } from './util.mjs'

export const TERMINAL = new Set(['done', 'failed', 'cancelled', 'timeout', 'lost'])
export const ACTIVE = new Set(['queued', 'running'])

const jobFile = (id) => join(jobDir(id), 'job.json')
const batchFile = (id) => join(batchDir(id), 'batch.json')

/** A queued or running job whose owner process vanished is reported as lost. */
function withDerivedStatus(job) {
  if (job && ACTIVE.has(job.status) && job.ownerPid && !pidAlive(job.ownerPid)) {
    return { ...job, status: 'lost', error: job.error ?? 'owner process exited before the job finished' }
  }
  return job
}

export function createJob(fields) {
  const id = newId('j')
  mkdirSync(jobDir(id), { recursive: true })
  const job = {
    id,
    name: null,
    batch: null,
    index: null,
    template: 'raw',
    prompt: '',
    cwd: process.cwd(),
    model: null,
    effort: null,
    timeoutSec: 1800,
    parent: null,
    status: 'queued',
    ownerPid: null,
    dshPid: null,
    sessionId: null,
    createdAt: nowIso(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    turnEnd: null,
    error: null,
    progress: { steps: 0, toolCalls: 0, lastTool: null, lastActivityAt: null },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    ...fields,
  }
  writeJsonAtomic(jobFile(id), job)
  return job
}

/** Raw job as stored, without lost detection. */
export function readJobRaw(id) {
  return readJson(jobFile(id), null)
}

export function readJob(id) {
  return withDerivedStatus(readJobRaw(id))
}

export function updateJob(id, patch) {
  const current = readJobRaw(id)
  if (!current) throw new DshoError(`Job ${id} not found`, 3)
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
  writeJsonAtomic(jobFile(id), next)
  return next
}

function listIds(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => !name.startsWith('.')).sort().reverse()
}

export function listJobs({ batch, limit, order } = {}) {
  let jobs = listIds(jobsDir()).map(readJob).filter(Boolean)
  if (batch) jobs = jobs.filter((j) => j.batch === batch)
  if (order === 'index') jobs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  else jobs.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id))
  return limit ? jobs.slice(0, limit) : jobs
}

export function createBatch(fields) {
  const id = newId('b')
  mkdirSync(batchDir(id), { recursive: true })
  const batch = {
    id,
    name: null,
    root: process.cwd(),
    parallel: 4,
    template: 'raw',
    jobs: [],
    ownerPid: null,
    createdAt: nowIso(),
    endedAt: null,
    ...fields,
  }
  writeJsonAtomic(batchFile(id), batch)
  return batch
}

export function readBatch(id) {
  return readJson(batchFile(id), null)
}

export function updateBatch(id, patch) {
  const current = readBatch(id)
  if (!current) throw new DshoError(`Batch ${id} not found`, 3)
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
  writeJsonAtomic(batchFile(id), next)
  return next
}

export function listBatches({ limit } = {}) {
  const batches = listIds(batchesDir()).map(readBatch).filter(Boolean)
  batches.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id))
  return limit ? batches.slice(0, limit) : batches
}

/** Count job states and fold them into one batch status. */
export function summarizeJobs(jobs) {
  const counts = {}
  for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1
  let status
  if ((counts.running ?? 0) + (counts.queued ?? 0) > 0) status = 'running'
  else if (jobs.length && (counts.done ?? 0) === jobs.length) status = 'done'
  else if (jobs.length && (counts.cancelled ?? 0) === jobs.length) status = 'cancelled'
  else if (!jobs.length) status = 'empty'
  else if (counts.done) status = 'partial'
  else status = 'failed'
  return { status, counts, total: jobs.length }
}

/**
 * Resolve a user reference to a job or batch: exact id, unique id prefix,
 * `last`, `last-batch`, batch name or job name (newest wins).
 */
export function resolveRef(ref) {
  if (!ref) throw new DshoError('Missing reference (job id, batch id, name, last or last-batch)', 2)
  const r = String(ref).replace(/^@/, '')
  const jobIds = listIds(jobsDir())
  const batchIds = listIds(batchesDir())
  if (r === 'last') {
    if (!jobIds.length) throw new DshoError('No jobs yet', 3)
    return { kind: 'job', id: jobIds[0] }
  }
  if (r === 'last-batch' || r === 'lastb') {
    if (!batchIds.length) throw new DshoError('No batches yet', 3)
    return { kind: 'batch', id: batchIds[0] }
  }
  if (jobIds.includes(r)) return { kind: 'job', id: r }
  if (batchIds.includes(r)) return { kind: 'batch', id: r }
  const prefixed = [
    ...jobIds.filter((id) => id.startsWith(r)).map((id) => ({ kind: 'job', id })),
    ...batchIds.filter((id) => id.startsWith(r)).map((id) => ({ kind: 'batch', id })),
  ]
  if (prefixed.length === 1) return prefixed[0]
  if (prefixed.length > 1) {
    throw new DshoError(`Reference "${ref}" is ambiguous: ${prefixed.slice(0, 5).map((p) => p.id).join(', ')}`, 2)
  }
  const batch = batchIds.map(readBatch).find((b) => b?.name === r)
  if (batch) return { kind: 'batch', id: batch.id }
  const job = jobIds.map(readJobRaw).find((j) => j?.name === r)
  if (job) return { kind: 'job', id: job.id }
  throw new DshoError(`Nothing found for "${ref}"`, 3, 'dsho ls lists jobs, dsho ls --batches lists batches')
}
