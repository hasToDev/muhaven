/**
 * scripts/upgrade-yield-distributor.ts
 *
 * Upgrade the YieldDistributor proxy to a new implementation.
 * Used after changing the contract (e.g., startDistribution signature).
 *
 * Usage:
 *   pnpm hardhat run scripts/upgrade-yield-distributor.ts --network arb-sepolia
 */

import { ethers, upgrades, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  // Read current deployment
  const deployPath = join(__dirname, "..", "deployments", `${net}.json`);
  const deployment = JSON.parse(readFileSync(deployPath, "utf8"));
  const proxyAddr = deployment.contracts.YieldDistributor.proxy;

  console.log(`\nUpgrading YieldDistributor on [${net}]`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy:    ${proxyAddr}\n`);

  const Factory = await ethers.getContractFactory("YieldDistributor");
  const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory);
  await upgraded.waitForDeployment();

  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log(`Old impl: ${deployment.contracts.YieldDistributor.implementation}`);
  console.log(`New impl: ${newImpl}`);

  // Update deployment file
  deployment.contracts.YieldDistributor.implementation = newImpl;
  deployment.timestamp = new Date().toISOString();
  writeFileSync(deployPath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment file updated → deployments/${net}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
