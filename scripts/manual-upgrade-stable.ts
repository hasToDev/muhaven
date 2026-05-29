/**
 * scripts/manual-upgrade-stable.ts
 *
 * MANUAL ProxyAdmin upgrade for MuHavenStable — bypasses the OZ
 * `hardhat-upgrades` plugin entirely. Use this when the OZ plugin
 * stalls on its lock file (`.openzeppelin/chain-421614.lock/`) or
 * when its silent pre-flight blocks visibility into what's happening.
 *
 * The plugin's value-add is storage-layout validation. We've already
 * run that separately via `scripts/validate-stable-upgrade.ts` against
 * the deployed impl, so re-doing it here is redundant — this script
 * assumes the caller has already validated layout safety.
 *
 * Required env:
 *   MUHAVEN_ENV=prod (or staging)
 *   NEW_IMPL=0x...   — the address of an already-deployed MuHavenStable
 *                      impl carrying the upgrade you want to apply.
 *
 * Read-only mode:
 *   DRY_RUN=1        — print the planned call + state diff, no broadcast.
 *
 * Idempotence:
 *   If the proxy already points at NEW_IMPL, the script exits cleanly
 *   without broadcasting.
 *
 * After success, the script:
 *   1. Persists the new impl into deployments/arb-sepolia-v2[.staging].json.
 *   2. Suggests the OZ manifest forceImport (operator-followup) so a
 *      future `upgrade-stable.ts` run sees the new impl.
 *   3. Prints `npx hardhat verify` command for Arbiscan.
 */

import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ERC1967_IMPL_SLOT_RAW =
  "0x" +
  (
    BigInt(ethers.keccak256(ethers.toUtf8Bytes("eip1967.proxy.implementation"))) -
    1n
  ).toString(16);
const ERC1967_ADMIN_SLOT_RAW =
  "0x" +
  (
    BigInt(ethers.keccak256(ethers.toUtf8Bytes("eip1967.proxy.admin"))) - 1n
  ).toString(16);

async function readImpl(provider: any, proxy: string): Promise<string> {
  const raw = await provider.getStorage(proxy, ERC1967_IMPL_SLOT_RAW);
  return ethers.getAddress("0x" + raw.slice(-40));
}

