import type { ScopedSession } from '../../../../domain/agent/model/scoped-session.js';
import type { Surface } from '../../../../domain/agent/model/surface.enum.js';
import type { IScopedSessionRepository } from '../../../../domain/agent/repository/scoped-session.repository.js';
import { AuditEventType } from '../../../../domain/agent/model/audit-event-type.enum.js';
import type { AppendAuditEventUseCase } from './append-audit-event.use-case.js';
import { deriveAutonomousSellCaps } from './scoped-sell-caps.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.A · GET /policy/scoped-session?surface=mcp.
 *
 * Returns the most-recently-minted active snapshot for `(userId, surface)`,
 * or `null` if zero match. Repository's `findLatestActive` does the lookup.
 *
 * Wave 5 Slice 1 (MCP sell) — this use-case now also SERVES the autonomous
 * sell caps. Legacy (pre-Slice-1) sessions were minted with only the
 * `subscription.purchase` selectorCap; the on-chain CallPolicy envelope
 * (D-1) already authorizes redeem + queue submit/claim, so we derive those
 * OFF-CHAIN caps + the per-token queue targets on read (LOCKED #1) — letting
 * the MCP re-sync them into the broker WITHOUT a re-mint. The augmentation is
 * applied to the returned domain entity (NOT persisted: read stays read-only
 * on the session table). A one-time provenance audit per session records that
 * the sell caps are platform-derived, not freshly user-consented. NEW mints
 * already carry these caps natively (frontend `buildScopedMintBody`), so
 * `deriveAutonomousSellCaps` is a no-op (`changed: false`) for them.
 *
 * Used by three callers:
 *   - Dashboard banner (`ActiveSessionBanner.vue`, Commit 2.C).
 *   - MCP server auto-sync (Commit 2.B).
 *   - Forensic queries / Slice 1 smoke.
 */
export interface GetActiveScopedSessionInput {
  userId: string;
  surface: Surface;
  /** Optional clock override for tests. Defaults to real `Date.now()`. */
  now?: Date;
}

/**
 * Process-lifetime dedup for the one-time sell-caps provenance audit. Keyed
 * by sessionId. The GET endpoint is hit on every MCP buy/sell (the revoke
 * kill-switch re-read), so an un-deduped audit would flood the WORM log;
 * this fires the provenance row at most once per (process, session). It
 * resets on restart — acceptable for a provenance note (a few duplicate WORM
 * rows over the backend's lifetime, all recording the same true fact). NOT a
 * correctness gate: the augmentation itself is recomputed every read.
 */
const auditedSellCapDerivation = new Set<string>();

/**
 * Cap on the dedup Set so a long-lived process can't leak unbounded memory.
 * A `Set` preserves insertion order, so eviction is FIFO (drop the oldest
 * sessionId). Eviction only risks one extra (true) provenance row if an old
 * session is read again after eviction — harmless for a WORM note.
 */
const AUDIT_DEDUP_MAX = 10_000;

function rememberAudited(sessionId: string): void {
  if (auditedSellCapDerivation.size >= AUDIT_DEDUP_MAX) {
    const oldest = auditedSellCapDerivation.values().next().value;
    if (oldest !== undefined) auditedSellCapDerivation.delete(oldest);
  }
  auditedSellCapDerivation.add(sessionId);
}

export class GetActiveScopedSessionUseCase {
  constructor(
    private readonly scopedRepo: IScopedSessionRepository,
    /**
     * Wave 5 Slice 1 — every per-token RedemptionQueue address
     * (`Object.values` of the `REDEMPTION_QUEUE_BY_TOKEN_JSON` map). Empty →
     * only the redeem cap is derived; queued-sell autonomy is not granted
     * (degrades to Path-C deep-link). Defaults to `[]` so existing callers /
     * tests compile unchanged.
     */
    private readonly redemptionQueueAddresses: readonly string[] = [],
    /**
     * Wave 5 Slice 1 — optional audit sink for the one-time sell-caps
     * provenance row. Omitted in unit tests that only assert the served
     * shape; when undefined the derivation still applies, just unaudited.
     */
    private readonly appendAuditEvent?: AppendAuditEventUseCase,
    /**
     * Wave 5 Slice 2a — every YieldSnapshot proxy address
     * (`YIELD_SNAPSHOT_ADDRESSES_JSON` values ∪ `YIELD_SNAPSHOT_ADDRESS`).
     * Empty → no claim cap / snapshot target derived (autonomous claim
     * degrades to a Path-C deep-link). Defaults to `[]` so existing
     * callers / tests compile unchanged.
     */
    private readonly yieldSnapshotAddresses: readonly string[] = [],
  ) {}

  async execute(input: GetActiveScopedSessionInput): Promise<ScopedSession | null> {
    const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const session = await this.scopedRepo.findLatestActive(
      input.userId,
      input.surface,
      nowSec,
    );
    if (!session) return null;

    const derived = deriveAutonomousSellCaps(
      session,
      this.redemptionQueueAddresses,
      this.yieldSnapshotAddresses,
    );
    if (!derived.changed) return session;

    // One-time provenance audit (LOCKED #1 caveat). Best-effort: a failure
    // (e.g. pre-`db:push` enum mismatch) must NOT break the read — the
    // augmentation still serves. session.userId can be null on a
    // CASCADE-orphaned row; skip the audit then (no owner to attribute it to).
    if (
      this.appendAuditEvent &&
      session.userId &&
      !auditedSellCapDerivation.has(session.sessionId)
    ) {
      // Mark BEFORE the await so concurrent reads don't double-emit, AND keep
      // it marked even on failure: a persistently-failing audit sink (e.g.
      // pre-`db:push` enum mismatch) must NOT turn this one-time note into a
      // per-read INSERT flood on a hot session. We accept one missed
      // provenance row over that flood — the augmentation still serves, and
      // the row re-attempts after a process restart clears this Set
      // (BE Arch review 2026-05-25).
      rememberAudited(session.sessionId);
      try {
        await this.appendAuditEvent.execute({
          userId: session.userId,
          surface: session.surface,
          eventType: AuditEventType.ScopedSessionSellCapsDerived,
          metadata: {
            sessionId: session.sessionId,
            addedSelectors: derived.addedSelectors,
            provenance:
              'platform-derived from the pre-authorized on-chain Scoped CallPolicy envelope ' +
              '(redeem + queue submit/claim already authorized at mint via the D-1 broadening); ' +
              'NOT a fresh per-redeem user consent — the original mint consent text was buy-framed',
          },
        });
      } catch {
        // Audit is best-effort; never block the read on it. Intentionally do
        // NOT un-mark (see the rememberAudited comment above).
      }
    }

    return session.with({
      selectorCaps: derived.selectorCaps,
      targetContracts: derived.targetContracts,
    });
  }
}
