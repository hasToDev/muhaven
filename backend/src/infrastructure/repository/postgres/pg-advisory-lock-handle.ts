/**
 * Wave 5 Q3 (step 4 / plan A.2 + B.1) — Postgres-backed advisory-lock
 * handle for the daily yield cron. Real implementation of the
 * `AdvisoryLockHandle` injection surface defined by
 * `yield-epoch-runner.ts`; the runner's v3.1 A3 contract is that the
 * CALLER acquires the lock, the runner releases it in `finally`.
 *
 * Lifecycle / correctness invariants (all load-bearing):
 *
 *   1. **Same-connection contract.** Postgres' session-scoped advisory
 *      locks REQUIRE that `pg_try_advisory_lock(...)` and
 *      `pg_advisory_unlock(...)` execute on the same backend session
 *      (the same `PoolClient`). Reading drizzle's `db.execute(...)` is
 *      INSUFFICIENT — drizzle pulls a fresh client from the pool per
 *      call. This module bypasses drizzle and holds the `PoolClient`
 *      itself.
 *
 *   2. **Two-arg `hashtextextended`.** v3.1 S2: the single-arg
 *      `hashtext(text)` returns int4 (32-bit), creating a 0.0023%
 *      collision risk against sibling crons that share namespace
 *      hashes. The two-arg form returns bigint (64-bit) and lets us
 *      keep the namespace string explicit + readable in queries.
 *
 *   3. **Always return the client.** Whether acquire succeeds or fails,
 *      the `PoolClient` MUST go back to the pool. A leaked client
 *      drains the 25-slot pool one slot at a time until the next deploy
 *      restarts the container. The acquire helpers handle this in
 *      their own `try { ... } catch { client.release(); throw }` ladder.
 *
 *   4. **Idempotent release.** The runner calls `handle.release()` in
 *      a `finally` block; if the runner already explicitly released the
 *      handle (e.g. revoke retry path), the second call must no-op
 *      cleanly. Never-throws is the runner contract — a thrown
 *      `release()` in `finally` would shadow the original error.
 *
 *   5. **Unlock-failure does not leak.** If `pg_advisory_unlock` returns
 *      false (lock not held by this session — usually means the session
 *      crashed between acquire and release), the client still returns
 *      to the pool. Postgres reclaims the orphaned lock when the
 *      backend session terminates, so the leak is bounded by the
 *      client's idle timeout (`idleTimeoutMillis: 30_000` in db.ts).
 *
 *   6. **Single handle per acquire — never re-wrap.** Round-1 Backend
 *      Architect H-1 (2026-05-21). The idempotent `release()` guard
 *      is keyed on the `released` flag of THIS handle instance — it
 *      only protects against double-release of the SAME handle
 *      object. A future caller that constructs a SECOND handle from
 *      the same `(namespace, key)` after release #1 (e.g. by
 *      acquiring again, or by manually `new PgAdvisoryLockHandle(...)
 *      ` with the same fields) would have a fresh `released = false`
 *      flag and would attempt to unlock a session that no longer
 *      holds the lock — `pg_advisory_unlock` returns false, log
 *      noise but no correctness break. Still: pass the SAME handle
 *      object through every layer (cron → runner) that needs to
 *      release it. The cron's belt-and-braces `finally { lock.
 *      release() }` and the runner's `finally { tokenLock.release() }`
 *      use the same object reference — that's the load-bearing
 *      property.
 *
 * @see backend/src/infrastructure/blockchain/yield-epoch-runner.ts
 */
import type { Pool, PoolClient } from 'pg';
import type { AdvisoryLockHandle } from '../../blockchain/yield-epoch-runner.js';
import { getLogger } from '../../../core/logger.js';

/** v3.1 A.2 namespace strings. Keep these constants stable —
 *  changing a namespace forks the lock keyspace and would let an
 *  in-flight tick double-fire against a fresh deploy until both
 *  containers restart. */
export const ADVISORY_LOCK_NAMESPACE = {
  /** Wraps the cron's `tick()` body. cron-vs-cron guard only;
   *  doesn't protect against the operator script (use the per-token
   *  namespace for that). */
  yieldCronTick: 'muhaven_cron',
  /** Per-token wrap around `runYieldEpoch`. Guards against cron-vs-
   *  manual-script double-fire on the same token (Security N5). */
  yieldTokenEpoch: 'muhaven_token_epoch',
} as const;

/** The single fixed key used with the tick-level namespace. The
 *  namespace + key pair is what `hashtextextended` hashes; we keep
 *  the key inline to make the intent obvious at call sites. */
export const YIELD_CRON_TICK_KEY = 'yield_cron_tick';

interface PgAdvisoryLockHandleOpts {
  client: PoolClient;
  namespace: string;
  key: string;
}

