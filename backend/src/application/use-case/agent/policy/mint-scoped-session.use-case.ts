import { ApplicationHttpError } from '../../../../core/errors.js';
import { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../domain/agent/model/scoped-session-status.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import type { MintScopedSessionDto } from '../../../dto/agent/policy.dto.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A · POST /policy/scoped-session.
 *
 * Persists the broker keystore's policy snapshot to the
 * `agent_scoped_sessions` mirror table so:
 *  - the dashboard banner (Commit 2.C) can render "Scoped session
 *    active";
 *  - the MCP server's auto-sync (Commit 2.B) can install the snapshot
 *    into a freshly-restarted broker keystore over IPC;
 *  - forensic queries can reconstruct what cap was in force at any
 *    given tx hash.
 *
 * **Pre-conditions enforced here (operator-confirmed 2026-05-22)**:
 *  1. User MUST be at `tier === 'scoped'` for `surface`. The tier
 *     transition's confirmation token is the consent gate; this
 *     endpoint inherits that consent transitively (no per-mint token
 *     required in Slice 1). Mismatch → 412 Precondition Failed.
 *  2. No existing ACTIVE row for `(userId, surface)`. Operator must
 *     explicitly DELETE the existing session first so accidental
 *     re-mint doesn't leave the broker keystore pointing at a stale
 *     snapshot during the gap. Mismatch → 409 Conflict with the
 *     existing `sessionId` so the dashboard can prompt for revoke.
 *  3. The Zod schema (`MintScopedSessionDtoSchema`) is the wire-shape
 *     gate: hex regexes, uint256 bounds, paired-nullness on selectorCap
 *     index/amount, non-empty target/cap arrays. This layer's only
 *     value-side concern is lowercasing 0x-hex (the broker compares
 *     case-insensitively, but storing case-stable keeps any future
 *     equality checks correct) — it does NOT re-validate the broker's
 *     target-allowlist semantic. The broker enforces target + selector
 *     match at sign time per `packages/mcp/src/broker/policy-snapshot.ts::
 *     checkPolicy`. Slice 4 wildcard adds a known-selectors allowlist
 *     here when multi-selector sessions ship.
 *
 * **Audit emission deferred to Commit 2.B**. This commit lands only the
 * REST/storage surface — emission from here will compose
 * `AppendAuditEventUseCase` with `eventType:
 * AuditEventType.ScopedSessionMinted` + metadata payload referencing
 * `consent_action_hash` for the forensic chain.
 */
export interface MintScopedSessionInput {
  userId: string;
  dto: MintScopedSessionDto;
  /** Optional clock override for tests. Defaults to real `Date.now()`. */
  now?: Date;
}

export interface MintScopedSessionResult {
  session: ScopedSession;
}

export class MintScopedSessionConflictError extends ApplicationHttpError {
  constructor(
    public readonly existingSessionId: string,
    public readonly surface: Surface,
  ) {
    super(
      409,
      `active scoped session already exists for surface=${surface}`,
      { existingSessionId, surface },
    );
    this.name = 'MintScopedSessionConflictError';
  }
}

export class MintScopedSessionUseCase {
  constructor(
    private readonly stateRepo: IAgentStateRepository,
    private readonly scopedRepo: IScopedSessionRepository,
  ) {}

  async execute(input: MintScopedSessionInput): Promise<MintScopedSessionResult> {
    const now = input.now ?? new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const surface = input.dto.surface;

    // 1. Tier gate — user must currently be at 'scoped' on this surface.
    //    `requestUserTierChange` already gate-keeps the climb to Scoped
    //    (PolicyBound + 5 confirms + risk Q); we re-check here so a
    //    direct-API caller can't post a snapshot before the tier
    //    transition committed.
    const state = await this.stateRepo.findByUserAndSurface(input.userId, surface);
    if (!state || state.tier !== Tier.Scoped) {
      throw new ApplicationHttpError(
        412,
        `cannot mint scoped session: surface=${surface} tier is ${state?.tier ?? 'unset'}, expected 'scoped'`,
      );
    }

    // 2. Active-dedup. A user wanting to rotate a session must DELETE
    //    the old row first (operator-confirmed Slice 2 design). The DB
    //    PK on sessionId also catches a same-id retry, but a different
    //    sessionId for the same (user, surface) would slip past PK
    //    without this guard.
    const existing = await this.scopedRepo.findLatestActive(input.userId, surface, nowSec);
    if (existing) {
      throw new MintScopedSessionConflictError(existing.sessionId, surface);
    }

    // 3. validUntilSec sanity — reject snapshots that mint already-expired.
    //    The Zod schema enforces `> 0`; this enforces `> now`.
    if (input.dto.snapshot.validUntilSec <= nowSec) {
      throw new ApplicationHttpError(
        422,
        `snapshot.validUntilSec ${input.dto.snapshot.validUntilSec} is not in the future (now=${nowSec})`,
      );
    }

    // 4. mintedAtSec clock-skew check. Frontend's claimed mint time can
    //    drift from server time by NTP skew; allow ±5 min. Tighter
    //    bound (≤30s) is a Slice 4 wildcard gate; Slice 1 is permissive.
    const CLOCK_SKEW_TOLERANCE_SEC = 300;
    const skew = Math.abs(input.dto.snapshot.mintedAtSec - nowSec);
    if (skew > CLOCK_SKEW_TOLERANCE_SEC) {
      throw new ApplicationHttpError(
        422,
        `snapshot.mintedAtSec ${input.dto.snapshot.mintedAtSec} drifts ${skew}s from server now=${nowSec} (max ${CLOCK_SKEW_TOLERANCE_SEC}s)`,
      );
    }

    // 5. Build the domain entity. Lowercase all hex so storage is
    //    case-stable; downstream comparisons (broker.preflight signer
    //    match) are case-insensitive but a mixed-case row on disk
    //    breaks `===` checks in any future raw-SQL query.
    const session = new ScopedSession({
      sessionId: input.dto.snapshot.sessionId,
      userId: input.userId,
      surface,
      status: ScopedSessionStatus.Active,
      signerAddress: input.dto.snapshot.signerAddress.toLowerCase() as `0x${string}`,
      permissionId: input.dto.snapshot.permissionId
        ? (input.dto.snapshot.permissionId.toLowerCase() as `0x${string}`)
        : null,
      targetContracts: input.dto.snapshot.targetContracts.map(
        (a) => a.toLowerCase() as `0x${string}`,
      ),
      selectorCaps: input.dto.snapshot.selectorCaps.map((c) => ({
        selector: c.selector.toLowerCase() as `0x${string}`,
        capArgIndex: c.capArgIndex,
        maxAmount: c.maxAmount,
      })),
      maxPerOpUsd6: BigInt(input.dto.maxPerOpUsd6),
      totalSpentUsd6: 0n,
      validUntilSec: input.dto.snapshot.validUntilSec,
      mintedAtSec: input.dto.snapshot.mintedAtSec,
      consentActionHash: input.dto.snapshot.consentActionHash
        ? (input.dto.snapshot.consentActionHash.toLowerCase() as `0x${string}`)
        : null,
      consentTextSha256: input.dto.snapshot.consentTextSha256
        ? (input.dto.snapshot.consentTextSha256.toLowerCase() as `0x${string}`)
        : null,
      mintedAt: now,
      revokedAt: null,
      expiredAt: null,
    });

    await this.scopedRepo.create(session);
    // TODO(Commit 2.B): emit AuditEventType.ScopedSessionMinted via
    // AppendAuditEventUseCase here. Metadata payload: { sessionId,
    // signerAddress, maxPerOpUsd6, validUntilSec, consentActionHash }
    // — keeps the forensic chain {userop → tier transition → snapshot
    // mint → ConfirmToken} reconstructable by stable key (Security M-2).

    return { session };
  }
}
