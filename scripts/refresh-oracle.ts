/**
 * Re-write the current NAV for every onboarded token so the oracle's
 * `updatedAt` stamp moves to `now` and `isFresh(token)` flips back to true.
 * The new value equals the prior NAV — the contract's deviation gate accepts
 * a 0-bps move and commits cleanly (refresh-only, no economic change).
 *
 * Use when the NAV worker hasn't been pushing updates and contract calls
 * downstream of `Subscription` / `Treasury` / `RedemptionQueue` start
 * reverting `StaleNAV`.
 *
 * Usage:
 *   MUHAVEN_ENV=prod    pnpm hardhat run scripts/refresh-oracle.ts --network arb-sepolia
 *   MUHAVEN_ENV=staging pnpm hardhat run scripts/refresh-oracle.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ORACLE_ABI = [
  "function getNAV(address token) view returns (uint256 nav, uint256 updatedAt)",
  "function isFresh(address token) view returns (bool)",
  "function getNavWriter(address token) view returns (address)",
  "function setNAV(address token, uint256 newNAV) external",
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
  if (!existsSync(path)) {
    throw new Error(`Deployment file not found: ${path}`);
  }
  const deployment = JSON.parse(readFileSync(path, "utf-8"));
  const tokens = deployment.tokens ?? {};

  const [signer] = await ethers.getSigners();
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Tokens     : ${Object.keys(tokens).length} onboarded\n`);

  for (const [symbol, info] of Object.entries(tokens) as [string, any][]) {
    const tokenAddr: string | undefined = info?.contracts?.MuHavenToken?.proxy;
    const oracleAddr: string | undefined = info?.registeredOracle;
    if (!tokenAddr || !oracleAddr) {
      console.log(`[${symbol}] missing token or oracle address — skipping`);
      continue;
    }

    const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);
    const writer: string = await oracle.getNavWriter(tokenAddr);
    if (writer.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(
        `[${symbol}] navWriter is ${writer}, signer is ${signer.address} — skipping`,
      );
      continue;
    }

    const [nav, updatedAt] = await oracle.getNAV(tokenAddr);
    const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
    const fresh: boolean = await oracle.isFresh(tokenAddr);

    console.log(
      `[${symbol}] NAV=${nav.toString()}, age=${ageSec}s, isFresh=${fresh}`,
    );

    if (fresh) {
      console.log(`[${symbol}] already fresh — skipping`);
      continue;
    }

    const tx = await oracle.setNAV(tokenAddr, nav);
    console.log(`[${symbol}] setNAV tx: ${tx.hash}`);
    await tx.wait();
    const freshAfter: boolean = await oracle.isFresh(tokenAddr);
    console.log(`[${symbol}] isFresh after refresh: ${freshAfter}\n`);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