/**
 * The handle returned by `acquireAdvisoryLock` on success. Owns its
 * `PoolClient` until `release()` returns it to the pool. Construct
 * only via the acquire helpers in this module — direct instantiation
 * is exposed for unit tests with a mocked client.
 */
export class PgAdvisoryLockHandle implements AdvisoryLockHandle {
  private released = false;
  private readonly client: PoolClient;
  private readonly namespace: string;
  private readonly key: string;
  private readonly logger = getLogger('PgAdvisoryLockHandle');

  constructor(opts: PgAdvisoryLockHandleOpts) {
    this.client = opts.client;
    this.namespace = opts.namespace;
    this.key = opts.key;
  }

  /**
   * Release the advisory lock + return the `PoolClient` to the pool.
   * Idempotent: a second call after the first has run is a structured
   * no-op. Never throws — failures (network drop, session crash) are
   * logged but swallowed, since the runner calls this from `finally`
   * and a thrown release would shadow the real error.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      // Two-arg hashtextextended is what acquire called with — must
      // match exactly for the unlock to find the lock entry.
      const res = await this.client.query<{ pg_advisory_unlock: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1, $2)) AS pg_advisory_unlock',
        [this.namespace, this.key],
      );
      const unlocked = res.rows[0]?.pg_advisory_unlock ?? false;
      if (!unlocked) {
        // The Pg session lost the lock between acquire + release
        // (e.g. connection dropped, server restart). Postgres reclaims
        // orphaned locks when the backend session terminates, so the
        // leak is bounded — log for triage but proceed.
        this.logger.warn(
          { namespace: this.namespace, key: this.key },
          'pg_advisory_unlock returned false — lock was already released or session lost',
        );
      }
    } catch (err) {
      this.logger.error(
        { err, namespace: this.namespace, key: this.key },
        'pg_advisory_unlock threw — relying on session-end reclaim',
      );
    } finally {
      try {
        this.client.release();
      } catch (releaseErr) {
        // Releasing back to the pool should never throw; if it does,
        // the client is already in an undefined state and the pool's
        // own error handler will reap it.
        this.logger.error(
          { err: releaseErr, namespace: this.namespace, key: this.key },
          'PoolClient.release() threw — pool reaper will handle',
        );
      }
    }
  }
}

/**
 * Try to acquire a Postgres session-scoped advisory lock keyed by
 * `(namespace, key)`. Returns a handle on success (the caller MUST
 * eventually call `handle.release()`) or `null` when the lock is
 * already held by another session (caller proceeds with a skip
 * branch — never blocks).
 *
 * v3.1 S2 — uses the two-arg `hashtextextended(text, text) → bigint`
 * form. Postgres' single-arg `hashtext(text) → int4` namespace would
 * collide with sibling crons (0.0023% per pair) and the int4
 * keyspace has zero protection against deliberate-collision attacks.
 *
 * On any error during acquire, the `PoolClient` is released back to
 * the pool before the throw propagates — never leaks a slot.
 */
export async function acquireAdvisoryLock(
  pool: Pool,
  namespace: string,
  key: string,
): Promise<PgAdvisoryLockHandle | null> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS pg_try_advisory_lock',
      [namespace, key],
    );
    const acquired = res.rows[0]?.pg_try_advisory_lock ?? false;
    if (!acquired) {
      client.release();
      return null;
    }
    return new PgAdvisoryLockHandle({ client, namespace, key });
  } catch (err) {
    // Acquire failed (network, query rejected by db) — return the
    // client to the pool before re-throwing. Without this, repeated
    // acquire failures drain the pool one slot at a time.
    try {
      client.release();
    } catch {
      // Pool reaper handles secondary failures.
    }
    throw err;
  }
}

/**
 * Convenience wrapper around `acquireAdvisoryLock` for the per-token
 * lock. The runner's `tokenLock` injection is constructed via this
 * helper from the cron's per-token loop.
 *
 * Address is lowercased at the boundary per
 * `feedback_address_case_at_repo_boundary` — without it a future
 * caller passing a checksummed address would hash to a different
 * slot than the lower-cased writer, defeating the lock.
 */
export async function acquireTokenLock(
  pool: Pool,
  tokenAddress: string,
): Promise<PgAdvisoryLockHandle | null> {
  return acquireAdvisoryLock(
    pool,
    ADVISORY_LOCK_NAMESPACE.yieldTokenEpoch,
    tokenAddress.toLowerCase(),
  );
}

/**
 * Convenience wrapper for the cron tick-level lock (one key, no per-
 * tick variance). Acquired at the top of `tick()` and released at the
 * bottom; protects against cron-vs-cron re-entry only.
 */
export async function acquireTickLock(pool: Pool): Promise<PgAdvisoryLockHandle | null> {
  return acquireAdvisoryLock(
    pool,
    ADVISORY_LOCK_NAMESPACE.yieldCronTick,
    YIELD_CRON_TICK_KEY,
  );
}
