/**
 * Seed script — inserts demo RWA tokens (MHTB + MHMM) into the database.
 *
 * Usage:
 *   cd backend && pnpm seed:tokens
 *
 * Requires DATABASE_URL and DB_PROVIDER=postgres in .env
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { PgRwaTokenRepository } from '../src/infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { RwaToken } from '../src/domain/token-registry/model/rwa-token.js';

const DEMO_TOKENS = [
  {
    address: '0x0000000000000000000000000000000000000001',
    name: 'MuHaven Treasury Bond',
    symbol: 'MHTB',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '4.30',
    yieldSchedule: 'monthly',
    kycTier: 0,
    assetClass: 'treasury' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000002',
    name: 'MuHaven Money Market',
    symbol: 'MHMM',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '4.30',
    yieldSchedule: 'daily',
    kycTier: 0,
    assetClass: 'money_market' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000003',
    name: 'BlackRock USD Liquidity Fund',
    symbol: 'BUIDL',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '5.00',
    yieldSchedule: 'daily',
    kycTier: 0,
    assetClass: 'money_market' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000004',
    name: 'Ondo US Dollar Yield',
    symbol: 'USDY',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '5.20',
    yieldSchedule: 'daily',
    kycTier: 0,
    assetClass: 'money_market' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000005',
    name: 'MuHaven 10-Year Treasury',
    symbol: 'MH10Y',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '4.50',
    yieldSchedule: 'semi-annual',
    kycTier: 0,
    assetClass: 'treasury' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000006',
    name: 'MuHaven Investment Grade Bond',
    symbol: 'MHIG',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '4.80',
    yieldSchedule: 'quarterly',
    kycTier: 0,
    assetClass: 'private_credit' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000007',
    name: 'MuHaven High Yield Bond',
    symbol: 'MHHY',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '7.50',
    yieldSchedule: 'quarterly',
    kycTier: 0,
    assetClass: 'private_credit' as const,
    minInvestment: '100',
  },
  {
    address: '0x0000000000000000000000000000000000000008',
    name: 'MuHaven Real Estate',
    symbol: 'MHRE',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '6.50',
    yieldSchedule: 'monthly',
    kycTier: 0,
    assetClass: 'real_estate' as const,
    minInvestment: '100',
  },
];

async function main() {
  const db = getDb();
  const repo = new PgRwaTokenRepository(db);

  for (const data of DEMO_TOKENS) {
    const existing = await repo.findByAddress(data.address);
    if (existing) {
      console.log(`[skip] ${data.symbol} already registered at ${data.address}`);
      continue;
    }

    const now = new Date();
    const token = new RwaToken({
      id: randomUUID(),
      ...data,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await repo.save(token);
    console.log(`[seed] ${data.symbol} registered at ${data.address}`);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
