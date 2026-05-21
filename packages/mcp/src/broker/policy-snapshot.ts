/**
 * Wave 5 Path D Slice 1 — per-session policy snapshot subsystem for the
 * broker daemon. Each snapshot describes the rules the broker enforces
 * BEFORE signing a UserOp: target-contract allowlist, selector allowlist,
 * per-op amount cap, expiry.
 *
 * Persistence model: one JSON file per snapshot under
 * `~/.muhaven/policy-snapshots/<sessionId>.json`. Atomic writes via
 * tmp-file + rename (POSIX & Windows). Mode 0600 on POSIX; Windows ACL
 * is whatever the user's profile dir provides.
 *
 * Why a directory not a single keystore record (cf. `keystore.ts` for
 * the JWT): users can have multiple concurrent scoped sessions
 * (different surfaces, different tiers), and the broker needs lookup-by-
 * sessionId during sign_userop. The JWT is a single-tenant record;
 * snapshots are a multi-record store keyed by sessionId.
 *
 * The OS keychain backend is intentionally NOT used here. Keychain APIs
 * generally hold one value per (service, account) pair and are awkward
 * for the "list all keys" lookup the doctor command needs. File-only
 * keeps it simple. Snapshots aren't long-term secrets — they describe
 * policy, not credentials — so the security posture is "operator
 * filesystem permissions" not "OS-trust-zone".
 */

import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { PolicySelectorCap, PolicySnapshotWire } from './protocol.js';

/** Public alias — callers can import either name. */
export type PolicySnapshot = PolicySnapshotWire;
export type { PolicySelectorCap } from './protocol.js';

export interface IPolicyStore {
  /** Return the snapshot for `sessionId`, or null if absent OR past
   *  `validUntilSec`. Callers treat both as "no active snapshot." */
  get(sessionId: string, nowSec: number): Promise<PolicySnapshot | null>;
  /** Overwrite any existing record for the snapshot's sessionId. */
  put(snapshot: PolicySnapshot): Promise<void>;
  /** Delete the snapshot. No-op when sessionId is absent. */
  delete(sessionId: string): Promise<void>;
  /** Return every snapshot in the store (including expired). Used by
   *  doctor / hello surfaces for diagnostics. NEVER exposed over IPC —
   *  see RD-3 commentary in PATH_D_PLAN.md and Backend Architect M-4. */
  list(): Promise<PolicySnapshot[]>;
  /** Optional one-shot async setup. The file-backed impl doesn't need
   *  this — the dir is created lazily on first put. Slice 5's spend-
   *  ledger impl will need to seed the SHA-256 chain from disk at boot;
   *  daemon.start() awaits `policyStore.init?.()` so the seed runs
   *  before any IPC request. Adding the optional method now avoids a
   *  refactor when Slice 5 lands (Backend Architect M-1). */
  init?(): Promise<void>;
}

export type PolicyStoreErrorCode =
  | 'invalid_session_id'
  | 'malformed_record'
  | 'write_failed'
  | 'read_failed'
  | 'delete_failed';

export class PolicyStoreError extends Error {
  constructor(readonly code: PolicyStoreErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PolicyStoreError';
  }
}

/**
 * sessionId is used directly as a filename — validate it can't escape
 * the store dir. The protocol layer already validates this regex on
 * incoming requests; we re-validate here as defense-in-depth so a
 * direct caller (tests, future CLI tools) can't slip a path-traversal
 * value past the protocol parser.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Local copy of uint256 max — protocol.ts has its own; keep them in
 *  lockstep. The disk-validator path uses this so a hand-edited file
 *  can't slip a > uint256 maxAmount past coercion. */
const UINT256_MAX_LOCAL = (1n << 256n) - 1n;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new PolicyStoreError(
      'invalid_session_id',
      `sessionId "${sessionId}" must be 1-128 chars [A-Za-z0-9_-] (path-traversal guard)`,
    );
  }
}

export class FilePolicyStore implements IPolicyStore {
  constructor(private readonly dir: string) {}

  static defaultDir(): string {
    return join(homedir(), '.muhaven', 'policy-snapshots');
  }

