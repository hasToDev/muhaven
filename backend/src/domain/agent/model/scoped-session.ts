import type { Surface } from './surface.enum.js';
import { ScopedSessionStatus } from './scoped-session-status.enum.js';

/**
 * Per-selector enforcement rule. Mirrors `PolicySelectorCap` in
 * `packages/mcp/src/broker/protocol.ts` (Wave 5 Path D Slice 1
 * Commit 2.A). Storage of the broker's wire shape, no transformation.
 *
 * `capArgIndex: null` ⇔ `maxAmount: null` ⇔ "selector allowed, no
 * arg-cap enforced." Both fields non-null carries the cap. `maxAmount`
 * is a uint256 decimal string in the SELECTOR's on-chain unit (shares
 * for `subscription.purchase`, NOT mhUSDC base-6 — distinct from
 * `maxPerOpUsd6` on the parent snapshot).
 */
export interface ScopedSelectorCap {
  readonly selector: `0x${string}`;
  readonly capArgIndex: number | null;
  readonly maxAmount: string | null;
}

/**
 * Backend mirror of the broker's per-session policy snapshot (Wave 5
 * Path D Slice 2 Commit 2.A · RD-3).
 *
 * AUTHORITATIVE source = broker keystore (`~/.muhaven/policy-snapshots/<id>.json`).
 * This mirror is READ-ONLY w/r/t enforcement decisions; the broker
 * daemon never reads from here. Three users of the mirror:
 *   1. Dashboard `ActiveSessionBanner.vue` (Commit 2.C) reads the
 *      latest active row for "Scoped session active — N actions, $X
 *      spent, expires in X."
 *   2. MCP server (Commit 2.B) reads the latest active row to
 *      `broker.storePolicySnapshot` over IPC on a freshly-restarted
 *      broker — the snapshot transport mechanism the Slice 1
 *      pre-commit recon surfaced.
 *   3. Forensic / audit-replay queries: "what cap was in force when
 *      tx X mined?" via `valid_until_sec` + `total_spent_usd6` deltas.
 *
 * **`mintedAt` vs `mintedAtSec`**: `mintedAt` = DB receipt time (server
 * clock). `mintedAtSec` = the snapshot's own wire timestamp (epoch seconds
 * frontend stamped at mint). The two can drift by clock skew. Slice 4
 * wildcard enforces ≤30s delta as a freshness gate; Slice 1 only stores.
 */
export interface ScopedSessionProps {
  sessionId: string;
  /**
   * The kernel-account id of the user who minted this session. Nullable
   * because the FK has `onDelete: 'set null'` — if the user is ever
   * deleted (GDPR-style), the row survives for audit-replay but loses
   * the user binding. Use-case writes always provide a non-null value
   * (from JWT subject); only reads of already-orphaned rows may return
   * null. `findLatestActive` filters by exact equality so null-userId
   * rows are excluded from active-session lookups (correct semantics —
   * a deleted user can't have an active scope).
   */
  userId: string | null;
  surface: Surface;
  status: ScopedSessionStatus;
  signerAddress: `0x${string}`;
  /** Null until Pickup B's frontend wires `getPermissionId()`. */
  permissionId: `0x${string}` | null;
  targetContracts: readonly `0x${string}`[];
  selectorCaps: readonly ScopedSelectorCap[];
  maxPerOpUsd6: bigint;
  totalSpentUsd6: bigint;
  validUntilSec: number;
  mintedAtSec: number;
  consentActionHash: `0x${string}` | null;
  consentTextSha256: `0x${string}` | null;
  mintedAt: Date;
  revokedAt: Date | null;
  expiredAt: Date | null;
}

export class ScopedSession {
  readonly sessionId: string;
  readonly userId: string | null;
  readonly surface: Surface;
  readonly status: ScopedSessionStatus;
  readonly signerAddress: `0x${string}`;
  readonly permissionId: `0x${string}` | null;
  readonly targetContracts: readonly `0x${string}`[];
  readonly selectorCaps: readonly ScopedSelectorCap[];
  readonly maxPerOpUsd6: bigint;
  readonly totalSpentUsd6: bigint;
  readonly validUntilSec: number;
  readonly mintedAtSec: number;
  readonly consentActionHash: `0x${string}` | null;
  readonly consentTextSha256: `0x${string}` | null;
  readonly mintedAt: Date;
  readonly revokedAt: Date | null;
  readonly expiredAt: Date | null;

  constructor(props: ScopedSessionProps) {
    this.sessionId = props.sessionId;
    this.userId = props.userId;
    this.surface = props.surface;
    this.status = props.status;
    this.signerAddress = props.signerAddress;
    this.permissionId = props.permissionId;
    this.targetContracts = props.targetContracts;
    this.selectorCaps = props.selectorCaps;
    this.maxPerOpUsd6 = props.maxPerOpUsd6;
    this.totalSpentUsd6 = props.totalSpentUsd6;
    this.validUntilSec = props.validUntilSec;
    this.mintedAtSec = props.mintedAtSec;
    this.consentActionHash = props.consentActionHash;
    this.consentTextSha256 = props.consentTextSha256;
    this.mintedAt = props.mintedAt;
    this.revokedAt = props.revokedAt;
    this.expiredAt = props.expiredAt;
  }

  with(patch: Partial<ScopedSessionProps>): ScopedSession {
    return new ScopedSession({ ...this, ...patch });
  }

  /**
   * Pure predicate. The repository's `findLatestActive` already filters
   * on `status='active'` + `valid_until_sec > now_sec`, but use-cases
   * that received a row out-of-band (e.g. by sessionId lookup) call
   * this to re-check before treating the row as usable.
   *
   * `nowSec` is the caller's reference clock (epoch seconds). Use-cases
   * pass `Math.floor(Date.now() / 1000)` for live queries; tests inject
   * deterministic clocks.
   */
  isActive(nowSec: number): boolean {
    if (this.status !== ScopedSessionStatus.Active) return false;
    if (this.validUntilSec <= nowSec) return false;
    return true;
  }
}
