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
    apy: '4.80',
    yieldSchedule: 'monthly',
    kycTier: 1,
    assetClass: 'treasury' as const,
    minInvestment: '1000',
  },
  {
    address: '0x0000000000000000000000000000000000000002',
    name: 'MuHaven Money Market',
    symbol: 'MHMM',
    issuerAddress: '0x0000000000000000000000000000000000000000',
    apy: '5.20',
    yieldSchedule: 'daily',
    kycTier: 0,
    assetClass: 'money_market' as const,
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
