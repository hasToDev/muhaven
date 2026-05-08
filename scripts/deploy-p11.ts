/**
 * scripts/deploy-p11.ts — Wave 4 P11 carry-over contract deploy
 *
 * Deploys the four P11 contracts that were engineering-complete on
 * `agenticwave` but never landed on testnet. Per `development/DEV_WAVE_4/
 * PROGRESS.md` §"Closeout follow-ups (Wave 5)" the deploy was deferred to
 * give the engineering DoD a clean signoff. This script closes that gap.
 *
 * Contracts deployed:
 *   1. KYCAttestationRegistry       (regular ctor — source-chain stub)
 *   2. MuHavenKYCVerifier            (regular ctor — destination-chain stub)
 *   3. DefaultProtection             (OZ Transparent Proxy)
 *   4. EncryptedGovernance           (OZ Transparent Proxy — bound to TBILL1
 *                                     by default; the agent surface reads
 *                                     a single ENCRYPTED_GOVERNANCE_ADDRESS,
 *                                     so per-token coverage is a Wave 5 ask)
 *
 * Cross-contract wiring:
 *   - DefaultProtection.setAuthorizedTrigger(governance, true)
 *   - <BoundToken>.setAuthorizedReader(governance, true)
 *
 * Architectural note — DefaultProtection's interface predates Wave 3.5 and
 * still references `MuHavenEscrow` + `YieldGate` (Wave 3 era). Both proxies
 * remain on-chain at the staging Wave 3 deployment and are reused as-is.
 * This is consistent with the contract's design + the ConfidentialUSDC
 * version-skew assumption (legacy `confidentialTransferFrom(address,address,
 * uint256)` selector). When DefaultProtection is rewritten against the Wave
 * 3.5 RedemptionQueue surface, this wiring will need updating.
 *
 * Usage:
 *   pnpm run deploy:p11:testnet            # prod
 *   pnpm run deploy:p11:testnet:stage      # staging
 *
 * Output: appends `p11.contracts` block to
 *         `deployments/{network}-v2[.staging].json`. Existing `contracts`
 *         + `tokens` blocks are preserved.
 *
 * Required env (testnet):
 *   - PRIVATE_KEY                         deployer (root .env)
 *   - ARB_SEPOLIA_RPC_URL                 RPC
 *
 * Optional env (with sensible defaults):
 *   - P11_GOVERNANCE_BOUND_TOKEN_SYMBOL   default: TBILL1
 *   - P11_VOTING_PERIOD_SECONDS           default: 604800 (7 days)
 *   - P11_QUORUM_BPS                      default: 5000 (50%)
 *   - P11_MIN_RESERVE_RATE_BPS            default: 300 (3%)
 *   - P11_KYC_VALIDITY_PERIOD_SECONDS     default: 2592000 (30 days)
 *   - P11_KYC_TRUSTED_SIGNER              default: deployer
 *   - P11_KYC_SOURCE_CHAIN_ID             default: 421614 (Arb Sepolia,
 *                                         source = destination for hackathon)
 */

