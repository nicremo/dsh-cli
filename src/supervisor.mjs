// Runs a batch: a fixed pool of workers pulls queued jobs until none are left.
import { existsSync, writeFileSync } from 'node:fs'
import { batchCancelMarker, cancelJob, cancelMarker, runJob } from './runner.mjs'
import { readBatch, readJobRaw, TERMINAL, updateBatch, updateJob } from './store.mjs'
import { DshoError, nowIso, sleep } from './util.mjs'

export { batchCancelMarker }

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
      // A cancelled batch (dsho cancel, or SIGTERM to this supervisor) starts nothing new:
      // runJob sees the job's marker and records `cancelled` right away.
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
  // Count before marking: the supervisor may record `cancelled` for queued jobs meanwhile.
  const open = batch.jobs.filter((jid) => !TERMINAL.has(readJobRaw(jid)?.status))
  writeFileSync(batchCancelMarker(id), nowIso())
  for (const jid of open) cancelJob(jid)
  return open.length
}
