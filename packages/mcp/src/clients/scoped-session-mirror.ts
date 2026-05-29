/**
 * Wave 5 Slice 2c follow-up WS-A — shared scoped-session mirror primitives.
 *
 * The `ScopedSessionMirrorDto`/`Response` wire types, the structural-guard
 * regexes, the `MirrorDtoMalformedError`, and the `mirrorDtoToPolicySnapshot`
 * transform were originally PRIVATE to `tools/handlers.ts`. They were hoisted
 * here (same pattern as the `path-d-encoding.ts` hoist) so the standalone,
 * KEYLESS `muhaven-reinvest` runner (`src/reinvest/*`, a separate tsup entry)
 * can reuse them WITHOUT importing the full tool-handler surface — which would
 * pull the MCP SDK + zod tool registry into the keyless runner bundle and
 * collapse the Option-D separation between the egress-capable runner and the
 * key-holding broker.
 *
 * `handlers.ts` re-imports these (its private `syncSnapshotFromMirror` stays
 * there, calling `mirrorDtoToPolicySnapshot`); the runner adds its own focused
 * sync in `reinvest/execute.ts` over the same transform. Single source of
 * truth: a drift in the structural guards would let one path accept a poisoned
 * mirror row the other rejects.
 */

import type { PolicySnapshotWire } from '../broker/protocol.js';

/**
 * Wave 5 Path D Slice 2 Commit 2.B — narrow type for the
 * `GET /api/v1/agent/policy/scoped-session?surface=mcp` response. Carries
 * only the fields the MCP server reads (a strict subset of the backend's
 * `ScopedSessionDto`). Hand-pinned rather than imported to keep the MCP
 * package free of a backend-runtime dep + decouple from backend DTO
 * release cadence (the wire shape is locked by the REST contract; DTO
 * additions inside the backend bundle are transparent here as long as
 * the documented fields stay).
 */
export interface ScopedSessionMirrorDto {
  readonly sessionId: string;
  readonly mode: 'scoped';
  /**
   * Wave 5 Option D Commit 3 — userId is needed by the C3 install-
   * material subroute as a query parameter (defense-in-depth on the
   * ownership re-check). Optional on the wire for back-compat with
   * pre-C2 backends that didn't surface it. Null after the FK CASCADE
   * SET NULL (orphan row); the MCP refuses to install on orphans.
   */
  readonly userId?: string | null;
  /**
   * Defense-in-depth (AI Engineer MED-1 pre-Codex pass): the MCP
   * re-validates `status === 'active'` before installing the snapshot
   * into the broker keystore, mirroring the same defensive posture as
   * the `signerAddress` cross-check. The backend's `findLatestActive`
   * already filters by `status='active'`, but a future SQL refactor
   * regression that dropped the predicate would silently leak a
   * revoked row to the broker — the structural defense lives at the
   * MCP boundary because it's the only chokepoint that survives a
   * backend filter bug.
   */
  readonly status: 'active' | 'revoked' | 'expired';
  readonly signerAddress: string;
  readonly permissionId: string | null;
  readonly targetContracts: readonly string[];
  readonly selectorCaps: readonly {
    readonly selector: string;
    readonly capArgIndex: number | null;
    readonly maxAmount: string | null;
  }[];
  readonly validUntilSec: number;
  readonly mintedAtSec: number;
  readonly consentActionHash: string | null;
  readonly consentTextSha256: string | null;
  /**
   * Wave 5 Option D Commit 3 — `enable_status` mirror field. Carried
   * to drive the MCP-side MODE.ENABLE branching:
   *  - `'pending'` → fetch install-material from C2 subroute + MODE.ENABLE
   *  - `'enabled'` → MODE.DEFAULT (validator already installed)
   *  - `'failed'`  → fallback `validator_install_failed_re_walk_required`
   *  - `null`      → legacy pre-C2 row, behave as MODE.DEFAULT
   */
  readonly enableStatus?: 'pending' | 'enabled' | 'failed' | null;
  /**
   * Wave 5 Option D Commit 3 — `validator_nonce` mirror field. Stored
   * at mint time; used to gate the MODE.ENABLE pre-check (live
   * `currentNonce()` MUST still match). Optional on the wire for
   * pre-C2 row back-compat.
   */
  readonly validatorNonce?: number | null;
}

export interface ScopedSessionMirrorResponse {
  readonly session: ScopedSessionMirrorDto | null;
}

