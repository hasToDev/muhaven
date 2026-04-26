/**
 * scripts/bulk-import-whitelist.ts — Wave 3 → Wave 3.5 whitelist migration
 *
 * Reads the Wave 3 `ERC3643KYCAdapter` whitelist by indexing
 * `WhitelistAdded` / `WhitelistRemoved` events from the contract's deploy
 * block to head, computes the live whitelist set, and batch-calls
 * `MuHavenIdentityRegistry.addWhitelisted([...])` so returning Wave 3
 * investors are auto-recognised by the Wave 3.5 platform.
 *
 * Per `MIGRATION.md` this is a hackathon-window UX continuity step — Wave
 * 3.5 lives behind dev-mode in the demo phase, but bulk-importing the
 * whitelist now means the production-mode flip later won't lock returning
 * investors out.
 *
 * Usage:
 *   pnpm run bulk-import-whitelist:testnet            # prod
 *   pnpm run bulk-import-whitelist:testnet:stage      # stage
 *
 * Optional env:
 *   MUHAVEN_ENV                prod | staging         (default: prod)
 *   WAVE3_KYC_ADAPTER          override Wave 3 adapter address
 *   WAVE3_KYC_FROM_BLOCK       starting block for the event scan
 *                              (default: 0 — costly on Arb Sepolia full
 *                              archive nodes; pin to deploy block when known)
 *   WAVE3_KYC_BATCH_SIZE       batch size per addWhitelisted call
 *                              (default: 200 — Arb Sepolia gas safe)
 *   WAVE3_KYC_LOG_CHUNK        eth_getLogs chunk size in blocks
 *                              (default: 50_000 — Onfinality cap)
 *   WAVE3_KYC_DRY_RUN          "true" → log + count only, no tx
 */

import { ethers, network } from "hardhat";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

type V2Deployment = {
  contracts: Record<string, { proxy?: string; address?: string }>;
  external: { kycAdapter: string };
};

type Wave3Deployment = {
  contracts: Record<string, { proxy?: string; address?: string }>;
};

