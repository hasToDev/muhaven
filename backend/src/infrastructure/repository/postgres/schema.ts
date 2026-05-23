import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  jsonb,
  boolean,
  date,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Wave 5 Option D · Commit 2 — `bytea` custom type for the pgcrypto-
 * encrypted columns `agent_scoped_sessions.enable_data` /
 * `enable_sig`. node-postgres returns bytea as `Buffer`; Drizzle's
 * built-in pg-core types don't ship a first-class `bytea` helper, so
 * `customType` is the canonical wiring.
 *
 * Storage shape: `pgp_sym_encrypt(cleartext_text, key) :: bytea`. The
 * repository never round-trips Buffers directly — writes go through
 * `encryptedTextOrNull` (which expands to a `pgp_sym_encrypt(...)`
 * SQL fragment), reads go through a separate raw-SELECT path that
 * applies `pgp_sym_decrypt(...)`. Default relational `findFirst` calls
 * use Drizzle's `columns: { enableData: false, enableSig: false }`
 * exclusion to keep the encrypted blobs out of the default response.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const escrowStatusEnum = pgEnum('escrow_status', [
  'PENDING',
  'ON_CHAIN',
  'PROCESSING',
  'SETTLED',
  'REDEEMED',
  'EXPIRED',
  'CANCELED',
  'FAILED',
]);

export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'PENDING_REDEEM',
  'PENDING_BRIDGE',
  'BRIDGING',
  'COMPLETED',
  'FAILED',
]);

export const walletProviderEnum = pgEnum('wallet_provider', [
  'zerodev',
  'walletconnect',
  'injected',
]);

export const userRoleEnum = pgEnum('user_role', ['investor', 'issuer']);

/**
 * Phase 9.A · Expansion (F2) — issuer KYB lifecycle. `unregistered` is the
 * default for non-issuers (and for issuer-roled users who haven't yet
 * walked through `/apply-issuer`). `pending` is reserved for the future
 * KYB-review queue; today the wizard auto-approves and skips this state.
 * `suspended` is governance-revoked — no path lands here yet, but the
 * enum value is reserved so a future ops tool can flip it.
 */
export const issuerStatusEnum = pgEnum('issuer_status', [
  'unregistered',
  'pending',
  'approved',
  'suspended',
]);

/**
 * Phase 9.A · Expansion (F2) — token deploy job lifecycle for the
 * self-serve onboarding wizard. The HTTP layer creates a row with status
 * `running`, the deploy library writes step transitions through the
 * progress callback, and the final outcome lands as `succeeded`
 * (with `result_token_address`) or `failed` (with `error_message` +
 * `last_step`).
 */
export const deployStatusEnum = pgEnum('deploy_status', [
  'running',
  'succeeded',
  'failed',
]);

export const escrowEventTypeEnum = pgEnum('escrow_event_type', [
  'EscrowCreated',
  'EscrowSettled',
  'EscrowRedeemed',
]);

// Wave 5 Q3 — YieldDistributionCron audit lifecycle. The runner writes
// `in_progress` BEFORE `openEpoch` so a crash between openEpoch and the
// post-fund DB write leaves a row that resume logic keys off — see
// `yield-epoch-runner.ts` step transitions. Terminal: `success` | `failure`.
export const yieldDistributionStatusEnum = pgEnum('yield_distribution_status', [
  'in_progress',
  'snapshot_done',
  'funded_no_audit',
  'success',
  'failure',
]);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    walletAddress: text('wallet_address').unique().notNull(),
    walletProvider: walletProviderEnum('wallet_provider').notNull(),
    role: userRoleEnum('role').notNull().default('investor'),
    email: text('email'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    // Phase 9.A · Expansion (F2) — issuer KYB metadata. `issuerStatus`
    // defaults to `unregistered` for everyone (including new issuer-roled
    // signups, until they walk through `/apply-issuer`); the existing
    // demo issuer rows are flipped to `approved` via
    // `backend/scripts/backfill-issuer-status.ts`. `issuerKybSubmission`
    // captures the raw wizard payload so a future re-review queue can
    // surface what was claimed at apply time.
    issuerStatus: issuerStatusEnum('issuer_status').notNull().default('unregistered'),
    issuerDisplayName: text('issuer_display_name'),
    issuerJurisdiction: text('issuer_jurisdiction'),
    issuerApprovedAt: timestamp('issuer_approved_at'),
    issuerKybSubmission: jsonb('issuer_kyb_submission'),
  },
  (t) => [
    index('users_wallet_address_idx').on(t.walletAddress),
    index('users_issuer_status_idx').on(t.issuerStatus),
  ],
);

/**
 * Phase 9.A · Expansion (F2) — per-deploy job rows for the self-serve
 * issuer onboarding wizard. One row per deploy attempt. The HTTP handler
 * inserts on `POST /v1/issuer/tokens/deploy`, mutates `lastStep` as the
 * progress callback fires, and finalises with `status = succeeded` (plus
 * `resultTokenAddress`) or `status = failed` (plus `errorMessage` +
 * `lastStep`). The SSE channel is in-process; the row is the
 * reconnect-from-anywhere fallback when the SSE socket drops.
 */
export const issuerTokenDeploys = pgTable(
  'issuer_token_deploys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    symbol: text('symbol').notNull(),
    config: jsonb('config').notNull(),
    status: deployStatusEnum('status').notNull().default('running'),
    lastStep: text('last_step'),
    resultTokenAddress: text('result_token_address'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    index('issuer_token_deploys_user_id_idx').on(t.userId),
    index('issuer_token_deploys_status_idx').on(t.status),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    refreshToken: text('refresh_token').unique().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => [
    index('sessions_refresh_token_idx').on(t.refreshToken),
    index('sessions_user_id_idx').on(t.userId),
  ],
);

export const nonces = pgTable(
  'nonces',
  {
    walletAddress: text('wallet_address').notNull(),
    nonce: text('nonce').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.walletAddress, t.nonce] })],
);

