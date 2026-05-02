/**
 * Phase 9.A · Expansion (F3) — demo-prep automation for two test issuers.
 *
 * Goal: produce the same backend + on-chain end-state the F2 wizard would,
 * for two pre-known issuer wallets, **without** walking the wizard from a
 * browser. The seeded rows are indistinguishable from "two real users
 * walked /apply-issuer" — same `users` shape, same `issuer_token_deploys`
 * row, same on-chain `MUHAVEN_ISSUER` registration.
 *
 * Production-trajectory posture: the script reuses the F2 deploy library
 * directly (bypassing only the HTTP/JWT/SSE layer), so the contract
 * deploys are byte-identical to a wizard-driven deploy. The corresponding
 * `users` + `issuer_token_deploys` writes are the same shape the F2 use
 * cases produce — see `apply-issuer.use-case.ts` + `deploy-token.use-case.ts`.
 *
 * **Idempotent.** Re-running:
 *   - `users` row: upserts by id (or by wallet_address via existing
 *     `findByWalletAddress`); status flips to `approved` if not already.
 *   - On-chain symbol pre-check: if `TokenRegistry` already lists the
 *     symbol, the deploy step is skipped. The corresponding
 *     `issuer_token_deploys` row is upserted to `succeeded`.
 *   - `rwa_tokens` row: existing rows are skipped (matches the
 *     `seed:tokens:v35` posture).
 *
 * Required env (read from backend/.env / .env.stage in container):
 *   SEED_ISSUER_A_ADDRESS    — kernel/EOA address registered as issuer A
 *   SEED_ISSUER_B_ADDRESS    — same for issuer B
 *   PLATFORM_DEPLOYER_PRIVATE_KEY + the F2 platform-address set + RPC_URL
 *   DATABASE_URL + DB_PROVIDER=postgres
 *
 * Optional env (each pair has hackathon-shaped defaults):
 *   SEED_ISSUER_A_NAME / SEED_ISSUER_A_JURISDICTION / SEED_ISSUER_A_EMAIL
 *   SEED_ISSUER_A_TOKEN_SYMBOL / SEED_ISSUER_A_TOKEN_NAME / SEED_ISSUER_A_ASSET_CLASS
 *   SEED_ISSUER_B_NAME / SEED_ISSUER_B_JURISDICTION / SEED_ISSUER_B_EMAIL
 *   SEED_ISSUER_B_TOKEN_SYMBOL / SEED_ISSUER_B_TOKEN_NAME / SEED_ISSUER_B_ASSET_CLASS
 *
 * Usage (inside the staging container):
 *   docker compose -f docker-compose.stage.yml -p muhaven-stage exec -T backend \
 *     pnpm tsx scripts/seed-demo-issuers.ts
 *
 * Caveat: the script does NOT create ZeroDev passkey-bound kernels for
 * the seeded addresses. If you want to log in as one of the seeded
 * issuers via the dashboard, register a passkey for that wallet first
 * (any login mode); the script's role flip will take effect on the
 * next sign-in.
 */
import { randomUUID } from 'node:crypto';
import { isAddress, type Address } from 'viem';
import { getDb } from '../src/infrastructure/repository/postgres/db.js';
import { PgUserRepository } from '../src/infrastructure/repository/postgres/pg-user.repository.js';
import { PgIssuerTokenDeployRepository } from '../src/infrastructure/repository/postgres/pg-issuer-token-deploy.repository.js';
import { PgRwaTokenRepository } from '../src/infrastructure/repository/postgres/pg-rwa-token.repository.js';
import { User, type IssuerKybSubmission } from '../src/domain/auth/model/user.js';
import {
  IssuerTokenDeploy,
  type DeployConfig,
} from '../src/domain/issuer-onboarding/model/issuer-token-deploy.js';
import { RwaToken, type AssetClass } from '../src/domain/token-registry/model/rwa-token.js';
import { container } from '../src/infrastructure/container.js';

interface DemoIssuerSpec {
  letter: 'A' | 'B';
  walletAddress: Address;
  displayName: string;
  jurisdiction: string;
  email: string;
  token: {
    symbol: string;
    name: string;
    assetClass: AssetClass;
    apy?: string;
    yieldSchedule?: 'monthly' | 'quarterly' | 'annual';
    minInvestment: string;
    initialNav: string;
  };
}