import { ethers, upgrades, network } from "hardhat";
import { writeFileSync, existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

type DeployEntry = {
  proxy?: string;
  implementation?: string;
  address?: string;
};

type V2Deployment = {
  network: string;
  env: string;
  timestamp: string;
  deployer: string;
  external: Record<string, unknown>;
  contracts: Record<string, DeployEntry>;
  tokens: Record<string, {
    contracts: { MuHavenToken?: { proxy: string }; [k: string]: unknown };
    [k: string]: unknown;
  }>;
  p11?: P11Block;
};

type P11Block = {
  timestamp: string;
  governanceBoundTokenSymbol: string;
  contracts: Record<string, DeployEntry>;
  external: Record<string, string>;
  config: Record<string, string | number>;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const isLocal = net === "hardhat" || net === "localhost";

  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  console.log(`\n=== Wave 4 P11 Carry-over Deploy ===`);
  console.log(`Network:  [${net}]`);
  console.log(`Env:      ${envName}`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  // ── Load v2 deployment ────────────────────────────────────────────────
  const v2Path = join(__dirname, "..", "deployments", `${net}-v2${envSuffix}.json`);
  if (!existsSync(v2Path)) {
    throw new Error(`v2 deployment not found at ${v2Path}; run deploy:v2:${net}${envSuffix ? ":stage" : ""} first`);
  }
  const v2: V2Deployment = JSON.parse(readFileSync(v2Path, "utf-8"));

  // Wave 3.5 InvestorRegistry — used by DefaultProtection + EncryptedGovernance.
  const investorRegistry = v2.contracts.InvestorRegistry?.proxy;
  if (!investorRegistry) {
    throw new Error("v2 deployment is missing InvestorRegistry.proxy — re-run deploy-v2 first");
  }
  console.log(`Wave 3.5 InvestorRegistry: ${investorRegistry}`);

  // ── Load Wave 3 legacy contracts (escrow + yieldGate) ────────────────
  // DefaultProtection's interface ports from Wave 3 — see file header.
  const wave3Path = join(__dirname, "..", "deployments", `${net}${envSuffix}.json`);
  let muhavenEscrow: string;
  let yieldGate: string;
  if (existsSync(wave3Path)) {
    const wave3 = JSON.parse(readFileSync(wave3Path, "utf-8"));
    muhavenEscrow = wave3.contracts?.MuHavenEscrow?.proxy ?? wave3.contracts?.MuHavenEscrow?.address;
    yieldGate = wave3.contracts?.YieldGate?.address ?? wave3.contracts?.YieldGate?.proxy;
    if (!muhavenEscrow || !yieldGate) {
      throw new Error(
        `Wave 3 deployment at ${wave3Path} is missing MuHavenEscrow or YieldGate. ` +
        `Set MUHAVEN_ESCROW_ADDRESS / YIELD_GATE_ADDRESS env to override.`
      );
    }
  } else {
    if (!process.env.MUHAVEN_ESCROW_ADDRESS || !process.env.YIELD_GATE_ADDRESS) {
      throw new Error(
        `No Wave 3 deployment file at ${wave3Path}; set MUHAVEN_ESCROW_ADDRESS + YIELD_GATE_ADDRESS env`
      );
    }
    muhavenEscrow = process.env.MUHAVEN_ESCROW_ADDRESS;
    yieldGate = process.env.YIELD_GATE_ADDRESS;
  }
  console.log(`Wave 3 MuHavenEscrow:  ${muhavenEscrow}`);
  console.log(`Wave 3 YieldGate:      ${yieldGate}`);

  // ── External deps ────────────────────────────────────────────────────
  const pusdc = (v2.external.legacyPusdc as string) ?? process.env.PUSDC_ADDRESS;
  const kycAdapter = (v2.external.kycAdapter as string) ?? process.env.KYC_ADAPTER_ADDRESS;
  if (!pusdc || !kycAdapter) {
    throw new Error("v2 deployment is missing external.legacyPusdc or external.kycAdapter");
  }
  console.log(`Legacy PUSDC:          ${pusdc}`);
  console.log(`ERC3643 KYC Adapter:   ${kycAdapter}`);

  // ── Bind governance to a MuHavenToken ────────────────────────────────
  const boundSymbol = (process.env.P11_GOVERNANCE_BOUND_TOKEN_SYMBOL || "TBILL1").toUpperCase();
  const boundEntry = v2.tokens?.[boundSymbol];
  if (!boundEntry) {
    throw new Error(
      `Bound token '${boundSymbol}' not found in v2 deployment tokens map; ` +
      `available: ${Object.keys(v2.tokens || {}).join(", ") || "(none)"}`
    );
  }
  const boundToken = boundEntry.contracts?.MuHavenToken?.proxy as string | undefined;
  if (!boundToken) {
    throw new Error(`Bound token '${boundSymbol}' has no MuHavenToken.proxy in v2 deployment`);
  }
  console.log(`Governance bound to:   ${boundSymbol} (${boundToken})`);

  // ── Config ────────────────────────────────────────────────────────────
  const minimumRateBps = Number(process.env.P11_MIN_RESERVE_RATE_BPS ?? 300);
  const votingPeriod = Number(process.env.P11_VOTING_PERIOD_SECONDS ?? 604800);
  const quorumBps = Number(process.env.P11_QUORUM_BPS ?? 5000);
  const kycValidity = Number(process.env.P11_KYC_VALIDITY_PERIOD_SECONDS ?? 2_592_000);
  const kycTrustedSigner = (process.env.P11_KYC_TRUSTED_SIGNER ?? deployer.address) as string;
  const kycSourceChainId = Number(
    process.env.P11_KYC_SOURCE_CHAIN_ID ?? (isLocal ? 31337 : 421614)
  );

  console.log(`\nConfig:`);
  console.log(`  minimumRateBps         = ${minimumRateBps}`);
  console.log(`  votingPeriod (s)       = ${votingPeriod}`);
  console.log(`  quorumBps              = ${quorumBps}`);
  console.log(`  kycValidity (s)        = ${kycValidity}`);
  console.log(`  kycTrustedSigner       = ${kycTrustedSigner}`);
  console.log(`  kycSourceChainId       = ${kycSourceChainId}\n`);

  const record: Record<string, DeployEntry> = {};

  // ── 1. KYCAttestationRegistry (source-chain stub, regular ctor) ──────
  console.log("Deploying KYCAttestationRegistry...");
  const KycReg = await ethers.getContractFactory("KYCAttestationRegistry");
  const kycReg = await KycReg.deploy(
    kycAdapter,
    kycTrustedSigner,
    deployer.address,
    kycValidity
  );
  await kycReg.waitForDeployment();
  const kycRegAddr = await kycReg.getAddress();
  record["KYCAttestationRegistry"] = { address: kycRegAddr };
  console.log(`   KYCAttestationRegistry: ${kycRegAddr}`);
  console.log();

  // ── 2. MuHavenKYCVerifier (destination-chain stub, regular ctor) ─────
  console.log("Deploying MuHavenKYCVerifier...");
  const KycVer = await ethers.getContractFactory("MuHavenKYCVerifier");
  const kycVer = await KycVer.deploy(
    kycTrustedSigner,
    kycSourceChainId,
    kycRegAddr,
    deployer.address
  );
  await kycVer.waitForDeployment();
  const kycVerAddr = await kycVer.getAddress();
  record["MuHavenKYCVerifier"] = { address: kycVerAddr };
  console.log(`   MuHavenKYCVerifier: ${kycVerAddr}`);
  console.log();

  // ── 3. DefaultProtection (OZ Transparent Proxy) ──────────────────────
  console.log("Deploying DefaultProtection (proxy)...");
  const Protection = await ethers.getContractFactory("DefaultProtection");
  const protection = await upgrades.deployProxy(
    Protection,
    [investorRegistry, muhavenEscrow, yieldGate, pusdc, deployer.address, minimumRateBps],
    { kind: "transparent", initializer: "initialize" }
  );
  await protection.waitForDeployment();
  const protectionAddr = await protection.getAddress();
  const protectionImpl = await upgrades.erc1967.getImplementationAddress(protectionAddr);
  record["DefaultProtection"] = { proxy: protectionAddr, implementation: protectionImpl };
  console.log(`   DefaultProtection proxy: ${protectionAddr}`);
  console.log(`   DefaultProtection impl:  ${protectionImpl}`);
  console.log();

  // ── 4. EncryptedGovernance (OZ Transparent Proxy) ────────────────────
  console.log("Deploying EncryptedGovernance (proxy)...");
  const Governance = await ethers.getContractFactory("EncryptedGovernance");
  const governance = await upgrades.deployProxy(
    Governance,
    [boundToken, protectionAddr, investorRegistry, deployer.address, votingPeriod, quorumBps],
    { kind: "transparent", initializer: "initialize" }
  );
  await governance.waitForDeployment();
  const governanceAddr = await governance.getAddress();
  const governanceImpl = await upgrades.erc1967.getImplementationAddress(governanceAddr);
  record["EncryptedGovernance"] = { proxy: governanceAddr, implementation: governanceImpl };
  console.log(`   EncryptedGovernance proxy: ${governanceAddr}`);
  console.log(`   EncryptedGovernance impl:  ${governanceImpl}`);
  console.log();

  // ── Post-deploy wiring ───────────────────────────────────────────────
  console.log("Wiring P11 cross-contract pointers...");

  // Governance must be allowed to trigger protection payouts.
  const protectionContract = await ethers.getContractAt("DefaultProtection", protectionAddr);
  await (await protectionContract.setAuthorizedTrigger(governanceAddr, true)).wait();
  console.log("   protection.setAuthorizedTrigger(governance) ✓");

  // Governance must be authorised to read totalSupply / balances on the
  // bound token (the `authorizedReaders` slot was forward-shipped from
  // Wave 3.5 — see PROGRESS §P11.B).
  const tokenContract = await ethers.getContractAt("MuHavenToken", boundToken);
  await (await tokenContract.setAuthorizedReader(governanceAddr, true)).wait();
  console.log(`   ${boundSymbol}.setAuthorizedReader(governance) ✓`);

  console.log();

  // ── Persist into v2 deployment file ──────────────────────────────────
  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });

  // Archive the prior v2 file if it has an existing p11 block (re-run).
  if (v2.p11) {
    const historyDir = join(outDir, "history");
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(historyDir, `${net}-v2${envSuffix}.${ts}.p11.json`);
    copyFileSync(v2Path, archivePath);
    console.log(`Archived prior v2 (with p11 block) → deployments/history/${net}-v2${envSuffix}.${ts}.p11.json`);
  }

  const p11Block: P11Block = {
    timestamp: new Date().toISOString(),
    governanceBoundTokenSymbol: boundSymbol,
    contracts: record,
    external: {
      muhavenEscrow,
      yieldGate,
      legacyPusdc: pusdc,
      kycAdapter,
      governanceBoundToken: boundToken,
    },
    config: {
      minimumRateBps,
      votingPeriodSeconds: votingPeriod,
      quorumBps,
      kycValidityPeriodSeconds: kycValidity,
      kycTrustedSigner,
      kycSourceChainId,
    },
  };

  const merged: V2Deployment = { ...v2, p11: p11Block };
  writeFileSync(v2Path, JSON.stringify(merged, null, 2));
  console.log(`\nP11 block saved → deployments/${net}-v2${envSuffix}.json (under p11.*)`);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n=== Wave 4 P11 Deployment Summary ===");
  const pad = 28;
  for (const [name, entry] of Object.entries(record)) {
    console.log(`  ${name.padEnd(pad)} ${entry.proxy ?? entry.address}`);
  }
  console.log(`\nGovernance bound token:  ${boundSymbol} (${boundToken})`);
  console.log("\nNext steps:");
  console.log("  1. Update backend/.env(.stage) with the new P11 env vars:");
  console.log(`       DEFAULT_PROTECTION_ADDRESS=${protectionAddr}`);
  console.log(`       ENCRYPTED_GOVERNANCE_ADDRESS=${governanceAddr}`);
  console.log(`       KYC_ATTESTATION_REGISTRY_ADDRESS=${kycRegAddr}`);
  console.log("  2. Restart backend so the AgentToolUseCases re-read the env.");
  console.log("  3. Verify implementations on Arbiscan:");
  console.log(`       npx hardhat verify --network arb-sepolia ${protectionImpl}`);
  console.log(`       npx hardhat verify --network arb-sepolia ${governanceImpl}`);
  console.log(`       npx hardhat verify --network arb-sepolia ${kycRegAddr} ` +
              `${kycAdapter} ${kycTrustedSigner} ${deployer.address} ${kycValidity}`);
  console.log(`       npx hardhat verify --network arb-sepolia ${kycVerAddr} ` +
              `${kycTrustedSigner} ${kycSourceChainId} ${kycRegAddr} ${deployer.address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
