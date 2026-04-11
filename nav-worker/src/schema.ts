/**
 * Drizzle schema — duplicated subset from backend.
 * Only the token_nav_history table and nav_source_type enum needed for writes.
 */
import { pgTable, pgEnum, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const navSourceTypeEnum = pgEnum('nav_source_type', [
  'on_chain',
  'api',
  'manual',
]);

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
