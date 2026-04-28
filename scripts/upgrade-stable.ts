/**
 * scripts/upgrade-stable.ts
 *
 * Upgrade the MuHavenStable wrapper proxy to a new implementation.
 * Phase 8 Option B / ADR-046 — adds the `trustedPayout` bypass surface
 * that `YieldSnapshot.claimYield` calls instead of `_silentFailBound`-
 * applying `transferFrom`. Cuts the wrapper-side FHE op chain on the
 * snapshot→investor leg from 5 → 2 ops (the cofhe TN testnet indexer
 * empirically refuses to register handles produced by the longer chain).
 *
 * Storage: adds one mapping slot (`_trustedPayer`); shrinks `__gap` from
 * 42 → 41 to compensate. Layout backward-compatible — every prior slot
 * keeps its index.
 *
 * Usage:
 *   MUHAVEN_ENV=staging \
 *     npx hardhat run scripts/upgrade-stable.ts --network arb-sepolia
 *
 *   MUHAVEN_ENV=prod    \
 *     npx hardhat run scripts/upgrade-stable.ts --network arb-sepolia
 *
 * After the run prints the new implementation address, verify it on
 * Arbiscan:
 *   npx hardhat verify --network arb-sepolia <new_impl>
 *
 * Then register the YieldSnapshot proxy as a trusted payer:
 *   MUHAVEN_ENV=staging \
 *     npx hardhat run scripts/grant-trusted-payer.ts --network arb-sepolia
 *
 * Then upgrade YieldSnapshot to switch claimYield onto the new path:
 *   MUHAVEN_ENV=staging \
 *     npx hardhat run scripts/upgrade-yield-snapshot.ts --network arb-sepolia
 *
 * The deployment record (`deployments/arb-sepolia-v2[.staging].json`) is
 * updated in place — only `contracts.MuHavenStable.implementation`
 * rotates.
 *
 * Production cutover note: per `feedback_phase8_no_prod_until_signaled`,
 * staging upgrade lands first + Stage E §10 re-runs clean before the
 * user explicitly authorises the prod upgrade.
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

  const stableEntry = deployment.contracts?.MuHavenStable;
  if (!stableEntry?.proxy) {
    throw new Error(
      `No MuHavenStable proxy entry found at ${deployPath}. ` +
        `Expected contracts.MuHavenStable.proxy / .implementation.`,
    );
  }

  const proxyAddr: string = stableEntry.proxy;
  const oldImpl: string | undefined = stableEntry.implementation;

  const [deployer] = await ethers.getSigners();
  console.log(`\n── MuHavenStable upgrade ────────────────────────────────`);
  console.log(`Network : ${network.name}`);
  console.log(`Env     : ${env}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Proxy   : ${proxyAddr}`);
  console.log(`Old impl: ${oldImpl ?? "(unknown — first record)"}`);

  const Factory = await ethers.getContractFactory("MuHavenStable");
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

  stableEntry.implementation = newImpl;
  deployment.timestamp = new Date().toISOString();
  writeFileSync(deployPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nDeployment record updated → ${deployPath}`);

  console.log(`\nNext steps:`);
  console.log(`  1. npx hardhat verify --network arb-sepolia ${newImpl}`);
  console.log(
    `  2. MUHAVEN_ENV=${env} pnpm hardhat run scripts/grant-trusted-payer.ts \\`,
  );
  console.log(`       --network arb-sepolia`);
  console.log(
    `  3. MUHAVEN_ENV=${env} pnpm hardhat run scripts/upgrade-yield-snapshot.ts \\`,
  );
  console.log(`       --network arb-sepolia`);
  console.log(`  4. Re-run STAGE_E_HANDOFF.md §10 with a fresh kernel.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
