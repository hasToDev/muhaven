/**
 * scripts/deploy.ts
 *
 * Full MuHaven deployment script using OpenZeppelin Transparent Proxies.
 *
 * Local (in-process hardhat network):
 *   pnpm run deploy:local
 *   → Deploys TestTreasury + MockPUSDC inline, then all core contracts.
 *     MuHavenEscrow is deployed fresh (replaces ReineiraOS ConfidentialEscrow — Phase 19B).
 *
 * Testnet (Arbitrum Sepolia):
 *   pnpm run deploy:testnet
 *   → Requires UNDERLYING_TOKEN_ADDRESS and PUSDC_ADDRESS in .env.
 *     MuHavenEscrow is deployed fresh behind an OZ Transparent Proxy.
 *
 * Output: deployments/{network}.json (proxy + implementation addresses)
 */

import { ethers, upgrades, network } from "hardhat";
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from "fs";
import { join } from "path";

type DeployEntry = {
  proxy?: string;
  implementation?: string;
  address?: string;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const isLocal = net === "hardhat" || net === "localhost";

  // Deployment environment — controls the output filename and guards against
  // accidentally overwriting the prod deployments record from a staging deploy
  // (and vice versa). Defaults to "prod" so existing deploys are unchanged.
  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(
      `MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`,
    );
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  console.log(`\nDeploying MuHaven to [${net}] (env=${envName})`);
  console.log(`Deployer: ${deployer.address}\n`);

  // ── Config ──────────────────────────────────────────────────────────────
  const owner = deployer.address;
  const issuer = process.env.ISSUER_ADDRESS || deployer.address;
  const usdcAddress = process.env.USDC_ADDRESS || ethers.ZeroAddress;
  // 100 underlying tokens (18 decimals) as minimum vault investment
  const minInvestment = ethers.parseUnits("100", 18);

  // Testnet: both required; local: deployed inline below
  let underlyingTokenAddress: string;
  let pusdcAddress: string;

  if (!isLocal) {
    if (!process.env.UNDERLYING_TOKEN_ADDRESS) {
      throw new Error("UNDERLYING_TOKEN_ADDRESS is required for non-local deploy");
    }
    if (!process.env.PUSDC_ADDRESS) {
      throw new Error("PUSDC_ADDRESS is required for non-local deploy");
    }
    underlyingTokenAddress = process.env.UNDERLYING_TOKEN_ADDRESS;
    pusdcAddress = process.env.PUSDC_ADDRESS;
  } else {
    // Will be assigned in the local-mocks block below; TS needs a definite value
    underlyingTokenAddress = ethers.ZeroAddress;
    pusdcAddress = ethers.ZeroAddress;
  }

  console.log(`Owner/Deployer:  ${owner}`);
  console.log(`Issuer:          ${issuer}`);
  console.log(`USDC:            ${usdcAddress || "(zero — not exercised at deploy)"}`);
  console.log();

  const record: Record<string, DeployEntry> = {};

  // ── 0. Local mocks (hardhat / localhost only) ────────────────────────────
  if (isLocal) {
    console.log("0a. [local] Deploying TestTreasury (underlying ERC-20)...");
    const TreasuryFactory = await ethers.getContractFactory("TestTreasury");
    const treasury = await TreasuryFactory.deploy(
      "Test Treasury Token",
      "tRWA",
      ethers.parseUnits("1000000", 18), // 1M tokens pre-minted to deployer
    );
    await treasury.waitForDeployment();
    underlyingTokenAddress = await treasury.getAddress();
    record["TestTreasury"] = { address: underlyingTokenAddress };
    console.log(`   TestTreasury: ${underlyingTokenAddress}`);

    console.log("0b. [local] Deploying MockPUSDC...");
    const MockPUSDCFactory = await ethers.getContractFactory("MockPUSDC");
    const mockPusdc = await MockPUSDCFactory.deploy();
    await mockPusdc.waitForDeployment();
    pusdcAddress = await mockPusdc.getAddress();
    record["MockPUSDC"] = { address: pusdcAddress };
    console.log(`   MockPUSDC: ${pusdcAddress}\n`);
  }

  // ── 1. ERC3643KYCAdapter (non-proxied — swap pattern) ───────────────────
  console.log("1. ERC3643KYCAdapter...");
  const KYCFactory = await ethers.getContractFactory("ERC3643KYCAdapter");
  const kycAdapter = await KYCFactory.deploy(owner);
  await kycAdapter.waitForDeployment();
  const kycAddr = await kycAdapter.getAddress();
  record["ERC3643KYCAdapter"] = { address: kycAddr };
  console.log(`   ${kycAddr}`);

  // ── 2. InvestorRegistry (proxied) ───────────────────────────────────────
  console.log("2. InvestorRegistry (proxy)...");
  const RegistryFactory = await ethers.getContractFactory("InvestorRegistry");
  const registry = await upgrades.deployProxy(RegistryFactory, [owner], {
    kind: "transparent",
  });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  record["InvestorRegistry"] = {
    proxy: registryAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(registryAddr),
  };
  console.log(`   proxy: ${registryAddr}`);
  console.log(`   impl:  ${record["InvestorRegistry"].implementation}`);

  // ── 3. MuHavenToken (proxied) ────────────────────────────────────────────
  // Note: initialize() already grants minter role to _issuer; no extra grantMinter call needed.
  console.log("3. MuHavenToken (proxy)...");
  const TokenFactory = await ethers.getContractFactory("MuHavenToken");
  const token = await upgrades.deployProxy(
    TokenFactory,
    ["MuHaven RWA Token", "mhRWA", kycAddr, registryAddr, issuer, usdcAddress],
    { kind: "transparent" },
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  record["MuHavenToken"] = {
    proxy: tokenAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(tokenAddr),
  };
  console.log(`   proxy: ${tokenAddr}`);
  console.log(`   impl:  ${record["MuHavenToken"].implementation}`);

  // ── 4. RiskParams (proxied) ──────────────────────────────────────────────
  console.log("4. RiskParams (proxy)...");
  const RiskFactory = await ethers.getContractFactory("RiskParams");
  const riskParams = await upgrades.deployProxy(RiskFactory, [owner], { kind: "transparent" });
  await riskParams.waitForDeployment();
  const riskAddr = await riskParams.getAddress();
  record["RiskParams"] = {
    proxy: riskAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(riskAddr),
  };
  console.log(`   proxy: ${riskAddr}`);
  console.log(`   impl:  ${record["RiskParams"].implementation}`);

  // ── 5. YieldGate (non-proxied — swap pattern) ────────────────────────────
  console.log("5. YieldGate...");
  const GateFactory = await ethers.getContractFactory("YieldGate");
  const yieldGate = await GateFactory.deploy(tokenAddr, kycAddr);
  await yieldGate.waitForDeployment();
  const gateAddr = await yieldGate.getAddress();
  record["YieldGate"] = { address: gateAddr };
  console.log(`   ${gateAddr}`);

  // ── 6. MuHavenEscrow (proxied) ───────────────────────────────────────────
  // Replaces the ReineiraOS ConfidentialEscrow in the yield pipeline (Phase 19B).
  // paymentToken is bound at init time — subsequent swaps via setPaymentToken().
  console.log("6. MuHavenEscrow (proxy)...");
  const EscrowFactory = await ethers.getContractFactory("MuHavenEscrow");
  const muhavenEscrow = await upgrades.deployProxy(
    EscrowFactory,
    [owner, pusdcAddress],
    { kind: "transparent" },
  );
  await muhavenEscrow.waitForDeployment();
  const escrowAddr = await muhavenEscrow.getAddress();
  record["MuHavenEscrow"] = {
    proxy: escrowAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(escrowAddr),
  };
  console.log(`   proxy: ${escrowAddr}`);
  console.log(`   impl:  ${record["MuHavenEscrow"].implementation}`);

  // ── 7. YieldDistributor (proxied) ────────────────────────────────────────
  console.log("7. YieldDistributor (proxy)...");
  const DistFactory = await ethers.getContractFactory("YieldDistributor");
  const distributor = await upgrades.deployProxy(
    DistFactory,
    [registryAddr, escrowAddr, gateAddr, owner, pusdcAddress],
    { kind: "transparent" },
  );
  await distributor.waitForDeployment();
  const distAddr = await distributor.getAddress();
  record["YieldDistributor"] = {
    proxy: distAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(distAddr),
  };
  console.log(`   proxy: ${distAddr}`);
  console.log(`   impl:  ${record["YieldDistributor"].implementation}`);

  // ── 8. MuHavenVault (proxied) ────────────────────────────────────────────
  console.log("8. MuHavenVault (proxy)...");
  const VaultFactory = await ethers.getContractFactory("MuHavenVault");
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [underlyingTokenAddress, tokenAddr, minInvestment],
    { kind: "transparent" },
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  record["MuHavenVault"] = {
    proxy: vaultAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(vaultAddr),
  };
  console.log(`   proxy: ${vaultAddr}`);
  console.log(`   impl:  ${record["MuHavenVault"].implementation}`);

  // ── Post-deploy wiring ───────────────────────────────────────────────────
  console.log("\nWiring...");

  // Token contract can register investors in the registry
  const registryContract = await ethers.getContractAt("InvestorRegistry", registryAddr);
  await (await registryContract.setAuthorizedCaller(tokenAddr, true)).wait();
  console.log("   registry.setAuthorizedCaller(token) ✓");

  // Vault can mint fhERC-20 tokens when wrapping
  // (issuer minter role already granted inside MuHavenToken.initialize())
  const tokenContract = await ethers.getContractAt("MuHavenToken", tokenAddr);
  await (await tokenContract.grantMinter(vaultAddr)).wait();
  console.log("   token.grantMinter(vault) ✓");

  // Issuer can call startDistribution on YieldDistributor
  const distContract = await ethers.getContractAt("YieldDistributor", distAddr);
  await (await distContract.setAuthorizedCaller(issuer, true)).wait();
  console.log("   distributor.setAuthorizedCaller(issuer) ✓");

  // YieldGate must know which escrow is allowed to call onConditionSet.
  // One-shot setter — if the escrow is ever rotated, deploy a fresh YieldGate too.
  const yieldGateContract = await ethers.getContractAt("YieldGate", gateAddr);
  await (await yieldGateContract.setAuthorizedEscrow(escrowAddr)).wait();
  console.log("   yieldGate.setAuthorizedEscrow(muhavenEscrow) ✓");

  // Distributor must be allowed to call MuHavenEscrow.fundFrom inside processBatch.
  const escrowContract = await ethers.getContractAt("MuHavenEscrow", escrowAddr);
  await (await escrowContract.setAuthorizedCaller(distAddr, true)).wait();
  console.log("   muhavenEscrow.setAuthorizedCaller(distributor) ✓");

  // Issuer wallet drives SDK batchCreate from off-chain — needs authorizedCaller
  // status so MuHavenEscrow accepts its batchCreate calls (redeem remains
  // permissionless — the silent-failure chain gates payouts).
  await (await escrowContract.setAuthorizedCaller(issuer, true)).wait();
  console.log("   muhavenEscrow.setAuthorizedCaller(issuer) ✓");

  // ── Save deployments (archive previous if exists) ────────────────────────
  // File naming: prod → `${net}.json`, staging → `${net}.staging.json`.
  // The suffix lives in the filename (not a subdirectory) so both files sit
  // side-by-side and are trivial to diff.
  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${net}${envSuffix}.json`);

  // Defence in depth: refuse to write to the *other* environment's file even
  // if someone wires the script up oddly. Staging must never touch the prod
  // JSON that the live frontend/backend consume.
  const prodPath = join(outDir, `${net}.json`);
  const stagingPath = join(outDir, `${net}.staging.json`);
  if (envName === "staging" && outPath === prodPath) {
    throw new Error("refusing to overwrite prod deployments file from a staging deploy");
  }
  if (envName === "prod" && outPath === stagingPath) {
    throw new Error("refusing to overwrite staging deployments file from a prod deploy");
  }

  if (existsSync(outPath)) {
    const historyDir = join(outDir, "history");
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(historyDir, `${net}${envSuffix}.${ts}.json`);
    copyFileSync(outPath, archivePath);
    console.log(`\nArchived previous deployment → deployments/history/${net}${envSuffix}.${ts}.json`);
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        network: net,
        env: envName,
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: record,
      },
      null,
      2,
    ),
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\nDeployments saved → deployments/${net}${envSuffix}.json`);
  console.log("\n=== MuHaven Deployment Summary ===");
  const pad = 22;
  for (const [name, entry] of Object.entries(record)) {
    console.log(`${name.padEnd(pad)} ${entry.proxy ?? entry.address}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
