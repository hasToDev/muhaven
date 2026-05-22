/**
 * Wire protocol between the MCP server (`@muhaven/mcp` STDIO subprocess)
 * and the long-running `muhaven-broker` daemon.
 *
 * Newline-delimited JSON over a Unix socket (POSIX) or named pipe
 * (Windows). Each request is a single JSON object; each response is a
 * single JSON object. No request pipelining, no streaming.
 *
 * **Protocol version 0.4.0** — additive bump from 0.3.0 for Wave 5
 * Path D Slice 1. Adds the policy-snapshot subsystem so the broker can
 * enforce scope + per-op spend cap BEFORE signing a UserOp:
 *  - `sign_userop` — like `sign_hash` but carries the structured inner
 *    call (target + callData) so the broker validates against the active
 *    policy snapshot before delegating to the signer. The MCP server
 *    computes the UserOp hash from the prepared UserOp; the broker
 *    signs it once policy passes.
 *  - `store_policy_snapshot` / `get_policy_snapshot` /
 *    `clear_policy_snapshot` — per-session policy CRUD. Snapshot
 *    persists across daemon restarts (file-backed under
 *    `~/.muhaven/policy-snapshots/<sessionId>.json`).
 *  - `get_active_session_id` — narrow "which session is live?" probe used
 *    by the MCP server to bootstrap Path D without needing the operator
 *    to thread the sessionId through env vars. Returns the sessionId of
 *    the SINGLE non-expired snapshot whose `signerAddress` matches the
 *    broker's loaded signer; returns `null` when zero match OR when
 *    multiple non-expired snapshots match (ambiguous case — caller falls
 *    back to Path C). Intentionally narrower than `list()` so RD-3 stays
 *    honoured (list() is daemon-internal only).
 * Also adds error codes `rate_limited`, `max_spend_exceeded`,
 * `policy_violation`, `scope_violation`, `no_active_snapshot`. Rate
 * limiting is enforced in Slice 5; the enum value ships now so
 * future-additive protocol bumps don't churn the codeset again.
 *
 * Trust model for `sign_userop`: per-selector, the broker decodes the
 * uint256 at the snapshot-declared `capArgIndex` of `innerCall.callData`
 * and enforces it against the matched `selectorCaps[i].maxAmount`. The
 * broker does NOT re-compute the UserOp hash from packed fields (that
 * would require entry-point + chain-id + packing knowledge inside the
 * broker). The hash itself is trusted as supplied by the MCP server; the
 * broker's job is to refuse signing when scope + per-op cap + signer
 * binding don't match. The on-chain CallPolicy validator is the
 * structural backstop for "what calldata can be executed at all" per
 * RD-2 / RD-5 in `PATH_D_PLAN.md`. Slice 4 wildcard MUST graduate to
 * canonical userOpHash reconstruction (RD-5).
 *
 * **Protocol version 0.3.0** (history) — additive bump from 0.2.0 in
 * @muhaven/mcp@0.1.3 to add `hello.hasSessionKey` + `hello.effectiveConfig`
 * (so a daemon booted without `MUHAVEN_BROKER_SESSION_KEY` can serve read
 * paths AND surface its effective backend/dashboard URLs to
 * `muhaven-broker login --from-daemon`). The 0.2.0 bump from 0.1.0 (Wave
 * 4 P3 ADR-3) added the `store_jwt` / `get_jwt` / `clear_jwt` triple —
 * the broker is the single keeper of the device-flow JWT (per ADR-3 D1
 * "polling, not loopback callback") in addition to the session-key
 * private half.
 *
 * @muhaven/mcp@0.1.5 added `hello.pid` (still protocol 0.3.0 — additive
 * optional field) so `muhaven-broker stop` can reach into the daemon
 * process by PID without forcing operators to grep `ps` output. Older
 * 0.1.4 daemons omit the field; `runStop` falls back to a structured
 * error message in that case.
 *
 * Threat-model invariants:
 *  - The broker NEVER reaches out to the network. It only:
 *      (a) signs hashes that the MCP server received from the backend,
 *      (b) stores / returns / clears a JWT that the MCP server
 *          received from the backend,
 *      (c) stores / returns / clears per-session policy snapshots that
 *          the MCP server (or operator CLI) provides at mint time.
 *    Splitting network egress (MCP server) from signing + secret
 *    storage (broker) is the lethal-trifecta mitigation in
 *    `THREAT_MODEL_P0.md` §"Lethal-trifecta self-audit".
 *  - Requests are size-capped (`maxRequestBytes`) — a malformed peer
 *    cannot exhaust broker memory by sending an unbounded JSON blob.
 */

