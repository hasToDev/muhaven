/**
 * Wave 5 Slice 2c — pidfile helpers for the `muhaven-reinvest` runner.
 *
 * The runner is NOT an IPC server (unlike the broker daemon, which
 * advertises its pid via `hello.pid`), so a pidfile is how `muhaven-reinvest
 * stop` AND the broker's `stop` reach it to SIGTERM. Written on boot,
 * removed on clean exit. Best-effort throughout — a stale pidfile after a
 * hard kill is handled by the reader (ESRCH ⇒ "already gone").
 */

import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { platform } from 'node:os';

/** Write `pid` to `path` (0600, parent 0700 on POSIX). */
export async function writeReinvestPid(path: string, pid: number): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (platform() !== 'win32') {
    try {
      await chmod(parent, 0o700);
    } catch {
      /* best-effort */
    }
  }
  await writeFile(path, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
  if (platform() !== 'win32') {
    try {
      await chmod(path, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

/** Read the pid from `path`, or null when absent / unreadable / malformed. */
export async function readReinvestPid(path: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/** Remove the pidfile. Best-effort (ENOENT swallowed). */
export async function clearReinvestPid(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Leave it — a stale pidfile is handled by the reader's ESRCH path.
    }
  }
}
