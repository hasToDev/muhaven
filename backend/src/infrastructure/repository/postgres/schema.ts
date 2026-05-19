import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  boolean,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    endpointId: text('endpoint_id')
      .references(() => checkoutWebhookEndpoints.endpointId)
      .notNull(),
    sessionId: text('session_id')
      .references(() => checkoutSessions.sessionId)
      .notNull(),
    eventType: text('event_type').notNull(),
    status: checkoutWebhookDeliveryStatusEnum('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseBodyExcerpt: text('response_body_excerpt'),
    errorMessage: text('error_message'),
    attemptedAt: timestamp('attempted_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
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
