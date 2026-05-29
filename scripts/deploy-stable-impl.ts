/**
 * scripts/deploy-stable-impl.ts
 *
 * Deploy a fresh MuHavenStable IMPLEMENTATION contract via raw ethers — no OZ
 * `hardhat-upgrades` plugin, so it can't stall on the Windows manifest lock
 * file (`.openzeppelin/chain-421614.lock/`) the way `upgrade-stable.ts` did on
 * the Phase 7 hotfix. The proxy is NOT touched here; this only deploys the new
 * impl bytecode and prints its address.
 *
 * Pair with `scripts/manual-upgrade-stable.ts` (which flips the proxy's impl
 * slot via `ProxyAdmin.upgradeAndCall`):
 *
 *   # 1. Validate storage layout (read-only):
 *   MUHAVEN_ENV=prod pnpm hardhat run scripts/validate-stable-upgrade.ts --network arb-sepolia
 *   # 2. Deploy the new impl (this script) — prints NEW_IMPL:
 *   MUHAVEN_ENV=prod pnpm hardhat run scripts/deploy-stable-impl.ts --network arb-sepolia
 *   # 3. Flip the proxy to it (manual, OZ-free, owner-gated):
 *   MUHAVEN_ENV=prod NEW_IMPL=0x… pnpm hardhat run scripts/manual-upgrade-stable.ts --network arb-sepolia
 *   # 4. Verify on Arbiscan:
 *   pnpm hardhat verify --network arb-sepolia 0x…
 *
 * The MuHavenStable constructor calls `_disableInitializers()`, so the freshly
 * deployed impl can't be initialised directly — only the proxy's storage is
 * ever used. Storage-layout safety is the job of step 1
 * (`validate-stable-upgrade.ts`); this script assumes it already passed.
 *
 * Required env:  MUHAVEN_ENV=prod | staging
 * Optional env:  DRY_RUN=1  — print the plan, deploy nothing.
 */

import { ethers, network } from "hardhat";

const ARB_SEPOLIA_CHAIN_ID = 421614;

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "").toLowerCase();
  if (env !== "prod" && env !== "staging") {
    throw new Error(`MUHAVEN_ENV must be prod|staging (got "${env || "(unset)"}").`);
  }
  const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== ARB_SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing to run: chainId=${chainId}, expected ${ARB_SEPOLIA_CHAIN_ID} (arb-sepolia).`);
  }

  const [signer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(signer.address);

  console.log(`── deploy-stable-impl ───────────────────────────────────`);
  console.log(`Network : ${network.name}`);
  console.log(`Env     : ${env}`);
  console.log(`Signer  : ${signer.address}`);
  console.log(`Balance : ${ethers.formatEther(bal)} ETH`);
  console.log(`Mode    : ${dryRun ? "DRY-RUN (no broadcast)" : "DEPLOY"}`);

  if (dryRun) {
    console.log(`\nDRY-RUN: would deploy a new MuHavenStable implementation. No broadcast.`);
    return;
  }

  const Factory = await ethers.getContractFactory("MuHavenStable");

  // Explicit, instrumented deploy over a STANDALONE provider + wallet on the
  // official Arbitrum sequencer RPC — NOT the hardhat-ethers signer. Diagnosis
  // (scripts/_diag-deploy.ts): the configured ARB_SEPOLIA_RPC_URL serves reads
  // (estimateGas/fee/nonce all < 600ms) but HANGS on `eth_sendRawTransaction`
  // (90s timeout), and `Factory.deploy()` via the hardhat signer hangs on the
  // same send. Routing the broadcast through a fresh JsonRpcProvider on the
  // canonical sequencer endpoint sidesteps both. Override with DEPLOY_RPC_URL.
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env not set — needed for the standalone broadcast wallet.");
  const broadcastRpc = process.env.DEPLOY_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(broadcastRpc);
  const wallet = new ethers.Wallet(pk, provider);
  if (wallet.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`PRIVATE_KEY wallet ${wallet.address} != hardhat signer ${signer.address}.`);
  }
  console.log(`Broadcast RPC : ${broadcastRpc}`);

  const deployData = (await Factory.getDeployTransaction()).data!;
  console.log(`\n[1/3] estimating gas + fee + nonce (broadcast RPC)…`);
  const t0 = Date.now();
  const [estGas, fee, nonce] = await Promise.all([
    provider.estimateGas({ from: wallet.address, data: deployData }),
    provider.getFeeData(),
    provider.getTransactionCount(wallet.address, "pending"),
  ]);
  // 20% gas headroom; explicit gasPrice (Arb Sepolia legacy pricing, ~0.02 gwei).
  const gasLimit = (estGas * 120n) / 100n;
  const gasPrice = (fee.gasPrice ?? 100_000_000n) * 2n; // 2× for fast inclusion
  console.log(`  estGas=${estGas} gasLimit=${gasLimit} gasPrice=${ethers.formatUnits(gasPrice, "gwei")}gwei nonce=${nonce} (${Date.now() - t0}ms)`);

  console.log(`\n[2/3] signing + broadcasting (standalone wallet, explicit nonce — shared-EOA cron safe)…`);
  const sendP = wallet.sendTransaction({
    data: deployData,
    gasLimit,
    gasPrice,
    nonce,
    type: 0, // legacy tx — Arb Sepolia
  });
  const sent = (await Promise.race([
    sendP,
    new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT(90s) on sendTransaction")), 90_000)),
  ])) as Awaited<typeof sendP>;
  console.log(`  ✓ broadcast — tx hash: ${sent.hash}`);
  console.log(`    track: https://sepolia.arbiscan.io/tx/${sent.hash}`);

  console.log(`\n[3/3] waiting for receipt…`);
  const receipt = await sent.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Deploy tx ${sent.hash} did not succeed (status=${receipt?.status}).`);
  }
  const addr = receipt.contractAddress;
  if (!addr) throw new Error(`Receipt has no contractAddress — not a deploy? tx=${sent.hash}`);
  console.log(`  mined: block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}`);
  console.log(`\n✓ New MuHavenStable impl deployed: ${addr}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Flip the proxy to it (OZ-free, owner-gated):`);
  console.log(`       MUHAVEN_ENV=${env} NEW_IMPL=${addr} \\`);
  console.log(`         pnpm hardhat run scripts/manual-upgrade-stable.ts --network arb-sepolia`);
  console.log(`  2. Verify on Arbiscan:`);
  console.log(`       pnpm hardhat verify --network arb-sepolia ${addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