  private snapshotPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  async get(sessionId: string, nowSec: number): Promise<PolicySnapshot | null> {
    validateSessionId(sessionId);
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new PolicyStoreError(
        'read_failed',
        `failed to read snapshot ${sessionId}: ${asMessage(err)}`,
        err,
      );
    }
    let parsed: PolicySnapshot;
    try {
      const obj = JSON.parse(raw);
      parsed = coerceFromDisk(obj);
    } catch (err) {
      throw new PolicyStoreError(
        'malformed_record',
        `snapshot ${sessionId} is not valid JSON: ${asMessage(err)}`,
        err,
      );
    }
    // Treat expired snapshots as absent. The caller's "is there an
    // active snapshot?" check has the same answer either way; we
    // garbage-collect expired files lazily on the next put/delete.
    if (parsed.validUntilSec <= nowSec) return null;
    return parsed;
  }

  async put(snapshot: PolicySnapshot): Promise<void> {
    validateSessionId(snapshot.sessionId);
    const dest = this.snapshotPath(snapshot.sessionId);
    const tmp = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700).catch(() => undefined);
      await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => undefined);
      await rename(tmp, dest);
    } catch (err) {
      // Best-effort tmp cleanup so a failed put doesn't leave clutter.
      await unlink(tmp).catch(() => undefined);
      throw new PolicyStoreError(
        'write_failed',
        `failed to write snapshot ${snapshot.sessionId}: ${asMessage(err)}`,
        err,
      );
    }
  }

  async delete(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    try {
      await unlink(this.snapshotPath(sessionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new PolicyStoreError(
        'delete_failed',
        `failed to delete snapshot ${sessionId}: ${asMessage(err)}`,
        err,
      );
    }
  }

  async list(): Promise<PolicySnapshot[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new PolicyStoreError(
        'read_failed',
        `failed to enumerate snapshot dir: ${asMessage(err)}`,
        err,
      );
    }
    const out: PolicySnapshot[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const sessionId = entry.slice(0, -'.json'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      try {
        const raw = await readFile(join(this.dir, entry), 'utf8');
        out.push(coerceFromDisk(JSON.parse(raw)));
      } catch {
        // Skip unreadable / malformed entries in list(); they'd already
        // throw if accessed individually via get().
        continue;
      }
    }
    return out;
  }
}

/**
 * Type-narrow a JSON-parsed object into a `PolicySnapshot`. Throws on
 * shape mismatch — caller catches and surfaces `malformed_record`. The
 * protocol layer (`parsePolicySnapshot` in protocol.ts) already enforces
 * this shape on the wire; this is defense-in-depth for disk-corruption
 * or hand-edited files.
 *
 * Accepts mixed-case hex (parser layer lowercases on the wire, but a
 * future direct disk-writer — e.g. operator CLI in Slice 3 — might emit
 * checksummed addresses). All hex is lowercased before return so the
 * comparisons in `checkPolicy` stay case-stable.
 */
function coerceFromDisk(obj: unknown): PolicySnapshot {
  if (typeof obj !== 'object' || obj === null) throw new Error('snapshot not an object');
  const o = obj as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || !SESSION_ID_RE.test(o.sessionId)) {
    throw new Error('snapshot.sessionId malformed');
  }
  if (o.mode !== 'scoped') throw new Error('snapshot.mode must be "scoped"');
  if (typeof o.signerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.signerAddress)) {
    throw new Error('snapshot.signerAddress malformed');
  }
  if (
    !Array.isArray(o.targetContracts) ||
    !o.targetContracts.every((t) => typeof t === 'string' && /^0x[0-9a-fA-F]{40}$/.test(t))
  ) {
    throw new Error('snapshot.targetContracts malformed');
  }
  if (!Array.isArray(o.selectorCaps) || o.selectorCaps.length === 0) {
    throw new Error('snapshot.selectorCaps malformed');
  }
  const caps: PolicySelectorCap[] = [];
  for (const c of o.selectorCaps) {
    if (typeof c !== 'object' || c === null) throw new Error('selectorCap not an object');
    const cap = c as Record<string, unknown>;
    if (typeof cap.selector !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(cap.selector)) {
      throw new Error('selectorCap.selector malformed');
    }
    const indexNull = cap.capArgIndex === null;
    const amountNull = cap.maxAmount === null;
    if (indexNull !== amountNull) {
      throw new Error('selectorCap.capArgIndex/maxAmount must both be null or both non-null');
    }
    if (!indexNull) {
      if (
        typeof cap.capArgIndex !== 'number' ||
        !Number.isInteger(cap.capArgIndex) ||
        cap.capArgIndex < 0 ||
        cap.capArgIndex > 31
      ) {
        throw new Error('selectorCap.capArgIndex must be an integer in [0, 31]');
      }
      if (typeof cap.maxAmount !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(cap.maxAmount)) {
        throw new Error('selectorCap.maxAmount malformed (length)');
      }
      // Tighten to match the parser layer's uint256-max bound — a hand-
      // edited file with maxAmount = "9".repeat(78) would otherwise pass
      // the length regex AND coerce to a value > uint256 max, producing
      // an effective-wildcard cap that no real on-chain value can reach.
      if (BigInt(cap.maxAmount) > UINT256_MAX_LOCAL) {
        throw new Error('selectorCap.maxAmount exceeds uint256 max');
      }
    }
    caps.push({
      selector: (cap.selector as string).toLowerCase() as `0x${string}`,
      capArgIndex: indexNull ? null : (cap.capArgIndex as number),
      maxAmount: indexNull ? null : (cap.maxAmount as string),
    });
  }
  if (typeof o.validUntilSec !== 'number' || o.validUntilSec <= 0) {
    throw new Error('snapshot.validUntilSec malformed');
  }
  if (typeof o.mintedAtSec !== 'number' || o.mintedAtSec <= 0) {
    throw new Error('snapshot.mintedAtSec malformed');
  }
  if (o.consentActionHash !== undefined) {
    if (typeof o.consentActionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.consentActionHash)) {
      throw new Error('snapshot.consentActionHash malformed');
    }
  }
  if (o.consentTextSha256 !== undefined) {
    if (typeof o.consentTextSha256 !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.consentTextSha256)) {
      throw new Error('snapshot.consentTextSha256 malformed');
    }
  }
  return {
    sessionId: o.sessionId,
    mode: 'scoped',
    signerAddress: (o.signerAddress as string).toLowerCase() as `0x${string}`,
    targetContracts: (o.targetContracts as string[]).map(
      (t) => t.toLowerCase() as `0x${string}`,
    ),
    selectorCaps: caps,
    validUntilSec: o.validUntilSec,
    mintedAtSec: o.mintedAtSec,
    ...(o.consentActionHash === undefined
      ? {}
      : { consentActionHash: (o.consentActionHash as string).toLowerCase() as `0x${string}` }),
    ...(o.consentTextSha256 === undefined
      ? {}
      : { consentTextSha256: (o.consentTextSha256 as string).toLowerCase() as `0x${string}` }),
  };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- enforcement primitives ----------