const VALID_ASSET_CLASSES: readonly AssetClass[] = [
  'treasury',
  'money_market',
  'private_credit',
  'real_estate',
  'other',
];

const DEFAULTS_A: Omit<DemoIssuerSpec, 'walletAddress'> = {
  letter: 'A',
  displayName: 'Acme Treasury SPV',
  jurisdiction: 'KY',
  email: 'demo-a@muhaven.app',
  token: {
    symbol: 'TBILL2',
    name: 'Demo T-Bill Series 2',
    assetClass: 'treasury',
    apy: '4.30',
    yieldSchedule: 'monthly',
    minInvestment: '1',
    initialNav: '1000000', // 1.00 PUSDC base units (6 decimals)
  },
};

const DEFAULTS_B: Omit<DemoIssuerSpec, 'walletAddress'> = {
  letter: 'B',
  displayName: 'Polaris Bullion SPV',
  jurisdiction: 'BM',
  email: 'demo-b@muhaven.app',
  token: {
    symbol: 'GOLD2',
    name: 'Demo Gold Series 2',
    assetClass: 'other',
    apy: undefined,
    yieldSchedule: undefined,
    minInvestment: '1',
    initialNav: '1000000',
  },
};

function loadSpec(letter: 'A' | 'B'): DemoIssuerSpec {
  const defaults = letter === 'A' ? DEFAULTS_A : DEFAULTS_B;
  const addr = process.env[`SEED_ISSUER_${letter}_ADDRESS`];
  if (!addr) {
    throw new Error(
      `SEED_ISSUER_${letter}_ADDRESS is required (the kernel/EOA address that should become the on-chain MUHAVEN_ISSUER for issuer ${letter})`,
    );
  }
  if (!isAddress(addr)) {
    throw new Error(`SEED_ISSUER_${letter}_ADDRESS is not a valid Ethereum address: ${addr}`);
  }

  const symbol = (process.env[`SEED_ISSUER_${letter}_TOKEN_SYMBOL`] ?? defaults.token.symbol)
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(symbol)) {
    throw new Error(`SEED_ISSUER_${letter}_TOKEN_SYMBOL must be 3–8 chars [A-Z0-9]: ${symbol}`);
  }

  const rawAssetClass =
    process.env[`SEED_ISSUER_${letter}_ASSET_CLASS`] ?? defaults.token.assetClass;
  if (!VALID_ASSET_CLASSES.includes(rawAssetClass as AssetClass)) {
    throw new Error(
      `SEED_ISSUER_${letter}_ASSET_CLASS must be one of ${VALID_ASSET_CLASSES.join('|')}: ${rawAssetClass}`,
    );
  }
  const assetClass = rawAssetClass as AssetClass;

  return {
    letter,
    walletAddress: addr as Address,
    displayName: process.env[`SEED_ISSUER_${letter}_NAME`] ?? defaults.displayName,
    jurisdiction: process.env[`SEED_ISSUER_${letter}_JURISDICTION`] ?? defaults.jurisdiction,
    email: process.env[`SEED_ISSUER_${letter}_EMAIL`] ?? defaults.email,
    token: {
      symbol,
      name: process.env[`SEED_ISSUER_${letter}_TOKEN_NAME`] ?? defaults.token.name,
      assetClass,
      apy: defaults.token.apy,
      yieldSchedule: defaults.token.yieldSchedule,
      minInvestment: defaults.token.minInvestment,
      initialNav: defaults.token.initialNav,
    },
  };
}

