/**
 * One-shot backfill: authorise each onboarded token's RedemptionQueue as
 * a caller on ModularCompliance. The original `scripts/onboard-token.ts`
 * (pre-2026-04-28) only authorised the token itself + MuHavenSubscription;
 * the RedemptionQueue was never wired even though `_settleRequest` fans
 * out to `compliance.destroyed(...)` per ADR-032. Result: every
 * `processEpoch` reverted `NotAuthorizedCaller()` (selector 0x7046c88d).
 *
 * Idempotent — re-running on already-authorised tokens just prints OK
 * and skips the tx.
 *
 * Usage:
 *   MUHAVEN_ENV=staging pnpm hardhat run scripts/backfill-queue-compliance-auth.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const COMPLIANCE_ABI = [
  "function authorizedCaller(address token, address caller) view returns (bool)",
  "function setAuthorizedCaller(address token, address caller, bool authorized) external",
  "function owner() view returns (address)",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "prod").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be "prod" or "staging", got "${env}"`);
  }
  const path = deploymentPath(env);
  if (!existsSync(path)) throw new Error(`Deployment file not found: ${path}`);
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const complianceAddr: string | undefined =
    deployment?.contracts?.ModularCompliance?.proxy;
  const tokens = deployment.tokens ?? {};
  if (!complianceAddr) throw new Error("ModularCompliance address missing");

  const [signer] = await ethers.getSigners();
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Compliance : ${complianceAddr}\n`);

  const compliance = new ethers.Contract(complianceAddr, COMPLIANCE_ABI, signer);
  const owner: string = await compliance.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not Compliance owner (${owner}); cannot setAuthorizedCaller`,
    );
  }

  for (const [symbol, info] of Object.entries(tokens) as [string, any][]) {
    const tokenAddr: string | undefined = info?.contracts?.MuHavenToken?.proxy;
    const queueAddr: string | undefined =
      info?.contracts?.RedemptionQueue?.proxy;
    if (!tokenAddr || !queueAddr) {
      console.log(`[${symbol}] missing token or queue — skipping`);
      continue;
    }

    const isAuth: boolean = await compliance.authorizedCaller(
      tokenAddr,
      queueAddr,
    );
    if (isAuth) {
      console.log(`[${symbol}] queue already authorized — skipping`);
      continue;
    }

    console.log(`[${symbol}] authorising queue ${queueAddr} on token ${tokenAddr}`);
    const tx = await compliance.setAuthorizedCaller(tokenAddr, queueAddr, true);
    console.log(`[${symbol}] setAuthorizedCaller tx: ${tx.hash}`);
    await tx.wait();
    const ok: boolean = await compliance.authorizedCaller(tokenAddr, queueAddr);
    console.log(`[${symbol}] authorizedCaller after: ${ok}`);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
