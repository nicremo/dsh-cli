// Runs a batch: a fixed pool of workers pulls queued jobs until none are left.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { batchDir } from './paths.mjs'
import { cancelJob, cancelMarker, runJob } from './runner.mjs'
import { readBatch, readJobRaw, updateBatch, updateJob } from './store.mjs'
import { DshoError, nowIso, sleep } from './util.mjs'

export const batchCancelMarker = (id) => join(batchDir(id), 'cancel')

export async function runBatch(id, { staggerMs = 400 } = {}) {
  const batch = readBatch(id)
  if (!batch) throw new DshoError(`Batch ${id} not found`, 3)
  updateBatch(id, { ownerPid: process.pid, startedAt: nowIso() })
  for (const jid of batch.jobs) {
    if (readJobRaw(jid)?.status === 'queued') updateJob(jid, { ownerPid: process.pid })
  }

  const queue = [...batch.jobs]
  const parallel = Math.max(1, Math.min(batch.parallel ?? 4, queue.length || 1))
  const worker = async (slot) => {
    // Stagger the first wave so parallel dsh boots do not race on npx caches.
    if (staggerMs) await sleep(slot * staggerMs)
    while (queue.length) {
      const jid = queue.shift()
      if (existsSync(batchCancelMarker(id)) && !existsSync(cancelMarker(jid))) writeFileSync(cancelMarker(jid), nowIso())
      try {
        await runJob(jid)
      } catch (err) {
        updateJob(jid, { status: 'failed', error: err.message, endedAt: nowIso() })
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, (_, slot) => worker(slot)))
  return updateBatch(id, { endedAt: nowIso() })
}

/** Cancel every unfinished job of a batch. */
export function cancelBatch(id) {
  const batch = readBatch(id)
  if (!batch) throw new DshoError(`Batch ${id} not found`, 3)
  writeFileSync(batchCancelMarker(id), nowIso())
  return batch.jobs.filter((jid) => cancelJob(jid)).length
}
