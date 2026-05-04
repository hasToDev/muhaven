/**
 * scripts/deploy-v2.ts — Wave 3.5 platform-wide deployment
 *
 * Deploys every Wave 3.5 contract that is *not* per-token (per-token
 * stacks land via `scripts/onboard-token.ts`).
 *
 * Usage:
 *   pnpm run deploy:v2:local                 # in-process hardhat (auto-mocks)
 *   pnpm run deploy:v2:testnet               # Arb Sepolia (prod)
 *   pnpm run deploy:v2:testnet:stage         # Arb Sepolia (stage)
 *
 * Output: `deployments/{network}-v2[.staging].json`
 *
 * Prerequisites (testnet only):
 *   - `.env` populated with `PRIVATE_KEY` + `ARB_SEPOLIA_RPC_URL` + `ARBISCAN_API_KEY`
 *   - `PUSDC_ADDRESS` env var (legacy ReineiraOS confidential USDC) — wrapped by `MuHavenStable`
 *   - Wave 3 deployment file on disk (so we can reuse `ERC3643KYCAdapter`
 *     per `MIGRATION.md` "KYC continuity" decision). Override with
 *     `KYC_ADAPTER_ADDRESS` if a fresh one is desired.
 *   - Optional Chainlink Functions wiring (configured per-token in onboard
 *     script, but the platform oracle is deployed here):
 *       CHAINLINK_FUNCTIONS_ROUTER       (default: Arb Sepolia canonical)
 *       CHAINLINK_FUNCTIONS_DON_ID       (default: fun-arbitrum-sepolia-1)
 *
 * Deploy order (`development/PRODUCTION_DESIGN/MIGRATION.md §"Deploy order (T-7)"`
 * + Phase 7.5 wrapper interleave + Phase 3 compliance topology):
 *   1.  MuHavenStable                          (wraps legacy PUSDC; pre-cutover deploy)
 *   2.  ClaimTopicsRegistry
 *   3.  TrustedIssuersRegistry
 *   4.  MuHavenIdentityRegistry                (devMode = true per ADR-023)
 *   5.  ModularCompliance
 *   6.  TokenRegistry
 *   7.  InvestorRegistry                       (fresh Wave 3.5 instance)
 *   8.  MuHavenSubscription                    (pusdc → MuHavenStable)
 *   9.  YieldSnapshot                          (pusdc → MuHavenStable)
 *  10.  IssuerControlledOracle                 (platform-shared, used by onboarding by default)
 *  11.  ChainlinkFunctionsOracle               (platform-shared, configured per-token in onboarding)
 *
 * Post-deploy wiring:
 *   - Subscription.setIdentityRegistry + setModularCompliance
 *   - MuHavenStable.setTrustedPayer(YieldSnapshot, true) — Phase 8 Option B
 *     / ADR-046 fast-path. Without this grant, `YieldSnapshot.claimYield`
 *     reverts `NotTrustedPayer` on every claim. Folded into the deploy so
 *     fresh stacks are claim-ready by construction; `scripts/grant-trusted-
 *     payer.ts` remains for upgrade scenarios (post-`upgrade-stable.ts`
 *     where the slot is freshly introduced and needs re-wiring).
 *   - InvestorRegistry.setAuthorizedCaller(...) is delegated to onboard-token.ts
 *   - Per-token oracle config + Token/Treasury/Queue stacks land in onboard-token.ts
 *
 * Chainlink Functions notes (see `development/DEV_WAVE_3_5/PROGRESS.md` Phase 8):
 *   - Subscription must be created on https://functions.chain.link (Arb Sepolia
 *     dashboard), funded with testnet LINK, and the deployed
 *     `ChainlinkFunctionsOracle` proxy address added as a *consumer* of the
 *     subscription. Subscription ID is consumed by `onboard-token.ts`.
 *   - DON ID for Arb Sepolia = `fun-arbitrum-sepolia-1` →
 *     `0x66756e2d617262697472756d2d7365706f6c69612d310000000000000000000000`.
 *   - Router for Arb Sepolia = `0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C`.
 *
 * Verification: run `npx hardhat verify --network arb-sepolia <impl_addr>`
 * for every implementation address in the output JSON. Implementation
 * addresses are surfaced in the Summary block at the end of the run.
 */

