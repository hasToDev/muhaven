import { z } from 'zod';
import { TIER_VALUES, type Tier } from '../../../domain/agent/model/tier.enum.js';
import { SURFACE_VALUES, type Surface } from '../../../domain/agent/model/surface.enum.js';
import type { Trigger } from '../../../domain/agent/model/trigger.enum.js';
import type { ActionId } from '../../../domain/agent/model/action-id.enum.js';
import { AUDIT_EVENT_TYPE_VALUES, type AuditEventType } from '../../../domain/agent/model/audit-event-type.enum.js';
import type { AgentUserState } from '../../../domain/agent/model/agent-user-state.js';
import type { AgentAuditEvent } from '../../../domain/agent/model/agent-audit-event.js';
import type {
  ScopedSession,
  ScopedSelectorCap,
  ScopedSessionEnableStatus,
  ScopedSessionInstallMaterial,
} from '../../../domain/agent/model/scoped-session.js';
import type { ScopedSessionStatus } from '../../../domain/agent/model/scoped-session-status.enum.js';

/**
 * Wave 5 Option D · Commit 1 (D-3) — Scoped tier TTL ceiling (seconds).
 *
 * MUST equal `frontend/src/views/agent/policy-scoped.helpers.ts::
 * SCOPED_MAX_TTL_SEC`. Both surfaces enforce the same value; the
 * frontend is the UX gate, the backend is the trust boundary against
 * non-dashboard clients (MCP, havenbot, openclaw, checkout, hand-curl).
 *
 * SecEng-HIGH-1 (multi-agent review 2026-05-23) — having a server-side
 * source-of-truth closes a 3× blast-radius gap under broker compromise.
 * A future revision MUST update both sites in lockstep.
 */
export const SCOPED_MAX_TTL_SEC = 28_800;

const tierSchema = z.enum(TIER_VALUES as readonly [Tier, ...Tier[]]);
const surfaceSchema = z.enum(SURFACE_VALUES as readonly [Surface, ...Surface[]]);
const actionIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
const auditEventTypeSchema = z.enum(
  AUDIT_EVENT_TYPE_VALUES as readonly [AuditEventType, ...AuditEventType[]],
);

export const RequestTierTransitionDtoSchema = z
  .object({
    surface: surfaceSchema,
    targetTier: tierSchema,
  })
  .strict();

export type RequestTierTransitionDto = z.infer<typeof RequestTierTransitionDtoSchema>;

export const CommitTierTransitionDtoSchema = z
  .object({
    surface: surfaceSchema,
    targetTier: tierSchema,
    confirmationToken: z.string().min(8).max(128),
  })
  .strict();

export type CommitTierTransitionDto = z.infer<typeof CommitTierTransitionDtoSchema>;

export const PauseDtoSchema = z
  .object({
    surface: surfaceSchema.optional(),
  })
  .strict();

export type PauseDto = z.infer<typeof PauseDtoSchema>;

export const ResumeDtoSchema = z
  .object({
    surface: surfaceSchema,
  })
  .strict();

export type ResumeDto = z.infer<typeof ResumeDtoSchema>;