async function readAdmin(provider: any, proxy: string): Promise<string> {
  const raw = await provider.getStorage(proxy, ERC1967_ADMIN_SLOT_RAW);
  return ethers.getAddress("0x" + raw.slice(-40));
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "staging").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be prod|staging (got "${env}")`);
  }
  const newImpl = process.env.NEW_IMPL;
  if (!newImpl || !ethers.isAddress(newImpl)) {
    throw new Error(
      `NEW_IMPL env must be a valid 0x... address (got "${newImpl ?? "(unset)"}")`,
    );
  }
  const dryRun = !!process.env.DRY_RUN;

  const suffix = env === "staging" ? ".staging" : "";
  const deployPath = join(
    __dirname,
    "..",
    "deployments",
    `arb-sepolia-v2${suffix}.json`,
  );
  const deployment = JSON.parse(readFileSync(deployPath, "utf8"));
  const proxy = deployment.contracts?.MuHavenStable?.proxy as string;
  if (!proxy) throw new Error(`No MuHavenStable.proxy in ${deployPath}`);

  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log(`── manual MuHavenStable upgrade ─────────────────────────`);
  console.log(`Network    : ${network.name}`);
  console.log(`Env        : ${env}`);
  console.log(`Signer     : ${signer.address}`);
  console.log(`Proxy      : ${proxy}`);
  console.log(`Target impl: ${newImpl}`);
  console.log(`Mode       : ${dryRun ? "DRY-RUN (no broadcast)" : "WRITE"}`);

  // Pre-flight reads.
  const [currentImpl, proxyAdmin, newImplCode, signerBal] = await Promise.all([
    readImpl(provider, proxy),
    readAdmin(provider, proxy),
    provider.getCode(newImpl),
    provider.getBalance(signer.address),
  ]);
  console.log(`\nProxy state pre-upgrade:`);
  console.log(`  current impl : ${currentImpl}`);
  console.log(`  proxyAdmin   : ${proxyAdmin}`);
  console.log(`  signer ETH   : ${ethers.formatEther(signerBal)}`);
  console.log(`  target code  : ${(newImplCode.length - 2) / 2} bytes`);

  if (currentImpl.toLowerCase() === newImpl.toLowerCase()) {
    console.log(
      `\n✓ Proxy already points at ${newImpl}. Nothing to do.`,
    );
    return;
  }
  if (newImplCode === "0x") {
    throw new Error(`Target impl ${newImpl} has NO bytecode — refusing to upgrade.`);
  }

  // ProxyAdmin owner check.
  const adminContract = new ethers.Contract(
    proxyAdmin,
    [
      "function owner() view returns (address)",
      "function upgradeAndCall(address proxy, address newImpl, bytes data) external payable",
    ],
    signer,
  );
  const owner = await adminContract.owner();
  console.log(`  admin.owner(): ${owner}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is NOT the ProxyAdmin owner (${owner}). ` +
        `Refusing to upgrade.`,
    );
  }

  if (dryRun) {
    console.log(
      `\nDRY-RUN: would call ${proxyAdmin}.upgradeAndCall(${proxy}, ${newImpl}, 0x)`,
    );
    return;
  }

  // Broadcast via a STANDALONE wallet on the official Arbitrum sequencer RPC,
  // NOT the hardhat-ethers signer. The configured ARB_SEPOLIA_RPC_URL serves
  // reads but HANGS on `eth_sendRawTransaction` (diagnosed 2026-05-29 — the
  // same hang that froze deploy-stable-impl.ts; reads above used the hardhat
  // provider fine). Override the broadcast endpoint with DEPLOY_RPC_URL.
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env not set — needed for the standalone broadcast wallet.");
  const broadcastRpc = process.env.DEPLOY_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  const bProvider = new ethers.JsonRpcProvider(broadcastRpc);
  const wallet = new ethers.Wallet(pk, bProvider);
  if (wallet.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`PRIVATE_KEY wallet ${wallet.address} != hardhat signer ${signer.address}.`);
  }
  const adminViaWallet = adminContract.connect(wallet) as ethers.Contract;

  console.log(`\n[1/1] broadcasting upgradeAndCall via ${broadcastRpc}…`);
  const [estGas, fee, nonce] = await Promise.all([
    adminViaWallet.upgradeAndCall.estimateGas(proxy, newImpl, "0x"),
    bProvider.getFeeData(),
    bProvider.getTransactionCount(wallet.address, "pending"),
  ]);
  const tx = await adminViaWallet.upgradeAndCall(proxy, newImpl, "0x", {
    gasLimit: (estGas * 120n) / 100n,
    gasPrice: (fee.gasPrice ?? 100_000_000n) * 2n,
    nonce,
    type: 0,
  });
  console.log(`  tx hash: ${tx.hash}`);
  console.log(`  track  : https://sepolia.arbiscan.io/tx/${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined  : block ${receipt?.blockNumber}, status=${receipt?.status}`);

  // Verify the impl slot actually flipped.
  const postImpl = await readImpl(provider, proxy);
  console.log(`\nProxy state post-upgrade:`);
  console.log(`  impl now: ${postImpl}`);
  if (postImpl.toLowerCase() !== newImpl.toLowerCase()) {
    throw new Error(
      `Upgrade tx mined but impl slot still ${postImpl} (expected ${newImpl}). ` +
        `Investigate immediately.`,
    );
  }

  // Persist into deployments json.
  const prevImpl = deployment.contracts.MuHavenStable.implementation;
  deployment.contracts.MuHavenStable.implementation = newImpl;
  deployment.contracts.MuHavenStable.previousImplementation = prevImpl;
  deployment.timestamp = new Date().toISOString();
  writeFileSync(deployPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nDeployment record updated → ${deployPath}`);
  console.log(`  contracts.MuHavenStable.implementation = ${newImpl}`);
  console.log(`  contracts.MuHavenStable.previousImplementation = ${prevImpl}`);

  console.log(`\nNext steps:`);
  console.log(`  1. Arbiscan verify:`);
  console.log(`       npx hardhat verify --network arb-sepolia ${newImpl}`);
  console.log(`  2. OZ manifest reconciliation (so a future upgrade-stable.ts can use the OZ plugin):`);
  console.log(`       — option A: run scripts/upgrade-stable.ts NEXT time; OZ will deploy yet another impl, but at least its manifest will agree thereafter.`);
  console.log(`       — option B: hand-edit .openzeppelin/unknown-421614.json's impls map (NOT recommended unless familiar with OZ schema).`);
  console.log(`  3. §5 e2e smoke:`);
  console.log(`       dashboard direct: muhaven.app/cash?mode=unwrap + $1-2 burn`);
  console.log(`       MCP cash.unwrap deep-link`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
