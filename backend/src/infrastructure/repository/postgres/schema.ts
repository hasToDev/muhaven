import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

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
  },
  (t) => [index('users_wallet_address_idx').on(t.walletAddress)],
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