/**
 * Wave 5 Path D Slice 2 Commit 2.B — defensive hex shape guards. The
 * backend Zod schema enforces these regexes at mint time + the broker
 * daemon's `parsePolicySnapshot` re-validates on store; this layer
 * catches malformed mirror rows LOCALLY (before the broker IPC round-
 * trip) so a tampered backend response surfaces with a clear
 * pre-broker error message instead of forwarding the broker's
 * `invalid_request` string verbatim into the LLM context
 * (round-1 SecEng L-3).
 */
const MCP_HEX_20_BYTE_RE = /^0x[0-9a-fA-F]{40}$/;
const MCP_HEX_4_BYTE_RE = /^0x[0-9a-fA-F]{8}$/;
const MCP_HEX_32_BYTE_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Symmetric with broker daemon's `SESSION_ID_RE` at
 * `packages/mcp/src/broker/protocol.ts` (mirror copy — keeping them in
 * sync is verified by integration tests). MCP-side guard rejects
 * path-traversal-ish or control-char sessionIds before the IPC round-
 * trip so the broker never sees a malformed key — Reality Checker
 * LOW-4 pre-Codex.
 */
const MCP_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class MirrorDtoMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorDtoMalformedError';
  }
}

/**
 * Transform the backend mirror's `ScopedSessionDto` to the broker IPC's
 * `PolicySnapshotWire`. Pure; pulls forward only the fields the broker
 * cares about (mirror also carries DB-only state like `userId`,
 * `status`, `maxPerOpUsd6`, `totalSpentUsd6`, `mintedAt` ISO strings —
 * those are for the dashboard banner + audit-replay, NOT broker
 * enforcement). Optional fields with `null` on the wire become
 * `undefined`-omitted on the broker side (parser uses optional-field
 * presence as the carrier; presence-of-null would fail the
 * `isOptionalHash32` guard).
 *
 * Throws `MirrorDtoMalformedError` on:
 *   - HEX-SHAPE violation (signerAddress, targetContracts entries,
 *     selectorCaps[].selector, permissionId, consent*Hash) — caught
 *     LOCALLY so a poisoned backend response surfaces with a structural
 *     message instead of echoing arbitrary backend error text.
 *   - `mode` not literally `'scoped'` — a future wildcard mirror row
 *     would otherwise be silently rewritten as scoped on the wire and
 *     bounce at the broker with a confusing tampered-payload error
 *     (CR-R2 L-3).
 *
 * **What this guard does NOT validate** (and therefore bounces at the
 * broker daemon's `parsePolicySnapshot` with a `mirror_sync_failed
 * (broker.invalid_request)` surface — see `typedErrorCode`):
 * - `validUntilSec` / `mintedAtSec` numeric range (must be positive,
 *   safe-integer).
 * - `selectorCaps[].capArgIndex` integer range (0-31) and the paired
 *   nullness of `capArgIndex` ↔ `maxAmount`.
 * - `selectorCaps[].maxAmount` uint256 decimal-string range.
 * - `targetContracts` / `selectorCaps` element-count bounds (1..32).
 * The broker remains the structural gate; this layer just catches the
 * cheap hex-shape cases before the IPC round-trip (CR-R2 M-2).
 */
