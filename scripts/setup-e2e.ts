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
 *   7. Whitelists + accredits the deployer itself (so deployer can be registered
 *      as an investor in test-e2e-sdk.ts — Phase 19D.3)
 *   8. Wraps USDC → PUSDC on the deployer wallet (E2E_WRAP_AMOUNT, default 10)
 *   9. Grants YieldDistributor operator access on the deployer's PUSDC balance
 *      so startDistribution's confidentialTransferFrom can pull funds
 *
 * Usage:
 *   pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia -- --address 0xYOUR_SMART_ACCOUNT
 *
 *   Or set the address via env var:
 *   E2E_ADDRESS=0xYOUR_SMART_ACCOUNT pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia
 *
 *   Tune wrap amount (skip by setting 0):
 *   E2E_WRAP_AMOUNT=20 pnpm hardhat run scripts/setup-e2e.ts --network arb-sepolia
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

// PUSDC wrap amount for deployer (6 decimals). 10 PUSDC by default — enough
// for ~20 distribution test runs at the 0.5 PUSDC default in test-e2e-sdk.ts.
// Set to 0 to skip the wrap step (useful on re-runs once the deployer already
// has a sizable cUSDC balance).
const DEFAULT_WRAP_AMOUNT_PUSDC = 10n;

// Operator approval expiry — 1 year from now in seconds. uint48 → max ~2^48.
const OPERATOR_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);

