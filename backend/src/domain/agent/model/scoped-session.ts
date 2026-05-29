import type { Surface } from './surface.enum.js';
import { ScopedSessionStatus } from './scoped-session-status.enum.js';

/**
 * Wave 5 Option D · Commit 2 — PermissionValidator install lifecycle.
 * Mirrors `agent_scoped_session_enable_status` pgEnum. See schema.ts
 * for the per-state JSDoc.
 */
export type ScopedSessionEnableStatus = 'pending' | 'enabled' | 'failed';

export const SCOPED_SESSION_ENABLE_STATUSES: readonly ScopedSessionEnableStatus[] = [
  'pending',
  'enabled',
  'failed',
];

export function isScopedSessionEnableStatus(
  v: unknown,
): v is ScopedSessionEnableStatus {
  return (
    typeof v === 'string' &&
    (SCOPED_SESSION_ENABLE_STATUSES as readonly string[]).includes(v)
  );
}

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
  /**
   * Wave 5 Option D · Commit 2 — PermissionValidator install state.
   *
   *   - `null` for pre-C2 rows (no install material captured)
   *   - `'pending'` for C2+ rows; flips to `'enabled'` or `'failed'`
   *     in C3 by the chain indexer / broker callback / watchdog.
   *
   * Distinct from `status` (the mirror-row lifecycle). A row can be
   * `status='active' AND enableStatus='pending'` — the dominant state
   * between C2 mint and C3's MCP-side ENABLE-mode UserOp landing.
   *
   * Optional on the props (defaults to `null`) so pre-C2 call sites
   * (existing tests, the migration use-case) continue to compile
   * unchanged. The Pg repo's `toDomain` always populates a concrete
   * value (`null` or one of the enum values).
   */
  enableStatus?: ScopedSessionEnableStatus | null;
  /**
   * Wall-clock UTC when the `PermissionInstalled` event observed via
   * chain indexer or receipt log. Lockstep with `enableStatus ===
   * 'enabled'` (DB CHECK constraint).
   */
  validatorEnabledAt?: Date | null;
  /**
   * Transaction hash that carried the validator-install UserOp. Set
   * alongside `validatorEnabledAt`. Lowercased 0x-hex.
   */
  validatorEnabledTxHash?: `0x${string}` | null;
  /**
   * `getKernelV3Nonce(...)` value captured at mint time + embedded in
   * the enableSig typed data. Surfaced on the install-material subroute
   * for the C3 broker pre-check (compare to live on-chain nonce →
   * fallback `enable_sig_stale` on mismatch). NOT encrypted at rest.
   */
  validatorNonce?: number | null;
  /**
   * Wave 5 Slice 2 (auto-reinvest) — user opt-in for the headless
   * claim→buy reinvest loop. Default `false`: a Scoped session does NOT
   * auto-reinvest unless the user toggles it on (Autonomy page). The
   * `GET /agent/reinvest/should-run` gate refuses (shouldRun:false) when
   * this is false, so the broker loop never claims+buys without consent.
   * Optional on the props (defaults to `false`) so pre-Slice-2 call sites
   * compile unchanged; the Pg repo's `toDomain` always populates it.
   */
  reinvestEnabled?: boolean;
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
  readonly enableStatus: ScopedSessionEnableStatus | null;
  readonly validatorEnabledAt: Date | null;
  readonly validatorEnabledTxHash: `0x${string}` | null;
  readonly validatorNonce: number | null;
  readonly reinvestEnabled: boolean;

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
    this.enableStatus = props.enableStatus ?? null;
    this.validatorEnabledAt = props.validatorEnabledAt ?? null;
    this.validatorEnabledTxHash = props.validatorEnabledTxHash ?? null;
    this.validatorNonce = props.validatorNonce ?? null;
    this.reinvestEnabled = props.reinvestEnabled ?? false;
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

/**
 * Wave 5 Option D · Commit 2 — install material for the C3 MCP-side
 * MODE.ENABLE UserOp. Surfaced ONLY by the dedicated install-material
 * subroute (`GET /policy/scoped-session/:sessionId/install-material`)
 * which is gated on the `BROKER_CALLBACK_SERVICE_SECRET` shared secret
 * plus a `userId` query parameter the route re-checks against the row.
 *
 * The default scoped-session read paths (`findById`, `findLatestActive`,
 * `GET /policy/scoped-session`) explicitly EXCLUDE these fields — both
 * to avoid round-tripping the encrypted bytea blob through Drizzle's
 * default relational query API AND to enforce a least-exposure read
 * boundary. The repository's `findInstallMaterialById` method is the
 * sole reader path.
 *
 * `enableData` + `enableSig` are CLEARTEXT here — the read path applies
 * `pgp_sym_decrypt(...)` inside the SELECT before this object exists.
 * `validatorNonce` is not encrypted (public uint32 from `currentNonce`).
 */
export interface ScopedSessionInstallMaterial {
  readonly sessionId: string;
  readonly userId: string | null;
  readonly surface: Surface;
  readonly status: ScopedSessionStatus;
  readonly signerAddress: `0x${string}`;
  readonly permissionId: `0x${string}` | null;
  readonly enableStatus: ScopedSessionEnableStatus | null;
  readonly enableData: `0x${string}` | null;
  readonly enableSig: `0x${string}` | null;
  readonly validatorNonce: number | null;
  readonly validatorEnabledAt: Date | null;
  readonly validatorEnabledTxHash: `0x${string}` | null;
  readonly validUntilSec: number;
  readonly mintedAtSec: number;
}