export const BROKER_PROTOCOL_VERSION = '0.4.0';

// ---------- requests ----------

export interface BrokerHelloRequest {
  readonly type: 'hello';
}

export interface BrokerSignHashRequest {
  readonly type: 'sign_hash';
  /** 0x-prefixed 32-byte hex (e.g., a UserOp hash to be ECDSA-signed). */
  readonly hash: `0x${string}`;
  /** Free-form context for the audit log. NOT trusted as policy input. */
  readonly intent?: {
    readonly tool: string;
    readonly summary?: string;
  };
}

export interface BrokerStoreJwtRequest {
  readonly type: 'store_jwt';
  /** A scoped device-flow JWT (mcp.read.*, mcp.propose.*) per ADR-3 D2. */
  readonly jwt: string;
  /** Optional issuer-stated expiry (epoch seconds). Used for proactive
   *  re-login UX; not for trust decisions. */
  readonly expiresAtSec?: number;
}

export interface BrokerGetJwtRequest {
  readonly type: 'get_jwt';
}

export interface BrokerClearJwtRequest {
  readonly type: 'clear_jwt';
}

/**
 * Wave 5 Path D Slice 1 — request a policy-gated UserOp signature. The
 * MCP server has computed `userOpHash` from a prepared UserOp; the broker
 * looks up the snapshot for `sessionId`, validates `innerCall` against
 * the snapshot's allowlist + per-op cap, signs `userOpHash`, and returns
 * the signature. See protocol-version JSDoc above for the trust model.
 */
export interface BrokerSignUserOpRequest {
  readonly type: 'sign_userop';
  /** Snapshot key — must match a snapshot previously stored via
   *  `store_policy_snapshot`. */
  readonly sessionId: string;
  /** EIP-4337 v0.7 userOpHash, 0x-prefixed 32-byte hex. Signed as-is. */
  readonly userOpHash: `0x${string}`;
  /** Structured representation of the kernel-inner call the prepared
   *  UserOp will execute. Broker uses this to validate scope + per-op
   *  cap. The MCP server is responsible for ensuring this matches what
   *  the on-chain executor will see. */
  readonly innerCall: {
    /** 0x-prefixed 20-byte hex (lowercased for compare-stability). */
    readonly target: `0x${string}`;
    /** Encoded selector + args. Selector = bytes 0..3; ABI words at
     *  bytes 4..35, 36..67, ... read by `decodeUint256ArgAt(callData,
     *  wordIndex)` per the matched `selectorCaps[i].capArgIndex`. */
    readonly callData: `0x${string}`;
  };
  /** Free-form context for the audit log. NOT trusted as policy input. */
  readonly intent?: {
    readonly tool: string;
    readonly summary?: string;
  };
}

/**
 * Wave 5 Path D Slice 1 — write a per-session policy snapshot. The MCP
 * server (or `muhaven-broker set-policy` CLI in Slice 3) calls this
 * after the frontend mint ceremony to give the broker the rules it
 * should enforce when `sign_userop` arrives.
 */
export interface BrokerStorePolicySnapshotRequest {
  readonly type: 'store_policy_snapshot';
  readonly snapshot: PolicySnapshotWire;
}

export interface BrokerGetPolicySnapshotRequest {
  readonly type: 'get_policy_snapshot';
  readonly sessionId: string;
}

export interface BrokerClearPolicySnapshotRequest {
  readonly type: 'clear_policy_snapshot';
  readonly sessionId: string;
}

/**
 * Wave 5 Path D Slice 1 (Commit 3) — narrow "active session" probe. No
 * arguments; the broker resolves uniqueness against its loaded signer's
 * address. The MCP server uses this to bootstrap Path D's broker-side
 * signing path before Slice 2's backend-mirror `agent_scoped_sessions`
 * table lands. Distinct from `get_policy_snapshot(sessionId)`: that
 * fetches a known-id snapshot; this discovers the active id when there
 * is exactly one.
 *
 * Returns `sessionId: null` (rather than an error) for both the "no
 * active snapshot" AND "ambiguous, multiple match" cases — callers must
 * treat them identically (fall back to Path C). Enumerating expired
 * snapshots OR snapshots for other signers is daemon-internal; never
 * surfaced over IPC.
 */