/**
 * Extract the uint256 value at word index `wordIndex` of an ABI-encoded
 * calldata blob (counting from 0 AFTER the 4-byte selector). Returns
 * the integer value as bigint.
 *
 * Layout assumption:
 *   bytes 0..3                 selector (4 bytes, 8 hex chars)
 *   bytes 4..35                arg word 0 (32 bytes, 64 hex chars)
 *   bytes 4+32n..35+32n        arg word n (32 bytes each)
 *
 * For `subscription.purchase(address token, InEuint128 encShares,
 * uint128 maxSharesHint, address ephemeralEOA)`:
 *   wordIndex 0 → bytes 4..35   = `token` left-zero-padded to 32 bytes
 *   wordIndex 1 → bytes 36..67  = InEuint128 dynamic-offset
 *   wordIndex 2 → bytes 68..99  = `maxSharesHint` left-zero-padded per Solidity ABI v1 (value in low 16 bytes; decoded as big-endian uint256 returns the value)
 *   wordIndex 3 → bytes 100..131 = `ephemeralEOA` left-zero-padded
 *
 * **CRITICAL — static-arg-encoding assumption:** the decoder reads
 * the raw 32-byte word at the offset, treating it as a uint256. For
 * dynamic-typed args (`bytes`, `string`, dynamic struct head), the
 * 32-byte slot at that offset is the OFFSET to the dynamic tail, NOT
 * the value. Future targets with dynamic args at-or-before the cap
 * index MUST NOT be added to a snapshot without an ABI-aware decoder.
 * For Slice 1, all curated targets are checked at policy-mint time.
 *
 * Throws if callData is too short to carry word `wordIndex`.
 */
