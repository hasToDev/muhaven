/**
 * scripts/sync-token-issuers.ts
 *
 * One-shot operator script. For every row in `rwa_tokens`, reads the
 * authoritative on-chain issuer via `TokenRegistry.getConfig(address).issuer`
 * and UPDATEs the DB column when stale.
 *
 * Why this exists
 * ───────────────
 * `rwa_tokens.issuer_address` is set at registration time (by
 * `seed-tokens-v35.ts` or the on-chain indexer) and is NEVER refreshed
 * when the on-chain `TokenRegistry.setIssuer(token, newIssuer)` rotates.
 * Several use cases trust the DB value as the issuer source-of-truth:
 *
 *   - `GetIssuerTokensUseCase.execute(addr)` → drives the issuer Tokens
 *     dashboard (Phase 9.A scoping fix)
 *   - `PrepareDistributionUseCase` (`prepare-distribution.use-case.ts:35`)
 *     → gates distribution authorisation
 *   - `GetIssuerStatsUseCase` → drives the issuer dashboard's aggregate
 *     stats
 *
 * Without this sync, the just-shipped `scripts/transfer-issuer.ts`
 * rotates on-chain but every backend issuer-only endpoint keeps
 * returning the OLD issuer's tokens. The new issuer can't see their
 * dashboard; the old issuer keeps appearing as if they still own
 * tokens they no longer do.
 *
 * Operator runbook
 * ────────────────
 *   # 1. Rotate on-chain issuer rights:
 *   MUHAVEN_ENV=staging \
 *   MUHAVEN_NEW_ISSUER=0xKernel... \
 *   pnpm hardhat run scripts/transfer-issuer.ts --network arb-sepolia
 *
 *   # 2. Sync DB to the new on-chain truth (this script):
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec backend \
 *     pnpm seed:sync-issuers
 *
 *   # Or locally against the homelab Postgres (adjust DATABASE_URL):
 *   DATABASE_URL=postgresql://... \
 *   RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
 *   TOKEN_REGISTRY_ADDRESS=0x... \
 *   pnpm seed:sync-issuers
 *
 * Required env (read from backend/.env.stage when run inside the
 * container):
 *   RPC_URL                  Arb Sepolia RPC endpoint
 *   TOKEN_REGISTRY_ADDRESS   TokenRegistry proxy
 *   DATABASE_URL             postgres connection
 *   DB_PROVIDER=postgres
 *
 * Idempotent: if the DB row already matches the on-chain issuer, the
 * script logs "skipped" and moves on. Safe to re-run on every demo
 * prep cycle.
 *
 * Production-trajectory follow-up: subscribe to
 * `TokenRegistry.IssuerUpdated` from the existing block-poller so
 * rotations land in the DB without an operator action. Deferred to
 * Wave 4; this script is the bridge.
 */

import { eq } from 'drizzle-orm';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { rwaTokens } from '../src/infrastructure/repository/postgres/schema.js';

const TOKEN_REGISTRY_ABI = [
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

interface OnChainConfig {
  active: boolean;
  treasury: Address;
  queue: Address;
  oracle: Address;
  issuer: Address;
  minInvestment: bigint;
  instantRedeemCap: bigint;
  epochDuration: number;
  paused: boolean;
}

async function readOnChainIssuer(
  client: PublicClient,
  registry: Address,
  token: Address,
): Promise<Address> {
  const cfg = (await client.readContract({
    address: registry,
    abi: TOKEN_REGISTRY_ABI,
    functionName: 'getConfig',
    args: [token],
  })) as unknown as OnChainConfig;
  return cfg.issuer;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const registryAddr = process.env.TOKEN_REGISTRY_ADDRESS as Address | undefined;

  if (!rpcUrl) throw new Error('RPC_URL env var required');
  if (!registryAddr) {
    throw new Error(
      'TOKEN_REGISTRY_ADDRESS env var required — set in backend/.env.stage',
    );
  }

  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  }) as PublicClient;

  const db = getDb();

  console.log(`[sync-token-issuers] registry: ${registryAddr}`);
  console.log(`[sync-token-issuers] rpc: ${rpcUrl}\n`);

  const rows = await db.query.rwaTokens.findMany();
  if (rows.length === 0) {
    console.log('[sync-token-issuers] no rows in rwa_tokens — nothing to sync');
    return;
  }

  let rotated = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const onChainIssuer = await readOnChainIssuer(
        client,
        registryAddr,
        row.address as Address,
      );

      const sameIssuer =
        row.issuerAddress.toLowerCase() === onChainIssuer.toLowerCase();
      if (sameIssuer) {
        console.log(
          `[${row.symbol}] in sync (${row.issuerAddress.slice(0, 10)}…) — skipped`,
        );
        skipped++;
        continue;
      }

      console.log(
        `[${row.symbol}] rotating ${row.issuerAddress.slice(0, 10)}… → ${onChainIssuer.slice(0, 10)}…`,
      );
      await db
        .update(rwaTokens)
        .set({ issuerAddress: onChainIssuer, updatedAt: new Date() })
        .where(eq(rwaTokens.id, row.id));
      rotated++;
    } catch (e) {
      console.error(
        `[${row.symbol}] FAILED:`,
        e instanceof Error ? e.message : e,
      );
      errored++;
    }
  }

  console.log(`\nDone. Rotated ${rotated}; skipped ${skipped}; errored ${errored}.`);
  if (rotated > 0) {
    console.log(
      'Issuer dashboards now reflect the new on-chain owner. Verify on /tokens.',
    );
  }
  if (errored > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
