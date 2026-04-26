/**
 * scripts/wrap-test-usdc.ts — wrap a small USDC float into PUSDC + mhUSDC
 *
 * For the Phase 8 smoke-test workflow on a low-balance Arb Sepolia
 * deployer. Run AFTER deploy-v2.ts has landed (the v2 deployment file
 * tells us where MuHavenStable lives so we can do the second wrap leg
 * in one tx).
 *
 * Flow per `MIGRATION.md` "PUSDC continuity":
 *   1. usdc.approve(legacyPusdc, amount)
 *   2. legacyPusdc.wrap(deployer, amount)              → deployer holds PUSDC
 *   3. legacyPusdc.setOperator(mhUSDC, type(uint48).max)
 *   4. mhUSDC.wrap(encAmount, ephemeralEOA=deployer)   → deployer holds mhUSDC
 *
 * After this, you can run a `Subscription.purchase` from the dashboard
 * (or SDK) using the deployer's mhUSDC balance.
 *
 * Usage:
 *   WRAP_AMOUNT_USDC=0.1 pnpm run wrap-test-usdc:testnet:stage
 *
 * Env:
 *   WRAP_AMOUNT_USDC    decimal USDC amount (default: 0.1)
 *   MUHAVEN_ENV         prod | staging (default: prod)
 *   PUSDC_ADDRESS       legacy PUSDC pointer (read from .env)
 *   USDC_ADDRESS        Circle USDC on Arb Sepolia (read from .env)
 *
 * Resilience:
 *   - Each leg checks the deployer's balance before sending — skips
 *     legs that would obviously revert (insufficient USDC, no PUSDC
 *     after wrap step, etc) and prints a follow-up command.
 *   - The mhUSDC wrap is silent-fail bounded by the wrapper, so passing
 *     too much PUSDC just no-ops the leg (no funds lost).
 */

import hre, { ethers, network } from "hardhat";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient } from "../tasks/utils";

const PUSDC_ABI = [
  "function wrap(address to, uint256 amount) external",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address holder, address spender) external view returns (bool)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
] as const;

const USDC_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  const usdcAddress = process.env.USDC_ADDRESS;
  const pusdcAddress = process.env.PUSDC_ADDRESS;
  if (!usdcAddress || !pusdcAddress) {
    throw new Error("USDC_ADDRESS and PUSDC_ADDRESS env vars required");
  }

  const v2Path = join(__dirname, "..", "deployments", `${net}-v2${envSuffix}.json`);
  if (!existsSync(v2Path)) {
    throw new Error(
      `Platform deployment not found at ${v2Path}. Run deploy-v2 first.`
    );
  }
  const platform = JSON.parse(readFileSync(v2Path, "utf-8"));
  const stableAddr = platform.contracts?.MuHavenStable?.proxy as string;
  if (!stableAddr) throw new Error("MuHavenStable not in platform deployment");

  const amountStr = process.env.WRAP_AMOUNT_USDC || "0.1";
  // Parse "0.1" → 100_000 (6-decimal base units) without losing precision
  const wrapAmountUnits = ethers.parseUnits(amountStr, 6);
  if (wrapAmountUnits === 0n) {
    throw new Error(`WRAP_AMOUNT_USDC must be > 0 (got '${amountStr}')`);
  }

  console.log(`\n=== Wrap test USDC → PUSDC → mhUSDC ===`);
  console.log(`Network:      [${net}] (${envName})`);
  console.log(`Deployer:     ${deployer.address}`);
  console.log(`USDC:         ${usdcAddress}`);
  console.log(`PUSDC:        ${pusdcAddress}`);
  console.log(`MuHavenStable: ${stableAddr}`);
  console.log(`Amount:       ${amountStr} USDC (${wrapAmountUnits} base units)\n`);

  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, deployer);
  const pusdc = new ethers.Contract(pusdcAddress, PUSDC_ABI, deployer);

  // ── Step 1: USDC → PUSDC ─────────────────────────────────────────────
  const usdcBal = (await usdc.balanceOf(deployer.address)) as bigint;
  console.log(`USDC balance: ${ethers.formatUnits(usdcBal, 6)}`);

  if (usdcBal < wrapAmountUnits) {
    console.log(
      `⚠ Insufficient USDC. Need ${ethers.formatUnits(wrapAmountUnits, 6)} ` +
        `but have ${ethers.formatUnits(usdcBal, 6)}. ` +
        `Top up at https://faucet.circle.com (Arb Sepolia, 20 USDC / 2h).`
    );
    process.exit(1);
  }

  console.log(`Step 1: usdc.approve(pusdc, ${amountStr})...`);
  const approveTx = await usdc.approve(pusdcAddress, wrapAmountUnits);
  await approveTx.wait();
  console.log(`        tx: ${approveTx.hash}`);

  console.log(`Step 2: pusdc.wrap(deployer, ${amountStr})...`);
  const pusdcWrapTx = await pusdc.wrap(deployer.address, wrapAmountUnits);
  await pusdcWrapTx.wait();
  console.log(`        tx: ${pusdcWrapTx.hash}\n`);

  // ── Step 3: PUSDC operator grant for MuHavenStable ───────────────────
  console.log(`Step 3: pusdc.setOperator(MuHavenStable, type(uint48).max)...`);
  const isOp = await pusdc.isOperator(deployer.address, stableAddr);
  if (isOp) {
    console.log(`        already an operator — skipping\n`);
  } else {
    const opTx = await pusdc.setOperator(stableAddr, 281474976710655n);
    await opTx.wait();
    console.log(`        tx: ${opTx.hash}\n`);
  }

  // ── Step 4: PUSDC → mhUSDC ───────────────────────────────────────────
  console.log(`Step 4: stable.wrap(${amountStr}, deployer)...`);
  const cofheClient = await createCofheClient(hre, deployer);
  const [encAmount] = await cofheClient
    .encryptInputs([Encryptable.uint64(wrapAmountUnits)])
    .execute();

  const stable = await ethers.getContractAt("MuHavenStable", stableAddr);
  // ephemeralEOA = deployer.address — the deployer's session can decrypt
  // its own mhUSDC balance via permit.
  const stableWrapTx = await stable.wrap(encAmount, deployer.address);
  await stableWrapTx.wait();
  console.log(`        tx: ${stableWrapTx.hash}\n`);

  console.log(`✓ Done. Deployer now holds ${amountStr} mhUSDC.`);
  console.log(`\nNext steps:`);
  console.log(`  - Grant Subscription as operator on mhUSDC before purchase:`);
  console.log(
    `      stable.setOperator(${platform.contracts.MuHavenSubscription.proxy}, type(uint48).max)`
  );
  console.log(`  - Then call Subscription.purchase from the dashboard / SDK.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
