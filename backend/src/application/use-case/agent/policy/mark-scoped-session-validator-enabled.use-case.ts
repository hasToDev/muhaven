import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import type { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

/**
 * Wave 5 Option D · Commit 3 — flip a scoped-session mirror row from
 * `enable_status='pending'` to `'enabled'` after on-chain
 * `PermissionInstalled(bytes4, uint32)` confirmation.
 *
 * Two callers race for this flip:
 *   1. **Chain indexer** — subscribes to `PermissionInstalled` events
 *      from kernel V3.1 contracts. AUTHORITATIVE source of truth.
 *   2. **Broker callback** — `POST .../validator-enabled` invoked by
 *      the broker daemon after the MCP server's MODE.ENABLE UserOp
 *      submits a receipt. Fast-path optimization — re-verifies the
 *      receipt via viem before reaching this use case.
 *
 * Idempotent: a second call after the first flip is a no-op (returns
 * the existing-enabled row).
 *
 * Audit emission: a successful flip emits one
 * `AuditEventType.ValidatorInstalled` row. The audit emit-after-flip
 * pattern matches `RevokeScopedSessionUseCase` and survives a partial
 * failure (DB commits the flip; orphan-mirror log fires when audit
 * write fails — operator triages out-of-band).
 *
 * **`source` metadata field** disambiguates the two callers for
 * forensic replay:
 *   - `'chain_indexer'` — block-poller observed the event.
 *   - `'broker_callback'` — MCP server's broker forwarded a receipt.
 */
export interface MarkScopedSessionValidatorEnabledInput {
  readonly sessionId: string;
  readonly txHash: `0x${string}`;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly source: 'chain_indexer' | 'broker_callback';
  /**
   * Wave 5 Option D Commit 3 (multi-agent review HIGH-2): when set,
   * the use-case re-checks that the row's stored `permissionId`
   * matches the value supplied by the caller. Defends against a
   * broker that POSTs `{sessionId: A, permissionId: B's}` with B's
   * receipt — the route-layer emitter cross-check catches the
   * `accountAddress`-vs-emitter mismatch, this catches the
   * `sessionId`-vs-`permissionId` mismatch.
   *
   * Optional because the chain indexer ALREADY matched on
   * `permissionId` via `findByPermissionIdAndAccountAddress` upstream;
   * a re-check would be redundant. The broker-callback route always
   * supplies it.
   */
  readonly expectedPermissionId?: `0x${string}`;
  readonly now?: Date;
}

export interface MarkScopedSessionValidatorEnabledResult {
  readonly session: ScopedSession;
  /** True when this call actually performed the flip; false when the
   *  row was already `enabled` (race winner already won). */
  readonly flipped: boolean;
}

const log = getLogger('MarkScopedSessionValidatorEnabled');

export class MarkScopedSessionValidatorEnabledUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(
    input: MarkScopedSessionValidatorEnabledInput,
  ): Promise<MarkScopedSessionValidatorEnabledResult> {
    const now = input.now ?? new Date();
    const before = await this.scopedRepo.findById(input.sessionId);
    if (!before) {
      throw new ApplicationHttpError(
        404,
        'scoped session not found',
        'scoped_session_not_found',
      );
    }
    if (before.enableStatus === 'enabled') {
      // Already-enabled race winner. Return the existing row + emit no
      // audit (the winner already did). `flipped=false` lets the caller
      // signal 200 vs 409 distinction (we return 200 with a flag, the
      // route maps to its preferred HTTP code).
      return { session: before, flipped: false };
    }
    if (before.enableStatus === 'failed') {
      // The watchdog flipped this row to `failed` before the receipt
      // arrived. Refuse the flip — operator triages out-of-band.
      throw new ApplicationHttpError(
        409,
        'session enable_status is already failed; receipt arrived after the watchdog window',
        'enable_already_failed',
      );
    }
    if (before.enableStatus !== 'pending') {
      // null = pre-C2 row, no install material was captured. Should
      // never receive a callback for these — defensive 404 over the
      // ambiguous 422.
      throw new ApplicationHttpError(
        404,
        'scoped session has no install material',
        'no_install_material',
      );
    }
    // Wave 5 Option D Commit 3 (multi-agent review HIGH-2) — when the
    // caller supplied an expected permissionId, cross-check it
    // against the row's stored value. Mismatch points at a confused
    // broker / replayed callback / cross-session-id substitution.
    // The check is one-shot; no audit emission (the use-case errors
    // out before the flip).
    if (
      input.expectedPermissionId &&
      before.permissionId &&
      before.permissionId.toLowerCase() !== input.expectedPermissionId.toLowerCase()
    ) {
      throw new ApplicationHttpError(
        422,
        `sessionId ${input.sessionId} carries permissionId ${before.permissionId} but callback supplied ${input.expectedPermissionId}`,
        'permission_id_mismatch',
      );
    }

    const flipped = await this.scopedRepo.markValidatorEnabled(
      input.sessionId,
      input.txHash,
      now,
    );
    if (!flipped) {
      // The pre-check said `pending` but the UPDATE matched 0 rows —
      // another writer flipped between our read and write. Re-read,
      // surface as already-enabled when it's `enabled`, else 409.
      const after = await this.scopedRepo.findById(input.sessionId);
      if (after?.enableStatus === 'enabled') {
        return { session: after, flipped: false };
      }
      throw new ApplicationHttpError(
        409,
        'concurrent enable_status flip; row not in pending state',
        'enable_status_race',
      );
    }

    // Audit emission. Match the RevokeScopedSession orphan-recovery
    // posture: log + carry on if the audit insert fails. The DB row is
    // the source of truth; the audit row is a forensic anchor.
    if (flipped.userId) {
      try {
        await this.appendAudit.execute({
          userId: flipped.userId,
          surface: flipped.surface,
          eventType: AuditEventType.ValidatorInstalled,
          metadata: {
            sessionId: flipped.sessionId,
            permissionId: flipped.permissionId,
            txHash: input.txHash.toLowerCase(),
            blockNumber: input.blockNumber,
            logIndex: input.logIndex,
            source: input.source,
            signerAddressPrefix: flipped.signerAddress.slice(0, 10),
          },
          now,
        });
      } catch (err) {
        log.error(
          {
            err,
            sessionId: flipped.sessionId,
            permissionId: flipped.permissionId,
            orphanMirrorRow: true,
          },
          'ValidatorInstalled audit emission failed — mirror row flipped, audit missing',
        );
      }
    } else {
      // Orphaned row (FK SET NULL after user deletion). Persist the
      // flip, log + skip audit. Mirrors the revoke-orphan posture.
      log.warn(
        {
          sessionId: flipped.sessionId,
          orphanMirrorRow: true,
        },
        'ValidatorInstalled flip on orphaned session row — audit skipped',
      );
    }

    return { session: flipped, flipped: true };
  }
}