export function decodeUint256ArgAt(
  callDataHex: `0x${string}`,
  wordIndex: number,
): bigint {
  if (!Number.isInteger(wordIndex) || wordIndex < 0) {
    throw new Error(`wordIndex must be a non-negative integer (got ${wordIndex})`);
  }
  // "0x" (2) + 8 selector hex + (wordIndex+1) * 64 hex = required min length
  const requiredLen = 2 + 8 + (wordIndex + 1) * 64;
  if (callDataHex.length < requiredLen) {
    throw new Error(
      `callData length ${callDataHex.length} too short to carry word ${wordIndex} (need ≥${requiredLen} chars)`,
    );
  }
  const wordStart = 2 + 8 + wordIndex * 64;
  const argHex = callDataHex.slice(wordStart, wordStart + 64);
  return BigInt(`0x${argHex}`);
}

/** Strict decoder for a 4-byte selector at the start of calldata. */
export function selectorOf(callDataHex: `0x${string}`): `0x${string}` {
  return callDataHex.slice(0, 10).toLowerCase() as `0x${string}`;
}

export interface PolicyCheckInput {
  readonly snapshot: PolicySnapshot;
  readonly innerCall: {
    readonly target: `0x${string}`;
    readonly callData: `0x${string}`;
  };
  /** Broker's loaded signer address (Trust Architect H-1). Must match
   *  `snapshot.signerAddress` (case-insensitive) or check fails with
   *  `policy_violation` — defends against a snapshot minted for a
   *  rotated/different session-key being applied to the active one. */
  readonly activeSigner: `0x${string}`;
  readonly nowSec: number;
}

export type PolicyCheckResult =
  | { ok: true }
  | {
      ok: false;
      /** Mirrors the BrokerErrorCode subset used for sign_userop rejections. */
      code: 'scope_violation' | 'policy_violation' | 'max_spend_exceeded' | 'no_active_snapshot';
      message: string;
    };

/**
 * Pure policy check — given a snapshot and the inner call MCP wants to
 * sign, decide whether the broker should proceed. No I/O, no logging —
 * the daemon composes side effects (audit, signing).
 *
 * Order of checks (each surfaces its own error code):
 *  1. Snapshot expiry (`scope_violation`).
 *  2. Signer binding (`policy_violation`) — snapshot's `signerAddress`
 *     must match the broker's active signer.
 *  3. Target allowlist match (`policy_violation`).
 *  4. Selector lookup in `selectorCaps` (`policy_violation`).
 *  5. Per-selector arg cap (`max_spend_exceeded`) — only when the
 *     matched selectorCap has a non-null `capArgIndex`.
 */
export function checkPolicy(input: PolicyCheckInput): PolicyCheckResult {
  const { snapshot, innerCall, activeSigner, nowSec } = input;

  if (snapshot.validUntilSec <= nowSec) {
    return {
      ok: false,
      code: 'scope_violation',
      message: `snapshot ${snapshot.sessionId} expired at ${snapshot.validUntilSec} (now ${nowSec})`,
    };
  }

  if (snapshot.signerAddress.toLowerCase() !== activeSigner.toLowerCase()) {
    return {
      ok: false,
      code: 'policy_violation',
      message: `snapshot ${snapshot.sessionId} bound to signer ${snapshot.signerAddress}, broker active signer is ${activeSigner}`,
    };
  }

  const targetLower = innerCall.target.toLowerCase();
  const targetMatch = snapshot.targetContracts.some((t) => t === targetLower);
  if (!targetMatch) {
    return {
      ok: false,
      code: 'policy_violation',
      message: `target ${innerCall.target} not in allowlist for session ${snapshot.sessionId}`,
    };
  }

  const selector = selectorOf(innerCall.callData);
  const rule = snapshot.selectorCaps.find((c) => c.selector === selector);
  if (!rule) {
    return {
      ok: false,
      code: 'policy_violation',
      message: `selector ${selector} not in selectorCaps for session ${snapshot.sessionId}`,
    };
  }

  if (rule.capArgIndex !== null && rule.maxAmount !== null) {
    let argValue: bigint;
    try {
      argValue = decodeUint256ArgAt(innerCall.callData, rule.capArgIndex);
    } catch (err) {
      return {
        ok: false,
        code: 'policy_violation',
        message: `callData decode failed at wordIndex ${rule.capArgIndex}: ${asMessage(err)}`,
      };
    }
    const cap = BigInt(rule.maxAmount);
    if (argValue > cap) {
      return {
        ok: false,
        code: 'max_spend_exceeded',
        message: `arg word[${rule.capArgIndex}] = ${argValue} exceeds maxAmount ${cap} for selector ${selector} (session ${snapshot.sessionId})`,
      };
    }
  }

  return { ok: true };
}