import { ethers, upgrades, network } from "hardhat";
import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from "fs";
import { join } from "path";

type DeployEntry = {
  proxy?: string;
  implementation?: string;
  address?: string;
};

// Canonical Arb Sepolia Chainlink Functions wiring (sourced from Chainlink
// docs at https://docs.chain.link/chainlink-functions/supported-networks).
// Override via env if Chainlink rotates these.
const ARB_SEPOLIA_FUNCTIONS_ROUTER = "0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C";
const ARB_SEPOLIA_FUNCTIONS_DON_ID =
  "0x66756e2d617262697472756d2d7365706f6c69612d310000000000000000000000"; // fun-arbitrum-sepolia-1

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const isLocal = net === "hardhat" || net === "localhost";

  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  console.log(`\n=== MuHaven Wave 3.5 Platform Deploy ===`);
  console.log(`Network:  [${net}]`);
  console.log(`Env:      ${envName}`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  // ── Resolve external dependencies (legacy PUSDC + Wave 3 KYC adapter) ──
  let pusdcAddress: string;
  let kycAdapterAddress: string;

  if (isLocal) {
    // Local mocks — deploy a fresh PUSDC + KYC adapter.
    console.log("0. [local] Deploying MockPUSDC...");
    const MockPUSDC = await ethers.getContractFactory("MockPUSDC");
    const pusdc = await MockPUSDC.deploy();
    await pusdc.waitForDeployment();
    pusdcAddress = await pusdc.getAddress();
    console.log(`   MockPUSDC: ${pusdcAddress}`);

    console.log("0. [local] Deploying ERC3643KYCAdapter...");
    const KYC = await ethers.getContractFactory("ERC3643KYCAdapter");
    const kyc = await KYC.deploy(deployer.address);
    await kyc.waitForDeployment();
    kycAdapterAddress = await kyc.getAddress();
    console.log(`   ERC3643KYCAdapter: ${kycAdapterAddress}\n`);
  } else {
    if (!process.env.PUSDC_ADDRESS) {
      throw new Error("PUSDC_ADDRESS env var required for testnet deploy");
    }
    pusdcAddress = process.env.PUSDC_ADDRESS;

    // KYC adapter: env override or read from the existing Wave 3 deploy file
    // per `MIGRATION.md` "KYC continuity" decision. Allows tests to swap to a
    // fresh adapter without touching the Wave 3 file.
    if (process.env.KYC_ADAPTER_ADDRESS) {
      kycAdapterAddress = process.env.KYC_ADAPTER_ADDRESS;
      console.log(`Using KYC adapter from env: ${kycAdapterAddress}`);
    } else {
      const wave3Path = join(__dirname, "..", "deployments", `${net}${envSuffix}.json`);
      if (!existsSync(wave3Path)) {
        throw new Error(
          `Could not locate Wave 3 deployments at ${wave3Path}. ` +
            `Set KYC_ADAPTER_ADDRESS env var to override.`
        );
      }
      const wave3 = JSON.parse(readFileSync(wave3Path, "utf-8"));
      kycAdapterAddress = wave3.contracts?.ERC3643KYCAdapter?.address;
      if (!kycAdapterAddress) {
        throw new Error(`No ERC3643KYCAdapter in ${wave3Path}`);
      }
      console.log(`Reusing Wave 3 KYC adapter: ${kycAdapterAddress}`);
    }
    console.log(`Legacy PUSDC: ${pusdcAddress}\n`);
  }

  const owner = deployer.address;
  const record: Record<string, DeployEntry> = {};

  // Helper: deploy a transparent proxy + push the entry into `record`.
  async function deployProxy(
    name: string,
    factoryName: string,
    initArgs: unknown[],
    initializer = "initialize"
  ) {
    console.log(`Deploying ${name}...`);
    const Factory = await ethers.getContractFactory(factoryName);
    const proxy = await upgrades.deployProxy(Factory, initArgs, {
      kind: "transparent",
      initializer,
    });
    await proxy.waitForDeployment();
    const proxyAddr = await proxy.getAddress();
    const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);
    record[name] = { proxy: proxyAddr, implementation: implAddr };
    console.log(`   ${name} proxy: ${proxyAddr}`);
    console.log(`   ${name} impl:  ${implAddr}`);
    return proxy;
  }

  // ── 1. MuHavenStable — wraps legacy PUSDC (Phase 7.5 / ADR-041) ────────
  // All other Wave 3.5 contracts that touch PUSDC will be initialised
  // pointing at the wrapper, so this must come first.
  const stable = await deployProxy(
    "MuHavenStable",
    "MuHavenStable",
    ["MuHaven Confidential USD", "mhUSDC", owner, pusdcAddress]
  );
  const stableAddr = await stable.getAddress();
  console.log();

  // ── 2. ClaimTopicsRegistry ─────────────────────────────────────────────
  const claimTopics = await deployProxy(
    "ClaimTopicsRegistry",
    "ClaimTopicsRegistry",
    [owner]
  );
  console.log();

  // ── 3. TrustedIssuersRegistry ──────────────────────────────────────────
  const trustedIssuers = await deployProxy(
    "TrustedIssuersRegistry",
    "TrustedIssuersRegistry",
    [owner]
  );
  console.log();

  // ── 4. MuHavenIdentityRegistry — devMode = true per ADR-023 ────────────
  const identity = await deployProxy(
    "MuHavenIdentityRegistry",
    "MuHavenIdentityRegistry",
    [owner, await claimTopics.getAddress(), await trustedIssuers.getAddress(), true]
  );
  const identityAddr = await identity.getAddress();
  console.log();

  // ── 5. ModularCompliance ───────────────────────────────────────────────
  const compliance = await deployProxy(
    "ModularCompliance",
    "ModularCompliance",
    [owner]
  );
  const complianceAddr = await compliance.getAddress();
  console.log();

  // ── 6. TokenRegistry ───────────────────────────────────────────────────
  const tokenRegistry = await deployProxy(
    "TokenRegistry",
    "TokenRegistry",
    [owner]
  );
  console.log();

  // ── 7. InvestorRegistry — fresh Wave 3.5 instance per MIGRATION.md ─────
  const investorRegistry = await deployProxy(
    "InvestorRegistry",
    "InvestorRegistry",
    [owner]
  );
  console.log();

  // ── 8. MuHavenSubscription — pusdc points at MuHavenStable wrapper ─────
  const subscription = await deployProxy(
    "MuHavenSubscription",
    "MuHavenSubscription",
    [owner, await tokenRegistry.getAddress(), kycAdapterAddress, stableAddr]
  );
  const subscriptionAddr = await subscription.getAddress();
  console.log();

  // ── 9. YieldSnapshot — pusdc points at MuHavenStable wrapper ───────────
  const yieldSnapshot = await deployProxy(
    "YieldSnapshot",
    "YieldSnapshot",
    [owner, await tokenRegistry.getAddress(), stableAddr]
  );
  console.log();

  // ── 10. IssuerControlledOracle (platform-shared, multi-token) ──────────
  // Sequencer feed = address(0) on Arb Sepolia (no public uptime feed
  // published yet). Re-wire via `setSequencerUptimeFeed` on Arb One.
  const issuerOracle = await deployProxy(
    "IssuerControlledOracle",
    "IssuerControlledOracle",
    [owner, ethers.ZeroAddress]
  );
  console.log();

  // ── 11. ChainlinkFunctionsOracle (platform-shared, multi-token) ────────
  const chainlinkRouter =
    process.env.CHAINLINK_FUNCTIONS_ROUTER || ARB_SEPOLIA_FUNCTIONS_ROUTER;
  // Local fork: skip Chainlink oracle (router doesn't exist on the local
  // CoFHE-mock chain). Subscription works on the issuer oracle alone.
  let functionsOracleAddr = "";
  if (!isLocal) {
    const functionsOracle = await deployProxy(
      "ChainlinkFunctionsOracle",
      "ChainlinkFunctionsOracle",
      [owner, chainlinkRouter, ethers.ZeroAddress]
    );
    functionsOracleAddr = await functionsOracle.getAddress();
    console.log(`   (router = ${chainlinkRouter})`);
    console.log();
  } else {
    console.log("Skipping ChainlinkFunctionsOracle on local network (no router).\n");
  }

  // ── Post-deploy wiring ─────────────────────────────────────────────────
  console.log("Wiring platform pointers...");

  // Subscription → Phase 3 wiring (IdentityRegistry supersedes the legacy
  // kycGate when set; ModularCompliance enables `canTransfer` gating).
  await (await subscription.setIdentityRegistry(identityAddr)).wait();
  console.log("   subscription.setIdentityRegistry ✓");

  await (await subscription.setModularCompliance(complianceAddr)).wait();
  console.log("   subscription.setModularCompliance ✓");

  // MuHavenStable trusted-payer grant — Phase 8 Option B / ADR-046.
  // YieldSnapshot.claimYield calls IMuHavenStable.trustedPayout(...),
  // which reverts NotTrustedPayer (selector 0x3e9d3e1e) for any caller
  // not in MuHavenStable._trustedPayer. Without this grant, every yield
  // claim fails on prod with a non-obvious selector — the failure mode
  // surfaced 2026-05-04 on the Phase 10 prod cutover when the standalone
  // grant-trusted-payer.ts step was skipped. Deployer == wrapper owner
  // here (line 174 inits the wrapper with `owner = deployer.address`),
  // so the call lands inline at deploy time. Idempotent on re-run via
  // the `isTrustedPayer` view — kept as an unconditional set since the
  // happy path here is a fresh deploy where the slot is empty.
  const yieldSnapshotAddr = await yieldSnapshot.getAddress();
  await (await stable.setTrustedPayer(yieldSnapshotAddr, true)).wait();
  console.log("   stable.setTrustedPayer(YieldSnapshot) ✓");

  // ── Persist deployments JSON ──────────────────────────────────────────
  // Capture external dependencies + Chainlink defaults so the onboarding
  // script can read everything from a single source of truth.
  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${net}-v2${envSuffix}.json`);

  if (existsSync(outPath)) {
    const historyDir = join(outDir, "history");
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(historyDir, `${net}-v2${envSuffix}.${ts}.json`);
    copyFileSync(outPath, archivePath);
    console.log(`\nArchived previous deployment → deployments/history/${net}-v2${envSuffix}.${ts}.json`);
  }

  const payload = {
    network: net,
    env: envName,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    external: {
      legacyPusdc: pusdcAddress,
      kycAdapter: kycAdapterAddress,
      chainlinkFunctionsRouter: chainlinkRouter,
      chainlinkFunctionsDonId: ARB_SEPOLIA_FUNCTIONS_DON_ID,
      // Subscription ID is created manually on the Chainlink Functions
      // dashboard (see `DEV_LOG.md` Phase 8 prereq). Persisted here once
      // the operator records it post-deploy. `onboard-token.ts` reads it
      // either from this slot or from `CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID`
      // env (env wins).
      chainlinkFunctionsSubscriptionId: process.env.CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID
        ? Number(process.env.CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID)
        : null,
    },
    contracts: record,
    tokens: {} as Record<string, unknown>,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nDeployments saved → deployments/${net}-v2${envSuffix}.json`);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n=== Wave 3.5 Platform Deployment Summary ===");
  const pad = 28;
  console.log("External:");
  console.log(`  ${"legacyPusdc".padEnd(pad)} ${pusdcAddress}`);
  console.log(`  ${"kycAdapter".padEnd(pad)} ${kycAdapterAddress}`);
  if (!isLocal) {
    console.log(`  ${"chainlinkFunctionsRouter".padEnd(pad)} ${chainlinkRouter}`);
  }
  console.log("Platform:");
  for (const [name, entry] of Object.entries(record)) {
    console.log(`  ${name.padEnd(pad)} ${entry.proxy ?? entry.address}`);
  }

  if (!isLocal) {
    console.log("\nNext steps:");
    console.log("  1. Record Chainlink Functions subscription ID in deployments JSON");
    console.log(`     (or set CHAINLINK_FUNCTIONS_SUBSCRIPTION_ID env var)`);
    console.log(`  2. Add ChainlinkFunctionsOracle ${functionsOracleAddr}`);
    console.log("     as a consumer of your Chainlink Functions subscription.");
    console.log("  3. Run scripts/bulk-import-whitelist.ts to bring Wave 3 investors over.");
    console.log("  4. Run scripts/onboard-token.ts (per-token) for TBILL1 and GOLD1.");
    console.log("  5. Verify implementations on Arbiscan with:");
    console.log("       npx hardhat verify --network arb-sepolia <impl_addr>");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