export interface BrokerGetActiveSessionIdRequest {
  readonly type: 'get_active_session_id';
}

/**
 * Per-selector enforcement rule. The broker matches `innerCall`'s
 * selector against `selector`, then — if `capArgIndex` is not null —
 * decodes the 32-byte word at that index after the 4-byte selector and
 * compares to `maxAmount` (≤ semantics).
 *
 * `capArgIndex` is the 0-based word index INTO THE ABI-ENCODED ARG TAIL.
 * For `subscription.purchase(address token, InEuint128 encShares,
 * uint128 maxSharesHint, address ephemeralEOA)`, the layout is:
 *   word 0 (bytes 4..35):  address token (left-zero-padded to 32 bytes)
 *   word 1 (bytes 36..67): InEuint128 dynamic-offset (FHE-encrypted tail)
 *   word 2 (bytes 68..99): uint128 maxSharesHint (left-zero-padded to 32 bytes per Solidity ABI v1; value in the low 16 bytes)
 *   word 3 (bytes 100..131): address ephemeralEOA (left-zero-padded)
 * So `capArgIndex: 2` caps `maxSharesHint` — the plaintext upper bound
 * on the encrypted share amount. The actual `encShares` is FHE-encrypted
 * and the broker cannot decrypt it; `maxSharesHint` is the structural
 * ceiling the broker enforces.
 *
 * `capArgIndex: null` means "selector is allowed, no arg-cap enforced"
 * (intended for nullary-value selectors like `claim()` in future slices).
 * `maxAmount` MUST be null when `capArgIndex` is null, and a uint256
 * decimal string otherwise.
 *
 * **Static-arg assumption (Slice 1):** the broker assumes the calldata
 * is ABI-encoded with no dynamic-type args at-or-before `capArgIndex`.
 * For dynamic-arg targets (`bytes`, `string`, dynamic struct head), the
 * 32-byte slot at the cap offset would be an OFFSET, not the value, and
 * the cap would trivially pass on a tiny "offset" value while the real
 * value sits in the dynamic tail. Slice 4 must NOT add such targets
 * without a selector-aware ABI decoder. (`subscription.purchase` is safe
 * — `InEuint128 calldata` is a dynamic struct, but `maxSharesHint` at
 * word 2 is statically encoded after the dynamic-struct head-offset.)
 */
export interface PolicySelectorCap {
  /** 0x-prefixed 4-byte hex (lowercased). */
  readonly selector: `0x${string}`;
  /** 0-based word index after the selector. Null = no arg-cap enforced. */
  readonly capArgIndex: number | null;
  /** uint256 decimal string. Null iff `capArgIndex` is null. Unit is
   *  whatever the target arg's base unit is (e.g. for purchase, uint128
   *  maxSharesHint → shares, not mhUSDC base-6). MCP server is
   *  responsible for converting user-intent units to the on-chain unit
   *  at snapshot-mint time. */
  readonly maxAmount: string | null;
}

/**
 * Wire shape of a policy snapshot. Strings (not bigints) so JSON
 * round-trips cleanly.
 *
 * Per-selector caps are carried in `selectorCaps`. The set of allowed
 * selectors is exactly `selectorCaps.map(c => c.selector)` — no
 * `allowedSelectors` field, single source of truth. See
 * `PolicySelectorCap` JSDoc for the static-arg-encoding assumption +
 * `capArgIndex` semantics.
 */