// ConfidentialUSDC ABI: the subset setup-e2e calls. Explicit to avoid having
// to import the whole ReineiraOS tokens package.
const PUSDC_ABI = [
  "function wrap(address to, uint256 amount) external",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
] as const;

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

  const pusdcAddress =
    process.env.PUSDC_ADDRESS ||
    "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f";

  console.log(`KYCAdapter:       ${kycAddr}`);
  console.log(`MuHavenToken:     ${tokenAddr}`);
  console.log(`YieldDistributor: ${distributorAddr}`);
  console.log(`TestTreasury:     ${treasuryAddr}`);
  console.log(`Circle USDC:      ${usdcAddress}`);
  console.log(`PUSDC (cUSDC):    ${pusdcAddress}\n`);

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

  // ── Step 7: Deployer-side KYC (whitelist + accredit) ───────────────
  // test-e2e-sdk.ts mints MuHavenToken to the deployer to register it as an
  // investor in the registry. Registration only succeeds if the deployer is
  // KYC-eligible. Mirrors the smart-account flow above, pointed at deployer.
  console.log("--- Step 7: Deployer KYC (whitelist + accredit) ---");
  if (!(await kyc.isWhitelisted(deployer.address))) {
    const tx = await kyc.addToWhitelist(deployer.address);
    await tx.wait();
    console.log(`  addToWhitelist(deployer) tx: ${tx.hash}`);
  } else {
    console.log(`  Deployer already whitelisted`);
  }
  if (!(await kyc.isAccredited(deployer.address))) {
    const tx = await kyc.addToAccreditedList(deployer.address);
    await tx.wait();
    console.log(`  addToAccreditedList(deployer) tx: ${tx.hash}`);
  } else {
    console.log(`  Deployer already accredited`);
  }
  console.log(`  ✓ Deployer KYC done\n`);

  // ── Step 8: Wrap USDC → PUSDC on the deployer wallet ───────────────
  // PUSDC's confidentialBalanceOf returns an encrypted handle, so we can't
  // compare it to a target cleartext amount from this script. The wrap step
  // is controlled explicitly: E2E_WRAP_AMOUNT (in PUSDC units, 6-decimal).
  // Default 10 PUSDC. Set to 0 to skip on re-runs.
  const wrapAmountEnv = process.env.E2E_WRAP_AMOUNT;
  const wrapAmountPusdc = wrapAmountEnv !== undefined
    ? BigInt(wrapAmountEnv)
    : DEFAULT_WRAP_AMOUNT_PUSDC;
  const wrapAmountUnits = wrapAmountPusdc * 10n ** 6n;

  console.log("--- Step 8: Wrap USDC → PUSDC (deployer) ---");
  let wrapOutcome: 'done' | 'skipped (E2E_WRAP_AMOUNT=0)' | 'skipped (insufficient USDC)';
  if (wrapAmountPusdc === 0n) {
    console.log("  E2E_WRAP_AMOUNT=0 — skipping wrap step");
    wrapOutcome = 'skipped (E2E_WRAP_AMOUNT=0)';
  } else {
    const deployerUsdcNow = await usdc.balanceOf(deployer.address);
    console.log(
      `  Target wrap: ${wrapAmountPusdc} PUSDC (${ethers.formatUnits(wrapAmountUnits, 6)} USDC)`,
    );
    console.log(
      `  Deployer USDC: ${ethers.formatUnits(deployerUsdcNow, 6)}`,
    );
    if (deployerUsdcNow < wrapAmountUnits) {
      console.log(
        `  ⚠ Insufficient deployer USDC to wrap (need ${ethers.formatUnits(wrapAmountUnits, 6)}). Skipping.`,
      );
      wrapOutcome = 'skipped (insufficient USDC)';
    } else {
      const usdcErc20 = await ethers.getContractAt(
        "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
        usdcAddress,
      );
      // Approve exactly the wrap amount; wrap pulls via safeTransferFrom.
      const approveTx = await usdcErc20.approve(pusdcAddress, wrapAmountUnits);
      await approveTx.wait();
      console.log(`  usdc.approve(pusdc, ${wrapAmountPusdc}) tx: ${approveTx.hash}`);

      const pusdc = new ethers.Contract(pusdcAddress, PUSDC_ABI, deployer);
      const wrapTx = await pusdc.wrap(deployer.address, wrapAmountUnits);
      await wrapTx.wait();
      console.log(`  pusdc.wrap(deployer, ${wrapAmountPusdc}) tx: ${wrapTx.hash}`);
      wrapOutcome = 'done';
    }
  }
  console.log(`  ${wrapOutcome === 'done' ? '✓' : '○'} Wrap step ${wrapOutcome}\n`);

  // ── Step 9: Set YieldDistributor as PUSDC operator ─────────────────
  // Required for YieldDistributor.startDistribution's confidentialTransferFrom
  // pull to succeed. setOperator is idempotent — calling it again refreshes
  // the expiry. Expiry 1 year out so it doesn't need re-running frequently.
  console.log("--- Step 9: Set distributor as PUSDC operator (deployer) ---");
  const pusdcView = new ethers.Contract(
    pusdcAddress,
    PUSDC_ABI,
    deployer,
  );
  const alreadyOp = await pusdcView.isOperator(deployer.address, distributorAddr);
  if (alreadyOp) {
    console.log(`  Distributor already an operator — refreshing expiry`);
  }
  const opTx = await pusdcView.setOperator(distributorAddr, OPERATOR_EXPIRY);
  await opTx.wait();
  console.log(
    `  pusdc.setOperator(distributor, ${new Date(
      Number(OPERATOR_EXPIRY) * 1000,
    ).toISOString()}) tx: ${opTx.hash}`,
  );
  console.log(`  ✓ Operator set\n`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("=== E2E Setup Complete ===");
  console.log(`  Target (smart account): ${targetAddress}`);
  console.log(`    ✓ KYC Tier 1 (whitelist)`);
  console.log(`    ✓ KYC Tier 2 (accredited)`);
  console.log(`    ✓ Minter role (MuHavenToken)`);
  console.log(`    ✓ Authorized caller (YieldDistributor)`);
  console.log(`    ✓ USDC funded`);
  console.log(`    ✓ TestTreasury funded`);
  console.log(`  Deployer (${deployer.address}):`);
  console.log(`    ✓ KYC Tier 1 + Tier 2`);
  console.log(`    ${wrapOutcome === 'done' ? '✓' : '○'} PUSDC wrap: ${wrapOutcome === 'done' ? `${wrapAmountPusdc} cUSDC wrapped` : wrapOutcome}`);
  console.log(`    ✓ YieldDistributor as PUSDC operator`);
  console.log(`\nReady for Phase 19D.3: test-e2e-sdk.ts\n`);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message || err);
  process.exitCode = 1;
});
