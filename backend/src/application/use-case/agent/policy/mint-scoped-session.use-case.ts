import { ApplicationHttpError } from '../../../../core/errors.js';
import { getLogger } from '../../../../core/logger.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import { ScopedSessionStatus } from '../../../../domain/agent/model/scoped-session-status.enum.js';
import { Tier } from '../../../../domain/agent/model/tier.enum.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IAgentStateRepository } from '../../../../domain/agent/repository/agent-state.repository.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import { isPgUniqueViolation } from '../../../../infrastructure/repository/postgres/pg-errors.js';
import type { MintScopedSessionDto } from '../../../dto/agent/policy.dto.js';
import type { AppendAuditEventUseCase } from './append-audit-event.use-case.js';

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
 * **Audit emission (Commit 2.B)**: composes `AppendAuditEventUseCase` with
 * `eventType: AuditEventType.ScopedSessionMinted`. Metadata carries the
 * **partial** forensic-chain anchors per Security M-2 (RD-3) —
 * `sessionId`, `signerAddress`, `maxPerOpUsd6`, `validUntilSec`,
 * `mintedAtSec`, and `consentActionHash` when the mint carried one.
 * NEVER store decrypted FHE values in `metadata` — only handles /
 * hashes / cleartext-by-design fields (`agent_audit_events.metadata`
 * schema JSDoc).
 *
 * **Forensic-chain partial state (CR-R2 H-2 + Compliance H-1)** —
 * READ THIS QUALIFIER FIRST before assuming WORM-alone reconstruction
 * works in prod TODAY:
 *   - The frontend Pickup A (Slice 1 PolicyTransitionPage) does NOT
 *     yet POST `consentActionHash` on the mint DTO (the field is
 *     `.optional()` in `MintScopedSessionDtoSchema`). So between 2.B
 *     ship and the frontend wire-up, every prod `ScopedSessionMinted`
 *     row's `metadata.consentActionHash` is ABSENT. Compliance audit
 *     queries that JOIN on stable key would find NO matches today.
 *   - **TODAY's adjacency-based chain**: forensic queries reconstruct
 *     `{ScopedSessionMinted → TierChanged → ConfirmTokenConsumed}` via
 *     `userId + surface + created_at` adjacency (the three rows land
 *     within a single use-case execution, microseconds apart). Lossy
 *     under concurrent mints but acceptable for Slice 2 traffic
 *     volume (one mint per user per day at most).
 *   - **TOMORROW's stable-key chain** (post-Pickup-A): WORM-alone
 *     reconstruction by stable key works — the matching
 *     `ConfirmTokenConsumed` and `TierChanged` audit rows already
 *     carry the same `actionHash` since 2.B
 *     (`transition-tier.use-case.ts:toChainAnchorHash`); the chain
 *     closes the moment the frontend Pickup A starts populating
 *     `consentActionHash` on the mint POST.
 *   - `consentTextSha256` is intentionally omitted today; Slice 4
 *     wildcard gate item #5 will graduate.
 *
 * The emission lives in the USE-CASE layer (not the REST handler) so
 * direct-domain callers (a future CLI, a cron job) also emit — a route-
 * layer-only emission would silently miss any non-HTTP entry point. The
 * audit row writes AFTER the mirror row commits; if the audit write
 * throws, the use-case re-throws (500) AND emits a structured
 * `orphanMirrorRow:true` log so the entry shows up in homelab grep
 * sweeps. Atomic ordering matters less here than the audit row
 * arriving SOON: the forensic chain reconstructs from the row pair,
 * not from join-time ordering.
 *
 * **Known deferred work (Compliance Auditor R2 H-2)**: orphan-mirror
 * detection has NO automated cron yet — STATUS.md Slice 3 pickup
 * tracks the reconciliation script + Telegram alert (LEFT JOIN
 * `agent_scoped_sessions` against `agent_audit_events` where
 * `metadata->>'sessionId'` doesn't pair). Until the cron lands, prod-
 * curl operators MUST monitor backend logs for `orphanMirrorRow:true`
 * entries AND scan the mirror table by hand on incident-response
 * cadence. The "no-prod-curl window" is closed for the success path
 * but the audit-throw path's compensating control is still
 * runbook-only.
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
    private readonly appendAudit: AppendAuditEventUseCase,
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

    // 2a. Opportunistic expiry sweep (Pickup A follow-up — bug #10 in
    //    PICKUP_A_OPEN_INVESTIGATIONS.md). The DB unique constraint
    //    `agent_scoped_sessions_user_surface_active_uq_v2` is partial on
    //    `status='active'` ONLY — it does NOT consider `valid_until_sec`.
    //    Without this sweep, the use-case's app-level dedup at step 2b
    //    correctly returns null for a time-expired row (its predicate
    //    filters `valid_until_sec > nowSec`), but the subsequent INSERT
    //    at step 5 hits the DB constraint → 23505. Result: a user whose
    //    last session expired by time but never had `status` transitioned
    //    to `expired` cannot re-mint a fresh session — they're stuck.
    //    Bit the operator tonight 2026-05-22 on the Pickup A re-smoke;
    //    the only recovery was a manual `UPDATE` on prod DB.
    //
    //    **Scope of this sweep is per-(user, surface)** via
    //    `markExpiredForUserSurface`. Uses the partial active-index
    //    `agent_scoped_sessions_user_surface_active_uq_v2` — at most
    //    one row in the active state per (user, surface), so the
    //    UPDATE locks ≤1 row per mint and there is no cross-user
    //    write contention with concurrent mints from OTHER users.
    //    R1 Code Reviewer MED-1 + Security Engineer MED-1 +
    //    R2 Software Architect H-2 round 2 — narrowed from the bulk
    //    variant which would have full-table-scanned the active-index
    //    on every mint. The bulk `markExpired` stays for the future
    //    expiry-sweep cron (Slice 5+) which sweeps cross-user on a
    //    schedule.
    //
    //    The DB-constraint catch at step 5 (see below) closes the race
    //    where two concurrent mints for the same (user, surface) both
    //    pass dedup but the loser hits 23505 — Security Engineer H-1
    //    round 1.
    await this.scopedRepo.markExpiredForUserSurface(input.userId, surface, nowSec, now);

    // 2b. Active-dedup. A user wanting to rotate a still-valid session
    //    must DELETE the old row first (operator-confirmed Slice 2
    //    design). The DB PK on sessionId also catches a same-id retry,
    //    but a different sessionId for the same (user, surface) would
    //    slip past PK without this guard. The 2a sweep above ensures
    //    "expired by time but status=active" rows don't false-positive
    //    this gate.
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

    // 5b. Race-safe create. The 2a sweep + 2b dedup are best-effort —
    //    two concurrent mints for the SAME (user, surface) where both
    //    pass dedup (because the previous row was just freshly expired
    //    by 2a in race A, and B's 2b reads after A's sweep but before
    //    A's create) would both attempt INSERT. The partial UNIQUE
    //    `agent_scoped_sessions_user_surface_active_uq_v2` rejects the
    //    loser with 23505. Without this catch the loser would surface as
    //    a generic 500 to the user; with it, the loser sees the same
    //    409 + existingSessionId payload the optimistic dedup gate
    //    emits. The DB constraint is the load-bearing gate; this catch
    //    just maps it to the user-friendly response shape.
    //    Security Engineer H-1 round 1.
    //
    //    R2 Software Architect H-1 + Backend Architect M-1 — use
    //    `isPgUniqueViolation` (walks `.code` / `.cause.code` /
    //    `.driverError.code`) instead of reading the top-level `.code`
    //    directly. Defends against a future Drizzle major-version bump
    //    that wraps pg errors in `DrizzleQueryError`.
    try {
      await this.scopedRepo.create(session);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        // Re-query to surface the actual existing row's sessionId. The
        // race winner's row landed between our dedup check and our
        // create, so a fresh lookup gets the authoritative answer.
        const winner = await this.scopedRepo.findLatestActive(input.userId, surface, nowSec);
        if (winner) {
          throw new MintScopedSessionConflictError(winner.sessionId, surface);
        }
      }
      throw err;
    }

    // Forensic-chain anchor — Security M-2 (RD-3). Stored as cleartext
    // structural fields + optional `consentActionHash`; no decrypted FHE
    // primitives. `maxPerOpUsd6` is serialized as string (bigint isn't
    // JSON-safe). `consentTextSha256` is intentionally omitted from the
    // audit metadata — today the chain only needs `consentActionHash`
    // to correlate the authorizing ConfirmTokenConsumed row.
    //
    // TODO(Slice 4 wildcard gate #5): graduate to include
    // `consentTextSha256` on every `ScopedSessionMinted` AND every
    // Scoped-bound `TierChanged` audit row, so a forensic query "prove
    // the user saw THIS text" reconstructs from the WORM audit chain
    // alone (without joining against the mirror table, which doesn't
    // carry the WORM property and could drift). Codified in
    // SecEng M-2 round 1 + Code Reviewer L-2 round 1.
    try {
      await this.appendAudit.execute({
        userId: input.userId,
        surface,
        eventType: AuditEventType.ScopedSessionMinted,
        metadata: {
          sessionId: session.sessionId,
          signerAddress: session.signerAddress,
          maxPerOpUsd6: session.maxPerOpUsd6.toString(),
          validUntilSec: session.validUntilSec,
          mintedAtSec: session.mintedAtSec,
          ...(session.consentActionHash
            ? { consentActionHash: session.consentActionHash }
            : {}),
        },
        now,
      });
    } catch (err) {
      // Structured log so the operator can grep `orphanMirrorRow:true`
      // even before the H-2 reconciliation cron lands (Compliance L-4
      // round 2). Re-throw — the use-case MUST surface the failure so
      // the REST handler returns 500 and the user/operator notices.
      getLogger('MintScopedSessionUseCase').error(
        {
          err,
          sessionId: session.sessionId,
          userId: input.userId,
          surface,
          orphanMirrorRow: true,
        },
        'audit emission failed AFTER mirror commit — mirror row is orphaned, reconcile manually',
      );
      throw err;
    }

    return { session };
  }
}
