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
 * Phase 9.C / L1 (2026-05-04) — pre-flight enumeration. Before rotating
 * the impl, walks every epoch in `[1, nextEpochId]` and flags any
 * post-9.B / pre-L1 in-flight epoch (funded, non-zero unscaled
 * `ratePerShare`, not yet swept). Such epochs would mis-claim by a
 * factor of 1e6 under the L1 contract (which divides per-claim share
 * by RATE_SCALE = 1_000_000). Operators must explicitly acknowledge
 * the breaking change via `MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1` before the
 * upgrade proceeds — see ADR-048 / RATE_SCALE natspec.
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

/**
 * Phase 9.C / L1 — enumerate epochs and flag post-9.B in-flight ones
 * (funded with an unscaled `ratePerShare`, not yet swept). These would
 * misbehave under L1's per-claim div-by-RATE_SCALE math.
 *
 * Heuristic: an epoch is "L1-incompatible in-flight" iff
 *   funded == true
 *   ratePerShare > 0
 *   ratePerShare < SCALE_HEURISTIC_THRESHOLD (= RATE_SCALE × 1)  ← see below
 *   isSwept == false
 *
 * The threshold detects "pre-L1 unscaled" rates: pre-L1 unscaled rates
 * are `floor(yield / supply)` — typically much smaller than RATE_SCALE
 * for any realistic supply. L1-scaled rates are `floor(yield × RATE_SCALE
 * / supply)` and are typically much larger than RATE_SCALE.
 *
 * **Intended use case is a one-shot pre-L1 → L1 cutover.** This script
 * runs ONCE against a snapshot proxy holding only pre-9.C epochs (which
 * are either pre-9.B with `ratePerShare == 0` and skipped, or post-9.B
 * with unscaled rates and flagged). If the script gets re-run AFTER L1
 * is live (e.g. for a future contract revision), L1-funded epochs with
 * scaled rates < RATE_SCALE would falsely block — possible when an
 * issuer funds a sub-1:1 yield (e.g. $1 yield on $25 supply scales to
 * `40_000n` which is below RATE_SCALE = `1_000_000n`). At that point
 * the operator should either:
 *   (a) override with `MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1` after manually
 *       verifying the flagged epochs are L1-funded (not pre-L1
 *       leftovers), or
 *   (b) replace this heuristic with a deploy-timestamp comparison
 *       (`epoch.snapshotEndTs > L1_DEPLOY_TS`) — out of scope for the
 *       initial L1 cutover.
 */
async function preflightInFlightEpochs(snapshotAddr: string): Promise<{ id: bigint; rate: bigint }[]> {
  const RATE_SCALE_THRESHOLD = 1_000_000n;
  const snapshot = new ethers.Contract(
    snapshotAddr,
    [
      "function nextEpochId() view returns (uint256)",
      "function getEpoch(uint256) view returns (tuple(address token, uint256 snapshotStartTs, uint256 snapshotEndTs, bool finalized, bool funded, bytes32 encTotalYield, bytes32 encTotalSupply, bytes32 encRatio, uint256 claimExpiry, uint256 holderCount, uint128 ratePerShare))",
      "function isSwept(uint256) view returns (bool)",
    ],
    ethers.provider,
  );

  const next: bigint = await snapshot.nextEpochId();
  const flagged: { id: bigint; rate: bigint }[] = [];
  for (let i = 1n; i <= next; i++) {
    const e = await snapshot.getEpoch(i);
    if (!e.funded) continue;
    if (e.ratePerShare === 0n) continue;        // pre-9.B legacy encRatio path — safe.
    if (e.ratePerShare >= RATE_SCALE_THRESHOLD) continue;  // L1-scaled rate — safe.
    const swept: boolean = await snapshot.isSwept(i);
    if (swept) continue;
    flagged.push({ id: i, rate: e.ratePerShare });
  }
  return flagged;
}

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

  // Phase 9.C / L1 — pre-flight enumeration. Refuse to ship the L1
  // contract over a snapshot proxy holding pre-L1 in-flight epochs
  // (post-9.B funded epochs with unscaled `ratePerShare`). Such
  // epochs would silent-fail every claim post-upgrade.
  console.log(`\n[0/2] enumerating in-flight epochs…`);
  const flagged = await preflightInFlightEpochs(proxyAddr);
  if (flagged.length > 0) {
    console.log(`\n  ⚠ Found ${flagged.length} pre-L1 in-flight epoch(s):`);
    for (const f of flagged) {
      console.log(`     epoch #${f.id}  ratePerShare=${f.rate}  (< RATE_SCALE = unscaled)`);
    }
    if (process.env.MUHAVEN_ALLOW_PRE_L1_INFLIGHT !== "1") {
      console.log(`\n  Aborting upgrade — these epochs would silent-fail every claim`);
      console.log(`  under the L1 contract. Either:`);
      console.log(`    1. Wait for every snapshotted holder to claim, then advance past`);
      console.log(`       claimExpiry and call YieldSnapshot.sweepExpired(epochId);`);
      console.log(`    2. Re-run with MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1 if you accept the`);
      console.log(`       breaking change (in-flight epoch claims will silent-fail to zero).`);
      process.exit(1);
    }
    console.log(`\n  MUHAVEN_ALLOW_PRE_L1_INFLIGHT=1 set — proceeding despite warning.`);
  } else {
    console.log(`  no pre-L1 in-flight epochs found.`);
  }

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
