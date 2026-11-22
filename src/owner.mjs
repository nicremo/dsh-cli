// Is the process that owns a job (its runner or batch supervisor) still alive?
//
// A pid alone is not enough on Windows: it hands a dead process's pid to a new process
// within milliseconds, so `process.kill(pid, 0)` can vouch for a runner that is long gone.
// Each runner therefore holds an exclusive lock on ~/.dsho/owners/<pid>.lock for its
// whole life. Windows refuses any other open of that file while the runner lives and
// releases it the moment the process ends, however it ends.
import { closeSync, constants, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './paths.mjs'
import { pidAlive } from './util.mjs'

const IS_WINDOWS = process.platform === 'win32'
// libuv's exclusive-open flag; Node does not export it in fs.constants on every version.
const UV_FS_O_EXLOCK = constants.UV_FS_O_EXLOCK ?? 0x10000000

export const ownerLockPath = (pid) => join(home(), 'owners', `${pid}.lock`)

let held = null

/** Called by a runner at start: hold the lock that proves this process is alive (Windows). */
export function holdOwnerLock() {
  if (!IS_WINDOWS || held) return
  const path = ownerLockPath(process.pid)
  mkdirSync(join(home(), 'owners'), { recursive: true })
  try {
    held = { fd: openSync(path, constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK), path }
  } catch {
    return // Liveness then falls back to the pid.
  }
  process.on('exit', () => {
    try {
      closeSync(held.fd)
      unlinkSync(held.path)
    } catch {
      // Already gone.
    }
  })
}

/**
 * Remove a lock left behind by a crashed runner whose pid a new runner just received.
 * A lock that is held cannot be removed, so this never touches a live runner's lock.
 */
export function clearStaleOwnerLock(pid) {
  if (!IS_WINDOWS || !pid) return
  try {
    unlinkSync(ownerLockPath(pid))
  } catch {
    // Missing, or held by a live runner.
  }
}

/** True while the owner process lives. */
export function ownerAlive(pid) {
  if (!pidAlive(pid)) return false
  if (!IS_WINDOWS) return true
  let fd
  try {
    fd = openSync(ownerLockPath(pid), 'r')
  } catch {
    // No lock yet (the runner is still starting, or an older dsho): trust the pid.
    // Any other error means another process holds the lock: the owner lives.
    return true
  }
  closeSync(fd)
  // The lock file exists but nobody holds it: its runner is gone and the pid was reused.
  return false
}