export function mirrorDtoToPolicySnapshot(
  dto: ScopedSessionMirrorDto,
): PolicySnapshotWire {
  // Runtime mode discriminator — the TS type pins literal `'scoped'`
  // but a regressed backend / future wildcard row would slip past
  // the type assertion. Slice 4 wildcard widens the union explicitly.
  if (dto.mode !== 'scoped') {
    throw new MirrorDtoMalformedError(
      `mode must be 'scoped' (got ${JSON.stringify(dto.mode)}); wildcard mirror auto-sync ships in Slice 4`,
    );
  }
  // Defense-in-depth on backend filter regression (AI Engineer MED-1
  // pre-Codex). Backend's `findLatestActive` filters by
  // `status='active'`, so today this branch can never fire. A future
  // SQL refactor that drops the predicate would silently install a
  // revoked / expired row into the broker keystore — catching it here
  // means a revoke that landed in the mirror table also blocks the
  // auto-sync, preserving the Compliance "revoke = consent window
  // closes" invariant even under a backend regression.
  if (dto.status !== 'active') {
    throw new MirrorDtoMalformedError(
      `status must be 'active' for auto-sync (got ${JSON.stringify(dto.status)}); backend mirror should have filtered this row out`,
    );
  }
  // Defense-in-depth on sessionId shape (Reality Checker LOW-4
  // pre-Codex). Broker's parsePolicySnapshot also re-checks, but
  // catching it here means a tampered backend response with a
  // path-traversal-ish sessionId never reaches the broker IPC.
  if (typeof dto.sessionId !== 'string' || !MCP_SESSION_ID_RE.test(dto.sessionId)) {
    throw new MirrorDtoMalformedError(
      `sessionId must match /^[A-Za-z0-9_-]{1,128}$/`,
    );
  }
  if (!MCP_HEX_20_BYTE_RE.test(dto.signerAddress)) {
    throw new MirrorDtoMalformedError(
      `signerAddress is not a 0x-prefixed 20-byte hex`,
    );
  }
  if (!Array.isArray(dto.targetContracts) || dto.targetContracts.length === 0) {
    throw new MirrorDtoMalformedError(
      `targetContracts must be a non-empty array`,
    );
  }
  for (const t of dto.targetContracts) {
    if (typeof t !== 'string' || !MCP_HEX_20_BYTE_RE.test(t)) {
      throw new MirrorDtoMalformedError(
        `targetContracts entry is not a 0x-prefixed 20-byte hex`,
      );
    }
  }
  if (!Array.isArray(dto.selectorCaps) || dto.selectorCaps.length === 0) {
    throw new MirrorDtoMalformedError(`selectorCaps must be a non-empty array`);
  }
  for (const c of dto.selectorCaps) {
    if (typeof c?.selector !== 'string' || !MCP_HEX_4_BYTE_RE.test(c.selector)) {
      throw new MirrorDtoMalformedError(
        `selectorCaps entry has a malformed selector`,
      );
    }
  }
  // Optional fields: loose `!= null` catches BOTH `null` (today's
  // backend emits this when the field is absent) AND `undefined`
  // (defense against a future backend serializer that omits null
  // keys; without the loose-eq guard, a missing key would route to
  // `regex.test(undefined)` → throws "malformed" with a misleading
  // message). The spread blocks below ALREADY use truthiness checks
  // which correctly handle both cases; this guard's only job is to
  // catch present-but-malformed values.
  if (dto.permissionId != null && !MCP_HEX_4_BYTE_RE.test(dto.permissionId)) {
    throw new MirrorDtoMalformedError(
      `permissionId is not a 0x-prefixed 4-byte hex`,
    );
  }
  if (
    dto.consentActionHash != null &&
    !MCP_HEX_32_BYTE_RE.test(dto.consentActionHash)
  ) {
    throw new MirrorDtoMalformedError(
      `consentActionHash is not a 0x-prefixed 32-byte hex`,
    );
  }
  if (
    dto.consentTextSha256 != null &&
    !MCP_HEX_32_BYTE_RE.test(dto.consentTextSha256)
  ) {
    throw new MirrorDtoMalformedError(
      `consentTextSha256 is not a 0x-prefixed 32-byte hex`,
    );
  }
  // Lowercase normalize at the boundary so the broker IPC receives
  // case-stable hex. The broker daemon's `parsePolicySnapshot` also
  // lowercases on its side (defense-in-depth), but normalizing here
  // means broker-internal `seenSelectors` deduplication + any future
  // equality check on the wire format reads consistent input
  // regardless of which casing the mirror happened to emit
  // (AI Engineer LOW-1 pre-Codex).
  return {
    sessionId: dto.sessionId,
    mode: 'scoped',
    signerAddress: dto.signerAddress.toLowerCase() as `0x${string}`,
    targetContracts: dto.targetContracts.map(
      (a) => a.toLowerCase() as `0x${string}`,
    ),
    selectorCaps: dto.selectorCaps.map((c) => ({
      selector: c.selector.toLowerCase() as `0x${string}`,
      capArgIndex: c.capArgIndex,
      maxAmount: c.maxAmount,
    })),
    validUntilSec: dto.validUntilSec,
    mintedAtSec: dto.mintedAtSec,
    ...(dto.consentActionHash
      ? { consentActionHash: dto.consentActionHash.toLowerCase() as `0x${string}` }
      : {}),
    ...(dto.consentTextSha256
      ? { consentTextSha256: dto.consentTextSha256.toLowerCase() as `0x${string}` }
      : {}),
    ...(dto.permissionId
      ? { permissionId: dto.permissionId.toLowerCase() as `0x${string}` }
      : {}),
  };
}
