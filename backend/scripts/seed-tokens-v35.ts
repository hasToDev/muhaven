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
  // ── Wave 5 Q1 — 11 real RWAs sourced from rwa.xyz ────────────────────
  //
  // APY values are apy_7_day snapshots from `oracle_snapshots` at the
  // 2026-05-19 cutover ingest. They'll drift; the long-term plan is for
  // the frontend to read APY directly from `oracle_snapshots.apy_7_day`
  // and let MARKETING.apy fall away. Until that lands, these are
  // operator-refreshed editorial values — bump quarterly or after a
  // major rate move. `seed-yield-bearing-overrides.ts` owns the
  // is_yield_bearing classification (separate concern); MARKETING here
  // is for the legacy `rwa_tokens` display surface.
  //
  // assetClass enum has 5 values (treasury, money_market, private_credit,
  // real_estate, other). Reinsurance + equities have no fit → `'other'`;
  // enum widening is deferred to 1B/1C when the marketplace UI actually
  // varies by asset class.
  //
  // Symbol keys MUST match the on-chain `symbol()` exactly (case-sensitive
  // lookup). The mixed-case tickers (syrupUSDC, ONyc, STRCx, MUon,
  // NVDAon, TSLAx) preserve the rwa.xyz canonical form.
  USYC: {
    assetClass: 'money_market',
    apy: '3.13',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  BUIDL: {
    assetClass: 'money_market',
    apy: '3.55',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  USDY: {
    assetClass: 'money_market',
    apy: '3.55',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  EUTBL: {
    assetClass: 'money_market',
    apy: '1.75',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  CETES: {
    assetClass: 'treasury',
    apy: '5.04',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  syrupUSDC: {
    assetClass: 'private_credit',
    apy: '4.32',
    yieldSchedule: 'monthly',
    kycTier: 0,
    minInvestment: '1',
  },
  ONyc: {
    assetClass: 'other',        // Reinsurance — no enum fit
    apy: '11.29',
    yieldSchedule: 'quarterly', // Reinsurance distributions less frequent
    kycTier: 0,
    minInvestment: '1',
  },
  // Tokenized equities — no APY, no scheduled yield
  STRCx: {
    assetClass: 'other',
    apy: undefined,
    yieldSchedule: undefined,
    kycTier: 0,
    minInvestment: '1',
  },
  MUon: {
    assetClass: 'other',
    apy: undefined,
    yieldSchedule: undefined,
    kycTier: 0,
    minInvestment: '1',
  },
  NVDAon: {
    assetClass: 'other',
    apy: undefined,
    yieldSchedule: undefined,
    kycTier: 0,
    minInvestment: '1',
  },
  TSLAx: {
    assetClass: 'other',
    apy: undefined,
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
  let refreshed = 0;
  let skipped = 0;

  for (const tokenAddr of tokenAddrs) {
    // Always read on-chain truth — issuer rotation, paused-state flips,
    // and (future) per-token config changes all need to flow into
    // `rwa_tokens` regardless of whether the row exists yet. Cheap on
    // a public RPC; the alternative ("skip if row exists") was the
    // pre-2026-05-03 behaviour that left the dashboard stale after
    // every `unpause-token.ts` run.
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

    const existing = await repo.findByAddress(tokenAddr);
    const expectedStatus = cfg.paused ? 'paused' : 'active';

    if (existing) {
      // Existing row — point-update only the columns the F1 indexer is
      // responsible for (status + issuer_address). Other columns (name,
      // apy, asset_class, etc.) stay as the operator / wizard set them
      // — re-seeding is for catching missed events, not for clobbering
      // operator overrides. Both repo methods are idempotent (no-op
      // when the column already matches).
      let didUpdate = false;
      if (existing.status !== expectedStatus) {
        await repo.updatePausedStatus(tokenAddr, cfg.paused);
        didUpdate = true;
      }
      if (existing.issuerAddress.toLowerCase() !== cfg.issuer.toLowerCase()) {
        await repo.updateIssuer(tokenAddr, cfg.issuer);
        didUpdate = true;
      }
      if (didUpdate) {
        console.log(
          `[refresh] ${symbol} (${tokenAddr}) → status=${expectedStatus}, ` +
            `issuer=${cfg.issuer}`,
        );
        refreshed += 1;
      } else {
        console.log(`[skip] already in sync: ${symbol} (${tokenAddr})`);
        skipped += 1;
      }
      continue;
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
      status: expectedStatus,
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

  console.log(`\nDone. inserted=${inserted}, refreshed=${refreshed}, skipped=${skipped}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
