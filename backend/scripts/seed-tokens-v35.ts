/**
 * Seed script — registers the Wave 3.5 RWA tokens (TBILL1, GOLD1) in the
 * backend's `rwa_tokens` table so the marketplace + tokens API surface them.
 *
 * Reads addresses from `deployments/arb-sepolia-v2[.staging].json` so the
 * single source of truth stays the on-chain deploy file. Marketing metadata
 * (name, asset class, APY hint, yield schedule) is hardcoded per symbol —
 * those fields don't live on-chain.
 *
 * Usage:
 *   cd backend
 *   MUHAVEN_ENV=staging pnpm seed:tokens:v35     # staging
 *   MUHAVEN_ENV=prod    pnpm seed:tokens:v35     # prod
 *
 * Idempotent: skips tokens already registered. Re-run after any onboard-token
 * call to add new symbols without disturbing existing entries.
 *
 * Behaviour vs the legacy `seed:tokens` script (which inserted 8 placeholder
 * demo tokens at addresses 0x0000…0001 through 0x0000…0008):
 *   - Replaces those placeholders for Wave 3.5 demos. The placeholder rows
 *     are NOT cleaned up by this script — drop the DB volume per
 *     STAGING.md "Reset staging database" if a clean slate is wanted.
 *   - The placeholder addresses still surface in `nav-worker/src/engine.ts`
 *     TOKEN_SOURCES and write to `token_nav_history`. Wave 3.5 tokens read
 *     NAV from the on-chain oracle directly (not from `token_nav_history`),
 *     so the nav-worker writes are harmless noise until that file gets a
 *     Wave 3.5 follow-up.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { PgRwaTokenRepository } from '../src/infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { RwaToken, type AssetClass } from '../src/domain/token-registry/model/rwa-token.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface V2Deployment {
  network: string;
  env: string;
  deployer: string;
  tokens: Record<string, {
    symbol: string;
    name: string;
    issuer: string;
    contracts: { MuHavenToken: { proxy: string } };
  }>;
}

/**
 * Marketing metadata per symbol — fields that don't live on-chain and would
 * otherwise need a TokenRegistry extension. Tracked here so the seed script
 * is the single place to tune APY hints / asset class for the marketplace.
 */
const MARKETING: Record<string, {
  assetClass: AssetClass;
  apy?: string;
  yieldSchedule?: string;
  kycTier: number;
  minInvestment?: string;
}> = {
  TBILL1: {
    assetClass: 'treasury',
    apy: '4.30',          // FRED DGS3MO 90-day average — refresh manually as needed
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  GOLD1: {
    assetClass: 'other',  // No 'commodity' class today; 'other' is the closest fit
    apy: undefined,       // Gold doesn't yield — no APY to display
    yieldSchedule: undefined,
    kycTier: 0,
    minInvestment: '1',
  },
};

async function main() {
  const envName = (process.env.MUHAVEN_ENV || 'staging').toLowerCase();
  if (envName !== 'prod' && envName !== 'staging') {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === 'staging' ? '.staging' : '';
  const network = process.env.MUHAVEN_NETWORK || 'arb-sepolia';

  const deployPath = join(
    __dirname, '..', '..', 'deployments', `${network}-v2${envSuffix}.json`,
  );
  if (!existsSync(deployPath)) {
    throw new Error(`Deployment file not found: ${deployPath}. Run scripts/deploy-v2.ts first.`);
  }
  const platform: V2Deployment = JSON.parse(readFileSync(deployPath, 'utf-8'));

  const symbolList = Object.keys(platform.tokens);
  if (symbolList.length === 0) {
    console.log(`No tokens in ${deployPath}. Nothing to seed.`);
    process.exit(0);
  }

  console.log(`\n=== Wave 3.5 Token Seed ===`);
  console.log(`Network:     ${network}`);
  console.log(`Env:         ${envName}`);
  console.log(`Deploy file: ${deployPath}`);
  console.log(`Tokens:      ${symbolList.join(', ')}\n`);

  const db = getDb();
  const repo = new PgRwaTokenRepository(db);

  let inserted = 0;
  let skipped = 0;

  for (const symbol of symbolList) {
    const tk = platform.tokens[symbol];
    const tokenAddr = tk.contracts.MuHavenToken.proxy;

    const existing = await repo.findByAddress(tokenAddr);
    if (existing) {
      console.log(`[skip] ${symbol} already registered at ${tokenAddr}`);
      skipped += 1;
      continue;
    }

    const meta = MARKETING[symbol];
    if (!meta) {
      // Unknown symbol — fall back to defensive defaults so the seed never
      // hard-fails on a future symbol that hasn't been added to MARKETING yet.
      console.log(`[warn] no MARKETING entry for ${symbol}; using 'other' defaults`);
    }

    const now = new Date();
    const token = new RwaToken({
      id: randomUUID(),
      address: tokenAddr,
      name: tk.name,
      symbol: tk.symbol,
      issuerAddress: tk.issuer,
      apy: meta?.apy,
      yieldSchedule: meta?.yieldSchedule,
      kycTier: meta?.kycTier ?? 0,
      assetClass: meta?.assetClass ?? 'other',
      minInvestment: meta?.minInvestment,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    await repo.save(token);
    console.log(`[seed] ${symbol} (${tokenAddr}) → ${token.assetClass}, apy=${token.apy ?? 'n/a'}`);
    inserted += 1;
  }

  console.log(`\nDone. inserted=${inserted}, skipped=${skipped}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
