/**
 * scripts/upgrade-tokens.ts
 *
 * Upgrade every per-RWA `MuHavenToken` proxy to a freshly compiled impl.
 * Wave 3.5 onboards each RWA as its own MuHavenToken proxy (TBILL1, GOLD1,
 * …) but all proxies share the SAME implementation. The OZ upgrade plugin
 * detects the matching artifact bytecode after the first proxy migration
 * and reuses the deployed impl for the remaining proxies — net result is
 * one impl deployment + N proxy `upgradeTo()` rotations.
 *
 * Known upgrade rounds (most recent first):
 *
 *   Phase 9.A · Option Z follow-up (2026-05-XX) — broadens the
 *     `Transfer(from, to)` event with the encrypted `amount` handle so
 *     P2P transfers can be audited end-to-end on /activity. Adds a new
 *     `refreshAuditGrant(euint128, address)` external (mirror of
 *     `MuHavenStable.refreshAuditGrant`) for cross-session decrypts of
 *     historical Transfer audit handles. Stamps `FHE.allowThis(amount) +
 *     FHE.allow(amount, from/to/eph)` at every `emit Transfer` site so
 *     the audit grant survives across sessions. Off-chain indexer reads
 *     the new amount field; investor decrypts via permit on /activity
 *     row click. No storage changes.
 *
 * Usage:
 *   MUHAVEN_ENV=staging \
 *     npx hardhat run scripts/upgrade-tokens.ts --network arb-sepolia
 *
 *   MUHAVEN_ENV=prod    \
 *     npx hardhat run scripts/upgrade-tokens.ts --network arb-sepolia
 *
 * After the run prints each proxy's new implementation address, verify
 * each impl on Arbiscan:
 *   npx hardhat verify --network arb-sepolia <new_impl>
 * (One call covers every proxy that landed on the same impl.)
 *
 * Production cutover note: per `feedback_phase8_no_prod_until_signaled`,
 * staging upgrade lands first + the corresponding smoke walks clean
 * before the user explicitly authorises the prod upgrade.
 */

import { ethers, upgrades, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface TokenEntry {
  symbol?: string;
  contracts?: {
    MuHavenToken?: { proxy?: string; implementation?: string };
  };
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

  const tokens: Record<string, TokenEntry> = deployment.tokens ?? {};
  const tokenSymbols = Object.keys(tokens);
  if (tokenSymbols.length === 0) {
    throw new Error(
      `No tokens found in ${deployPath}. Expected tokens.* entries with ` +
        `contracts.MuHavenToken.proxy / .implementation.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log(`\n── MuHavenToken bulk upgrade ────────────────────────────`);
  console.log(`Network : ${network.name}`);
  console.log(`Env     : ${env}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Tokens  : ${tokenSymbols.length} (${tokenSymbols.join(", ")})`);

  const Factory = await ethers.getContractFactory("MuHavenToken");

  let touched = 0;
  for (const symbol of tokenSymbols) {
    const entry = tokens[symbol];
    const tokenContract = entry?.contracts?.MuHavenToken;
    if (!tokenContract?.proxy) {
      console.log(`\n[skip] ${symbol}: no MuHavenToken.proxy in deployment`);
      continue;
    }

    const proxyAddr = tokenContract.proxy;
    const oldImpl = tokenContract.implementation ?? "(unknown)";

    console.log(`\n── ${symbol} ────────────────────────────`);
    console.log(`Proxy   : ${proxyAddr}`);
    console.log(`Old impl: ${oldImpl}`);

    console.log(`[1/2] preparing upgrade via @openzeppelin/hardhat-upgrades…`);
    const upgraded = await upgrades.upgradeProxy(proxyAddr, Factory);
    await upgraded.waitForDeployment();

    const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddr);
    console.log(`[2/2] new implementation: ${newImpl}`);

    if (newImpl.toLowerCase() === oldImpl.toLowerCase()) {
      console.log(
        `Note: implementation unchanged — OZ plugin reused the bytecode hash.`,
      );
      continue;
    }

    tokenContract.implementation = newImpl;
    touched += 1;
  }

  if (touched === 0) {
    console.log(`\nNothing to write — every proxy is already on the latest impl.`);
    return;
  }

  deployment.timestamp = new Date().toISOString();
  writeFileSync(deployPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nDeployment record updated (${touched} token(s)) → ${deployPath}`);

  // Collect unique impl addresses for the verify hint.
  const impls = new Set<string>();
  for (const sym of tokenSymbols) {
    const impl = tokens[sym]?.contracts?.MuHavenToken?.implementation;
    if (impl) impls.add(impl);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Verify each unique implementation on Arbiscan:`);
  for (const impl of impls) {
    console.log(`       npx hardhat verify --network arb-sepolia ${impl}`);
  }
  console.log(`  2. Restart the backend stack so the indexer picks up the broadened`);
  console.log(`     Transfer event signature + new tax_event_type enum value:`);
  console.log(`       cd <muhaven-stage-dir> && docker compose restart backend`);
  console.log(`  3. Run \`pnpm db:push\` inside the backend container if the schema`);
  console.log(`     changed (Phase 9.A · Option Z follow-up adds the 'Transfer' enum`);
  console.log(`     value + extends the tax_events PK to include holder_address):`);
  console.log(`       docker compose exec -T backend pnpm db:push`);
  console.log(`  4. Re-walk the P2P transfer flow with a fresh kernel and verify`);
  console.log(`     /activity surfaces transfer-out + transfer-in rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