export interface PolicySnapshotWire {
  readonly sessionId: string;
  readonly mode: 'scoped';
  /** Address derived from the session-key private half. Broker compares
   *  this against its loaded `signer.address` at sign time; mismatch
   *  rejects with `policy_violation` to defend against snapshots minted
   *  for a rotated session-key being applied to the new key. */
  readonly signerAddress: `0x${string}`;
  /** Lowercased 0x-addresses that the broker will accept as
   *  `innerCall.target`. */
  readonly targetContracts: readonly `0x${string}`[];
  /** Per-selector rules. Selector must appear in this list AND
   *  `innerCall.target` must be in `targetContracts` for the selector
   *  match to authorize signing. */
  readonly selectorCaps: readonly PolicySelectorCap[];
  /** Epoch seconds. Snapshot is rejected on lookup after this time. */
  readonly validUntilSec: number;
  /** Epoch seconds at which the snapshot was created (audit). */
  readonly mintedAtSec: number;
  /** Optional Slice 1, REQUIRED Slice 4 wildcard. Hex-32 hash of the
   *  authorizing ConfirmToken's `actionHash` so the audit chain
   *  {userop → tier transition → consent token} is correlatable by
   *  stable key. Future-compat reserve per Trust Architect §4. */
  readonly consentActionHash?: `0x${string}`;
  /** Optional Slice 1, REQUIRED Slice 4 wildcard. Hex-32 hash of the
   *  consent text the user saw at mint time (Slice 4 gate #5). */
  readonly consentTextSha256?: `0x${string}`;
  /**
   * Wave 5 Path D Slice 1 Commit 3.5 — `getPermissionId()` for the
   * installed `@zerodev/permissions` PermissionValidator. 4-byte hex
   * (`keccak256(policyAndSignerData).slice(0, 4)`). Used by the MCP
   * server to compose the 24-byte nonce-key composite Kernel v3.1
   * requires for UserOps routed through the permission validator
   * (`pad(concat([VALIDATOR_MODE, VALIDATOR_TYPE.PERMISSION,
   * identifier(20), customKey(2)]))`). Without this, the bundler reads
   * the SUDO-validator nonce slot and the UserOp is routed through
   * the wrong validator → `AA24 InvalidSigner`.
   *
   * **Optional in Slice 1 for back-compat** with the not-yet-built
   * dashboard-side `storePolicySnapshot` POST. Path D refuses to
   * compose a UserOp when this field is absent → falls back to Path C
   * with reason `no_permission_id_in_snapshot`. Slice 2's frontend
   * mint flow MUST include this field; broker daemon enforces no
   * tighter today (additive optional field, no protocol version bump
   * because every existing 0.4.0 consumer that doesn't supply it just
   * loses Path D and degrades cleanly to Path C).
   */
  readonly permissionId?: `0x${string}`;
}

// ---------- responses ----------

export interface BrokerHelloResponse {
  readonly type: 'hello';
  readonly version: string;
  /**
   * 0x-prefixed checksummed address derived from the session key. When
   * the daemon was booted without `MUHAVEN_BROKER_SESSION_KEY` (read-only
   * posture; see `hasSessionKey`), this is the zero address.
   *
   * **DO NOT** use address-equality (`sessionKeyAddress !== ZERO_ADDRESS`)
   * as a proxy for "session key is loaded" — that's a soft signal that
   * future changes (e.g. allowing custom EOA-bound dev posture) could
   * break silently. The authoritative aliveness check is `hasSessionKey`.
   */
  readonly sessionKeyAddress: `0x${string}`;
  /** Whether a JWT is currently in the keystore. Useful for `doctor`. */
  readonly hasJwt: boolean;
  /**
   * Whether a session-key private half is loaded into the daemon. False
   * when the daemon was booted without `MUHAVEN_BROKER_SESSION_KEY` — in
   * that posture read tools still work (the broker serves JWT verbs), but
   * any `sign_hash` request returns `session_key_unavailable`. Field added
   * in protocol 0.3.0; absence implies `true` for back-compat with
   * 0.2.0 daemons.
   */
  readonly hasSessionKey?: boolean;
  /**
   * Effective backend + dashboard URLs the daemon resolved from its own
   * process env at boot. Surfaced so `muhaven-broker login --from-daemon`
   * can stay in lockstep with the daemon's view rather than re-reading
   * the CLI's env (which may diverge — e.g. login invoked over ssh inherits
   * a different shell env than the systemd-launched daemon). Field added
   * in protocol 0.3.0; absent on older daemons.
   */
  readonly effectiveConfig?: {
    readonly backendBaseUrl: string;
    readonly dashboardBaseUrl: string;
  };
  /**
   * OS process id of the daemon. Surfaced so `muhaven-broker stop` can
   * `process.kill(pid, 'SIGTERM')` without grepping `ps` output. Added in
   * @muhaven/mcp@0.1.5 (no protocol-version bump — additive optional
   * field). Older daemons omit; consumers MUST handle `undefined`.
   */
  readonly pid?: number;
}

