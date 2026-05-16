/**
 * scripts/rotate-yield-distributor-pusdc.ts
 *
 * Operator-only ONE-SHOT cutover: rotate `YieldDistributor.pusdc` from the
 * legacy ConfidentialUSDC (Privara pUSDC) to MuHavenStable (mhUSDC).
 *
 * Why this exists
 * ───────────────
 * The Wave 3.5 cutover rotated the `pusdc` storage field on Wave-3.5 contracts
 * (Subscription, RedemptionQueue, etc.) — see memory
 * `reference_phase7_5_pusdc_rotation`. But `YieldDistributor` is a Wave-3
 * contract; nothing was calling `startDistribution` post-cutover, so its
 * `pusdc` storage was never rotated. Surfaced 2026-05-21 Phase 2 prod
 * walkthrough: HavenBot's distribute_yield runner sends `setOperator` against
 * the new mhUSDC, but `YieldDistributor.startDistribution` does a low-level
 * `confidentialTransferFrom` against its stored `pusdc` (still pointing at
 * legacy) → `isOperator` is false on the wrong contract → revert
 * `PusdcTransferFailed()` (0x220ecdff).
 *
 * Safety
 * ──────
 * Past distributions captured `address(pusdc)` into their `Distribution.token`
 * field at start time, so existing escrows continue paying out in legacy
 * tokens — unaffected by this rotation. Only NEW distributions started after
 * this script runs will use mhUSDC. MuHavenEscrow doesn't hold its own pusdc
 * storage; it's a passive recipient via `_forwardYieldToEscrow`.
 *
 * Run once per environment, ever.
 *
 * Usage
 * ─────
 *   MUHAVEN_ENV=prod \
 *   pnpm hardhat run scripts/rotate-yield-distributor-pusdc.ts --network arb-sepolia
 *
 *   # Override target (default reads MuHavenStable.proxy from arb-sepolia-v2.json):
 *   MUHAVEN_ENV=prod \
 *   MUHAVEN_NEW_PUSDC=0xF9bc25b67238C870255c33EC75fA37A09C00edE7 \
 *   pnpm hardhat run scripts/rotate-yield-distributor-pusdc.ts --network arb-sepolia
 *
 * Required env
 *   MUHAVEN_ENV       prod | staging (no default).
 *
 * Optional env
 *   MUHAVEN_NEW_PUSDC Override the mhUSDC target; default reads
 *                     `contracts.MuHavenStable.proxy` from the v2 deploy file.
 *
 * Pre-flight: deployer PRIVATE_KEY in root .env must own YieldDistributor.
 * Idempotent: skips the tx if pusdc already equals the target.
 */

import { ethers } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const YD_ABI = [
  "function owner() view returns (address)",
  "function pusdc() view returns (address)",
  "function setPusdc(address newPusdc)",
];

const MHUSDC_ABI = [
  "function symbol() view returns (string)",
];

function v2DeploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

function wave3DeploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia${suffix}.json`);
}

async function main() {
  const rawEnv = process.env.MUHAVEN_ENV;
  if (!rawEnv || rawEnv.trim() === "") {
    throw new Error(
      `MUHAVEN_ENV is required (must be "prod" or "staging"). No default.`,
    );
  }
  const env = rawEnv.toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${rawEnv}"`);
  }

  // Wave 3 file: YieldDistributor
  const wave3Path = wave3DeploymentPath(env);
  if (!existsSync(wave3Path)) {
    throw new Error(`Wave-3 deployment file not found: ${wave3Path}`);
  }
  const wave3 = JSON.parse(readFileSync(wave3Path, "utf-8"));
  const ydAddr: string | undefined = wave3?.contracts?.YieldDistributor?.proxy;
  if (!ydAddr || ydAddr === ethers.ZeroAddress) {
    throw new Error(`YieldDistributor proxy not configured in ${wave3Path}`);
  }

  // v2 file: MuHavenStable
  let newPusdc = process.env.MUHAVEN_NEW_PUSDC;
  if (!newPusdc) {
    const v2Path = v2DeploymentPath(env);
    if (!existsSync(v2Path)) {
      throw new Error(
        `v2 deployment file not found: ${v2Path}. Set MUHAVEN_NEW_PUSDC explicitly.`,
      );
    }
    const v2 = JSON.parse(readFileSync(v2Path, "utf-8"));
    newPusdc = v2?.contracts?.MuHavenStable?.proxy;
    if (!newPusdc || newPusdc === ethers.ZeroAddress) {
      throw new Error(
        `MuHavenStable.proxy not in ${v2Path}. Set MUHAVEN_NEW_PUSDC explicitly.`,
      );
    }
  }
  const newPusdcAddr = ethers.getAddress(newPusdc);

  const [signer] = await ethers.getSigners();
  const yd = new ethers.Contract(ydAddr, YD_ABI, signer);
  const mhUsdc = new ethers.Contract(newPusdcAddr, MHUSDC_ABI, signer);

  console.log(`Network          : ${env}`);
  console.log(`YieldDistributor : ${ydAddr}`);
  console.log(`New pusdc target : ${newPusdcAddr}`);

  const [owner, currentPusdc, mhSymbol] = await Promise.all([
    yd.owner() as Promise<string>,
    yd.pusdc() as Promise<string>,
    mhUsdc.symbol().catch(() => "(symbol read failed)") as Promise<string>,
  ]);
  console.log(`YD owner         : ${owner}`);
  console.log(`Deployer signer  : ${await signer.getAddress()}`);
  console.log(`Current pusdc    : ${currentPusdc}`);
  console.log(`Target symbol    : ${mhSymbol}`);

  if (owner.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(
      `Signer is not the YieldDistributor owner — setPusdc will revert with OnlyOwner(). ` +
        `Make sure PRIVATE_KEY in root .env is the deployer EOA.`,
    );
  }
  if (mhSymbol !== "mhUSDC") {
    throw new Error(
      `Target ${newPusdcAddr} reports symbol "${mhSymbol}", expected "mhUSDC". ` +
        `Confirm MuHavenStable address before rotating.`,
    );
  }

  if (currentPusdc.toLowerCase() === newPusdcAddr.toLowerCase()) {
    console.log(`\nNoop: YieldDistributor.pusdc already points at ${newPusdcAddr}. Skipping.`);
    return;
  }

  console.log(`\nRotating: ${currentPusdc} → ${newPusdcAddr}`);
  const tx = await yd.setPusdc(newPusdcAddr);
  console.log(`tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Tx failed (status=${receipt?.status}): ${tx.hash}`);
  }
  // RPC view-lag note: do NOT re-read pusdc() here — Arbitrum public RPC can
  // serve a stale view immediately after a write. The receipt status is
  // authoritative. Verify by re-running the script; the idempotent path will
  // print "Noop".
  console.log(
    `\n✓ setPusdc tx mined in block ${receipt.blockNumber}. Re-run the script to verify (idempotent noop on second run).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
