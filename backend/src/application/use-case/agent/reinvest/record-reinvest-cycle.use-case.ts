import { ApplicationHttpError } from '../../../../core/errors.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IAgentAuditRepository } from '../../../../domain/agent/repository/agent-audit.repository.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { AppendAuditEventUseCase } from '../policy/append-audit-event.use-case.js';
import type {
  RecordReinvestCycleRequestDto,
  RecordReinvestCycleResponseDto,
} from '../../../dto/agent/reinvest.dto.js';

/**
 * Wave 5 Slice 2c (auto-reinvest runner) — record a completed reinvest
 * cycle as a WORM audit event.
 *
 * The keyless `muhaven-reinvest` runner calls this AFTER it atomically
 * claims a matured epoch and buys more of the same RWA in one
 * `executeBatch` UserOp. The append is gated by the SAME revoke
 * kill-switch as `MintEphemeralEoaUseCase` (a revoked session can't spam
 * the audit channel).
 *
 * **Dedup is BEST-EFFORT, not the durable guarantee.** A UserOp that is
 * slow to settle can be re-surfaced by the should-run gate before its
 * receipt lands; we suppress a duplicate `(user, epoch, token, snapshot)`
 * audit row by scanning recent rows. The DURABLE dedup is the on-chain
 * `hasClaimed` flag (a claimed epoch never re-surfaces in the gate) plus
 * the runner's in-process cooldown — this scan only protects the forensic
 * log against a re-surface inside the confirm window. The scan window is
 * bounded so the realistic row count stays under one page (the audit repo
 * returns ascending order; a pathological >`DEDUP_PAGE_LIMIT`-rows-in-
 * window burst would let a duplicate through, which is acceptable because
 * the on-chain flag — not this row — gates the spend).
 *
 * Amount-blind: the metadata is cleartext-by-design (epoch, token,
 * snapshot, userOpHash, txHash, buyShares, budgetUsd6). The CLAIMED amount
 * stays encrypted on-chain — no decrypted-FHE primitive enters this row.
 *
 * **Provenance:** these fields are BROKER-ASSERTED, not platform-verified.
 * The backend does not re-read the chain to confirm the userOp settled or
 * that `buyShares`/`budgetUsd6` match the on-chain call — it trusts the
 * authenticated runner's report (same trust level as the broker's
 * device-flow JWT). The authoritative economic record is the on-chain tx
 * (`userOpHash`/`txHash` are the cross-reference); this row is the forensic
 * narrative, not the source of truth. (Honest provenance, mirroring the
 * `scoped_session_sell_caps_derived` caveat.)
 */

const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

export interface RecordReinvestCycleInput extends RecordReinvestCycleRequestDto {
  /** JWT subject (kernel-account UUID) — keys the active-session gate +
   *  the audit row. Sourced from `authPayload.userId`, NOT the body. */
  readonly userId: string;
  /** Injectable clock. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Idempotency scan window. A re-surfaced slow-settling UserOp re-appears
 * within MINUTES (until the chain confirms + the gate's RPC read reflects
 * `hasClaimed`), so a 2h window covers the realistic re-surface horizon with
 * margin. The audit repo returns rows ASCENDING by `createdAt` AND caps a
 * page at `MAX_PAGE_SIZE` (200) — so for the recent match to be visible the
 * window must hold AT MOST one page of reinvest rows. In realistic operation
 * (poll cadence × claimable epochs across the user's tokens) a 2h window
 * stays far under 200, so all rows in the window are returned and the recent
 * duplicate is seen. `DEDUP_PAGE_LIMIT` is pinned at the repo cap (200) so
 * the value is HONEST (a higher number is silently clamped). Beyond
 * 200-rows-in-2h the dedup degrades to best-effort — the on-chain
 * `hasClaimed` flag is the authoritative dedup regardless (see the class
 * JSDoc); a duplicate audit row is a forensic blemish, never a double-spend.
 */
const DEDUP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const DEDUP_PAGE_LIMIT = 200;

export class RecordReinvestCycleUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    private readonly auditRepo: IAgentAuditRepository,
    private readonly appendAudit: AppendAuditEventUseCase,
  ) {}

  async execute(input: RecordReinvestCycleInput): Promise<RecordReinvestCycleResponseDto> {
    if (!ADDRESS_HEX.test(input.tokenAddress) || !ADDRESS_HEX.test(input.snapshotAddress)) {
      throw ApplicationHttpError.badRequest(
        'tokenAddress and snapshotAddress must be 0x-prefixed 20-byte hex addresses',
      );
    }

    const now = input.now ?? new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    // REVOKE KILL-SWITCH GATE (mirrors MintEphemeralEoaUseCase). The runner
    // only reaches here after a confirmed on-chain submit, but a session
    // revoked in the interim must not be able to append more audit rows.
    const activeSession = await this.scopedRepo.findLatestActive(
      input.userId,
      Surface.MCP,
      nowSec,
    );
    if (!activeSession) {
      throw new ApplicationHttpError(
        403,
        'no active Scoped session for this user — it was revoked or has expired; ' +
          'refusing to record a reinvest cycle for a dormant session',
      );
    }

    // Idempotency per (user, epoch): scan recent reinvest_cycle_executed
    // rows. A match on the same epoch + token + snapshot means this cycle
    // was already recorded (the gate re-surfaced a slow-settling UserOp).
    const tokenLower = input.tokenAddress.toLowerCase();
    const snapshotLower = input.snapshotAddress.toLowerCase();
    const since = new Date(now.getTime() - DEDUP_LOOKBACK_MS);
    const prior = await this.auditRepo.findByUserId(input.userId, {
      surface: Surface.MCP,
      eventTypes: [AuditEventType.ReinvestCycleExecuted],
      since,
      limit: DEDUP_PAGE_LIMIT,
    });
    const duplicate = prior.items.some((e) => {
      const m = e.metadata as Record<string, unknown> | null;
      if (!m) return false;
      return (
        String(m.epochId) === input.epochId &&
        String(m.token).toLowerCase() === tokenLower &&
        String(m.snapshot).toLowerCase() === snapshotLower
      );
    });
    if (duplicate) {
      return { recorded: false, reinvestCycleId: input.reinvestCycleId };
    }

    await this.appendAudit.execute({
      userId: input.userId,
      surface: Surface.MCP,
      eventType: AuditEventType.ReinvestCycleExecuted,
      metadata: {
        reinvestCycleId: input.reinvestCycleId,
        epochId: input.epochId,
        token: tokenLower,
        snapshot: snapshotLower,
        userOpHash: input.userOpHash.toLowerCase(),
        ...(input.txHash ? { txHash: input.txHash.toLowerCase() } : {}),
        buyShares: input.buyShares,
        budgetUsd6: input.budgetUsd6,
      },
      now,
    });

    return { recorded: true, reinvestCycleId: input.reinvestCycleId };
  }
}