export interface BrokerSignHashResponse {
  readonly type: 'sign_hash';
  /** 0x-prefixed 65-byte ECDSA signature (r || s || v). */
  readonly signature: `0x${string}`;
  readonly signerAddress: `0x${string}`;
}

export interface BrokerStoreJwtResponse {
  readonly type: 'store_jwt';
  readonly stored: true;
}

export interface BrokerGetJwtResponse {
  readonly type: 'get_jwt';
  /** Null when no JWT in keystore — caller must trigger device-flow. */
  readonly jwt: string | null;
  readonly expiresAtSec: number | null;
}

export interface BrokerClearJwtResponse {
  readonly type: 'clear_jwt';
  readonly cleared: true;
}

export interface BrokerSignUserOpResponse {
  readonly type: 'sign_userop';
  /** 0x-prefixed 65-byte ECDSA signature (r || s || v). */
  readonly signature: `0x${string}`;
  readonly signerAddress: `0x${string}`;
  readonly sessionId: string;
}

export interface BrokerStorePolicySnapshotResponse {
  readonly type: 'store_policy_snapshot';
  readonly stored: true;
  readonly sessionId: string;
}

export interface BrokerGetPolicySnapshotResponse {
  readonly type: 'get_policy_snapshot';
  /** Null when no snapshot for the requested sessionId, OR when the
   *  snapshot exists but is past `validUntilSec` (caller treats both as
   *  "no active snapshot"). */
  readonly snapshot: PolicySnapshotWire | null;
}

export interface BrokerClearPolicySnapshotResponse {
  readonly type: 'clear_policy_snapshot';
  readonly cleared: true;
  readonly sessionId: string;
}

export interface BrokerGetActiveSessionIdResponse {
  readonly type: 'get_active_session_id';
  /** Null when zero non-expired snapshots match the broker's loaded
   *  signer, OR when 2+ match (ambiguous). Callers fall back to Path C
   *  in either case. */
  readonly sessionId: string | null;
}

export interface BrokerErrorResponse {
  readonly type: 'error';
  readonly code: BrokerErrorCode;
  readonly message: string;
}

export type BrokerErrorCode =
  | 'invalid_request'
  | 'payload_too_large'
  | 'unsupported_type'
  | 'internal'
  | 'forbidden'
  | 'keystore_unavailable'
  | 'session_key_unavailable'
  // Wave 5 Path D Slice 1 — policy snapshot lifecycle + sign_userop gating
  | 'no_active_snapshot'
  | 'policy_violation'
  | 'scope_violation'
  | 'max_spend_exceeded'
  // Wave 5 Path D Slice 5 — rate limiting (enum reserved; not enforced yet)
  | 'rate_limited';

export type BrokerRequest =
  | BrokerHelloRequest
  | BrokerSignHashRequest
  | BrokerStoreJwtRequest
  | BrokerGetJwtRequest
  | BrokerClearJwtRequest
  | BrokerSignUserOpRequest
  | BrokerStorePolicySnapshotRequest
  | BrokerGetPolicySnapshotRequest
  | BrokerClearPolicySnapshotRequest
  | BrokerGetActiveSessionIdRequest;

export type BrokerResponse =
  | BrokerHelloResponse
  | BrokerSignHashResponse
  | BrokerStoreJwtResponse
  | BrokerGetJwtResponse
  | BrokerClearJwtResponse
  | BrokerSignUserOpResponse
  | BrokerStorePolicySnapshotResponse
  | BrokerGetPolicySnapshotResponse
  | BrokerClearPolicySnapshotResponse
  | BrokerGetActiveSessionIdResponse
  | BrokerErrorResponse;

const HASH_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_HEX_RE = /^0x[0-9a-fA-F]{8}$/;
const HEX_PREFIXED_RE = /^0x[0-9a-fA-F]*$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UINT256_DEC_RE = /^(0|[1-9][0-9]{0,77})$/;
/** Max calldata size accepted by parser. ~200KB hex = ~100KB bytes —
 *  generous for typical UserOps (kernel inner-call sizes ≤ a few KB)
 *  while still well under the 1MB IPC payload cap. */
const MAX_CALLDATA_HEX_LEN = 200_000;

export function isHashHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && HASH_HEX_RE.test(value);
}

