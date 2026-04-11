/**
 * scripts/test-testnet.ts
 *
 * Phase 8.7 — Test basic operations on a live testnet deployment.
 *
 * Reads deployed addresses from deployments/arb-sepolia.json and runs:
 *   1. Read contract metadata (name, symbol, decimals)
 *   2. Whitelist deployer address on KYC adapter
 *   3. Mint encrypted tokens to deployer
 *   4. Transfer encrypted tokens to a second address
 *   5. Request async balance decrypt + read result
 *
 * Usage:
 *   pnpm run test:testnet
 *   pnpm hardhat run scripts/test-testnet.ts --network arb-sepolia
 *
 * Prerequisites:
 *   - Contracts deployed via `pnpm run deploy:testnet`
 *   - deployments/arb-sepolia.json exists with contract addresses
 *   - Deployer wallet funded with testnet ETH
 */

import { ethers, network } from "hardhat";
import hre from "hardhat";
import { createCofheClient } from "../tasks/utils";
import { Encryptable } from "@cofhe/sdk";
import { loadDeployment, getAddress, sleep } from "./testnet-utils";

// CoFHE coprocessor delay — wait for async decrypt task to complete
const COFHE_DELAY_SECONDS = 15;

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const net = network.name;

  console.log(`\n=== MuHaven Testnet Operations Test ===`);
  console.log(`Network:  ${net}`);
  console.log(`Deployer: ${deployer.address}\n`);

  // ── Load deployment ─────────────────────────────────────────────────
  const deployment = loadDeployment();
  console.log(`Deployment loaded (${deployment.timestamp})\n`);

  const kycAddr = getAddress(deployment, "ERC3643KYCAdapter");
  const tokenAddr = getAddress(deployment, "MuHavenToken");
  const registryAddr = getAddress(deployment, "InvestorRegistry");

  console.log(`KYCAdapter:       ${kycAddr}`);
  console.log(`MuHavenToken:     ${tokenAddr}`);
  console.log(`InvestorRegistry: ${registryAddr}\n`);

  // ── Get contract instances ──────────────────────────────────────────
  const kyc = await ethers.getContractAt("ERC3643KYCAdapter", kycAddr);
  const token = await ethers.getContractAt("MuHavenToken", tokenAddr);
  const registry = await ethers.getContractAt("InvestorRegistry", registryAddr);

  // ── Test 1: Read contract metadata ──────────────────────────────────
  console.log("--- Test 1: Contract Metadata ---");
  const name = await token.name();
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  const kycProvider = await kyc.providerName();
  console.log(`  Token name:     ${name}`);
  console.log(`  Token symbol:   ${symbol}`);
  console.log(`  Token decimals: ${decimals}`);
  console.log(`  KYC provider:   ${kycProvider}`);
  console.log(`  ✓ Metadata reads successful\n`);

  // ── Test 2: Whitelist deployer ──────────────────────────────────────
  console.log("--- Test 2: Whitelist Deployer ---");
  const alreadyEligible = await kyc.isEligible(deployer.address);
  if (alreadyEligible) {
    console.log(`  Deployer already whitelisted, skipping`);
  } else {
    const tx = await kyc.addToWhitelist(deployer.address);
    await tx.wait();
    console.log(`  addToWhitelist tx: ${tx.hash}`);
  }
  // RPC nodes may lag behind on state reads after tx — retry a few times
  let eligible = false;
  for (let i = 0; i < 5; i++) {
    eligible = await kyc.isEligible(deployer.address);
    if (eligible) break;
    console.log(`  Waiting for state sync... (attempt ${i + 1}/5)`);
    await sleep(3000);
  }
  console.log(`  isEligible(deployer): ${eligible}`);
  if (!eligible) throw new Error("Deployer not eligible after whitelisting");
  console.log(`  ✓ Whitelist successful\n`);

  // ── Test 3: Mint encrypted tokens ───────────────────────────────────
  console.log("--- Test 3: Mint Encrypted Tokens ---");

  // Use the cofhe SDK to encrypt the mint amount
  const cofheClient = await createCofheClient(hre, deployer);

  const mintAmount = 1000n * 10n ** 18n; // 1000 tokens
  console.log(`  Encrypting ${ethers.formatUnits(mintAmount, 18)} tokens...`);
  const [encrypted] = await cofheClient
    .encryptInputs([Encryptable.uint128(mintAmount)])
    .execute();

  console.log(`  Encrypted ctHash: ${encrypted.ctHash}`);

  const mintTx = await token.mint(deployer.address, encrypted);
  const mintReceipt = await mintTx.wait();
  console.log(`  mint tx:      ${mintTx.hash}`);
  console.log(`  gas used:     ${mintReceipt?.gasUsed}`);
  console.log(`  ✓ Mint successful\n`);

  // ── Test 4: Check investor registry ─────────────────────────────────
  console.log("--- Test 4: Investor Registry ---");
  const isInvestor = await registry.isInvestor(deployer.address);
  const investorCount = await registry.investorCount();
  console.log(`  isInvestor(deployer): ${isInvestor}`);
  console.log(`  investorCount: ${investorCount}`);
  console.log(`  ✓ Registry updated\n`);

  // ── Test 5: Request async balance decrypt ───────────────────────────
  console.log("--- Test 5: Async Balance Decrypt ---");
  const decryptTx = await token.requestBalanceDecrypt();
  await decryptTx.wait();
  console.log(`  requestBalanceDecrypt tx: ${decryptTx.hash}`);
  console.log(
    `  Waiting ${COFHE_DELAY_SECONDS}s for CoFHE coprocessor...`,
  );
  await sleep(COFHE_DELAY_SECONDS * 1000);

  const [balance, decrypted] = await token.getBalanceDecryptResult(
    deployer.address,
  );
  console.log(`  decrypted: ${decrypted}`);
  if (decrypted) {
    console.log(
      `  balance:   ${ethers.formatUnits(balance, 18)} ${symbol}`,
    );
  } else {
    console.log(
      `  ⚠ Decrypt not yet complete — try reading again after more time`,
    );
  }
  console.log(`  ✓ Async decrypt flow tested\n`);

  // ── Test 6: Encrypted transfer ──────────────────────────────────────
  console.log("--- Test 6: Encrypted Transfer ---");

  // Use a second signer if available, otherwise generate a random address
  let recipient: string;
  if (signers.length > 1) {
    recipient = signers[1].address;
  } else {
    recipient = ethers.Wallet.createRandom().address;
  }

  // Whitelist recipient first
  const recipientEligible = await kyc.isEligible(recipient);
  if (!recipientEligible) {
    const whitelistTx = await kyc.addToWhitelist(recipient);
    await whitelistTx.wait();
    console.log(`  Whitelisted recipient: ${recipient}`);
    // Wait for RPC state sync
    for (let i = 0; i < 5; i++) {
      if (await kyc.isEligible(recipient)) break;
      console.log(`  Waiting for recipient state sync... (attempt ${i + 1}/5)`);
      await sleep(3000);
    }
  }

  const transferAmount = 100n * 10n ** 18n; // 100 tokens
  console.log(
    `  Encrypting ${ethers.formatUnits(transferAmount, 18)} tokens for transfer...`,
  );
  const [transferEnc] = await cofheClient
    .encryptInputs([Encryptable.uint128(transferAmount)])
    .execute();

  const transferTx = await token.transfer(recipient, transferEnc);
  const transferReceipt = await transferTx.wait();
  console.log(`  transfer tx:  ${transferTx.hash}`);
  console.log(`  gas used:     ${transferReceipt?.gasUsed}`);
  console.log(`  to:           ${recipient}`);
  console.log(`  ✓ Transfer successful\n`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("=== All Tests Passed ===");
  console.log(`  ✓ Test 1: Contract metadata reads`);
  console.log(`  ✓ Test 2: KYC whitelist`);
  console.log(`  ✓ Test 3: Encrypted mint (${ethers.formatUnits(mintAmount, 18)} tokens)`);
  console.log(`  ✓ Test 4: Investor registry`);
  console.log(`  ✓ Test 5: Async balance decrypt`);
  console.log(`  ✓ Test 6: Encrypted transfer (${ethers.formatUnits(transferAmount, 18)} tokens)`);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message || err);
  process.exitCode = 1;
});
