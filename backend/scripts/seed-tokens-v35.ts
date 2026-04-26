/**
 * Seed script — registers Wave 3.5 RWA tokens in the backend's `rwa_tokens`
 * table by reading the on-chain `TokenRegistry` directly. No filesystem
 * dependency on the deployments JSON, so this works inside the docker
 * container that only has `backend/` mounted.
 *
 * Usage (inside the backend container):
 *   docker compose exec backend pnpm seed:tokens:v35
 *
 * Required env (read from backend/.env.stage):
 *   RPC_URL                  Arb Sepolia RPC endpoint
 *   TOKEN_REGISTRY_ADDRESS   TokenRegistry proxy address
 *   DATABASE_URL             postgres connection string
 *   DB_PROVIDER=postgres
 *
 * Marketing metadata (asset class, APY hint, yield schedule, KYC tier,
 * min investment) lives in a small per-symbol MARKETING table inside this
 * script — those fields don't exist on-chain. Symbols not present in
 * MARKETING fall back to defensive defaults so a fresh on-chain symbol
 * doesn't hard-fail the seed run; tune the entry afterwards.
 *
 * Idempotent — skips tokens already registered. Re-run after every
 * onboard-token call to absorb new symbols.
 */
// No dotenv import — when run via `docker compose exec backend pnpm seed:tokens:v35`,
// env_file: ./backend/.env.stage in docker-compose injects every env var
// already. Local tsx runs against an already-exported shell env.
import { randomUUID } from 'node:crypto';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { PgRwaTokenRepository } from '../src/infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { RwaToken, type AssetClass } from '../src/domain/token-registry/model/rwa-token.js';

const TOKEN_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getRegisteredTokens',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getConfig',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'active', type: 'bool' },
          { name: 'treasury', type: 'address' },
          { name: 'queue', type: 'address' },
          { name: 'oracle', type: 'address' },
          { name: 'issuer', type: 'address' },
          { name: 'minInvestment', type: 'uint128' },
          { name: 'instantRedeemCap', type: 'uint128' },
          { name: 'epochDuration', type: 'uint32' },
          { name: 'paused', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

const MUHAVEN_TOKEN_ABI = [
  { type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const;

interface MarketingEntry {
  assetClass: AssetClass;
  apy?: string;
  yieldSchedule?: string;
  kycTier: number;
  minInvestment?: string;
}

const MARKETING: Record<string, MarketingEntry> = {
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

const FALLBACK_MARKETING: MarketingEntry = {
  assetClass: 'other',
  kycTier: 0,
  minInvestment: '1',
};

async function discoverTokens(
  client: PublicClient,
  registry: Address,
): Promise<Address[]> {
  // Pagination guard — if a deploy ever lists > 100 tokens, the script
  // logs a warning and stops. Easy to bump if needed.
  const PAGE = 100n;
  const tokens = await client.readContract({
    address: registry,
    abi: TOKEN_REGISTRY_ABI,
    functionName: 'getRegisteredTokens',
    args: [0n, PAGE],
  });
  if (tokens.length === Number(PAGE)) {
    console.warn('[warn] returned page is full — there may be more tokens to seed; bump PAGE.');
  }
  return [...tokens];
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const registryAddr = process.env.TOKEN_REGISTRY_ADDRESS as Address | undefined;

  if (!rpcUrl) throw new Error('RPC_URL env var required');
  if (!registryAddr) {
    throw new Error(
      'TOKEN_REGISTRY_ADDRESS env var required — set it in backend/.env.stage ' +
        '(read from deployments/arb-sepolia-v2[.staging].json contracts.TokenRegistry.proxy).',
    );
  }

  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  console.log('\n=== Wave 3.5 Token Seed (on-chain discovery) ===');
  console.log(`RPC URL:        ${rpcUrl}`);
  console.log(`TokenRegistry:  ${registryAddr}\n`);

  const tokenAddrs = await discoverTokens(client, registryAddr);
  if (tokenAddrs.length === 0) {
    console.log('No tokens registered in TokenRegistry. Nothing to seed.');
    process.exit(0);
  }
  console.log(`Discovered ${tokenAddrs.length} token(s):`);
  for (const a of tokenAddrs) console.log(`   ${a}`);
  console.log();

  const db = getDb();
  const repo = new PgRwaTokenRepository(db);

  let inserted = 0;
  let skipped = 0;

  for (const tokenAddr of tokenAddrs) {
    // Existence check first — saves an RPC roundtrip on tokens already in DB.
    const existing = await repo.findByAddress(tokenAddr);
    if (existing) {
      console.log(`[skip] already registered: ${tokenAddr}`);
      skipped += 1;
      continue;
    }

    // Pull symbol + name from the token contract; pull issuer from
    // TokenRegistry (single source of truth — issuer rotation propagates).
    const [symbol, name, cfg] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: MUHAVEN_TOKEN_ABI, functionName: 'symbol' }),
      client.readContract({ address: tokenAddr, abi: MUHAVEN_TOKEN_ABI, functionName: 'name' }),
      client.readContract({
        address: registryAddr,
        abi: TOKEN_REGISTRY_ABI,
        functionName: 'getConfig',
        args: [tokenAddr],
      }),
    ]);

    const meta = MARKETING[symbol] ?? FALLBACK_MARKETING;
    if (!MARKETING[symbol]) {
      console.log(`[warn] no MARKETING entry for "${symbol}" — using 'other' defaults`);
    }

    const now = new Date();
    const token = new RwaToken({
      id: randomUUID(),
      address: tokenAddr,
      name,
      symbol,
      issuerAddress: cfg.issuer,
      apy: meta.apy,
      yieldSchedule: meta.yieldSchedule,
      kycTier: meta.kycTier,
      assetClass: meta.assetClass,
      minInvestment: meta.minInvestment,
      // Mirror the on-chain pause state into the application status — a token
      // registered as paused on-chain shouldn't show as 'active' in the API.
      status: cfg.paused ? 'paused' : 'active',
      createdAt: now,
      updatedAt: now,
      ...(cfg.paused ? { pausedAt: now } : {}),
    });

    await repo.save(token);
    console.log(
      `[seed] ${symbol} (${tokenAddr}) → ${token.assetClass}, ` +
        `apy=${token.apy ?? 'n/a'}, status=${token.status}`,
    );
    inserted += 1;
  }

  console.log(`\nDone. inserted=${inserted}, skipped=${skipped}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
