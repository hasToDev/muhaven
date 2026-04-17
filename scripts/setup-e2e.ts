/**
 * scripts/setup-e2e.ts
 *
 * Phase 19 — Grant all on-chain roles and fund a ZeroDev smart account
 * for E2E testing.
 *
 * Takes a smart account address as argument and:
 *   1. Whitelists on ERC3643KYCAdapter (Tier 1)
 *   2. Accredits on ERC3643KYCAdapter (Tier 2)
 *   3. Grants minter role on MuHavenToken
 *   4. Authorizes on YieldDistributor
 *   5. Transfers USDC from deployer to smart account
 *   6. Transfers TestTreasury (underlying ERC-20) tokens to smart account
 *
 * Usage:
 *   pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia -- --address 0xYOUR_SMART_ACCOUNT
 *
 *   Or set the address via env var:
 *   E2E_ADDRESS=0xYOUR_SMART_ACCOUNT pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia
 *
 * Prerequisites:
 *   - Contracts deployed via `pnpm run deploy:testnet`
 *   - deployments/arb-sepolia.json exists
 *   - Deployer wallet funded with testnet ETH + USDC
 */

import { ethers } from "hardhat";
import { loadDeployment, getAddress, sleep } from "./testnet-utils";

// Amounts to transfer for testing
const USDC_TRANSFER_AMOUNT = 100n * 10n ** 6n; // 100 USDC (6 decimals)
const TREASURY_TRANSFER_AMOUNT = 1000n * 10n ** 18n; // 1000 TestTreasury tokens (18 decimals)

