/**
 * scripts/manual-upgrade-tokens.ts
 *
 * MANUAL per-proxy ProxyAdmin upgrade for EVERY active MuHavenToken proxy —
 * bypasses the OZ `hardhat-upgrades` plugin entirely (which stalls on the
 * Windows manifest lock + hangs on the configured RPC's `eth_sendRawTransaction`).
 * Slice 1.5 (the `pullFromInvestor` FHE.min over-sell clamp).
 *
 * Each active RWA is its own transparent-proxy MuHavenToken with its OWN
 * ProxyAdmin (all owned by the deployer EOA). This script reads each proxy's
 * admin slot and calls `ProxyAdmin.upgradeAndCall(proxy, NEW_IMPL, 0x)` on that
 * specific admin, broadcasting through a standalone wallet on the official
 * Arbitrum sequencer RPC with a FRESH pending-nonce read + receipt-wait per tx
 * (safe against the shared-EOA homelab-cron nonce race).
 *
 * Storage-layout safety is the job of `scripts/validate-token-upgrade.ts`
 * (run it first); this script assumes layout was validated.
 *
 * Retired tokens (TBILL1, GOLD1 — the W1 `DEFAULT_SKIP_SYMBOLS`) are skipped:
 * they are on an older impl and not on the sell path. Override the set with
 * SYMBOLS=CETES,USYC (comma-separated) to upgrade only specific tokens.
 *
 * Required env:
 *   MUHAVEN_ENV=prod | staging
 *   NEW_IMPL=0x...    — an already-deployed MuHavenToken impl (deploy-token-impl.ts).
 * Optional env:
 *   DRY_RUN=1         — print the plan + per-proxy state diff, no broadcast.
 *   SYMBOLS=A,B       — restrict to these token symbols (default: all non-retired).
 *   DEPLOY_RPC_URL    — override the broadcast endpoint.
 *
 * Idempotent: a proxy already on NEW_IMPL is skipped. Re-runnable after a
 * partial failure (already-migrated proxies are no-ops).
 */

import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ARB_SEPOLIA_CHAIN_ID = 421614;
const RETIRED_SYMBOLS = new Set(["TBILL1", "GOLD1"]);

const ERC1967_IMPL_SLOT_RAW =
  "0x" +
  (BigInt(ethers.keccak256(ethers.toUtf8Bytes("eip1967.proxy.implementation"))) - 1n).toString(16);
const ERC1967_ADMIN_SLOT_RAW =
  "0x" +
  (BigInt(ethers.keccak256(ethers.toUtf8Bytes("eip1967.proxy.admin"))) - 1n).toString(16);