export const escrows = pgTable(
  'escrows',
  {
    id: text('id').primaryKey(),
    publicId: text('public_id').unique().notNull(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    type: text('type').notNull(),
    counterparty: text('counterparty'),
    deadline: timestamp('deadline'),
    externalReference: text('external_reference'),
    amount: numeric('amount').notNull(),
    currencyType: text('currency_type').notNull(),
    currencyCode: text('currency_code').notNull(),
    status: escrowStatusEnum('status').notNull().default('PENDING'),
    walletId: text('wallet_id').notNull(),
    metadata: jsonb('metadata'),
    onChainEscrowId: text('on_chain_escrow_id'),
    txHash: text('tx_hash'),
    distributionId: integer('distribution_id'),
    tokenAddress: text('token_address'),
    beneficiary: text('beneficiary'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('escrows_public_id_idx').on(t.publicId),
    index('escrows_user_id_status_idx').on(t.userId, t.status),
    index('escrows_tx_hash_idx').on(t.txHash),
    index('escrows_on_chain_escrow_id_idx').on(t.onChainEscrowId),
  ],
);

export const withdrawals = pgTable(
  'withdrawals',
  {
    id: text('id').primaryKey(),
    publicId: text('public_id').unique().notNull(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    walletId: text('wallet_id').notNull(),
    escrowIds: jsonb('escrow_ids').notNull().$type<number[]>(),
    destinationChain: integer('destination_chain').notNull(),
    destinationDomain: integer('destination_domain').notNull(),
    recipientAddress: text('recipient_address').notNull(),
    status: withdrawalStatusEnum('status').notNull().default('PENDING_REDEEM'),
    estimatedAmount: numeric('estimated_amount').notNull(),
    walletProvider: text('wallet_provider').notNull(),
    actualAmount: numeric('actual_amount'),
    fee: numeric('fee'),
    redeemTxHash: text('redeem_tx_hash'),
    bridgeTxHash: text('bridge_tx_hash'),
    destinationTxHash: text('destination_tx_hash'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    index('withdrawals_public_id_idx').on(t.publicId),
    index('withdrawals_user_id_status_idx').on(t.userId, t.status),
  ],
);

export const assetClassEnum = pgEnum('asset_class', [
  'treasury',
  'money_market',
  'private_credit',
  'real_estate',
  'other',
]);

export const tokenStatusEnum = pgEnum('token_status', [
  'active',
  'paused',
  'winding_down',
  'archived',
]);

export const navSourceTypeEnum = pgEnum('nav_source_type', [
  'on_chain',
  'api',
  'manual',
]);

export const yieldStatusEnum = pgEnum('yield_status', [
  'pending',
  'claimable',
  'claimed',
  'expired',
]);

export const rwaTokens = pgTable(
  'rwa_tokens',
  {
    id: text('id').primaryKey(),
    address: text('address').unique().notNull(),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    issuerAddress: text('issuer_address').notNull(),
    apy: numeric('apy'),
    yieldSchedule: text('yield_schedule'),
    kycTier: integer('kyc_tier').notNull().default(1),
    assetClass: assetClassEnum('asset_class').notNull().default('other'),
    minInvestment: numeric('min_investment'),
    status: tokenStatusEnum('status').notNull().default('active'),
    // Wave 5+ per-token YieldSnapshot proxy (2026-05-23). Nullable
    // because legacy seed rows predate per-token snapshots — those
    // tokens fall back to the singleton snapshot proxy resolved via
    // the frontend's `VITE_YIELD_SNAPSHOT_ADDRESS` env-var on
    // `getYieldSnapshot()` miss.
    yieldSnapshotAddress: text('yield_snapshot_address'),
    // Wave 5 Q3 (v3.1 A2) — per-token override of the global
    // `YIELD_CRON_MAX_SUPPLY_CAP` env. Nullable: null means "use global
    // default." Set per-token when supply patterns warrant a tighter
    // overage cap — protects against the silent-fail correctness footgun
    // the day actual MuHaven supply crosses the blanket 10M cap. uint128
    // base units (39 digits = uint128.max).
    maxSupplyCapOverride: numeric('max_supply_cap_override', { precision: 39, scale: 0 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    pausedAt: timestamp('paused_at'),
    windingDownAt: timestamp('winding_down_at'),
    archivedAt: timestamp('archived_at'),
  },
  (t) => [
    index('rwa_tokens_address_idx').on(t.address),
    index('rwa_tokens_issuer_address_idx').on(t.issuerAddress),
    index('rwa_tokens_status_idx').on(t.status),
  ],
);

export const portfolios = pgTable(
  'portfolios',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull(),
    lastSyncedAt: timestamp('last_synced_at'),
  },
  (t) => [
    index('portfolios_user_id_idx').on(t.userId),
    uniqueIndex('portfolios_user_token_idx').on(t.userId, t.tokenAddress),
  ],
);

export const yieldRecords = pgTable(
  'yield_records',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    distributionId: integer('distribution_id').notNull(),
    escrowId: text('escrow_id'),
    tokenAddress: text('token_address').notNull(),
    amount: numeric('amount'),
    status: yieldStatusEnum('status').notNull().default('pending'),
    claimedAt: timestamp('claimed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('yield_records_user_id_idx').on(t.userId),
    index('yield_records_distribution_id_idx').on(t.distributionId),
    index('yield_records_escrow_id_idx').on(t.escrowId),
  ],
);

export const escrowEvents = pgTable(
  'escrow_events',
  {
    txHash: text('tx_hash').primaryKey(),
    escrowId: text('escrow_id').notNull(),
    eventType: escrowEventTypeEnum('event_type').notNull(),
    blockNumber: text('block_number').notNull(),
    createdAt: text('created_at').notNull(),
    ttl: integer('ttl').notNull(),
    messageHash: text('message_hash'),
    amount: text('amount'),
  },
  (t) => [index('escrow_events_escrow_id_idx').on(t.escrowId)],
);

export const tokenNavHistory = pgTable(
  'token_nav_history',
  {
    id: text('id').primaryKey(),
    tokenAddress: text('token_address').notNull(),
    nav: numeric('nav').notNull(),
    apy: numeric('apy'),
    totalAum: numeric('total_aum'),
    yieldRate: numeric('yield_rate'),
    source: text('source').notNull(),
    sourceType: navSourceTypeEnum('source_type').notNull(),
    sourceTimestamp: timestamp('source_timestamp'),
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('token_nav_history_token_address_idx').on(t.tokenAddress),
    index('token_nav_history_fetched_at_idx').on(t.fetchedAt),
  ],
);

/**
 * Wave 3.5 tax-event marker store (ADR-020). Plaintext markers ONLY — no
 * encrypted-derived amounts. The investor reconstructs amounts client-side
 * from their decrypted handle + the recorded NAV-at-time. PRIMARY KEY is
 * `(tx_hash, log_index)` so reorgs that re-emit the same log don't double-
 * count, and so backfill replays are idempotent.
 *
 * Wave 3.5 contracts emit `Purchased` / `Redeemed` / `QueueClaimed` /
 * `YieldClaimed` (not the ADR-020 names directly). The indexer maps:
 *   Purchased         → 'Acquisition'
 *   Redeemed          → 'Disposition' (instant)
 *   QueueClaimed      → 'Disposition' (queued)
 *   YieldClaimed      → 'IncomeAccrual'
 * `FeeEvent` (paymaster ops) is deferred — the Wave 3.5 paymaster wiring
 * doesn't surface a per-investor gas charge yet.
 */
export const taxEventTypeEnum = pgEnum('tax_event_type', [
  'Acquisition',
  'Disposition',
  'IncomeAccrual',
  'FeeEvent',
  // Phase 9.A · Option Z — cash conversions surfaced via MuHavenStable
  // Wrap/Unwrap events. The encrypted amount handle lives in
  // `tax_events.metadata.encrypted_amount_handle`; investor decrypts via
  // permit. `tokenAddress` is null for these rows (cash isn't an RWA).
  'Wrap',
  'Unwrap',
  // Phase 9.A · Option Z follow-up — P2P share transfers surfaced via
  // `MuHavenToken.Transfer(from, to, amount)` (broadened in this round).
  // The indexer inserts TWO rows per qualifying event — one keyed by
  // sender, one by recipient — distinguished by `metadata.direction`
  // ('outbound' | 'inbound') and `metadata.counterparty`. PK is extended
  // to include `holder_address` to allow the two rows to share
  // `(tx_hash, log_index)`. Mints/burns/protocol-mediated moves are
  // filtered out at the indexer level.
  'Transfer',
]);

export const taxEvents = pgTable(
  'tax_events',
  {
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    eventType: taxEventTypeEnum('event_type').notNull(),
    holderAddress: text('holder_address').notNull(),
    tokenAddress: text('token_address'),
    blockNumber: text('block_number').notNull(),
    blockTimestamp: timestamp('block_timestamp').notNull(),
    /**
     * Plaintext NAV at the block timestamp (1e8 fixed-point string). Pulled
     * from the oracle at index time so the investor doesn't need to back-
     * resolve historical NAV during CSV export. Null when the event has no
     * NAV semantic (income-accrual, fee).
     */
    navAtTime: numeric('nav_at_time'),
    /** Snapshot/queue/distribution id referenced by the event, when applicable. */
    referenceId: text('reference_id'),
    /** Marker-only metadata (e.g. `escalated` for redeem). Never amounts. */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    // PK includes holder_address so a single Transfer event produces two
    // rows (sender-keyed + recipient-keyed) without colliding. Existing
    // rows have a unique (tx_hash, log_index, holder_address) tuple by
    // construction (every prior eventType emits exactly one row), so the
    // PK widening is a no-data-rewrite ALTER TABLE for declarative push.
    primaryKey({ columns: [t.txHash, t.logIndex, t.holderAddress] }),
    index('tax_events_holder_address_idx').on(t.holderAddress),
    index('tax_events_token_address_idx').on(t.tokenAddress),
    index('tax_events_block_timestamp_idx').on(t.blockTimestamp),
  ],
);

// ── Wave 4 Phase P1 — Tiered-autonomy engine ──────────────────────────
//
// Tables backing the agent state machine (ADR-0) and audit log. The
// `agent_audit_events` table is append-only by contract — see
// `IAgentAuditRepository`. Production deploys should additionally revoke
// UPDATE/DELETE on this table at the Postgres role level.

export const agentTierEnum = pgEnum('agent_tier', [
  'advisory',
  'confirm-per-action',
  'policy-bound',
  'scoped',
  'paused',
]);

export const agentSurfaceEnum = pgEnum('agent_surface', [
  'havenbot',
  'mcp',
  'openclaw',
  'checkout',
]);

export const agentTriggerEnum = pgEnum('agent_trigger', [
  'T-1-pause',
  'T-2-drawdown',
  'T-3-oracle',
  'T-4-fhe-attest',
  'T-5-kyc-revoke',
  'T-6-account-recovery',
  'T-7-session-ttl',
]);

export const agentAuditEventTypeEnum = pgEnum('agent_audit_event_type', [
  'tier_changed',
  'paused',
  'resumed',
  'cron_tick',
  'confirm_token_issued',
  'confirm_token_consumed',
  'permit_granted',
  'permit_revoked',
  'validator_installed',
  'validator_uninstalled',
  'kyc_revocation_received',
  'risk_questionnaire_complete',
  // Wave 5 Path D Slice 2 (Commit 2.A) — scoped-session lifecycle audit.
  // Enum values landed in the foundation commit so the migration is a
  // single ALTER TYPE...ADD VALUE round; emission from MintScopedSession /
  // RevokeScopedSession use-cases is wired in Commit 2.B alongside the MCP
  // auto-sync. Adding unused enum values is harmless — Postgres enums
  // append-only by value via Drizzle declarative push.
  'scoped_session_minted',
  'scoped_session_revoked',
  'scoped_session_expired',
  // Wave 5 Option D · Commit 1 — operator-driven one-shot revoke of
  // pre-D1 narrow-CallPolicy Scoped sessions. See
  // `audit-event-type.enum.ts::ScopedSessionRevokedByPolicyMigration`
  // JSDoc for the rationale + the use-case that emits it.
  // Adding an unused enum value is harmless; the migration use-case
  // emits one row per affected `agent_scoped_sessions` row at run time.
  'scoped_session_revoked_by_policy_migration',
]);

export const agentUserState = pgTable(
  'agent_user_state',
  {
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    surface: agentSurfaceEnum('surface').notNull(),
    tier: agentTierEnum('tier').notNull(),
    pausedAt: timestamp('paused_at'),
    pauseTrigger: agentTriggerEnum('pause_trigger'),
    pauseMetadata: jsonb('pause_metadata'),
    enteredAt: timestamp('entered_at').notNull(),
    /** ZeroDev validator currently installed for the policy-bound tier. */
    validatorAddress: text('validator_address'),
    confirmedActionCount: integer('confirmed_action_count').notNull().default(0),
    riskQuestionnaireComplete: boolean('risk_questionnaire_complete')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.surface] }),
    index('agent_user_state_tier_surface_idx').on(t.tier, t.surface),
    index('agent_user_state_user_id_idx').on(t.userId),
  ],
);

export const agentAuditEvents = pgTable(
  'agent_audit_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    surface: agentSurfaceEnum('surface').notNull(),
    eventType: agentAuditEventTypeEnum('event_type').notNull(),
    tierBefore: agentTierEnum('tier_before'),
    tierAfter: agentTierEnum('tier_after'),
    trigger: agentTriggerEnum('trigger'),
    /** ActionId enum from ADR-1 (1=Buy, 2=Sell, 3=Claim, 4=Rebalance). */
    actionId: integer('action_id'),
    /**
     * Event-specific JSON. NEVER store decrypted FHE values here — only
     * handle hashes. See `THREAT_MODEL_P0.md` privacy boundary checklist.
     */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('agent_audit_events_user_created_idx').on(t.userId, t.createdAt),
    index('agent_audit_events_surface_created_idx').on(t.surface, t.createdAt),
    index('agent_audit_events_event_type_idx').on(t.eventType),
    // Wave 5 Path D — operator forensic query "when did anyone enter Scoped"
    // is cheap via this partial index without proliferating a dedicated
    // audit event type. Tier transitions are sparse; partial index stays small.
    index('agent_audit_events_tier_after_scoped_idx')
      .on(t.createdAt)
      .where(sql`tier_after = 'scoped'`),
  ],
);

export const agentCronState = pgTable('agent_cron_state', {
  id: text('id').primaryKey(),
  lastTickAt: timestamp('last_tick_at'),
  lastTickUserCount: integer('last_tick_user_count'),
  lastTickBreachCount: integer('last_tick_breach_count'),
  lastTickError: text('last_tick_error'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const agentConfirmTokenActionKindEnum = pgEnum(
  'agent_confirm_token_action_kind',
  ['tier_transition', 'pause', 'resume', 'permit_grant'],
);

export const agentConfirmTokens = pgTable(
  'agent_confirm_tokens',
  {
    token: text('token').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    actionKind: agentConfirmTokenActionKindEnum('action_kind').notNull(),
    actionHash: text('action_hash').notNull(),
    actionPayload: jsonb('action_payload').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('agent_confirm_tokens_user_expires_idx').on(t.userId, t.expiresAt),
    index('agent_confirm_tokens_action_hash_idx').on(t.actionHash, t.userId),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// Scoped-session mirror (Wave 5 Path D Slice 2 Commit 2.A · RD-3)
//
// Per RD-3 in `development/DEV_WAVE_5/PATH_D_PLAN.md`, the broker keystore
// (`~/.muhaven/policy-snapshots/<sessionId>.json` per `policy-snapshot.ts`)
// holds the AUTHORITATIVE policy snapshot — the daemon decides whether to
// sign UserOps against that file. This Postgres table is a READ-ONLY
// MIRROR of the same data so the dashboard can render an "active session"
// banner, audit-replay tools can answer "what cap was in force at tx
// time?", and the MCP server can fetch the snapshot to install into a
// freshly-restarted broker (the snapshot transport gap Slice 1 surfaced
// pre-commit).
//
// **Privacy invariant**: this table never stores cleartext FHE values
// (mhUSDC balances, share counts). `max_per_op_usd6` is the operator-
// chosen ceiling in mhUSDC base-6, NOT a real spend. `selector_caps`
// carries selector-denominated arg caps in the on-chain unit (shares for
// `subscription.purchase`). Pre-publish review must re-verify no
// decrypt-result lands here.
//
// **Column types**:
//  - `session_id` matches the broker's regex (`^[A-Za-z0-9_-]{1,128}$`)
//    so the mirror PK is the same string both surfaces use to refer to
//    the snapshot.
//  - `signer_address` is the lowercased 0x-hex of the address derived
//    from the session-key private half. Broker compares against its
//    loaded signer at sign time; mismatch rejects (policy_violation in
//    the broker; signer_mismatch fallback in handlers.ts attemptPathD).
//  - `permission_id` is the 4-byte `@zerodev/permissions::getPermissionId()`
//    output; NULL until the frontend mint flow populates it (Pickup B).
//    The optional `0x[0-9a-f]{8}` CHECK constraint mirrors the wire
//    validator in `packages/mcp/src/broker/protocol.ts::isOptionalPermissionId`.
//  - `target_contracts` + `selector_caps` round-trip the JSON exactly as
//    the broker stores it on disk, so the mirror → broker auto-sync in
//    Commit 2.B is a pass-through (no re-validation reshape).
//  - `max_per_op_usd6` + `total_spent_usd6` are uint256-decimal-string-
//    compatible (precision 78). Slice 5 spend ledger increments
//    `total_spent_usd6`; Slice 1 leaves it at 0.
//  - `minted_at_sec` mirrors the snapshot's wire `mintedAtSec` (epoch
//    seconds the FRONTEND timestamped at mint). `minted_at` is the DB
//    receipt time (server clock). The two can drift by clock skew —
//    queries that need "when did the user actually mint" should use
//    `minted_at_sec`; queries that need "when did the row land in our
//    storage" should use `minted_at`. Slice 4 wildcard requires their
//    delta to be ≤ 30s as a freshness gate; Slice 1 doesn't enforce.
//  - `consent_action_hash` + `consent_text_sha256` are the forensic-
//    chain breadcrumbs per Security M-2 + Slice 4 gate item #5. Both
//    optional in Slice 1, mandatory at Slice 4 wildcard.
//
// **Indexes**: the hot path is "is there an active scoped session for
// (user, surface)?" — both the dashboard banner read AND the MCP auto-
// sync hit this. Partial index `WHERE status='active'` keeps the
// in-RAM working set narrow (revoked + expired rows stay on disk but
// don't bloat the index). Defensive secondary index on `signer_address`
// for forensic queries like "did this address ever hold scope?".

export const agentScopedSessionStatusEnum = pgEnum(
  'agent_scoped_session_status',
  ['active', 'revoked', 'expired'],
);

/**
 * Wave 5 Option D · Commit 2 — PermissionValidator install lifecycle on
 * the Kernel v3.1 chain side.
 *
 *   - `pending`  — mint ceremony captured enableData + enableSig +
 *                  validatorNonce; the validator is NOT yet installed
 *                  on-chain. C3's MCP-side ENABLE-mode UserOp fires the
 *                  first install on the next Path D buy.
 *   - `enabled`  — `PermissionInstalled(bytes4 permission, uint32 nonce)`
 *                  event observed by the chain indexer (C3); or, as
 *                  fast-path, the broker callback re-verified a tx
 *                  receipt log against the same ABI. The chain indexer
 *                  is AUTHORITATIVE; broker callback is best-effort
 *                  optimization. `validator_enabled_at` and
 *                  `validator_enabled_tx_hash` populate alongside.
 *   - `failed`   — 60-block watchdog (C3) flips `pending` → `failed`
 *                  when no `PermissionInstalled` event lands within the
 *                  window. Operator alert fires + user must re-walk
 *                  the ceremony.
 *
 * Distinct from `agent_scoped_session_status` — that column tracks the
 * mirror-row lifecycle (active / revoked / expired); this one tracks
 * the on-chain validator-install state. A row can be `status='active'`
 * AND `enable_status='pending'` simultaneously (mint landed, install
 * UserOp not yet fired — the dominant state until C3 ships).
 */
export const agentScopedSessionEnableStatusEnum = pgEnum(
  'agent_scoped_session_enable_status',
  ['pending', 'enabled', 'failed'],
);

export const agentScopedSessions = pgTable(
  'agent_scoped_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    /**
     * Audit-replay survives user deletion: drop `notNull()` and set
     * `onDelete: 'set null'` so a future GDPR-style user-deletion path
     * preserves the scoped-session row (forensic value: "what cap was in
     * force when tx X mined?") without a CASCADE that would erase the
     * audit chain. Mirrors `agentDeviceCodes.userId` precedent. Without
     * this, the FK default is NO ACTION → user deletion blocks forever.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    surface: agentSurfaceEnum('surface').notNull(),
    status: agentScopedSessionStatusEnum('status').notNull().default('active'),
    /** 0x-prefixed 20-byte hex, lowercased. ECDSA address derived from
     *  the session-key private half the frontend minted. */
    signerAddress: text('signer_address').notNull(),
    /** 0x-prefixed 4-byte hex from `@zerodev/permissions::getPermissionId()`.
     *  NULLABLE for back-compat with legacy pre-Pickup-B rows; Pickup B
     *  (commit `1a28618`) populates on every fresh mint via the frontend's
     *  `installScopedSessionKey` → `buildScopedMintBody` thread. Rows
     *  with NULL here return Path D fallback `no_permission_id_in_snapshot`
     *  and degrade cleanly to Path C deep-link. */
    permissionId: text('permission_id'),
    /** Lowercased 0x-addresses the broker will accept as innerCall.target.
     *  JSON array of strings; matches the broker's
     *  `PolicySnapshotWire.targetContracts` shape exactly. */
    targetContracts: jsonb('target_contracts').notNull(),
    /** Per-selector enforcement rules. JSON array of
     *  `{ selector: '0x' + 8 hex, capArgIndex: number|null, maxAmount: string|null }`.
     *  Round-trips broker's `PolicySnapshotWire.selectorCaps` verbatim. */
    selectorCaps: jsonb('selector_caps').notNull(),
    /** User-intent USDC ceiling in 6-decimal base. Distinct from
     *  per-selector caps (which are in on-chain units, e.g. shares for
     *  subscription.purchase). Used by the dashboard banner; Slice 5
     *  spend ledger references this as the cumulative cap. */
    maxPerOpUsd6: numeric('max_per_op_usd6', { precision: 78, scale: 0 }).notNull(),
    /** Cumulative spend tracker. Slice 5 spend ledger increments this on
     *  each `userop_submitted` audit; Slice 1/2 leave it at 0. */
    totalSpentUsd6: numeric('total_spent_usd6', { precision: 78, scale: 0 })
      .notNull()
      .default('0'),
    /**
     * Snapshot expiry — epoch seconds. Broker rejects sign_userop after
     * this time; `findLatestActive` filters server-side. `bigint` (int8)
     * not `numeric` so `Number(...)` at the repo→domain boundary never
     * truncates: JS `Number.MAX_SAFE_INTEGER` (2^53 ≈ year 287_396_259) is
     * far past any plausible TTL ceiling, and Pg int8 → JS number via
     * Drizzle's `mode: 'number'` is fixed-width + register-comparable.
     */
    validUntilSec: bigint('valid_until_sec', { mode: 'number' }).notNull(),
    /** Frontend's claimed mint time (snapshot `mintedAtSec` from the wire
     *  shape). Allowed clock skew vs `mintedAt` is operator policy;
     *  Slice 4 wildcard enforces ≤30s. See `validUntilSec` JSDoc for the
     *  `bigint` rationale. */
    mintedAtSec: bigint('minted_at_sec', { mode: 'number' }).notNull(),
    /** Optional Security M-2 / Slice 4 gate item #5 forensic chain. */
    consentActionHash: text('consent_action_hash'),
    consentTextSha256: text('consent_text_sha256'),
    /** DB receipt time. */
    mintedAt: timestamp('minted_at').notNull().defaultNow(),
    revokedAt: timestamp('revoked_at'),
    expiredAt: timestamp('expired_at'),
    // ──────────────────────────────────────────────────────────────────
    // Wave 5 Option D · Commit 2 — install-material capture for the
    // MCP-side MODE.ENABLE UserOp (C3). All columns NULL-first so the
    // declarative push lands cleanly against the populated prod table
    // (pre-C2 rows have no install material; the in-force schema gate
    // is the application-layer DTO).
    // ──────────────────────────────────────────────────────────────────
    /**
     * `permissionValidator.getEnableData(accountAddress)` output — ABI-
     * encoded `(policy[], signer)` payload that the kernel's plugin-
     * manager unpacks during install. Cleartext shape: `0x` + 2-8192
     * hex chars (depends on policy count). Encrypted at rest via
     * pgcrypto `pgp_sym_encrypt(...)`. The repository's default
     * `findFirst` calls explicitly exclude this column; only the
     * dedicated install-material subroute returns it (decrypted) via
     * a separate raw-SQL select wrapped in `pgp_sym_decrypt(...)`.
     */
    enableData: bytea('enable_data'),
    /**
     * `passkey.signTypedData(getPluginsEnableTypedData(...))` output —
     * WebAuthn envelope (~256-1024 bytes hex), authorising the
     * PermissionValidator install under the SUDO validator (the
     * passkey). Encrypted at rest, same shape contract as `enableData`.
     *
     * Strictly bound to `(account_address, validator_nonce, permission_id)`
     * via the kernel V3.1 `getPluginsEnableTypedData` typedData domain.
     * A leaked enableSig is single-use against a single permissionId;
     * the threat motivating encrypt-at-rest is a malicious-DB-reader
     * pre-empting the user's install + revoke window (SecEng T-1).
     */
    enableSig: bytea('enable_sig'),
    /**
     * The on-chain `currentNonce(accountAddress)` value read at mint
     * time via `getKernelV3Nonce(...)`. Embedded in the typed data the
     * passkey signed — the MCP-side ENABLE-mode UserOp (C3) must use
     * exactly this nonce or the kernel rejects the install with
     * `AA23 InvalidValidator` / typedData mismatch. A future buy after
     * the kernel's validator nonce advanced surfaces as `enable_sig_stale`
     * (C3 fallback) and the user re-walks the ceremony.
     *
     * Stored as `bigint` (int8) with `mode: 'number'` to match the
     * `valid_until_sec` precedent; uint32 ceiling enforced via CHECK.
     */
    validatorNonce: bigint('validator_nonce', { mode: 'number' }),
    /**
     * PermissionValidator install lifecycle. See enum JSDoc above.
     *
     * NO column-level default — the use-case (`MintScopedSessionUseCase`)
     * is the single source-of-truth for the derivation
     * ("install material captured → 'pending', else NULL"). A schema
     * default would back-fill the C1-recovery row with `'pending'`
     * during `db:push` (Drizzle's ALTER TABLE ADD COLUMN with default
     * back-fills existing rows), violating the "pre-C2 rows are pure
     * NULL" invariant. Multi-agent review BE Arch M-1 absorbed.
     */
    enableStatus: agentScopedSessionEnableStatusEnum('enable_status'),
    /**
     * UTC timestamp from the on-chain `PermissionInstalled` event /
     * receipt log when the validator install landed. NULL while
     * `enable_status != 'enabled'`; populated alongside the enum flip.
     * Lockstep enforced via CHECK `(validator_enabled_at IS NULL) =
     * (enable_status IS NULL OR enable_status != 'enabled')`.
     */
    validatorEnabledAt: timestamp('validator_enabled_at'),
    /**
     * The transaction hash that carried the MODE.ENABLE UserOp whose
     * receipt emitted `PermissionInstalled`. Forensic anchor for
     * incident-response queries ("which tx installed this scope?").
     * Lowercased 0x-hex (CHECK enforces shape).
     */
    validatorEnabledTxHash: text('validator_enabled_tx_hash'),
  },
  (t) => [
    /**
     * **Uniqueness invariant** — "at most one active session per
     * `(user_id, surface)`". Partial UNIQUE keyed on EXACTLY those two
     * columns (under the `WHERE status='active'` predicate) so two
     * concurrent mints with distinct sessionIds (and distinct
     * timestamps) CANNOT both land: the second insert fails Pg `23505`
     * and the application layer maps it to a 409 Conflict. Adding more
     * columns to the unique key would defeat the invariant — fresh-CR
     * round-2 HIGH-1 codified this: putting `valid_until_sec` or
     * `minted_at` in the unique tuple makes the 4-tuple miss across two
     * racing requests (different `now()` ms-precision), so both rows
     * land and the broker keystore can momentarily mirror two snapshots.
     *
     * Name suffix `_uq_v2` per memory
     * `feedback_drizzle_predicate_change_index_rename`: Drizzle
     * declarative push compares index NAMES not predicates. The `_v1`
     * shape (4-tuple) shipped briefly to the working tree; `_v2`
     * forces a clean DROP+CREATE on next `db:push`.
     */
    uniqueIndex('agent_scoped_sessions_user_surface_active_uq_v2')
      .on(t.userId, t.surface)
      .where(sql`status = 'active'`),
    /**
     * **Hot-path lookup** — separate non-unique partial index keyed on
     * `(user_id, surface, valid_until_sec, minted_at DESC)`. Backs:
     *   - Dashboard `ActiveSessionBanner.vue` poll (Commit 2.C)
     *   - MCP server auto-sync on `position.*` tool calls (Commit 2.B)
     *   - Use-case active-dedup pre-check (mint-scoped-session.use-case.ts)
     *
     * The leading equality columns (`user_id, surface`) make the index
     * sargable for `findLatestActive`; the trailing `valid_until_sec`
     * makes the `> nowSec` inequality index-scannable. The
     * `minted_at DESC` trailing column does NOT generally eliminate a
     * sort step (after a range scan on `valid_until_sec`, the rows
     * are ordered by `(valid_until_sec, minted_at DESC)`, not by
     * `minted_at DESC` alone — Pg still has to sort across the range).
     * It's a tiebreak column: in the typical 0-or-1-row case (per the
     * sibling UNIQUE invariant), the trailing column is decorative.
     *
     * Splitting the UNIQUE invariant from the lookup-shape index is
     * deliberate: the UNIQUE column set must EXACTLY match the
     * invariant (`user_id, surface`) so concurrent-race protection
     * works; the lookup index can carry extra trailing columns for
     * sargability without affecting uniqueness. Both partials share
     * the `WHERE status='active'` predicate so the planner can prefer
     * either based on cardinality.
     */
    index('agent_scoped_sessions_lookup_active_v1')
      .on(t.userId, t.surface, t.validUntilSec, t.mintedAt.desc())
      .where(sql`status = 'active'`),
    // Forensic lookups — "did this session-key address ever mint a
    // snapshot?". Useful for incident response.
    index('agent_scoped_sessions_signer_idx').on(t.signerAddress),
    // CHECK constraints mirror the broker's wire-shape validators in
    // `packages/mcp/src/broker/protocol.ts` so a hand-INSERT or an
    // operator-CLI write can't slip a malformed value past the gate
    // that the use-case layer normally enforces. Hex regexes match
    // exactly: 20-byte address (40 lower-hex chars), optional 4-byte
    // permissionId (8 lower-hex), optional 32-byte 64-hex consent hashes.
    check(
      'agent_scoped_sessions_session_id_chk',
      sql`session_id ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    check(
      'agent_scoped_sessions_signer_address_chk',
      sql`signer_address ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      'agent_scoped_sessions_permission_id_chk',
      sql`permission_id IS NULL OR permission_id ~ '^0x[0-9a-f]{8}$'`,
    ),
    check(
      'agent_scoped_sessions_consent_action_hash_chk',
      sql`consent_action_hash IS NULL OR consent_action_hash ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      'agent_scoped_sessions_consent_text_sha256_chk',
      sql`consent_text_sha256 IS NULL OR consent_text_sha256 ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      'agent_scoped_sessions_max_per_op_usd6_chk',
      sql`max_per_op_usd6 >= 0`,
    ),
    check(
      'agent_scoped_sessions_total_spent_usd6_chk',
      sql`total_spent_usd6 >= 0`,
    ),
    check('agent_scoped_sessions_valid_until_sec_chk', sql`valid_until_sec > 0`),
    check('agent_scoped_sessions_minted_at_sec_chk', sql`minted_at_sec > 0`),
    // ──────────────────────────────────────────────────────────────────
    // Wave 5 Option D · Commit 2 — install-material gates.
    // ──────────────────────────────────────────────────────────────────
    /**
     * `validator_nonce` is the on-chain `currentNonce` (uint32). NULL
     * for pre-C2 rows and any future client that doesn't supply the
     * field. Range gate doubles as defense-in-depth: a malicious POST
     * with a `Number.MAX_SAFE_INTEGER`-shaped value would otherwise
     * round-trip via Drizzle `mode: 'number'` int8.
     */
    check(
      'agent_scoped_sessions_validator_nonce_chk',
      sql`validator_nonce IS NULL OR (validator_nonce >= 0 AND validator_nonce <= 4294967295)`,
    ),
    /**
     * `validator_enabled_tx_hash` must be a lowercased 32-byte 0x-hex
     * when present. Matches `agent_scoped_sessions_consent_action_hash_chk`
     * and the consent / signer regexes elsewhere on this table.
     */
    check(
      'agent_scoped_sessions_validator_enabled_tx_hash_chk',
      sql`validator_enabled_tx_hash IS NULL OR validator_enabled_tx_hash ~ '^0x[0-9a-f]{64}$'`,
    ),
    /**
     * Lockstep invariant — the timestamp populates IFF the enum flips
     * to `enabled`. C3 wires both columns together inside a single
     * UPDATE; the CHECK closes the operator-error window where one
     * leg is updated without the other.
     *
     * Note: `enable_status IS NULL` matches the `validator_enabled_at
     * IS NULL` side of the equality because pre-C2 rows have both as
     * NULL (the column itself was added in this commit).
     */
    check(
      'agent_scoped_sessions_enable_status_at_lockstep_chk',
      sql`(validator_enabled_at IS NULL) = (enable_status IS NULL OR enable_status != 'enabled')`,
    ),
    /**
     * Encrypted-blob size cap. pgcrypto adds ~50-90 bytes overhead on
     * top of the cleartext; 8192 bytes is a generous bound for the
     * worst-case ABI-encoded enableData under our policy count.
     * Without this, a malformed write (or future schema drift that
     * accepts longer cleartext) would silently grow rows past
     * Postgres's TOAST threshold.
     */
    check(
      'agent_scoped_sessions_enable_data_size_chk',
      sql`enable_data IS NULL OR octet_length(enable_data) <= 8192`,
    ),
    check(
      'agent_scoped_sessions_enable_sig_size_chk',
      sql`enable_sig IS NULL OR octet_length(enable_sig) <= 4096`,
    ),
    /**
     * Partial index — backs the C3 chain-indexer's per-block scan
     * "find pending rows that may have been enabled" + the 60-block
     * watchdog "find pending rows older than threshold". The
     * `minted_at` leading order column makes the watchdog's
     * range-scan sargable; the partial predicate keeps the active +
     * pending working set small (revoked / expired / enabled rows
     * stay on disk but out of this index). BE MED-4 from the R2
     * Option D plan absorbed.
     */
    index('agent_scoped_sessions_pending_enable_v1')
      .on(t.mintedAt)
      .where(sql`enable_status = 'pending' AND status = 'active'`),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// Device-code authorization (Wave 4 P3 ADR-3)
//
// Tracks the OAuth-2-style device-authorization-grant ceremony used by
// `@muhaven/mcp` to acquire scoped JWTs without paste-token UX. WORM-ish:
// `status` only flips forward (pending → authorized | denied | expired
// → consumed). The Postgres CHECK constraint + a partial unique index on
// `userCode WHERE status='pending'` enforce the invariant.
//
// The `jwt` column stores the issued (scoped) bearer token until the
// broker polls and consumes it. Stored briefly (≤code TTL) and cleared
// when status flips to `consumed`.

export const agentDeviceCodeStatusEnum = pgEnum('agent_device_code_status', [
  'pending',
  'authorized',
  'denied',
  'expired',
  'consumed',
]);

export const agentDeviceCodes = pgTable(
  'agent_device_codes',
  {
    /** Opaque high-entropy primary key — broker polls with this. */
    deviceCode: text('device_code').primaryKey(),
    /** User-readable 8-char code (XXXX-XXXX, uppercase) typed in dashboard. */
    userCode: text('user_code').notNull(),
    status: agentDeviceCodeStatusEnum('status').notNull().default('pending'),
    /**
     * User who authorized the code (null until authorize step).
     *
     * `onDelete: 'set null'` (Code Review #5, post-port hardening): a
     * delete-account flow that touches `users` would otherwise fail
     * with a 23503 constraint violation against the consumed/denied
     * audit rows. Audit-preserving SET NULL is the conservative
     * choice — `userCode` / `deviceCode` carry no PII once `userId`
     * is null.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Scopes minted onto the JWT — JSON array of strings. */
    scope: jsonb('scope').$type<string[]>(),
    /** Scoped JWT — present iff status='authorized'; cleared on consume. */
    jwt: text('jwt'),
    /** Optional reason set by the deny path. */
    denyReason: text('deny_reason'),
    /** Process / host / OS the broker reported when requesting the code. */
    requesterMetadata: jsonb('requester_metadata').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Only ONE pending row per userCode — collisions on the user-code
    // namespace are rejected at insert time. Status transitions release
    // the user code for reuse if needed (Wave 5 may rotate codes).
    uniqueIndex('agent_device_codes_user_code_pending_idx')
      .on(t.userCode)
      .where(sql`status = 'pending'`),
    index('agent_device_codes_user_id_idx').on(t.userId),
    index('agent_device_codes_expires_idx').on(t.expiresAt),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// OpenClaw confirmation intents (Wave 4 P4)
//
// Each intent represents a state-mutating action staged by the OpenClaw
// skill / Telegram surface. Tier is computed at mint time and locked into
// the row so a malicious caller cannot lower it after the fact. Status
// only flips forward; production deploys should add a Postgres trigger
// to enforce the transition at the row level (Wave 5).

export const openclawIntentKindEnum = pgEnum('openclaw_intent_kind', ['buy', 'claim']);

export const openclawIntentTierEnum = pgEnum('openclaw_intent_tier', [
  'inline',
  'mini_app_otp',
  'passkey_deeplink',
]);

export const openclawIntentStatusEnum = pgEnum('openclaw_intent_status', [
  'pending',
  'confirmed',
  'consumed',
  'denied',
  'expired',
]);

export const openclawIntents = pgTable(
  'openclaw_intents',
  {
    /** ULID-shaped intent id. */
    intentId: text('intent_id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    kind: openclawIntentKindEnum('kind').notNull(),
    tier: openclawIntentTierEnum('tier').notNull(),
    status: openclawIntentStatusEnum('status').notNull().default('pending'),
    /** USDC 6-decimal — text to preserve bigint precision through Postgres NUMERIC. */
    amountUsd6: numeric('amount_usd6', { precision: 30, scale: 0 }).notNull(),
    payload: jsonb('payload').notNull(),
    /** Deterministic hash of (kind, payload, userId, createdAtSec). */
    intentHash: text('intent_hash').notNull(),
    /**
     * 6-digit OTP for the mini_app_otp tier; null otherwise. Stored in
     * cleartext — short TTL (~5 min) and only valid for one consume.
     */
    otp: text('otp'),
    telegramChatId: text('telegram_chat_id'),
    confirmedAt: timestamp('confirmed_at'),
    consumedAt: timestamp('consumed_at'),
    deniedAt: timestamp('denied_at'),
    denyReason: text('deny_reason'),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('openclaw_intents_user_created_idx').on(t.userId, t.createdAt),
    index('openclaw_intents_status_idx').on(t.status),
    index('openclaw_intents_telegram_chat_idx').on(t.telegramChatId),
    index('openclaw_intents_expires_idx').on(t.expiresAt),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// Telegram-account ↔ MuHaven-user link (Wave 4 P4)

export const telegramLinkCodes = pgTable(
  'telegram_link_codes',
  {
    linkCode: text('link_code').primaryKey(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    consumedByChatId: text('consumed_by_chat_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('telegram_link_codes_user_id_idx').on(t.userId),
    index('telegram_link_codes_expires_idx').on(t.expiresAt),
  ],
);

export const telegramLinks = pgTable(
  'telegram_links',
  {
    telegramChatId: text('telegram_chat_id').primaryKey(),
    /** Telegram user.id — verified at link time AND on every Mini App
     *  initData hash check. Distinct from chat.id because the protocol
     *  does not guarantee equality (private chat == ; group chat ≠). */
    telegramUserId: text('telegram_user_id').notNull(),
    userId: text('user_id')
      .references(() => users.id)
      .notNull(),
    telegramUsername: text('telegram_username'),
    linkedAt: timestamp('linked_at').notNull().defaultNow(),
    unlinkedAt: timestamp('unlinked_at'),
    lastActiveAt: timestamp('last_active_at'),
  },
  (t) => [
    index('telegram_links_user_id_idx').on(t.userId),
    index('telegram_links_tg_user_id_idx').on(t.telegramUserId),
    index('telegram_links_unlinked_idx').on(t.unlinkedAt),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// Hosted-checkout sessions (Wave 4 P5)
//
// Stripe-style records describing a single buyer-facing payment flow.
// `enc_payload` is AES-256-GCM ciphertext keyed by a 32B fragment key
// that lives only in the buyer's URL hash — backend cannot decrypt the
// payload after issue. Status only flips forward; concurrent
// transitions resolve via conditional UPDATE.

export const checkoutSessionStatusEnum = pgEnum('checkout_session_status', [
  'pending',
  'funded',
  'wrapped',
  'purchased',
  'settled',
  'expired',
  'failed',
]);

export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    /** `cs_<26-base32>` — Stripe-shaped public id. */
    sessionId: text('session_id').primaryKey(),
    issuerUserId: text('issuer_user_id')
      .references(() => users.id)
      .notNull(),
    status: checkoutSessionStatusEnum('status').notNull().default('pending'),
    /** Cleartext metadata — issuer/token/label/successUrl/cancelUrl. */
    metadata: jsonb('metadata').notNull(),
    /** Buyer's resolved kernel address — null until first page load + link. */
    buyerAddress: text('buyer_address'),
    /** AES-256-GCM iv:authTag:ciphertext envelope (base64url segments). */
    encPayload: text('enc_payload').notNull(),
    /** Set on the `purchased` transition; null otherwise. */
    purchaseTxHash: text('purchase_tx_hash'),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('checkout_sessions_issuer_created_idx').on(t.issuerUserId, t.createdAt),
    // Third-pass review (Arch H-1): composite index for the §5 Path D
    // dashboard list page's `findByIssuerUserId({status, cursor})` access
    // pattern. Without it, a high-selectivity status filter (e.g. `failed`
    // ~1%) at 10K sessions/issuer scans up to 10K rows to return one page.
    // Drizzle declarative push (`pnpm db:push`) handles the ALTER cleanly.
    index('checkout_sessions_issuer_status_created_idx').on(
      t.issuerUserId,
      t.status,
      t.createdAt,
    ),
    index('checkout_sessions_status_idx').on(t.status),
    index('checkout_sessions_expires_idx').on(t.expiresAt),
    // Wave 5 P4 — `CheckoutSettlementIndexer` looks up sessions by
    // `purchase_tx_hash` on every `MuHavenSubscription.Purchased` event.
    // Partial index: only rows with a non-null hash, which is the small
    // subset (`status IN ('purchased', 'settled')`).
    index('checkout_sessions_purchase_tx_idx').on(t.purchaseTxHash),
  ],
);

// ────────────────────────────────────────────────────────────────────────
// Hosted-checkout webhook endpoints + delivery log (Wave 4 P5)
//
// Issuer-registered HTTPS targets receive Stripe-style HMAC-SHA256-signed
// payloads on every session transition. `disabled_at` set when the
// issuer revokes; `signing_secret` is shown ONCE at create time but
// stored in the row so the dispatcher can keep signing.

export const checkoutWebhookEndpoints = pgTable(
  'checkout_webhook_endpoints',
  {
    endpointId: text('endpoint_id').primaryKey(),
    issuerUserId: text('issuer_user_id')
      .references(() => users.id)
      .notNull(),
    url: text('url').notNull(),
    /** Random 32B `whsec_…` hex — surfaced ONCE at create time. */
    signingSecret: text('signing_secret').notNull(),
    /** JSON array of event types; empty = all. */
    enabledEvents: jsonb('enabled_events').notNull().$type<string[]>(),
    disabledAt: timestamp('disabled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('checkout_webhook_endpoints_issuer_idx').on(t.issuerUserId),
    index('checkout_webhook_endpoints_disabled_idx').on(t.disabledAt),
  ],
);

export const checkoutWebhookDeliveryStatusEnum = pgEnum(
  'checkout_webhook_delivery_status',
  ['pending', 'delivered', 'failed'],
);

export const checkoutWebhookDeliveries = pgTable(
  'checkout_webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    endpointId: text('endpoint_id').notNull(),
    sessionId: text('session_id').notNull(),
    eventType: text('event_type').notNull(),
    status: checkoutWebhookDeliveryStatusEnum('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseBodyExcerpt: text('response_body_excerpt'),
    errorMessage: text('error_message'),
    attemptedAt: timestamp('attempted_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  // FKs are declared at the table level (not inline `.references()`) so we
  // can pin explicit names UNDER Postgres' 63-char identifier limit. The
  // auto-generated drizzle names (`<table>_<col>_<fktable>_<fkcol>_fk`)
  // exceed 63 chars here and get truncated by Postgres on CREATE, which
  // causes drizzle-kit push to propose the same cosmetic DROP+ADD on
  // every push forever (observed 2026-05-19 cutover; see STATUS.md
  // "Post-cutover operator follow-ups").
  (t) => [
    foreignKey({
      columns: [t.endpointId],
      foreignColumns: [checkoutWebhookEndpoints.endpointId],
      name: 'checkout_webhook_deliveries_endpoint_fk',
    }),
    foreignKey({
      columns: [t.sessionId],
      foreignColumns: [checkoutSessions.sessionId],
      name: 'checkout_webhook_deliveries_session_fk',
    }),
    index('checkout_webhook_deliveries_endpoint_idx').on(t.endpointId, t.attemptedAt),
    index('checkout_webhook_deliveries_session_idx').on(t.sessionId, t.attemptedAt),
  ],
);

// ── Wave 5 Q1 — RWA oracle ingest (rwa.xyz data harvest) ───────────────
//
// Three tables back the off-chain reference data for the 11 curated RWAs
// scraped from `app.rwa.xyz` via `development/ORACLE_DATA_MINE/`. The
// on-chain `rwa_tokens` row stays the authoritative catalog (address,
// symbol, asset class enum, on-chain `nav` via `token_nav_history`); these
// tables enrich it with the display strings + scalar snapshots + chart
// time-series the marketplace + token-detail + portfolio pages need.
//
// Ticker is the canonical join key (case-preserved — rwa.xyz uses mixed
// case like `syrupUSDC` / `MUon`). Foreign-key-less by design: oracle
// data ships BEFORE the matching `rwa_tokens` row exists during demo prep,
// and a deprecated on-chain token can still keep its historical metadata.

export const tokenMetadata = pgTable(
  'token_metadata',
  {
    ticker: text('ticker').primaryKey(),
    // Source identity — `rwaxyzAssetId` is the numeric id rwa.xyz uses
    // internally; `rwaxyzSlug` is the URL-form slug ("circle-usyc"). Both
    // are used by the refresh pipeline for targeted re-fetches.
    rwaxyzAssetId: integer('rwaxyz_asset_id'),
    rwaxyzSlug: text('rwaxyz_slug'),
    sourceUrl: text('source_url'),
    // Branding + classification
    displayName: text('display_name').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),
    colorHex: text('color_hex'),
    website: text('website'),
    // rwa.xyz's canonical `isYieldBearing` flag captured verbatim. This
    // is what their classifier says about the underlying token shape.
    isYieldBearing: boolean('is_yield_bearing').notNull().default(false),
    // MuHaven's per-token override of rwa.xyz's classification. Null →
    // honour `is_yield_bearing`. Set this when the rwa.xyz flag doesn't
    // match how MuHaven wants to surface the token (e.g. CETES / EUTBL
    // / syrupUSDC / ONyc are flagged false on rwa.xyz despite having
    // APY data; MuHaven treats them as yield-bearing for the daily
    // distribution cron + marketplace APY card). The read endpoint
    // computes the final `is_yield_bearing` as
    // `override ?? is_yield_bearing` — preserving provenance while
    // letting MuHaven take editorial responsibility.
    isYieldBearingOverride: boolean('is_yield_bearing_override'),
    distributesIncome: boolean('distributes_income'),
    // Asset class — slug form ("us-treasury-debt") + display name. Distinct
    // from the on-chain `rwa_tokens.asset_class` enum because the rwa.xyz
    // taxonomy has finer-grained categories than our 5-value pgEnum.
    assetClassSlug: text('asset_class_slug'),
    assetClassName: text('asset_class_name'),
    // Issuer / manager / jurisdiction — all display strings
    issuerName: text('issuer_name'),
    issuerLegalName: text('issuer_legal_name'),
    issuerLei: text('issuer_lei'),
    issuerCountry: text('issuer_country'),
    managerName: text('manager_name'),
    jurisdictionCountry: text('jurisdiction_country'),
    regulatoryFramework: text('regulatory_framework'),
    governingBody: text('governing_body'),
    legalStructure: text('legal_structure'),
    inceptionDate: text('inception_date'),
    // Fees (basis points)
    feeManagementBps: integer('fee_management_bps'),
    feePerformanceBps: integer('fee_performance_bps'),
    feeStructureDescription: text('fee_structure_description'),
    // Primary market terms
    pmSubscriptionFrequency: text('pm_subscription_frequency'),
    pmSubscriptionMinimumDollar: numeric('pm_subscription_minimum_dollar', { precision: 20, scale: 8 }),
    pmRedemptionFrequency: text('pm_redemption_frequency'),
    pmKycRequired: boolean('pm_kyc_required'),
    // Per-chain underlying token list — `[{ network, networkId, address,
    // decimals, standards[] }, ...]`. Stored as JSON because the array
    // length + per-row shape are per-asset variant (USYC has 3 chains,
    // EUTBL has 1, etc.) — a separate table would be over-normalized for
    // a display-only field.
    underlyingTokens: jsonb('underlying_tokens'),
    lastRefreshedAt: timestamp('last_refreshed_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('token_metadata_rwaxyz_asset_id_idx').on(t.rwaxyzAssetId),
    // Partial index — marketplace "yield-bearing only" filter. Predicate
    // matches the effective-yield-bearing semantic
    // (`override ?? is_yield_bearing`) so the planner uses it whether
    // MuHaven has overridden the rwa.xyz flag or accepted it.
    //
    // NAME suffixed `_v2` so drizzle-kit push detects it as a
    // rename-and-recreate. drizzle-kit DOES NOT detect predicate-only
    // changes on existing indexes (observed 2026-05-19, stage db:push
    // silently kept the old predicate). Re-naming the index when the
    // predicate changes forces a clean DROP + CREATE every time.
    index('token_metadata_is_yield_bearing_idx_v2')
      .on(t.ticker)
      .where(sql`COALESCE(is_yield_bearing_override, is_yield_bearing) = true`),
  ],
);

export const oracleSnapshots = pgTable(
  'oracle_snapshots',
  {
    // Natural PK — every snapshot for a ticker is unique by ingest
    // moment. The earlier UUID PK let retries within the same epoch
    // double-insert (charts would then pick arbitrarily); the natural
    // PK fails loud, the use case routes through `onConflictDoNothing`
    // so a same-second retry is a no-op.
    ticker: text('ticker').notNull(),
    snapshotAt: timestamp('snapshot_at').notNull().defaultNow(),
    // Source provenance — match `nav_source_type` semantics: every Q1/Q2
    // ingest writes `rwaxyz_scrape`; future live-oracle wiring (Dinari)
    // would write its own source string.
    source: text('source').notNull().default('rwaxyz_scrape'),
    // Scalars — all nullable because field availability varies per asset
    // (stocks have no APY; some treasuries hide concentration metrics).
    // Numeric bounds picked while the table is empty: dollar amounts
    // (NAV / price / TVL) at (20, 8); percent rates (APY / yield-rate /
    // concentration) at (10, 6); token supply at (36, 18) to match
    // on-chain ERC-20 18-decimals semantics. Switching later requires
    // a column rewrite, so anchor them now.
    navDollar: numeric('nav_dollar', { precision: 20, scale: 8 }),
    priceDollar: numeric('price_dollar', { precision: 20, scale: 8 }),
    apy7Day: numeric('apy_7_day', { precision: 10, scale: 6 }),
    apy30Day: numeric('apy_30_day', { precision: 10, scale: 6 }),
    dailyYieldRate: numeric('daily_yield_rate', { precision: 10, scale: 6 }),
    yieldToMaturityPercent: numeric('yield_to_maturity_percent', { precision: 10, scale: 6 }),
    dailyYieldDistributedDollar: numeric('daily_yield_distributed_dollar', { precision: 20, scale: 8 }),
    hypothetical10kPerformance: numeric('hypothetical_10k_performance', { precision: 20, scale: 8 }),
    totalSupplyToken: numeric('total_supply_token', { precision: 36, scale: 18 }),
    totalAssetValueDollar: numeric('total_asset_value_dollar', { precision: 20, scale: 8 }),
    marketValueDollar: numeric('market_value_dollar', { precision: 20, scale: 8 }),
    holdingAddressesCount: integer('holding_addresses_count'),
    top5HolderConcentration: numeric('top_5_holder_concentration', { precision: 10, scale: 6 }),
    rwaxyzUpdatedAt: timestamp('rwaxyz_updated_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ticker, t.snapshotAt] }),
  ],
);

export const oracleTimeseries = pgTable(
  'oracle_timeseries',
  {
    ticker: text('ticker').notNull(),
    measureSlug: text('measure_slug').notNull(),
    // Postgres `date` — Drizzle accepts the same YYYY-MM-DD string
    // input as the prior `text` form but gives us range planner stats,
    // `BETWEEN` ergonomics, and future declarative partitioning by
    // month/year. The repo lookup pattern `WHERE date >= '2025-01-01'`
    // is the dominant chart query.
    date: date('date').notNull(),
    // Wide enough to hold dollar billions + sub-cent precision; matches
    // the `oracle_snapshots.*_dollar` scale class. The 8-scale also
    // covers percent rates (3.13140000) and holder counts (44.00000000)
    // without ambiguity.
    value: numeric('value', { precision: 28, scale: 8 }).notNull(),
    // Optional unit metadata pulled from the measure descriptor — kept
    // here so a chart consumer can render "$1.23" vs "3.14%" vs "44
    // holders" without round-tripping to `token_metadata`.
    unit: text('unit'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  // The composite PK `(ticker, measure_slug, date)` is itself a btree
  // whose leftmost prefix `(ticker, measure_slug)` already serves any
  // chart query filtering on those two columns when the predicate is
  // `ticker = ?`. Repo lookups use `lower(ticker) = lower(?)` for the
  // case-insensitive contract (see `feedback_address_case_at_repo_boundary`
  // — same pattern), and `lower()` defeats the PK btree. The functional
  // index below makes `lower(ticker)` sargable so the `findMetadata`
  // DISTINCT measure_slug query (and any future case-insensitive
  // timeseries lookups) plan an index scan instead of a seq scan.
  // Cheap to maintain at 28k rows; mandatory before the catalog scales.
  (t) => [
    primaryKey({ columns: [t.ticker, t.measureSlug, t.date] }),
    index('oracle_timeseries_lower_ticker_measure_idx').on(
      sql`lower(${t.ticker})`,
      t.measureSlug,
    ),
  ],
);

// ── Wave 5 Q3 — Daily yield-distribution cron audit + tick state ────
//
// `yield_distributions` is the per-(token, epoch) audit row written by
// `runYieldEpoch`. The row lands BEFORE `openEpoch` with `status =
// 'in_progress'`, transitions through `snapshot_done` → `funded_no_audit`
// → `success` (or `failure`). On boot, the cron resumes any non-terminal
// row by re-using its stored `rate_per_share` + `enc_total_yield_usd6`
// rather than recomputing from the latest oracle snapshot — this is the
// load-bearing idempotency guarantee for the Q3 plan A.3 step 3.
//
// Token addresses are lower-cased at the write boundary per
// `feedback_address_case_at_repo_boundary`; the unique-constraint on
// (token_address, epoch_id) depends on that contract.
export const yieldDistributions = pgTable(
  'yield_distributions',
  {
    id: text('id').primaryKey(),
    tokenAddress: text('token_address').notNull(),
    // On-chain `epochId` is `uint256` (`YieldSnapshot._currentEpoch` is
    // uint256). `numeric(20, 0)` covered uint64 comfortably but an
    // operator/integration test that calls `openEpoch` directly could
    // push the counter to a uint256-range value and our insert would
    // fail with `numeric field overflow`. Widened to uint256 (78
    // digits) — variable-width numeric storage costs zero at the
    // realistic daily-cron rate (Database Optimizer M-3, 2026-05-20).
    epochId: numeric('epoch_id', { precision: 78, scale: 0 }).notNull(),
    // v3.1 S3 — uint128.max ≈ 3.4e38 is 39 digits; `numeric(36, 0)` was
    // three digits short. Width also covers the safety bounds enforced in
    // `yield-epoch-runner.ts` (B.3).
    ratePerShare: numeric('rate_per_share', { precision: 39, scale: 0 }).notNull(),
    // Plaintext yield-cap committed to `YieldSnapshot.fundEpoch`, in mhUSDC
    // base units (USD * 1e6, integer). v3.1 S9 trust posture: the value
    // is already public-derivable from `apy_7_day × nav_dollar / 365 ×
    // effectiveCap` — no new privacy surface. The confidentiality
    // boundary is the per-investor claim share, not the aggregate epoch
    // yield. Stored as `numeric(39, 0)` (uint128 base units, integer-
    // valued by contract); the prior `numeric(20, 8)` widened storage by
    // 2 decimals beyond mhUSDC's 6, which combined with `apy_at_time` +
    // `nav_at_time` would have leaked the exact `effectiveCap` (Security
    // review M-1, 2026-05-20). Now bit-identical to the on-chain uint128
    // shape — no inversion possible from the trio of stored columns.
    encTotalYieldUsd6: numeric('enc_total_yield_usd6', { precision: 39, scale: 0 }).notNull(),
    // Snapshot of the oracle inputs at the moment the rate was computed,
    // for post-hoc reconcile / chart overlays. `numeric(20, 8)` matches
    // `oracle_snapshots.nav_dollar`; `numeric(10, 6)` matches
    // `oracle_snapshots.apy_7_day`.
    navAtTimeUsd: numeric('nav_at_time_usd', { precision: 20, scale: 8 }).notNull(),
    apyAtTimePercent: numeric('apy_at_time_percent', { precision: 10, scale: 6 }).notNull(),
    status: yieldDistributionStatusEnum('status').notNull(),
    fundEpochTxHash: text('fund_epoch_tx_hash'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastResumedAt: timestamp('last_resumed_at', { withTimezone: true }),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('yld_dist_token_started_idx').on(t.tokenAddress, t.startedAt),
    uniqueIndex('yld_dist_token_epoch_uniq').on(t.tokenAddress, t.epochId),
    // `findLatestUnresolved` queries via `lower(token_address) AND status
    // NOT IN ('success', 'failure')` — partial index keeps the working
    // set to a handful of rows during normal operation (DB review M-1,
    // 2026-05-20). The functional `lower()` half honors the address-
    // case-at-boundary contract (`feedback_address_case_at_repo_boundary`)
    // which the unique btree on `(tokenAddress, epochId)` does NOT cover
    // (`feedback_lower_defeats_pk_sargable`).
    //
    // Name suffix `_v1` is load-bearing per
    // `feedback_drizzle_predicate_change_index_rename` — drizzle-kit
    // push compares index NAMES, not predicates. If the WHERE clause
    // ever changes, bump to `_v2` to force DROP+CREATE.
    index('yld_dist_lower_token_unresolved_v1_idx')
      .on(sql`lower(${t.tokenAddress})`, t.startedAt)
      .where(sql`status NOT IN ('success', 'failure')`),
    // Address-case-at-boundary is convention today; this CHECK promotes
    // it to a schema invariant. Future writer that forgets `.toLowerCase()`
    // gets rejected at insert time instead of silently bypassing the
    // unique constraint (DB review H-2, 2026-05-20).
    check(
      'yld_dist_token_address_lowercase',
      sql`${t.tokenAddress} = lower(${t.tokenAddress})`,
    ),
  ],
);

// `cron_state` is the single-flight tick guard for any backend cron that
// needs idempotency across container restarts. Q3 keys two rows on this
// table:
//   - `yield-distribution` — the 23h-floor tick guard per A.1.
//   - `yield-distribution-heartbeat` — the 23h-floor debounce for the
//     daily Telegram heartbeat at end-of-tick (2026-05-22 — replaces
//     the pre-existing `yield-cron-boot-alert` row that was a 6h-
//     debounce on a dry-run-gated boot alert; the legacy row stays
//     as dangling data in prod until the operator runs the one-shot
//     `scripts/sql/cleanup-yield-cron-boot-alert.sql`).
// Future crons add more rows; the table is not Q3-specific.
// `defaultNow()` on `lastFiredAt` lets the
// `INSERT … ON CONFLICT DO NOTHING` seed pattern omit the column.
//
// LOAD-BEARING INVARIANT (DB review H-1, 2026-05-20): the tick guard
// MUST be a single-statement conditional UPDATE — NEVER a SELECT-then-
// UPDATE. The atomic form:
//
//   UPDATE cron_state SET last_fired_at = NOW()
//     WHERE cron_name = $1 AND last_fired_at < NOW() - INTERVAL '23 hours'
//     RETURNING 1;
//
// is race-safe under Postgres' row-level lock — concurrent ticks
// serialize on the row, the loser sees the winner's `last_fired_at`
// after commit, predicate fails, RETURNING is empty. Refactoring to
// SELECT-then-UPDATE for telemetry would silently reintroduce a TOCTOU
// race that double-fires the cron under restart-induced contention.
export const cronState = pgTable('cron_state', {
  cronName: text('cron_name').primaryKey(),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