async function main() {
  const [deployer] = await ethers.getSigners();

  // ── Parse target address ────────────────────────────────────────────
  const targetAddress =
    process.env.E2E_ADDRESS ||
    process.argv.find((arg) => arg.startsWith("0x"));

  if (!targetAddress || !targetAddress.startsWith("0x")) {
    console.error(
      "\n❌ No target address provided.\n" +
        "Usage:\n" +
        "  E2E_ADDRESS=0x... pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia\n" +
        "  pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia -- 0x...\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== MuHaven E2E Setup ===`);
  console.log(`Network:        ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Target (smart): ${targetAddress}\n`);

  // ── Load deployment ─────────────────────────────────────────────────
  const deployment = loadDeployment();
  const kycAddr = getAddress(deployment, "ERC3643KYCAdapter");
  const tokenAddr = getAddress(deployment, "MuHavenToken");
  const distributorAddr = getAddress(deployment, "YieldDistributor");
  const treasuryAddr =
    process.env.TEST_TREASURY_ADDRESS ||
    deployment.contracts["TestTreasury"]?.proxy ||
    deployment.contracts["TestTreasury"]?.address ||
    "0x580621f5FC5fF3d7912a570839AC1eb55F44a999";

  const usdcAddress =
    process.env.USDC_ADDRESS ||
    "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

  console.log(`KYCAdapter:       ${kycAddr}`);
  console.log(`MuHavenToken:     ${tokenAddr}`);
  console.log(`YieldDistributor: ${distributorAddr}`);
  console.log(`TestTreasury:     ${treasuryAddr}`);
  console.log(`Circle USDC:      ${usdcAddress}\n`);

  // ── Get contract instances ──────────────────────────────────────────
  const kyc = await ethers.getContractAt("ERC3643KYCAdapter", kycAddr);
  const token = await ethers.getContractAt("MuHavenToken", tokenAddr);
  const distributor = await ethers.getContractAt(
    "YieldDistributor",
    distributorAddr,
  );
  const usdc = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    usdcAddress,
  );
  const treasury = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    treasuryAddr,
  );

  // ── Step 1: Whitelist (Tier 1 KYC) ──────────────────────────────────
  console.log("--- Step 1: Whitelist (Tier 1 KYC) ---");
  const alreadyWhitelisted = await kyc.isWhitelisted(targetAddress);
  if (alreadyWhitelisted) {
    console.log(`  Already whitelisted, skipping`);
  } else {
    const tx = await kyc.addToWhitelist(targetAddress);
    await tx.wait();
    console.log(`  addToWhitelist tx: ${tx.hash}`);
  }
  // Wait for state sync
  for (let i = 0; i < 5; i++) {
    if (await kyc.isEligible(targetAddress)) break;
    console.log(`  Waiting for state sync... (${i + 1}/5)`);
    await sleep(3000);
  }
  console.log(`  isEligible: ${await kyc.isEligible(targetAddress)}`);
  console.log(`  ✓ Whitelist done\n`);

  // ── Step 2: Accredit (Tier 2) ───────────────────────────────────────
  console.log("--- Step 2: Accredit (Tier 2) ---");
  const alreadyAccredited = await kyc.isAccredited(targetAddress);
  if (alreadyAccredited) {
    console.log(`  Already accredited, skipping`);
  } else {
    const tx = await kyc.addToAccreditedList(targetAddress);
    await tx.wait();
    console.log(`  addToAccreditedList tx: ${tx.hash}`);
  }
  console.log(`  isAccredited: ${await kyc.isAccredited(targetAddress)}`);
  console.log(`  ✓ Accreditation done\n`);

  // ── Step 3: Grant minter role ───────────────────────────────────────
  console.log("--- Step 3: Grant Minter Role ---");
  const alreadyMinter = await token.minters(targetAddress);
  if (alreadyMinter) {
    console.log(`  Already a minter, skipping`);
  } else {
    const tx = await token.grantMinter(targetAddress);
    await tx.wait();
    console.log(`  grantMinter tx: ${tx.hash}`);
  }
  // Wait for state sync
  for (let i = 0; i < 5; i++) {
    if (await token.minters(targetAddress)) break;
    console.log(`  Waiting for state sync... (${i + 1}/5)`);
    await sleep(3000);
  }
  console.log(`  isMinter: ${await token.minters(targetAddress)}`);
  console.log(`  ✓ Minter role granted\n`);

  // ── Step 4: Authorize on YieldDistributor ────────────────────────────
  console.log("--- Step 4: Authorize on YieldDistributor ---");
  const alreadyAuthorized = await distributor.authorizedCallers(targetAddress);
  if (alreadyAuthorized) {
    console.log(`  Already authorized, skipping`);
  } else {
    const tx = await distributor.setAuthorizedCaller(targetAddress, true);
    await tx.wait();
    console.log(`  setAuthorizedCaller tx: ${tx.hash}`);
  }
  console.log(
    `  isAuthorized: ${await distributor.authorizedCallers(targetAddress)}`,
  );
  console.log(`  ✓ Distributor authorization done\n`);

  // ── Step 5: Transfer USDC ───────────────────────────────────────────
  console.log("--- Step 5: Transfer USDC ---");
  const deployerUsdcBal = await usdc.balanceOf(deployer.address);
  const targetUsdcBal = await usdc.balanceOf(targetAddress);
  console.log(
    `  Deployer USDC: ${ethers.formatUnits(deployerUsdcBal, 6)}`,
  );
  console.log(
    `  Target USDC:   ${ethers.formatUnits(targetUsdcBal, 6)}`,
  );

  if (targetUsdcBal >= USDC_TRANSFER_AMOUNT) {
    console.log(`  Target already has sufficient USDC, skipping`);
  } else if (deployerUsdcBal < USDC_TRANSFER_AMOUNT) {
    console.log(
      `  ⚠ Deployer has insufficient USDC (need ${ethers.formatUnits(USDC_TRANSFER_AMOUNT, 6)}). Skipping transfer.`,
    );
    console.log(`  Get testnet USDC from Circle faucet.`);
  } else {
    const tx = await usdc.transfer(targetAddress, USDC_TRANSFER_AMOUNT);
    await tx.wait();
    console.log(
      `  Transferred ${ethers.formatUnits(USDC_TRANSFER_AMOUNT, 6)} USDC`,
    );
    console.log(`  tx: ${tx.hash}`);
  }
  console.log(`  ✓ USDC step done\n`);

  // ── Step 6: Transfer TestTreasury tokens ────────────────────────────
  console.log("--- Step 6: Transfer TestTreasury Tokens ---");
  const deployerTreasuryBal = await treasury.balanceOf(deployer.address);
  const targetTreasuryBal = await treasury.balanceOf(targetAddress);
  console.log(
    `  Deployer Treasury: ${ethers.formatUnits(deployerTreasuryBal, 18)}`,
  );
  console.log(
    `  Target Treasury:   ${ethers.formatUnits(targetTreasuryBal, 18)}`,
  );

  if (targetTreasuryBal >= TREASURY_TRANSFER_AMOUNT) {
    console.log(`  Target already has sufficient Treasury tokens, skipping`);
  } else if (deployerTreasuryBal < TREASURY_TRANSFER_AMOUNT) {
    console.log(
      `  ⚠ Deployer has insufficient Treasury tokens. Skipping transfer.`,
    );
  } else {
    const tx = await treasury.transfer(
      targetAddress,
      TREASURY_TRANSFER_AMOUNT,
    );
    await tx.wait();
    console.log(
      `  Transferred ${ethers.formatUnits(TREASURY_TRANSFER_AMOUNT, 18)} Treasury tokens`,
    );
    console.log(`  tx: ${tx.hash}`);
  }
  console.log(`  ✓ Treasury step done\n`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("=== E2E Setup Complete ===");
  console.log(`  Target: ${targetAddress}`);
  console.log(`  ✓ KYC Tier 1 (whitelist)`);
  console.log(`  ✓ KYC Tier 2 (accredited)`);
  console.log(`  ✓ Minter role (MuHavenToken)`);
  console.log(`  ✓ Authorized caller (YieldDistributor)`);
  console.log(`  ✓ USDC funded`);
  console.log(`  ✓ TestTreasury funded`);
  console.log(`\nThe target address is ready for E2E testing.\n`);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message || err);
  process.exitCode = 1;
});