async function ensureUser(
  spec: DemoIssuerSpec,
  userRepo: PgUserRepository,
): Promise<User> {
  const existing = await userRepo.findByWalletAddress(spec.walletAddress);
  const submission: IssuerKybSubmission = {
    display_name: spec.displayName,
    jurisdiction: spec.jurisdiction,
    contact_email: spec.email,
    attestation: 'kyb_skipped',
    submitted_at: new Date().toISOString(),
  };
  const approvedAt = existing?.issuerApprovedAt ?? new Date();

  const updated = new User({
    id: existing?.id ?? randomUUID(),
    walletAddress: spec.walletAddress,
    walletProvider: existing?.walletProvider ?? 'zerodev',
    role: 'issuer',
    email: spec.email,
    createdAt: existing?.createdAt ?? new Date(),
    issuerStatus: 'approved',
    issuerDisplayName: spec.displayName,
    issuerJurisdiction: spec.jurisdiction,
    issuerApprovedAt: approvedAt,
    issuerKybSubmission: existing?.issuerKybSubmission ?? submission,
  });
  await userRepo.save(updated);

  if (existing) {
    console.log(
      `  [user] updated existing row → role=issuer, status=approved (id=${updated.id})`,
    );
  } else {
    console.log(`  [user] inserted new row → role=issuer, status=approved (id=${updated.id})`);
  }
  return updated;
}

async function ensureToken(
  spec: DemoIssuerSpec,
  user: User,
  deployRepo: PgIssuerTokenDeployRepository,
  rwaTokenRepo: PgRwaTokenRepository,
): Promise<{ tokenAddress: Address; deployedNow: boolean }> {
  const library = container.getDeployLibrary();
  if (!library) {
    throw new Error(
      'Deploy library is not configured — set PLATFORM_DEPLOYER_PRIVATE_KEY + the F2 platform-address env vars and re-run',
    );
  }

  // Symbol pre-check is idempotent — if the token is already on-chain we
  // skip the deploy and only ensure DB rows mirror the existing state.
  const existingOnChain = await library.findExistingTokenBySymbol(spec.token.symbol);

  // Refuse to clobber a token someone else owns — the rwa_tokens row
  // mirrors on-chain truth (modulo F1 indexer lag), so a mismatch here
  // means the script's spec disagrees with the deployed reality. Surface
  // the conflict instead of silently writing rows pointing at this
  // spec's applicant.
  if (existingOnChain) {
    const conflicting = await rwaTokenRepo.findByAddress(existingOnChain);
    if (
      conflicting &&
      conflicting.issuerAddress.toLowerCase() !== spec.walletAddress.toLowerCase()
    ) {
      throw new Error(
        `Symbol ${spec.token.symbol} already deployed at ${existingOnChain} with a different issuer ` +
          `(on-chain: ${conflicting.issuerAddress}, spec: ${spec.walletAddress}). ` +
          `Pick a different SEED_ISSUER_${spec.letter}_TOKEN_SYMBOL or rotate the on-chain issuer first.`,
      );
    }
  }

  const config: DeployConfig = {
    symbol: spec.token.symbol,
    name: spec.token.name,
    asset_class: spec.token.assetClass,
    initial_nav: spec.token.initialNav,
    min_investment: spec.token.minInvestment,
    yield_schedule: spec.token.yieldSchedule ?? 'monthly',
    applicant_address: spec.walletAddress,
  };

  let tokenAddress: Address;
  let deployedNow = false;

  if (existingOnChain) {
    tokenAddress = existingOnChain;
    console.log(
      `  [chain] symbol ${spec.token.symbol} already on-chain at ${tokenAddress} — skipping deploy`,
    );
  } else {
    console.log(`  [chain] deploying ${spec.token.symbol} (this takes ~30-60s on Arb Sepolia)…`);
    const result = await library.deploy(
      {
        symbol: spec.token.symbol,
        name: spec.token.name,
        applicant: spec.walletAddress,
        initialNav: BigInt(spec.token.initialNav),
        minInvestment: BigInt(spec.token.minInvestment),
        // Same defaults as DeployTokenUseCase.run() so the seeded
        // tokens behave identically to wizard-deployed ones.
        instantRedeemCap: 100_000_000n,
        epochDuration: 86_400,
      },
      (event) => {
        if (event.status === 'mined') {
          console.log(`    ✓ ${event.step}${event.txHash ? ` (${event.txHash.slice(0, 10)}…)` : ''}`);
        }
      },
    );
    tokenAddress = result.tokenAddress;
    deployedNow = true;
    console.log(`  [chain] deployed ${spec.token.symbol} at ${tokenAddress}`);
  }

  // `rwa_tokens` row — direct write so the script is fully hands-off
  // (the F1 indexer only catches IssuerUpdated, not new TokenRegistered;
  // operators normally close that gap with `seed:tokens:v35`).
  const existingRwa = await rwaTokenRepo.findByAddress(tokenAddress);
  if (existingRwa) {
    console.log(`  [db]    rwa_tokens row already present — skipping`);
  } else {
    const now = new Date();
    const token = new RwaToken({
      id: randomUUID(),
      address: tokenAddress,
      name: spec.token.name,
      symbol: spec.token.symbol,
      issuerAddress: spec.walletAddress,
      apy: spec.token.apy,
      yieldSchedule: spec.token.yieldSchedule,
      kycTier: 0,
      assetClass: spec.token.assetClass,
      minInvestment: spec.token.minInvestment,
      // Token registers PAUSED via the deploy library — applicant kernel
      // unpauses post-setNAV. Mirror that into the application status.
      status: 'paused',
      createdAt: now,
      updatedAt: now,
      pausedAt: now,
    });
    await rwaTokenRepo.save(token);
    console.log(`  [db]    rwa_tokens row → status=paused (kernel unpauses post-setNAV)`);
  }

  // `issuer_token_deploys` row — mirrors what `DeployTokenUseCase.run()`
  // produces on the happy path. Skip when the rwa_tokens row was already
  // present in this run (re-run case): the wizard's deploy-history list
  // is keyed on this table, and accumulating dozens of identical
  // succeeded rows on every re-seed adds noise without information.
  if (deployedNow || !existingRwa) {
    const deploy = new IssuerTokenDeploy({
      id: randomUUID(),
      userId: user.id,
      symbol: spec.token.symbol,
      config,
      status: 'succeeded',
      lastStep: 'register_token',
      resultTokenAddress: tokenAddress,
      errorMessage: null,
      createdAt: new Date(),
      completedAt: new Date(),
    });
    await deployRepo.save(deploy);
    console.log(`  [db]    issuer_token_deploys row → succeeded (deploy_id=${deploy.id})`);
  } else {
    console.log(`  [db]    issuer_token_deploys row skipped (mirror already in place)`);
  }

  return { tokenAddress, deployedNow };
}

