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
 * Enumeration (2026-05-17 Design A): the token set is read from on-chain
 * `TokenRegistry.getRegisteredTokens()` rather than the deployment JSON.
 * This covers every onboarded token including those registered via the
 * apply-issuer flow after the v2 deploy. Tokens whose `navWriter` does
 * NOT match the signer are skipped with a structured log line
 * (`[<SYMBOL>] issuer-owned (navWriter=X, signer=Y) — cannot refresh`)
 * so the operator can identify which need separate handling (issuer-side
 * rotation, manual setNAV via issuer key, etc.).
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

const REGISTRY_ABI = [
  "function getRegisteredTokens(uint256 offset, uint256 limit) view returns (address[] memory)",
  "function registeredTokenCount() view returns (uint256)",
  "function getConfig(address token) view returns (tuple(bool active, address treasury, address queue, address oracle, address issuer, uint128 minInvestment, uint128 instantRedeemCap, uint32 epochDuration, bool paused))",
];

const TOKEN_ABI = ["function symbol() view returns (string)"];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

async function enumerateTokens(registry: any) {
  const count: bigint = await registry.registeredTokenCount();
  const all: string[] = [];
  const pageSize = 100n;
  for (let off = 0n; off < count; off += pageSize) {
    const page: string[] = await registry.getRegisteredTokens(off, pageSize);
    all.push(...page);
  }
  // Build per-token (address, oracle, active, paused) records.
  const records: { address: string; oracle: string; active: boolean; paused: boolean }[] = [];
  for (const addr of all) {
    const cfg = await registry.getConfig(addr);
    records.push({
      address: addr,
      oracle: cfg.oracle,
      active: cfg.active,
      paused: cfg.paused,
    });
  }
  return records;
}

async function resolveSymbol(addr: string, signer: any): Promise<string> {
  try {
    const tok = new ethers.Contract(addr, TOKEN_ABI, signer);
    return await tok.symbol();
  } catch {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }
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
  const registryAddr = deployment.contracts?.TokenRegistry?.proxy;
  if (!registryAddr) {
    throw new Error(`TokenRegistry proxy not found in ${path}`);
  }

  const [signer] = await ethers.getSigners();
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, signer);

  const records = await enumerateTokens(registry);
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Registry   : ${registryAddr}`);
  console.log(`Tokens     : ${records.length} registered (${records.filter((r) => r.active).length} active)`);
  console.log();

  let refreshed = 0;
  let skippedIssuerOwned = 0;
  let skippedFresh = 0;
  let skippedInactive = 0;

  for (const rec of records) {
    const symbol = await resolveSymbol(rec.address, signer);

    if (!rec.active) {
      console.log(`[${symbol}] inactive — skipping`);
      skippedInactive++;
      continue;
    }
    if (rec.oracle === ethers.ZeroAddress) {
      console.log(`[${symbol}] no oracle wired — skipping`);
      continue;
    }

    const oracle = new ethers.Contract(rec.oracle, ORACLE_ABI, signer);
    const writer: string = await oracle.getNavWriter(rec.address);

    if (writer.toLowerCase() !== signer.address.toLowerCase()) {
      // Loud skip — operator needs to know which tokens have writers
      // outside their control (typically issuer-onboarded tokens whose
      // navWriter is the issuer's kernel).
      console.log(
        `[${symbol}] issuer-owned (navWriter=${writer}, signer=${signer.address}) — cannot refresh from this signer`,
      );
      skippedIssuerOwned++;
      continue;
    }

    const [nav, updatedAt] = await oracle.getNAV(rec.address);
    const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
    const fresh: boolean = await oracle.isFresh(rec.address);

    console.log(
      `[${symbol}] NAV=${nav.toString()}, age=${ageSec}s, isFresh=${fresh}, paused=${rec.paused}`,
    );

    if (fresh) {
      console.log(`[${symbol}] already fresh — skipping`);
      skippedFresh++;
      continue;
    }

    try {
      const tx = await oracle.setNAV(rec.address, nav);
      console.log(`[${symbol}] setNAV tx: ${tx.hash}`);
      await tx.wait();
      const freshAfter: boolean = await oracle.isFresh(rec.address);
      console.log(`[${symbol}] isFresh after refresh: ${freshAfter}\n`);
      refreshed++;
    } catch (err) {
      console.error(
        `[${symbol}] setNAV FAILED:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log("─".repeat(72));
  console.log(`Summary: refreshed=${refreshed}, fresh-already=${skippedFresh}, issuer-owned=${skippedIssuerOwned}, inactive=${skippedInactive}`);
  if (skippedIssuerOwned > 0) {
    console.log();
    console.log(
      `⚠ ${skippedIssuerOwned} token(s) have issuer-owned navWriters. The platform`,
    );
    console.log(
      `  cannot refresh these. Options:`,
    );
    console.log(
      `   1. Rotate navWriter to a platform-controlled EOA via`,
    );
    console.log(
      `      \`scripts/rotate-nav-writers.ts\` (oracle owner only).`,
    );
    console.log(
      `   2. The issuer pushes setNAV themselves with their own signer.`,
    );
    console.log(`  See \`development/STATUS.md\` "Design A platform-managed`);
    console.log(`  navWriter" 2026-05-17 entry for context.`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