export function isAddressHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && ADDRESS_HEX_RE.test(value);
}

export function isSelectorHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && SELECTOR_HEX_RE.test(value);
}

export function isHexPrefixed(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && HEX_PREFIXED_RE.test(value);
}

function isJwtShape(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && JWT_RE.test(value);
}

function isSessionIdShape(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function isUint256DecString(value: unknown): value is string {
  return typeof value === 'string' && UINT256_DEC_RE.test(value);
}

/** uint256 max = 2^256 - 1 = 78 decimal digits. */
const UINT256_MAX = (1n << 256n) - 1n;

function isUint256InRange(value: string): boolean {
  if (!isUint256DecString(value)) return false;
  // Regex permits up to 78 digits; explicit numeric bound to reject the
  // sliver of 78-digit values > uint256 max (Code Reviewer MED-1).
  return BigInt(value) <= UINT256_MAX;
}

function parseSelectorCap(raw: unknown): PolicySelectorCap | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'selectorCap must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  if (!isSelectorHex(obj.selector)) {
    return { error: 'selectorCap.selector must be a 4-byte 0x-hex' };
  }
  const capArgIndex = obj.capArgIndex;
  const maxAmount = obj.maxAmount;
  const indexIsNull = capArgIndex === null;
  const amountIsNull = maxAmount === null;
  if (indexIsNull !== amountIsNull) {
    return {
      error:
        'selectorCap.capArgIndex and selectorCap.maxAmount must both be null or both non-null',
    };
  }
  if (!indexIsNull) {
    if (
      typeof capArgIndex !== 'number' ||
      !Number.isInteger(capArgIndex) ||
      capArgIndex < 0 ||
      capArgIndex > 31
    ) {
      return {
        error: 'selectorCap.capArgIndex must be an integer in [0, 31] (max 32 ABI words)',
      };
    }
    if (typeof maxAmount !== 'string' || !isUint256InRange(maxAmount)) {
      return { error: 'selectorCap.maxAmount must be a uint256 decimal string ≤ 2^256-1' };
    }
  }
  return {
    selector: (obj.selector as string).toLowerCase() as `0x${string}`,
    capArgIndex: indexIsNull ? null : (capArgIndex as number),
    maxAmount: indexIsNull ? null : (maxAmount as string),
  };
}

function isOptionalHash32(value: unknown): value is `0x${string}` | undefined {
  return value === undefined || isHashHex(value);
}

/**
 * Wave 5 Path D Slice 1 Commit 3.5 — validator for the 4-byte
 * `permissionId` hex string (`getPermissionId()` output from
 * `@zerodev/permissions`). Same shape as a function selector.
 */
function isOptionalPermissionId(value: unknown): value is `0x${string}` | undefined {
  return value === undefined || isSelectorHex(value);
}

