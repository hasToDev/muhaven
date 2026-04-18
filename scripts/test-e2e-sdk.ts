/**
 * scripts/test-e2e-sdk.ts
 *
 * Phase 19D.3 — Full yield distribution pipeline driven by `@muhaven/sdk`
 * against a live Arb Sepolia deployment.
 *
 * Flow
 * ----
 *   1. Sanity — verify deployment + deployer authorization.
 *   2. Register the deployer as an investor (mints 1e18 MuHavenToken to self
 *      so InvestorRegistry.investorCount > 0 — idempotent via a balance check).
 *   3. distributeYield(E2E_DISTRIBUTE_AMOUNT) — SDK encrypts, starts, creates
 *      escrows, funds (processBatch → fundFrom).
 *   4. Verify on-chain state: distribution COMPLETED, escrowIds attached,
 *      per-investor escrow `paidAmount` handle initialized.
 *   5. claimYield(escrowId) — deployer redeems their own escrow. This
 *      exercises the MuHavenEscrow silent-failure AND chain + PUSDC transfer.
 *   6. Summary — print all tx hashes so they can be inspected on Arbiscan.
 *
 * Observable side-effects (what the operator should see):
 *   - Etherscan: MuHavenToken.mint, YieldDistributor.startDistribution,
 *     MuHavenEscrow.batchCreate, YieldDistributor.processBatch (N calls),
 *     MuHavenEscrow.redeem, plus ConfidentialUSDC.confidentialTransfer events.
 *   - Backend Docker logs (after Phase 19D.4): the event poller should pick
 *     up EscrowCreated + EscrowRedeemed and write yield records.
 *
 * Config
 * ------
 *   E2E_DISTRIBUTE_AMOUNT=0.5   — PUSDC to distribute (default 0.5, supports decimals)
 *   E2E_SKIP_CLAIM=1            — skip the redeem step (useful for pure-distribute runs)
 *   E2E_SKIP_MINT=1             — skip the investor-registration mint
 *
 * Usage
 * -----
 *   pnpm hardhat run scripts/test-e2e-sdk.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import hre from "hardhat";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Encryptable } from "@cofhe/sdk";
import { MuHavenClient, type MuHavenAddresses, type ProgressEvent } from "@muhaven/sdk";
import { createCofheClient } from "../tasks/utils";
import { loadDeployment, getAddress, sleep } from "./testnet-utils";

const ARB_SEPOLIA_CHAIN_ID = 421614;
const PUSDC_DECIMALS = 6;
const ONE_TOKEN = 10n ** 18n;

function toPusdcUnits(human: string): bigint {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(PUSDC_DECIMALS)).slice(0, PUSDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(PUSDC_DECIMALS) + BigInt(fracPadded || "0");
}

function fmtPusdc(units: bigint): string {
  const whole = units / 10n ** BigInt(PUSDC_DECIMALS);
  const frac = units % 10n ** BigInt(PUSDC_DECIMALS);
  return `${whole}.${frac.toString().padStart(PUSDC_DECIMALS, "0")}`;
}

function makeViemClients() {
  const rpcUrl = process.env.ARB_SEPOLIA_RPC_URL;
  const pk = process.env.PRIVATE_KEY;
  if (!rpcUrl) throw new Error("ARB_SEPOLIA_RPC_URL is required");
  if (!pk) throw new Error("PRIVATE_KEY is required");

  const account = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
  );
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
  const walletClient = createWalletClient({
    chain: arbitrumSepolia,
    transport,
    account,
  });
  return { publicClient, walletClient, address: account.address };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  if (net !== "arb-sepolia") {
    throw new Error(
      `This script targets Arb Sepolia. Current network: ${net}. Run with --network arb-sepolia.`,
    );
  }

  console.log(`\n=== Phase 19D.3 — MuHaven SDK E2E (Arb Sepolia) ===\n`);
  console.log(`Deployer: ${deployer.address}`);
  const balEth = await ethers.provider.getBalance(deployer.address);
  console.log(`ETH:      ${ethers.formatEther(balEth)} ETH\n`);

  // ── Load deployment ─────────────────────────────────────────────────
  const deployment = loadDeployment();
  const addresses: MuHavenAddresses = {
    muhavenEscrow: getAddress(deployment, "MuHavenEscrow") as Address,
    yieldDistributor: getAddress(deployment, "YieldDistributor") as Address,
    investorRegistry: getAddress(deployment, "InvestorRegistry") as Address,
    yieldGate: getAddress(deployment, "YieldGate") as Address,
  };
  const tokenAddr = getAddress(deployment, "MuHavenToken");
  const pusdcAddress = process.env.PUSDC_ADDRESS ||
    "0x6b6e6479b8b3237933c3ab9d8be969862d4ed89f";

  console.log("Addresses:");
  console.log(`  MuHavenToken:     ${tokenAddr}`);
  console.log(`  InvestorRegistry: ${addresses.investorRegistry}`);
  console.log(`  YieldGate:        ${addresses.yieldGate}`);
  console.log(`  MuHavenEscrow:    ${addresses.muhavenEscrow}`);
  console.log(`  YieldDistributor: ${addresses.yieldDistributor}`);
  console.log(`  PUSDC:            ${pusdcAddress}\n`);

  // ── Preflight: authorization checks ─────────────────────────────────
  const distributor = await ethers.getContractAt("YieldDistributor", addresses.yieldDistributor);
  const registry = await ethers.getContractAt("InvestorRegistry", addresses.investorRegistry);
  const token = await ethers.getContractAt("MuHavenToken", tokenAddr);

  const isAuthorized = await distributor.authorizedCallers(deployer.address);
  if (!isAuthorized) {
    throw new Error(
      `Deployer is not authorizedCaller on YieldDistributor. Run setup-e2e.ts first.`,
    );
  }
  const isMinter = await token.minters(deployer.address);
  if (!isMinter) {
    throw new Error(
      `Deployer is not a MuHavenToken minter. deploy.ts grants this via initialize — did you run deploy:testnet?`,
    );
  }

  // ── Step 1: Register deployer as investor (mint self 1 token) ───────
  console.log("--- Step 1: Register deployer as investor ---");
  const alreadyRegistered = await registry.isInvestor(deployer.address);
  const skipMint = process.env.E2E_SKIP_MINT === "1";

  if (alreadyRegistered) {
    console.log(`  Deployer already registered in InvestorRegistry`);
  } else if (skipMint) {
    console.log(`  E2E_SKIP_MINT=1 — skipping mint (investorCount may be 0 → distribution will revert NoInvestors)`);
  } else {
    // Encrypt 1 token amount and mint to self. This registers via token._update → registry.register.
    const cofheClient = await createCofheClient(hre, deployer);
    const [encMint] = (await cofheClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute()) as any[];
    const mintTx = await token.mint(deployer.address, encMint);
    const mintRec = await mintTx.wait();
    console.log(`  token.mint(deployer, 1 MHRWA) tx: ${mintTx.hash} (gas: ${mintRec!.gasUsed})`);
  }
  const investorCount = await registry.investorCount();
  console.log(`  investorCount: ${investorCount}`);
  if (investorCount === 0n) {
    throw new Error("InvestorRegistry empty — distribution cannot proceed. Run without E2E_SKIP_MINT=1.");
  }
  console.log(`  ✓ Step 1 done\n`);

  // ── Step 2: SDK distributeYield ─────────────────────────────────────
  const distributeHuman = process.env.E2E_DISTRIBUTE_AMOUNT || "0.5";
  const distributeUnits = toPusdcUnits(distributeHuman);
  console.log("--- Step 2: SDK distributeYield ---");
  console.log(`  Distribute: ${distributeHuman} PUSDC (${distributeUnits} units)\n`);

  const cofheClient = await createCofheClient(hre, deployer);
  const { publicClient, walletClient } = makeViemClients();

  const sdk = new MuHavenClient({
    publicClient,
    walletClient,
    cofheClient: cofheClient as any,
    addresses,
    expectedChainId: ARB_SEPOLIA_CHAIN_ID,
  });
  await sdk.validateNetwork();

  const progress: ProgressEvent[] = [];
  const startedAt = Date.now();
  const result = await sdk.distributeYield(distributeUnits, {
    batchSize: 50,
    onProgress: (e) => {
      progress.push(e);
      const txSuffix = e.txHash ? ` (tx: ${e.txHash.slice(0, 10)}…)` : "";
      console.log(`  [${e.stage}] ${e.current}/${e.total}${e.message ? ` — ${e.message}` : ""}${txSuffix}`);
    },
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n  distributionId:   ${result.distributionId}`);
  console.log(`  escrowIds:        [${result.escrowIds.join(", ")}]`);
  console.log(`  createTxHashes:   ${result.createTxHashes.length} txs`);
  console.log(`  fundTxHashes:     ${result.fundTxHashes.length} txs`);
  console.log(`  elapsed:          ${elapsedSec}s`);
  console.log(`  ✓ Step 2 done\n`);

  // ── Step 3: Verify on-chain state ───────────────────────────────────
  console.log("--- Step 3: Verify on-chain state ---");
  const complete = await distributor.isDistributionComplete(result.distributionId);
  const onchainEscrowIds = await distributor.getEscrowIds(result.distributionId);
  console.log(`  isDistributionComplete: ${complete}`);
  console.log(`  getEscrowIds(${result.distributionId}): [${onchainEscrowIds.join(", ")}]`);
  if (!complete) throw new Error("Distribution not COMPLETED after SDK pipeline");
  if (onchainEscrowIds.length !== result.escrowIds.length) {
    throw new Error(
      `Escrow ID length mismatch — SDK returned ${result.escrowIds.length}, chain returned ${onchainEscrowIds.length}`,
    );
  }

  const escrow = await ethers.getContractAt("MuHavenEscrow", addresses.muhavenEscrow);
  for (const id of result.escrowIds) {
    const exists = await escrow.exists(id);
    if (!exists) throw new Error(`Escrow ${id} does not exist post-fund`);
    const paid = await escrow.getPaidAmount(id);
    console.log(`  escrow ${id}: exists=${exists}, paidAmount=${paid.toString().slice(0, 18)}…`);
  }
  console.log(`  ✓ Step 3 done\n`);

  // ── Step 4: Redeem ──────────────────────────────────────────────────
  const skipClaim = process.env.E2E_SKIP_CLAIM === "1";
  console.log("--- Step 4: Redeem deployer's escrow ---");
  if (skipClaim) {
    console.log(`  E2E_SKIP_CLAIM=1 — skipping redeem\n`);
  } else {
    // Deployer's escrow is the one where encrypted owner == deployer. The SDK
    // created escrows in registry order — find the index of the deployer in
    // the registry and claim that escrow.
    const paginated = await registry.getInvestorsPaginated(0, investorCount);
    const investors: string[] = paginated.map((x: string) => x);
    const deployerIndex = investors.findIndex(
      (a) => a.toLowerCase() === deployer.address.toLowerCase(),
    );
    if (deployerIndex < 0) {
      throw new Error(
        `Deployer not in registry — cannot identify deployer's escrow. Investors: ${investors.join(", ")}`,
      );
    }
    const deployerEscrowId = result.escrowIds[deployerIndex];
    console.log(`  Deployer is investor index ${deployerIndex} → escrow #${deployerEscrowId}`);

    const claimTx = await sdk.claimYield(deployerEscrowId);
    console.log(`  claimYield tx: ${claimTx}`);

    // The "indicator" that ConfidentialUSDC returns from balanceOf() is a
    // pseudo-random tick, not a true balance — sampling it is timing-sensitive
    // and noisy. Parse the tx receipt for the real signals instead:
    //
    //   - MuHavenEscrow.EscrowRedeemed(escrowId)            — redeem ran
    //   - ConfidentialUSDC.ConfidentialTransfer(from, to)   — cUSDC moved
    //   - ConfidentialUSDC.Transfer(from, to, indicatorTick) — ERC-20 indicator log
    const receipt = await ethers.provider.getTransactionReceipt(claimTx);
    if (!receipt) throw new Error(`No receipt for claim tx ${claimTx}`);

    const EVT_ESCROW_REDEEMED = ethers.id("EscrowRedeemed(uint256)");
    const EVT_CONF_TRANSFER = ethers.id("ConfidentialTransfer(address,address,uint256)");
    const EVT_ERC20_TRANSFER = ethers.id("Transfer(address,address,uint256)");

    const escrowAddrLc = addresses.muhavenEscrow.toLowerCase();
    const pusdcAddrLc = pusdcAddress.toLowerCase();

    const saw = {
      escrowRedeemed: false,
      confTransfer: false,
      erc20Transfer: false,
    };
    for (const log of receipt.logs) {
      const addr = log.address.toLowerCase();
      const topic0 = log.topics[0];
      if (addr === escrowAddrLc && topic0 === EVT_ESCROW_REDEEMED) {
        saw.escrowRedeemed = true;
      }
      if (addr === pusdcAddrLc && topic0 === EVT_CONF_TRANSFER) {
        saw.confTransfer = true;
      }
      if (addr === pusdcAddrLc && topic0 === EVT_ERC20_TRANSFER) {
        saw.erc20Transfer = true;
      }
    }

    console.log(
      `  events: EscrowRedeemed=${saw.escrowRedeemed} ConfidentialTransfer=${saw.confTransfer} IndicatorTransfer=${saw.erc20Transfer}`,
    );

    if (!saw.escrowRedeemed) {
      throw new Error(`redeem tx did not emit EscrowRedeemed — something is broken`);
    }
    if (!saw.confTransfer) {
      console.log(
        `  ⚠ No ConfidentialTransfer on PUSDC — the silent-fail chain likely zeroed the payout.`,
      );
      console.log(
        `    Check KYC eligibility (YieldGate.canRedeem), escrow ownership, and that startDistribution`,
      );
      console.log(
        `    successfully forwarded cUSDC to the escrow contract (requires impl with _forwardYieldToEscrow).`,
      );
    } else {
      console.log(`  ✓ cUSDC payout observed (ConfidentialTransfer + indicator tick)`);
    }
    console.log(`  ✓ Step 4 done\n`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("=== Pipeline Complete ===");
  console.log(`  distributionId:   ${result.distributionId}`);
  console.log(`  escrowIds:        [${result.escrowIds.join(", ")}]`);
  console.log(`  All tx hashes:`);
  for (const h of result.createTxHashes) console.log(`    ${h}`);
  for (const h of result.fundTxHashes) console.log(`    ${h}`);
  console.log(`\n  Verify on Arbiscan: https://sepolia.arbiscan.io/address/${addresses.muhavenEscrow}#events`);
  console.log(`  Verify on Arbiscan: https://sepolia.arbiscan.io/address/${addresses.yieldDistributor}#events`);
  console.log();
}

main().catch((err) => {
  console.error("\n❌ test-e2e-sdk failed:", err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
