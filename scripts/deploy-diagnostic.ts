/**
 * scripts/deploy-diagnostic.ts
 *
 * Deploy diagnostic contracts (MockPUSDC + TestFHERC20) to testnet
 * for investigating the confidentialTransferFrom revert.
 *
 * These contracts use real CoFHE FHE operations on testnet but have
 * controllable behavior (e.g., toggleable ACL check) to isolate the issue.
 *
 * Usage:
 *   pnpm hardhat run scripts/deploy-diagnostic.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  console.log(`\n=== Deploy Diagnostic Contracts ===`);
  console.log(`Network:  ${net}`);
  console.log(`Deployer: ${deployer.address}\n`);

  // ── Deploy MockPUSDC ────────────────────────────────────────────────
  console.log("--- Deploying MockPUSDC ---");
  const MockPUSDCFactory = await ethers.getContractFactory("MockPUSDC");
  const mockPusdc = await MockPUSDCFactory.deploy();
  await mockPusdc.waitForDeployment();
  const mockPusdcAddr = await mockPusdc.getAddress();
  console.log(`  MockPUSDC deployed at: ${mockPusdcAddr}`);

  // Mint initial tokens to deployer
  const mintAmount = 100_000_000n; // 100 PUSDC (6 decimals)
  const mintTx = await mockPusdc.mint(deployer.address, mintAmount);
  await mintTx.wait();
  console.log(`  Minted ${mintAmount} to deployer\n`);

  // ── Deploy TestFHERC20 ──────────────────────────────────────────────
  console.log("--- Deploying TestFHERC20 ---");
  const TestFHERC20Factory = await ethers.getContractFactory("TestFHERC20");
  const testToken = await TestFHERC20Factory.deploy();
  await testToken.waitForDeployment();
  const testTokenAddr = await testToken.getAddress();
  console.log(`  TestFHERC20 deployed at: ${testTokenAddr}`);

  // Mint initial tokens to deployer
  const mintTx2 = await testToken.mint(deployer.address, mintAmount);
  await mintTx2.wait();
  console.log(`  Minted ${mintAmount} to deployer`);
  console.log(`  ACL check enabled: ${await testToken.aclCheckEnabled()}\n`);

  // ── Save deployment ─────────────────────────────────────────────────
  const diagPath = join(__dirname, "..", "deployments", `${net}.diagnostic.json`);

  // Merge with existing diagnostic deployment if present
  let existing: any = {};
  if (existsSync(diagPath)) {
    try {
      existing = JSON.parse(readFileSync(diagPath, "utf8"));
    } catch { /* ignore */ }
  }

  const deployment = {
    ...existing,
    network: net,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      ...(existing.contracts ?? {}),
      MockPUSDC: mockPusdcAddr,
      TestFHERC20: testTokenAddr,
    },
  };

  writeFileSync(diagPath, JSON.stringify(deployment, null, 2));
  console.log(`Deployment saved → deployments/${net}.diagnostic.json`);
  console.log(`\nNext steps:`);
  console.log(`  1. Upgrade YieldDistributor: pnpm hardhat run scripts/upgrade-yield-distributor.ts --network ${net}`);
  console.log(`  2. Run diagnostics:          pnpm hardhat run scripts/test-diagnostic.ts --network ${net}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
