/**
 * scripts/grant-trusted-payer.ts
 *
 * One-shot owner-gated tx that registers the YieldSnapshot proxy as a
 * trusted payer on the MuHavenStable wrapper. Required after upgrading
 * MuHavenStable to the Phase 8 Option B / ADR-046 implementation;
 * `YieldSnapshot.claimYield` calls `IMuHavenStable.trustedPayout(...)`
 * which loud-reverts `NotTrustedPayer` until this grant lands.
 *
 * Idempotent: if the snapshot proxy is already registered, the tx is
 * skipped (the script reads `isTrustedPayer` first). Re-runs are safe.
 *
 * Caller must be the wrapper's `owner()` — staging + prod multi-sig
 * configurations differ; the script reads `owner()` and aborts if the
 * connected signer doesn't match.
 *
 * Usage:
 *   MUHAVEN_ENV=staging \
 *     npx hardhat run scripts/grant-trusted-payer.ts --network arb-sepolia
 *
 *   MUHAVEN_ENV=prod    \
 *     npx hardhat run scripts/grant-trusted-payer.ts --network arb-sepolia
 *
 * Production cutover note: per `feedback_phase8_no_prod_until_signaled`,
 * staging upgrade lands first + Stage E §10 re-runs clean before the
 * user explicitly authorises the prod upgrade.
 */

import { ethers, network } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

const STABLE_ABI = [
  "function owner() view returns (address)",
  "function isTrustedPayer(address payer) view returns (bool)",
  "function setTrustedPayer(address payer, bool allowed) external",
  "event TrustedPayerSet(address indexed payer, bool allowed)",
];

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

  const stableAddr: string | undefined =
    deployment.contracts?.MuHavenStable?.proxy;
  const snapshotAddr: string | undefined =
    deployment.contracts?.YieldSnapshot?.proxy;
  if (!stableAddr || !snapshotAddr) {
    throw new Error(
      `Missing MuHavenStable.proxy or YieldSnapshot.proxy at ${deployPath}.`,
    );
  }

  const [signer] = await ethers.getSigners();
  const stable = new ethers.Contract(stableAddr, STABLE_ABI, signer);

  const wrapperOwner: string = await stable.owner();

  console.log(`\n── grant trusted payer (snapshot → wrapper) ─────────────`);
  console.log(`Network       : ${network.name}`);
  console.log(`Env           : ${env}`);
  console.log(`Wrapper       : ${stableAddr}`);
  console.log(`Snapshot      : ${snapshotAddr}`);
  console.log(`Wrapper owner : ${wrapperOwner}`);
  console.log(`Connected as  : ${signer.address}`);

  if (signer.address.toLowerCase() !== wrapperOwner.toLowerCase()) {
    throw new Error(
      `Connected signer ${signer.address} is not the wrapper owner ` +
        `${wrapperOwner}. Connect the owning wallet (or rotate ownership) ` +
        `before running this script.`,
    );
  }

  const already: boolean = await stable.isTrustedPayer(snapshotAddr);
  if (already) {
    console.log(`\nSnapshot is already a trusted payer — nothing to do.`);
    return;
  }

  console.log(`\n[1/1] setTrustedPayer(${snapshotAddr}, true)…`);
  const tx = await stable.setTrustedPayer(snapshotAddr, true);
  console.log(`[1/1]   tx: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`[1/1]   confirmed (block ${rcpt!.blockNumber})`);

  const verified: boolean = await stable.isTrustedPayer(snapshotAddr);
  if (!verified) {
    throw new Error(
      `Post-tx readback says snapshot is NOT a trusted payer — registration` +
        ` failed silently? Investigate before proceeding.`,
    );
  }

  console.log(`\nDone. YieldSnapshot proxy registered as trusted payer.`);
  console.log(`Next: MUHAVEN_ENV=${env} pnpm hardhat run scripts/upgrade-yield-snapshot.ts \\`);
  console.log(`        --network arb-sepolia`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