function parsePolicySnapshot(raw: unknown): PolicySnapshotWire | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'snapshot must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  if (!isSessionIdShape(obj.sessionId)) {
    return { error: 'snapshot.sessionId must be 1-128 chars [A-Za-z0-9_-]' };
  }
  if (obj.mode !== 'scoped') {
    return { error: "snapshot.mode must be 'scoped' (wildcard ships in Slice 4)" };
  }
  if (!isAddressHex(obj.signerAddress)) {
    return { error: 'snapshot.signerAddress must be a 0x-prefixed 20-byte hex' };
  }
  const targetContracts = obj.targetContracts;
  if (
    !Array.isArray(targetContracts) ||
    targetContracts.length === 0 ||
    targetContracts.length > 32 ||
    !targetContracts.every(isAddressHex)
  ) {
    return {
      error: 'snapshot.targetContracts must be a 1..32-element array of 0x-addresses',
    };
  }
  const rawCaps = obj.selectorCaps;
  if (!Array.isArray(rawCaps) || rawCaps.length === 0 || rawCaps.length > 32) {
    return { error: 'snapshot.selectorCaps must be a 1..32-element array' };
  }
  const parsedCaps: PolicySelectorCap[] = [];
  const seenSelectors = new Set<string>();
  for (const c of rawCaps) {
    const parsed = parseSelectorCap(c);
    if ('error' in parsed) return { error: `selectorCaps: ${parsed.error}` };
    if (seenSelectors.has(parsed.selector)) {
      return { error: `selectorCaps: duplicate selector ${parsed.selector}` };
    }
    seenSelectors.add(parsed.selector);
    parsedCaps.push(parsed);
  }
  if (
    typeof obj.validUntilSec !== 'number' ||
    !Number.isFinite(obj.validUntilSec) ||
    obj.validUntilSec <= 0
  ) {
    return { error: 'snapshot.validUntilSec must be a positive number' };
  }
  if (
    typeof obj.mintedAtSec !== 'number' ||
    !Number.isFinite(obj.mintedAtSec) ||
    obj.mintedAtSec <= 0
  ) {
    return { error: 'snapshot.mintedAtSec must be a positive number' };
  }
  if (!isOptionalHash32(obj.consentActionHash)) {
    return { error: 'snapshot.consentActionHash must be a 0x-prefixed 32-byte hex when provided' };
  }
  if (!isOptionalHash32(obj.consentTextSha256)) {
    return { error: 'snapshot.consentTextSha256 must be a 0x-prefixed 32-byte hex when provided' };
  }
  if (!isOptionalPermissionId(obj.permissionId)) {
    return { error: 'snapshot.permissionId must be a 0x-prefixed 4-byte hex when provided' };
  }
  return {
    sessionId: obj.sessionId,
    mode: 'scoped',
    signerAddress: (obj.signerAddress as string).toLowerCase() as `0x${string}`,
    targetContracts: (targetContracts as string[]).map(
      (a) => a.toLowerCase() as `0x${string}`,
    ),
    selectorCaps: parsedCaps,
    validUntilSec: obj.validUntilSec,
    mintedAtSec: obj.mintedAtSec,
    ...(obj.consentActionHash === undefined
      ? {}
      : { consentActionHash: (obj.consentActionHash as string).toLowerCase() as `0x${string}` }),
    ...(obj.consentTextSha256 === undefined
      ? {}
      : { consentTextSha256: (obj.consentTextSha256 as string).toLowerCase() as `0x${string}` }),
    ...(obj.permissionId === undefined
      ? {}
      : { permissionId: (obj.permissionId as string).toLowerCase() as `0x${string}` }),
  };
}

/**
 * Parse a single-line request payload. Returns either the validated
 * request or a structured error — the daemon converts errors to a
 * `BrokerErrorResponse` without raising so a malformed peer cannot crash
 * the daemon process.
 */
