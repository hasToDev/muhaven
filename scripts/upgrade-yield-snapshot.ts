/**
 * scripts/upgrade-yield-snapshot.ts
 *
 * Upgrade the YieldSnapshot proxy to a new implementation. Phase 8 blocker
 * fix (`PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md`) — switches `claimYield`'s
 * mhUSDC payout from the legacy 2-arg `confidentialTransfer(address,uint256)`
 * shim (kernel-only ACL on the post-claim handle → frontend `decryptForView`
 * 403s, refresh fallback can't fully recover) to the modern split-grant
 * `IMuHavenStable.transferFrom(self, investor, encShare64, address(0),
 * ephemeralEOA)` (ADR-044) which plants the session-EOA grant in the same tx.
 *
 * Storage layout: unchanged. Proxy address: unchanged. Frontend / SDK env:
 * unchanged.
 *
 * Usage:
 *   MUHAVEN_ENV=staging npx hardhat run scripts/upgrade-yield-snapshot.ts \
 *     --network arb-sepolia
 *
 *   MUHAVEN_ENV=prod    npx hardhat run scripts/upgrade-yield-snapshot.ts \
 *     --network arb-sepolia
 *
 * After the run prints the new implementation address, verify it on
 * Arbiscan:
 *   npx hardhat verify --network arb-sepolia <new_impl>
 *
 * The deployment record (`deployments/arb-sepolia-v2[.staging].json`) is
 * updated in place — only `contracts.YieldSnapshot.implementation` rotates.
 *
 * NOTE — production cutover: per `feedback_phase8_no_prod_until_signaled`,
 * staging upgrade lands first + Stage E §10 re-runs clean before the user
 * explicitly authorises the prod upgrade.
 */

import { ethers, upgrades, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "staging").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(
      `MUHAVEN_ENV must be "prod" or "staging" (got "${env}")`,
    );
  }

  const suffix = env === "staging" ? ".staging" : "";
  const deployPath = join(
    __dirname,
    "..",
    "deployments",
    `arb-sepolia-v2${suffix}.json`,
  );
  const deployment = JSON.parse(readFileSync(deployPath, "utf8"));

  const ysEntry = deployment.contracts?.YieldSnapshot;
  if (!ysEntry?.proxy) {
    throw new Error(
      `No YieldSnapshot proxy entry found at ${deployPath}. ` +
        `Expected contracts.YieldSnapshot.proxy / .implementation.`,
    );
  }

  const proxyAddr: string = ysEntry.proxy;
  const oldImpl: string | undefined = ysEntry.implementation;

  const [deployer] = await ethers.getSigners();
  console.log(`\n── YieldSnapshot upgrade ────────────────────────────────`);
  console.log(`Network : ${network.name}`);
  console.log(`Env     : ${env}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy   : ${proxyAddr}`);
  console.log(`Old impl: ${oldImpl ?? "(unknown — first record)"}`);

  const Factory = await ethers.getContractFactory("YieldSnapshot");
  console.log(`\n[1/2] preparing upgrade via @openzeppelin/hardhat-upgrades…`);
  const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory);
  await upgraded.waitForDeployment();

  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log(`[2/2] new implementation: ${newImpl}`);

  if (newImpl.toLowerCase() === (oldImpl ?? "").toLowerCase()) {
    console.log(
      `\nNote: implementation address unchanged. ` +
        `OZ upgrade-plugin reused the bytecode hash — nothing to redeploy.`,
    );
    return;
  }

  ysEntry.implementation = newImpl;
  deployment.timestamp = new Date().toISOString();
  writeFileSync(deployPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nDeployment record updated → ${deployPath}`);

  console.log(`\nNext steps:`);
  console.log(`  1. npx hardhat verify --network arb-sepolia ${newImpl}`);
  console.log(`  2. Re-run STAGE_E_HANDOFF.md §10 (claim → /portfolio decrypt).`);
  console.log(`     Expected: 0 console 403s, 0 passkey prompts.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