async function main() {
  const [signer] = await ethers.getSigners();
  const net = network.name;

  const envName = (process.env.MUHAVEN_ENV || "prod").toLowerCase();
  if (envName !== "prod" && envName !== "staging") {
    throw new Error(`MUHAVEN_ENV must be 'prod' or 'staging' (got '${envName}')`);
  }
  const envSuffix = envName === "staging" ? ".staging" : "";

  // Resolve the Wave 3.5 IdentityRegistry from the v2 deployment file.
  const v2Path = join(__dirname, "..", "deployments", `${net}-v2${envSuffix}.json`);
  if (!existsSync(v2Path)) {
    throw new Error(`Platform deployment not found: ${v2Path}`);
  }
  const platform: V2Deployment = JSON.parse(readFileSync(v2Path, "utf-8"));
  const identityAddr = platform.contracts.MuHavenIdentityRegistry?.proxy;
  if (!identityAddr) throw new Error("MuHavenIdentityRegistry not in v2 deployment");

  // Resolve Wave 3 KYC adapter — env override else read from Wave 3 file.
  let kycAdapterAddr = process.env.WAVE3_KYC_ADAPTER;
  if (!kycAdapterAddr) {
    const wave3Path = join(__dirname, "..", "deployments", `${net}${envSuffix}.json`);
    if (!existsSync(wave3Path)) {
      throw new Error(
        `Wave 3 deployment not found at ${wave3Path}. ` +
          `Set WAVE3_KYC_ADAPTER env var to override.`
      );
    }
    const wave3: Wave3Deployment = JSON.parse(readFileSync(wave3Path, "utf-8"));
    kycAdapterAddr = wave3.contracts.ERC3643KYCAdapter?.address;
    if (!kycAdapterAddr) throw new Error(`No ERC3643KYCAdapter in ${wave3Path}`);
  }

  const fromBlock = Number(process.env.WAVE3_KYC_FROM_BLOCK || 0);
  const batchSize = Number(process.env.WAVE3_KYC_BATCH_SIZE || 200);
  const logChunk = Number(process.env.WAVE3_KYC_LOG_CHUNK || 50_000);
  const dryRun = (process.env.WAVE3_KYC_DRY_RUN || "").toLowerCase() === "true";

  console.log(`\n=== Wave 3 → Wave 3.5 Whitelist Bulk-Import ===`);
  console.log(`Network:           [${net}] (${envName})`);
  console.log(`Signer:            ${signer.address}`);
  console.log(`Wave 3 KYC adapter: ${kycAdapterAddr}`);
  console.log(`Wave 3.5 IdReg:    ${identityAddr}`);
  console.log(`From block:        ${fromBlock}`);
  console.log(`Log chunk:         ${logChunk} blocks`);
  console.log(`Add batch size:    ${batchSize}`);
  console.log(`Dry run:           ${dryRun}\n`);

  const adapter = await ethers.getContractAt("ERC3643KYCAdapter", kycAdapterAddr);
  const identity = await ethers.getContractAt(
    "MuHavenIdentityRegistry",
    identityAddr
  );

  // ── Step 1: walk the event log ─────────────────────────────────────────
  // Compute the live whitelist set: every account that has had MORE
  // `WhitelistAdded` events than `WhitelistRemoved` events lands in the
  // final set. Tracked as a Map<address, count> to keep the migration
  // resilient against double-add / re-add patterns.
  const head = await ethers.provider.getBlockNumber();
  const counts = new Map<string, number>();

  const addedTopic = adapter.interface.getEvent("WhitelistAdded")!.topicHash;
  const removedTopic = adapter.interface.getEvent("WhitelistRemoved")!.topicHash;

  console.log(`Scanning blocks ${fromBlock}…${head}`);
  for (let from = fromBlock; from <= head; from += logChunk) {
    const to = Math.min(from + logChunk - 1, head);
    const filter = {
      address: kycAdapterAddr,
      fromBlock: from,
      toBlock: to,
      topics: [[addedTopic, removedTopic]],
    };
    let logs;
    try {
      logs = await ethers.provider.getLogs(filter);
    } catch (err) {
      console.error(`getLogs failed for ${from}…${to}: ${err}`);
      throw err;
    }
    for (const log of logs) {
      const parsed = adapter.interface.parseLog(log)!;
      const account: string = parsed.args[0];
      const lower = account.toLowerCase();
      const cur = counts.get(lower) ?? 0;
      counts.set(
        lower,
        parsed.name === "WhitelistAdded" ? cur + 1 : cur - 1
      );
    }
    if (logs.length > 0) {
      console.log(
        `   blocks ${from}…${to}: ${logs.length} events (${counts.size} unique addresses so far)`
      );
    }
  }

  const candidates = Array.from(counts.entries())
    .filter(([, c]) => c > 0)
    .map(([a]) => ethers.getAddress(a));
  console.log(`\nFound ${candidates.length} candidate whitelisted addresses.`);

  if (candidates.length === 0) {
    console.log("Nothing to import. Exiting.");
    return;
  }

  // ── Step 2: filter out addresses already on the v2 registry ───────────
  const toAdd: string[] = [];
  for (const addr of candidates) {
    const already = await identity.isWhitelisted(addr);
    if (!already) toAdd.push(addr);
  }
  console.log(
    `${toAdd.length} addresses need import (${candidates.length - toAdd.length} already on v2 registry).`
  );

  if (toAdd.length === 0) {
    console.log("Already in sync. Exiting.");
    return;
  }

  // Surface a sample so the operator can spot-check before signing.
  console.log("\nSample addresses to import:");
  for (const a of toAdd.slice(0, 5)) console.log(`   ${a}`);
  if (toAdd.length > 5) console.log(`   … ${toAdd.length - 5} more`);

  if (dryRun) {
    console.log("\nDry run — not submitting transactions.");
    return;
  }

  // ── Step 3: batch addWhitelisted ──────────────────────────────────────
  console.log(`\nSubmitting addWhitelisted batches of ${batchSize}...`);
  for (let i = 0; i < toAdd.length; i += batchSize) {
    const slice = toAdd.slice(i, i + batchSize);
    const tx = await identity.addWhitelisted(slice);
    console.log(
      `   batch ${i / batchSize + 1}/${Math.ceil(
        toAdd.length / batchSize
      )} (${slice.length} addrs): ${tx.hash}`
    );
    await tx.wait();
  }

  // ── Step 4: post-run verification ─────────────────────────────────────
  let verifiedCount = 0;
  for (const addr of toAdd) {
    if (await identity.isWhitelisted(addr)) verifiedCount += 1;
  }
  console.log(
    `\nVerification: ${verifiedCount}/${toAdd.length} addresses present on v2 registry.`
  );
  if (verifiedCount !== toAdd.length) {
    throw new Error(
      `Mismatch — ${toAdd.length - verifiedCount} addresses failed to land`
    );
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