export function parseBrokerRequest(line: string): BrokerRequest | BrokerErrorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: 'error', code: 'invalid_request', message: 'request is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'error', code: 'invalid_request', message: 'request must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case 'hello':
      return { type: 'hello' };
    case 'sign_hash': {
      const hash = obj.hash;
      if (!isHashHex(hash)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_hash.hash must be a 0x-prefixed 32-byte hex string',
        };
      }
      const intent = obj.intent;
      const intentValid =
        intent === undefined ||
        (typeof intent === 'object' &&
          intent !== null &&
          typeof (intent as Record<string, unknown>).tool === 'string');
      if (!intentValid) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_hash.intent.tool must be a string when provided',
        };
      }
      return {
        type: 'sign_hash',
        hash,
        ...(intent === undefined ? {} : { intent: intent as BrokerSignHashRequest['intent'] }),
      };
    }
    case 'store_jwt': {
      const jwt = obj.jwt;
      if (!isJwtShape(jwt)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'store_jwt.jwt must be a JWT-shaped string ≤8192 chars',
        };
      }
      const expiresAtSec = obj.expiresAtSec;
      const expiresValid =
        expiresAtSec === undefined ||
        (typeof expiresAtSec === 'number' && Number.isFinite(expiresAtSec) && expiresAtSec > 0);
      if (!expiresValid) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'store_jwt.expiresAtSec must be a positive number when provided',
        };
      }
      return {
        type: 'store_jwt',
        jwt,
        ...(expiresAtSec === undefined ? {} : { expiresAtSec: expiresAtSec as number }),
      };
    }
    case 'get_jwt':
      return { type: 'get_jwt' };
    case 'clear_jwt':
      return { type: 'clear_jwt' };
    case 'sign_userop': {
      const sessionId = obj.sessionId;
      if (!isSessionIdShape(sessionId)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_userop.sessionId must be 1-128 chars [A-Za-z0-9_-]',
        };
      }
      const userOpHash = obj.userOpHash;
      if (!isHashHex(userOpHash)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_userop.userOpHash must be a 0x-prefixed 32-byte hex string',
        };
      }
      const innerCall = obj.innerCall;
      if (typeof innerCall !== 'object' || innerCall === null) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_userop.innerCall must be an object with { target, callData }',
        };
      }
      const ic = innerCall as Record<string, unknown>;
      if (!isAddressHex(ic.target)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'sign_userop.innerCall.target must be a 0x-prefixed 20-byte hex',
        };
      }
      // callData must be 0x-prefixed hex, even-length, ≥74 chars
      // ("0x" + 8 hex selector + 64 hex first-uint256-arg = 74). The
      // broker's policy check decodes the first uint256 from bytes
      // 4..35, so anything shorter cannot carry the required arg.
      // Capped to MAX_CALLDATA_HEX_LEN so a malformed peer cannot OOM
      // the broker via a giant blob.
      if (
        !isHexPrefixed(ic.callData) ||
        (ic.callData as string).length < 74 ||
        (ic.callData as string).length % 2 !== 0 ||
        (ic.callData as string).length > MAX_CALLDATA_HEX_LEN
      ) {
        return {
          type: 'error',
          code: 'invalid_request',
          message:
            'sign_userop.innerCall.callData must be 0x-prefixed even-length hex ≥74 chars (selector + first uint256 arg) and ≤200000 chars',
        };
      }
      // intent is free-form context for the audit log. Explicit-extract
      // rather than spread so unlisted keys don't propagate and a 999KB
      // summary blob can't bloat the audit channel (Code Reviewer MED-3).
      const intent = obj.intent;
      let safeIntent: BrokerSignUserOpRequest['intent'] | undefined;
      if (intent !== undefined) {
        if (typeof intent !== 'object' || intent === null) {
          return {
            type: 'error',
            code: 'invalid_request',
            message: 'sign_userop.intent must be an object when provided',
          };
        }
        const intentObj = intent as Record<string, unknown>;
        if (typeof intentObj.tool !== 'string' || intentObj.tool.length > 64) {
          return {
            type: 'error',
            code: 'invalid_request',
            message: 'sign_userop.intent.tool must be a string ≤64 chars',
          };
        }
        if (
          intentObj.summary !== undefined &&
          (typeof intentObj.summary !== 'string' || intentObj.summary.length > 256)
        ) {
          return {
            type: 'error',
            code: 'invalid_request',
            message: 'sign_userop.intent.summary must be a string ≤256 chars when provided',
          };
        }
        safeIntent = {
          tool: intentObj.tool,
          ...(typeof intentObj.summary === 'string' ? { summary: intentObj.summary } : {}),
        };
      }
      return {
        type: 'sign_userop',
        sessionId,
        userOpHash,
        innerCall: {
          target: (ic.target as string).toLowerCase() as `0x${string}`,
          callData: (ic.callData as string).toLowerCase() as `0x${string}`,
        },
        ...(safeIntent === undefined ? {} : { intent: safeIntent }),
      };
    }
    case 'store_policy_snapshot': {
      const parsed = parsePolicySnapshot(obj.snapshot);
      if ('error' in parsed) {
        return { type: 'error', code: 'invalid_request', message: parsed.error };
      }
      return { type: 'store_policy_snapshot', snapshot: parsed };
    }
    case 'get_policy_snapshot': {
      if (!isSessionIdShape(obj.sessionId)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'get_policy_snapshot.sessionId must be 1-128 chars [A-Za-z0-9_-]',
        };
      }
      return { type: 'get_policy_snapshot', sessionId: obj.sessionId };
    }
    case 'clear_policy_snapshot': {
      if (!isSessionIdShape(obj.sessionId)) {
        return {
          type: 'error',
          code: 'invalid_request',
          message: 'clear_policy_snapshot.sessionId must be 1-128 chars [A-Za-z0-9_-]',
        };
      }
      return { type: 'clear_policy_snapshot', sessionId: obj.sessionId };
    }
    case 'get_active_session_id':
      return { type: 'get_active_session_id' };
    default:
      return {
        type: 'error',
        code: 'unsupported_type',
        message: `unsupported request type: ${String(obj.type)}`,
      };
  }
}

export function serializeResponse(res: BrokerResponse): string {
  return JSON.stringify(res) + '\n';
}