export const BuildPermissionTemplateDtoSchema = z
  .object({
    tier: tierSchema,
    actions: z.array(actionIdSchema).min(0),
    ttlSec: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export type BuildPermissionTemplateDto = z.infer<typeof BuildPermissionTemplateDtoSchema>;

export const AuditQueryDtoSchema = z
  .object({
    surface: surfaceSchema.optional(),
    eventTypes: z.array(auditEventTypeSchema).max(20).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AuditQueryDto = z.infer<typeof AuditQueryDtoSchema>;

export interface AgentUserStateDto {
  userId: string;
  surface: Surface;
  tier: Tier;
  pausedAt: string | null;
  pauseTrigger: Trigger | null;
  pauseMetadata: Record<string, unknown> | null;
  enteredAt: string;
  validatorAddress: string | null;
  confirmedActionCount: number;
  riskQuestionnaireComplete: boolean;
  updatedAt: string;
}

export function toUserStateDto(state: AgentUserState): AgentUserStateDto {
  return {
    userId: state.userId,
    surface: state.surface,
    tier: state.tier,
    pausedAt: state.pausedAt?.toISOString() ?? null,
    pauseTrigger: state.pauseTrigger,
    pauseMetadata: state.pauseMetadata,
    enteredAt: state.enteredAt.toISOString(),
    validatorAddress: state.validatorAddress,
    confirmedActionCount: state.confirmedActionCount,
    riskQuestionnaireComplete: state.riskQuestionnaireComplete,
    updatedAt: state.updatedAt.toISOString(),
  };
}

export interface AgentAuditEventDto {
  id: string;
  userId: string;
  surface: Surface;
  eventType: AuditEventType;
  tierBefore: Tier | null;
  tierAfter: Tier | null;
  trigger: Trigger | null;
  actionId: ActionId | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function toAuditEventDto(event: AgentAuditEvent): AgentAuditEventDto {
  return {
    id: event.id,
    userId: event.userId,
    surface: event.surface,
    eventType: event.eventType,
    tierBefore: event.tierBefore,
    tierAfter: event.tierAfter,
    trigger: event.trigger,
    actionId: event.actionId,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  };
}

export interface PolicyStateResponseDto {
  /**
   * The authenticated user's on-chain kernel smart-account address
   * (0x-prefixed 20-byte hex; sourced from the SIWE-verified
   * `authPayload.walletAddress`, NOT from the JWT subject which is a
   * UUID). Surfaced at the top level (not just on `surfaces[n].userId`)
   * so MCP clients can resolve the kernel address without ordering /
   * non-empty assumptions about the surfaces array.
   *
   * Wave 5 Path D Slice 1 (Commit 3) — added so the MCP server can
   * resolve the kernel address before building a Path D UserOp. Slice 2
   * will extend further with an `activeScopedSession` block carrying
   * the in-force snapshot summary (RD-3).
   *
   * Pickup A follow-up — earlier doc claimed "= JWT subject"; the
   * implementation matched the wrong doc and emitted the UUID. The
   * MCP server's `attemptPathD` validates `^0x[0-9a-fA-F]{40}$` on
   * this field and a UUID can never match → forced
   * `no_validator_registered` for every user, every call. Both the
   * doc and the impl rotated to walletAddress in the same diff.
   */
  accountAddress: string;
  surfaces: AgentUserStateDto[];
}

export interface PauseResponseDto {
  pausedSurfaces: Surface[];
  cascade: boolean;
}

export interface AuditQueryResponseDto {
  items: AgentAuditEventDto[];
  cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Wave 5 Path D Slice 2 Commit 2.A — scoped-session mirror DTO + Zod wire
// validators. Mirrors the broker's `PolicySnapshotWire` shape in
// `packages/mcp/src/broker/protocol.ts` so the data round-trips
// frontend → backend mirror → MCP server → broker keystore without
// reshape. Re-validation here is defense-in-depth — the broker's wire
// parser also enforces these constraints, but the backend cannot trust
// any field a malicious frontend POST might set.
// ─────────────────────────────────────────────────────────────────────────

const HEX_4_BYTE_RE = /^0x[0-9a-fA-F]{8}$/;
const HEX_20_BYTE_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_32_BYTE_RE = /^0x[0-9a-fA-F]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Wave 5 Option D · Commit 2 — `enableData` shape gate.
 * Cleartext `0x` + 2–65536 hex chars (4–65538 total).
 *
 * **Hot-patch 2026-05-23**: the original `{2,8192}` bound (~4KB
 * cleartext) was sized for a small policy count. The real
 * `SCOPED_AUTONOMOUS_PERMISSIONS` set on Wave 5 prod has ~125
 * permissions (subscription × 2 + per-token queues × 22 + per-token
 * snapshots × 77 + setOperator + refresh-grants ~25), yielding an
 * ABI-encoded `getEnableData()` payload of ~15KB binary = ~30KB
 * hex. The operator's first C2 mint hit `got 30146 chars`. Raising
 * to 65536 hex (~32KB cleartext) gives ~2× safety margin for future
 * permission growth (~500 selectors). Empty hex (`0x`) still
 * rejected — kernel rejects 0-length validatorData at install.
 */
const ENABLE_DATA_HEX_RE = /^0x[0-9a-fA-F]{2,65536}$/;
/**
 * Wave 5 Option D · Commit 2 — `enableSig` shape gate.
 * Cleartext `0x` + 256–16384 hex chars (258–16386 total).
 *
 * Multi-agent review SecEng H-3 absorbed — the 128-char floor accepted
 * a bare 65-byte ECDSA `(r,s,v)` signature (130 hex), which is NOT the
 * shape `@zerodev/passkey-validator::signTypedData` returns. The
 * tightened 256-hex floor admits the absolute floor of a WebAuthn
 * envelope (authenticatorData ≥ 37 bytes + clientDataJSON ≥ 60 bytes
 * + DER ECDSA ≥ 70 bytes ≈ 167 bytes raw; the 256-hex floor is a
 * small safety margin under that).
 *
 * **Hot-patch 2026-05-23**: upper bound raised 4096 → 16384 hex
 * (~8KB) preemptively alongside the enableData hot-patch — some
 * platform-authenticator attestation flows can emit envelopes
 * past 2KB; the operator hasn't hit this yet but the asymmetric
 * bound risk (enable_data hit limit on first mint, enable_sig might
 * on a different device) is cheap to close in the same deploy.
 */
const ENABLE_SIG_HEX_RE = /^0x[0-9a-fA-F]{256,16384}$/;
/** uint256 decimal — 0 alone OR a non-zero leading digit followed by ≤77 digits. */
const UINT256_DEC_RE = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;

const uint256DecString = z
  .string()
  .regex(UINT256_DEC_RE, 'must be a uint256 decimal string')
  .refine((s) => BigInt(s) <= UINT256_MAX, 'exceeds uint256 max (2^256-1)');

/**
 * Static-arg encoding caveat (Slice 1 invariant): the broker's
 * `decodeUint256ArgAt` decoder reads the 32-byte word at the cap offset
 * directly. For dynamic-typed args (`bytes`, `string`, dynamic struct
 * head), the slot at that offset is an OFFSET to the dynamic tail, not
 * the value — so a cap on such an arg trivially passes against the
 * small offset value. Slice 1 only ships `subscription.purchase`
 * (static at slot 2); future selectors with dynamic args at-or-before
 * the cap index MUST add an ABI-aware decoder, or reject at mint.
 */
export const ScopedSelectorCapSchema = z
  .object({
    selector: z
      .string()
      .regex(HEX_4_BYTE_RE, 'selector must be a 0x-prefixed 4-byte hex'),
    capArgIndex: z.union([z.number().int().min(0).max(31), z.null()]),
    maxAmount: z.union([uint256DecString, z.null()]),
  })
  .strict()
  .refine(
    (c) => (c.capArgIndex === null) === (c.maxAmount === null),
    'capArgIndex and maxAmount must both be null or both non-null',
  );

/**
 * The body shape the dashboard POSTs to `POST /policy/scoped-session`.
 * Carries the broker's wire-shape verbatim AS `snapshot` so the mirror
 * → broker auto-sync (Commit 2.B) is a pass-through, plus the
 * user-intent `maxPerOpUsd6` (mhUSDC base-6 ceiling, distinct from
 * `selectorCaps[i].maxAmount` which is in selector-native unit).
 *
 * Defense-in-depth: every regex / range constraint mirrors the broker's
 * own parser. The mint use-case re-checks `signerAddress` shape +
 * `targetContracts.includes(subscription)` etc; defense-in-depth here
 * makes invalid input bounce before any DB write.
 */
export const MintScopedSessionDtoSchema = z
  .object({
    snapshot: z
      .object({
        sessionId: z.string().regex(SESSION_ID_RE),
        mode: z.literal('scoped'),
        signerAddress: z
          .string()
          .regex(HEX_20_BYTE_RE, 'signerAddress must be a 0x-prefixed 20-byte hex'),
        targetContracts: z
          .array(z.string().regex(HEX_20_BYTE_RE, 'invalid target contract'))
          .min(1)
          .max(32),
        selectorCaps: z.array(ScopedSelectorCapSchema).min(1).max(32),
        // Epoch seconds. Capped at `Number.MAX_SAFE_INTEGER` (≈ year
        // 287_396_259) so a malicious frontend POSTing `1e18` (within
        // int8 range but past JS's safe-integer range) gets rejected at
        // the wire instead of round-tripping through the Pg `bigint`
        // with IEEE 754 precision loss. The bound is well past any
        // plausible TTL ceiling.
        validUntilSec: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        mintedAtSec: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        consentActionHash: z.string().regex(HEX_32_BYTE_RE).optional(),
        consentTextSha256: z.string().regex(HEX_32_BYTE_RE).optional(),
        /** 4-byte permissionId. Pickup B (commit `1a28618`) frontends
         *  populate it; kept `.optional()` here for back-compat with
         *  pre-Pickup-B clients (legacy stage frontends, hand-curled
         *  POSTs, future external mint clients). MCP server's
         *  `attemptPathD` returns `no_permission_id_in_snapshot` when
         *  absent → Path C deep-link fallback. Tighten to required
         *  when all known clients are Pickup B+. */
        permissionId: z.string().regex(HEX_4_BYTE_RE).optional(),
        /**
         * Wave 5 Option D · Commit 2 — captured install material. The
         * frontend mint ceremony reads `validatorNonce` via
         * `getKernelV3Nonce`, `enableData` via
         * `permissionValidator.getEnableData(accountAddress)`, and
         * `enableSig` via passkey-signed
         * `getPluginsEnableTypedData(...)`. All three are `.optional()`
         * on the DTO because:
         *
         *   - Pre-C2 frontends (legacy stage, hand-curled POSTs) don't
         *     supply them → mint still succeeds, `enable_status`
         *     stays NULL, the mirror row degrades cleanly to Path C
         *     deep-link via the existing `no_active_session_key`
         *     fallback chain.
         *   - The strict-required gate moves to C3 / later when every
         *     known client is on the C2 wire shape.
         *
         * Shape-validated via regex AND length-bounded (the regex
         * already enforces the length, but Zod's separate refine gives
         * a clearer error message). `validatorNonce` is bounded to
         * uint32 (kernel V3.1 `currentNonce` is uint32; > uint32 would
         * round-trip incorrectly through Drizzle's `mode: 'number'`).
         */
        enableData: z.string().regex(ENABLE_DATA_HEX_RE).optional(),
        enableSig: z.string().regex(ENABLE_SIG_HEX_RE).optional(),
        validatorNonce: z
          .number()
          .int()
          .min(0)
          .max(4_294_967_295)
          .optional(),
      })
      .strict(),
    /** User-intent USDC ceiling in 6-decimal base. Distinct from the
     *  per-selector `maxAmount` (which is in selector-native unit, e.g.
     *  shares for `subscription.purchase`). The dashboard banner
     *  displays this; Slice 5 spend ledger references it as the
     *  cumulative cap. */
    maxPerOpUsd6: uint256DecString,
    surface: surfaceSchema,
  })
  .strict()
  .refine(
    (input) => {
      // `selectorCaps[i].selector` MUST be unique within the array —
      // mirrors `parsePolicySnapshot::seenSelectors` in the broker.
      const seen = new Set<string>();
      for (const cap of input.snapshot.selectorCaps) {
        const lower = cap.selector.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
      }
      return true;
    },
    { message: 'selectorCaps contains duplicate selectors' },
  )
  .refine(
    (input) => {
      // Wave 5 Option D · Commit 2 — install-material trio is
      // all-or-none. A partial capture (e.g. enableSig without
      // enableData) lands a half-broken row that C3's MCP-side
      // ENABLE-mode UserOp can't compose; better to bounce at the
      // wire than persist a structurally-orphaned mirror entry.
      // Multi-agent review SecEng M-2 + Codex L-3 absorbed.
      const fields = [
        input.snapshot.enableData,
        input.snapshot.enableSig,
        input.snapshot.validatorNonce,
      ];
      const presentCount = fields.filter((v) => v !== undefined).length;
      return presentCount === 0 || presentCount === 3;
    },
    {
      message:
        'install material (enableData, enableSig, validatorNonce) must be all-present or all-absent — partial captures rejected (Option D · C2).',
    },
  )
  .refine(
    (input) => {
      // Wave 5 Option D · Commit 1 (D-3) — server-side TTL ceiling.
      // The frontend `policy-scoped.helpers.ts::SCOPED_MAX_TTL_SEC`
      // caps Scoped sessions at 28_800s (8h), but the dashboard is
      // not the only client; MCP / havenbot / openclaw / checkout
      // surfaces or a custom script can POST directly. SecEng-HIGH-1
      // in the multi-agent review (2026-05-23) flagged that a
      // malicious / compromised client can otherwise mint a 24h+
      // session and grow the broker-compromise blast radius 3×.
      // The chain CallPolicy's `toTimestampPolicy(validUntil)`
      // accepts whatever value the frontend passes — so the backend
      // mirror MUST be the source-of-truth ceiling.
      const ttlSec = input.snapshot.validUntilSec - input.snapshot.mintedAtSec;
      return ttlSec > 0 && ttlSec <= SCOPED_MAX_TTL_SEC;
    },
    {
      message: `snapshot TTL (validUntilSec - mintedAtSec) must be in (0, ${SCOPED_MAX_TTL_SEC}] seconds (Option D · D-3 ceiling).`,
    },
  );

export type MintScopedSessionDto = z.infer<typeof MintScopedSessionDtoSchema>;

export const RevokeScopedSessionParamsSchema = z
  .object({
    sessionId: z.string().regex(SESSION_ID_RE),
  })
  .strict();

export type RevokeScopedSessionParams = z.infer<typeof RevokeScopedSessionParamsSchema>;

export const GetScopedSessionQuerySchema = z
  .object({
    surface: surfaceSchema,
  })
  .strict();

export type GetScopedSessionQuery = z.infer<typeof GetScopedSessionQuerySchema>;

export interface ScopedSelectorCapDto {
  selector: string;
  capArgIndex: number | null;
  /** uint256 decimal string — preserves bigint precision across JSON. */
  maxAmount: string | null;
}

export interface ScopedSessionDto {
  sessionId: string;
  /**
   * Discriminator field for Slice 4 wildcard preparation. Today only
   * `'scoped'` is emitted; the field exists so Commit 2.B's MCP auto-sync
   * can construct a `PolicySnapshotWire` (which requires `mode`) by pure
   * DTO pass-through without injecting the constant in MCP-side code.
   * Slice 4 widens the literal union to `'scoped' | 'wildcard'`.
   */
  mode: 'scoped';
  /** Null when the user has been deleted (FK CASCADE SET NULL); the row
   *  is preserved for audit-replay but loses the user binding. */
  userId: string | null;
  surface: Surface;
  status: ScopedSessionStatus;
  signerAddress: string;
  permissionId: string | null;
  targetContracts: readonly string[];
  selectorCaps: readonly ScopedSelectorCapDto[];
  /** uint256 decimal string. */
  maxPerOpUsd6: string;
  totalSpentUsd6: string;
  validUntilSec: number;
  mintedAtSec: number;
  consentActionHash: string | null;
  consentTextSha256: string | null;
  mintedAt: string;
  revokedAt: string | null;
  expiredAt: string | null;
  /**
   * Wave 5 Option D · Commit 2 — install lifecycle fields. NULL on
   * pre-C2 rows + on rows that didn't capture install material at
   * mint. enableData + enableSig are NEVER on this DTO (encrypt-at-
   * rest, redacted from default GET responses); the install-material
   * subroute is the sole reveal point.
   */
  enableStatus: ScopedSessionEnableStatus | null;
  validatorEnabledAt: string | null;
  validatorEnabledTxHash: string | null;
  validatorNonce: number | null;
  /**
   * Wave 5 Slice 2 (auto-reinvest) — user opt-in for the headless
   * claim→buy loop. The Autonomy toggle flips it; the `should-run` gate
   * reads it. Defaults `false`.
   */
  reinvestEnabled: boolean;
}

/**
 * Wave 5 Option D · Commit 2 — internal install-material wire shape.
 * Returned ONLY by the dedicated install-material subroute
 * (`GET /policy/scoped-session/:sessionId/install-material`) which
 * is gated on the `BROKER_CALLBACK_SERVICE_SECRET` shared secret.
 *
 * `enableData` / `enableSig` are pgcrypto-decrypted server-side
 * before this DTO is constructed; both are cleartext 0x-prefixed hex.
 */
export interface ScopedSessionInstallMaterialDto {
  sessionId: string;
  userId: string | null;
  surface: Surface;
  status: ScopedSessionStatus;
  signerAddress: string;
  permissionId: string | null;
  enableStatus: ScopedSessionEnableStatus | null;
  enableData: string | null;
  enableSig: string | null;
  validatorNonce: number | null;
  validatorEnabledAt: string | null;
  validatorEnabledTxHash: string | null;
  validUntilSec: number;
  mintedAtSec: number;
}

export function toScopedSessionInstallMaterialDto(
  m: ScopedSessionInstallMaterial,
): ScopedSessionInstallMaterialDto {
  return {
    sessionId: m.sessionId,
    userId: m.userId,
    surface: m.surface,
    status: m.status,
    signerAddress: m.signerAddress,
    permissionId: m.permissionId,
    enableStatus: m.enableStatus,
    enableData: m.enableData,
    enableSig: m.enableSig,
    validatorNonce: m.validatorNonce,
    validatorEnabledAt: m.validatorEnabledAt?.toISOString() ?? null,
    validatorEnabledTxHash: m.validatorEnabledTxHash,
    validUntilSec: m.validUntilSec,
    mintedAtSec: m.mintedAtSec,
  };
}

// Wave 5 Option D · Commit 2 had a `GetInstallMaterialQuerySchema`
// (a `userId` query-param validator) for the install-material route's
// original shared-service-secret auth model. The C3 third commit moved
// that route to user-JWT auth (userId derived from the verified JWT
// subject, not a query param), so the schema is removed — there's no
// longer a userId query param to validate.

export function toScopedSelectorCapDto(c: ScopedSelectorCap): ScopedSelectorCapDto {
  return {
    selector: c.selector,
    capArgIndex: c.capArgIndex,
    maxAmount: c.maxAmount,
  };
}

export function toScopedSessionDto(session: ScopedSession): ScopedSessionDto {
  return {
    sessionId: session.sessionId,
    mode: 'scoped',
    userId: session.userId,
    surface: session.surface,
    status: session.status,
    signerAddress: session.signerAddress,
    permissionId: session.permissionId,
    targetContracts: session.targetContracts,
    selectorCaps: session.selectorCaps.map(toScopedSelectorCapDto),
    maxPerOpUsd6: session.maxPerOpUsd6.toString(),
    totalSpentUsd6: session.totalSpentUsd6.toString(),
    validUntilSec: session.validUntilSec,
    mintedAtSec: session.mintedAtSec,
    consentActionHash: session.consentActionHash,
    consentTextSha256: session.consentTextSha256,
    mintedAt: session.mintedAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
    expiredAt: session.expiredAt?.toISOString() ?? null,
    // Wave 5 Option D · Commit 2 — install lifecycle fields. enableData
    // + enableSig deliberately omitted (encrypt-at-rest, install-
    // material subroute is the sole reveal point).
    enableStatus: session.enableStatus,
    validatorEnabledAt: session.validatorEnabledAt?.toISOString() ?? null,
    validatorEnabledTxHash: session.validatorEnabledTxHash,
    validatorNonce: session.validatorNonce,
    reinvestEnabled: session.reinvestEnabled,
  };
}