async function main() {
  console.log('\n=== Phase 9.A · Expansion (F3) — demo issuer seed ===\n');

  const specs = [loadSpec('A'), loadSpec('B')];

  // Refuse to seed two demo issuers against the same wallet — the second
  // ensureUser would silently overwrite the first's KYB metadata, and
  // both tokens would resolve to one issuer in /investors. Same-symbol
  // collision is also a misconfig — surface it before any chain tx.
  if (specs[0].walletAddress.toLowerCase() === specs[1].walletAddress.toLowerCase()) {
    throw new Error(
      `SEED_ISSUER_A_ADDRESS and SEED_ISSUER_B_ADDRESS resolve to the same wallet (${specs[0].walletAddress}); each demo issuer needs a distinct wallet.`,
    );
  }
  if (specs[0].token.symbol === specs[1].token.symbol) {
    throw new Error(
      `Issuer A and B specify the same token symbol (${specs[0].token.symbol}); set SEED_ISSUER_${specs[1].letter}_TOKEN_SYMBOL to a different value.`,
    );
  }

  const db = getDb();
  const userRepo = new PgUserRepository(db);
  const deployRepo = new PgIssuerTokenDeployRepository(db);
  const rwaTokenRepo = new PgRwaTokenRepository(db);

  let totalDeployed = 0;
  for (const spec of specs) {
    console.log(
      `Issuer ${spec.letter} — ${spec.displayName} (${spec.jurisdiction}) · ${spec.walletAddress}`,
    );
    const user = await ensureUser(spec, userRepo);
    const { deployedNow } = await ensureToken(spec, user, deployRepo, rwaTokenRepo);
    if (deployedNow) totalDeployed += 1;
    console.log();
  }

  console.log(
    `Done. ${totalDeployed} new token(s) deployed; ${specs.length - totalDeployed} already present.`,
  );
  if (totalDeployed > 0) {
    console.log(
      'Next: each issuer kernel (or operator) signs `oracle.setNAV(initial)` + ' +
        '`tokenRegistry.setPaused(false)` to flip the new tokens to active. ' +
        'See PHASE_9A_EXPANSION_PLAN.md §F2.7.',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[seed-demo-issuers] failed:', err);
  process.exit(1);
});