async function readSlotAddr(provider: any, addr: string, slot: string): Promise<string> {
  const raw = await provider.getStorage(addr, slot);
  return ethers.getAddress("0x" + raw.slice(-40));
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be prod|staging (got "${env || "(unset)"}").`);
  }
  const newImpl = process.env.NEW_IMPL;
  if (!newImpl || !ethers.isAddress(newImpl)) {
    throw new Error(`NEW_IMPL env must be a valid 0x... address (got "${newImpl ?? "(unset)"}").`);
  }
  const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");
  const onlySymbols = (process.env.SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== ARB_SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing to run: chainId=${chainId}, expected ${ARB_SEPOLIA_CHAIN_ID}.`);
  }

  const suffix = env === "staging" ? ".staging" : "";
  const deployPath = join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
  const deployment = JSON.parse(readFileSync(deployPath, "utf8"));
  const tokens: Record<string, any> = deployment.tokens ?? {};

  const targets = Object.keys(tokens).filter((s) => {
    if (onlySymbols.length > 0) return onlySymbols.includes(s);
    return !RETIRED_SYMBOLS.has(s);
  });
  if (targets.length === 0) throw new Error(`No target tokens selected in ${deployPath}.`);

  const [signer] = await ethers.getSigners();
  const readProvider = ethers.provider;

  console.log(`── manual MuHavenToken bulk upgrade ─────────────────────`);
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Target impl: ${newImpl}`);
  console.log(`Mode       : ${dryRun ? "DRY-RUN (no broadcast)" : "WRITE"}`);
  console.log(`Tokens     : ${targets.length} (${targets.join(", ")})`);
  console.log(`Skipping   : ${[...RETIRED_SYMBOLS].join(", ")} (retired)`);

  const newImplCode = await readProvider.getCode(newImpl);
  if (newImplCode === "0x") {
    throw new Error(`Target impl ${newImpl} has NO bytecode — refusing to upgrade.`);
  }
  console.log(`Target code: ${(newImplCode.length - 2) / 2} bytes`);

  // Standalone broadcast wallet (reads via hardhat provider are fine).
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env not set — needed for the standalone broadcast wallet.");
  const broadcastRpc = process.env.DEPLOY_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  const bProvider = new ethers.JsonRpcProvider(broadcastRpc);
  const wallet = new ethers.Wallet(pk, bProvider);
  if (wallet.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`PRIVATE_KEY wallet ${wallet.address} != hardhat signer ${signer.address}.`);
  }

  const ADMIN_ABI = [
    "function owner() view returns (address)",
    "function upgradeAndCall(address proxy, address newImpl, bytes data) external payable",
  ];

  let flipped = 0;
  let skipped = 0;
  const dirty: string[] = [];

  for (const symbol of targets) {
    const mt = tokens[symbol]?.contracts?.MuHavenToken;
    const proxy = mt?.proxy as string | undefined;
    if (!proxy) {
      console.log(`\n[skip] ${symbol}: no MuHavenToken.proxy in deployment`);
      continue;
    }

    console.log(`\n── ${symbol} (${proxy}) ────────────────────────────`);
    const [currentImpl, adminAddr] = await Promise.all([
      readSlotAddr(readProvider, proxy, ERC1967_IMPL_SLOT_RAW),
      readSlotAddr(readProvider, proxy, ERC1967_ADMIN_SLOT_RAW),
    ]);
    console.log(`  current impl : ${currentImpl}`);
    console.log(`  proxyAdmin   : ${adminAddr}`);

    if (currentImpl.toLowerCase() === newImpl.toLowerCase()) {
      console.log(`  ✓ already on target impl — skipping.`);
      skipped++;
      continue;
    }

    const adminRead = new ethers.Contract(adminAddr, ADMIN_ABI, readProvider);
    const owner = await adminRead.owner();
    console.log(`  admin.owner(): ${owner}`);
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`${symbol}: signer ${signer.address} is NOT ProxyAdmin owner (${owner}). Aborting.`);
    }

    if (dryRun) {
      console.log(`  DRY-RUN: would call ${adminAddr}.upgradeAndCall(${proxy}, ${newImpl}, 0x)`);
      continue;
    }

    const adminWrite = new ethers.Contract(adminAddr, ADMIN_ABI, wallet);
    // Fresh pending-nonce read PER tx + wait for receipt before the next —
    // safe against the shared-EOA homelab-cron nonce race.
    const [estGas, fee, nonce] = await Promise.all([
      adminWrite.upgradeAndCall.estimateGas(proxy, newImpl, "0x"),
      bProvider.getFeeData(),
      bProvider.getTransactionCount(wallet.address, "pending"),
    ]);
    console.log(`  broadcasting upgradeAndCall (nonce=${nonce}, gas=${estGas})…`);
    const tx = await adminWrite.upgradeAndCall(proxy, newImpl, "0x", {
      gasLimit: (estGas * 120n) / 100n,
      gasPrice: (fee.gasPrice ?? 100_000_000n) * 2n,
      nonce,
      type: 0,
    });
    console.log(`  tx: https://sepolia.arbiscan.io/tx/${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${symbol}: upgrade tx ${tx.hash} failed (status=${receipt?.status}).`);
    }

    const postImpl = await readSlotAddr(readProvider, proxy, ERC1967_IMPL_SLOT_RAW);
    if (postImpl.toLowerCase() !== newImpl.toLowerCase()) {
      throw new Error(`${symbol}: tx mined but impl slot still ${postImpl} (expected ${newImpl}).`);
    }
    console.log(`  ✓ ${symbol} impl now: ${postImpl} (block ${receipt.blockNumber})`);

    mt.previousImplementation = currentImpl;
    mt.implementation = newImpl;
    flipped++;
    dirty.push(symbol);
  }

  if (!dryRun && flipped > 0) {
    deployment.timestamp = new Date().toISOString();
    writeFileSync(deployPath, JSON.stringify(deployment, null, 2) + "\n");
    console.log(`\nDeployment record updated (${flipped} flipped: ${dirty.join(", ")}) → ${deployPath}`);
  }

  console.log(`\nSummary: ${flipped} flipped, ${skipped} already-current${dryRun ? " (DRY-RUN)" : ""}.`);
  if (!dryRun) {
    console.log(`\nNext steps:`);
    console.log(`  1. Arbiscan verify (one call covers every proxy on this impl):`);
    console.log(`       pnpm hardhat verify --network arb-sepolia ${newImpl}`);
    console.log(`  2. Prod over-sell smoke: sell a deliberately-large amount on an active token`);
    console.log(`     → confirm the FULL position sells (not zero) via read.activity / dashboard.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
