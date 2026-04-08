import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
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
]);

export const userRoleEnum = pgEnum('user_role', ['investor', 'issuer']);

export const escrowEventTypeEnum = pgEnum('escrow_event_type', [
  'EscrowCreated',
  'EscrowSettled',
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('rwa_tokens_address_idx').on(t.address),
    index('rwa_tokens_issuer_address_idx').on(t.issuerAddress),
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
  (t) => [index('portfolios_user_id_idx').on(t.userId)],
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
