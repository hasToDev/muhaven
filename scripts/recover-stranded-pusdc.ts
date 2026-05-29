/**
 * scripts/recover-stranded-pusdc.ts
 *
 * Operator-only (Wave 5 W3 · Phase 9): redeem MuHavenStable's STRANDED legacy
 * PUSDC back into USDC, topping the wrapper's reserve back up.
 *
 * Why this exists
 * ───────────────
 * Every W3 withdraw (`withdrawToUsdc` → `claimUsdc`) burns mhUSDC and pays
 * USDC from the wrapper's reserve, but the legacy PUSDC that originally backed
 * that mhUSDC stays stranded inside the wrapper forever (see
 * `ADR_W3_RESERVE_MODEL.md` "Negative" → stranded-PUSDC accounting). Phase 9
 * adds two owner-only entrypoints so the wrapper can redeem its own stranded
 * PUSDC via the legacy PUSDC's two-phase async `unwrap` + `claimUnwrapped`:
 *   - `recoverStrandedPusdcStart(uint64 amount)`  → returns legacyClaimId
 *   - `recoverStrandedPusdcClaim(uint256 legacyClaimId)`
 * This script drives both legs (operator-gated, ~30-60s apart for the legacy
 * coprocessor decrypt) and the read-only pre-flight that confirms the legacy
 * selectors before any broadcast.
 *
 * ⚠ The `amount` is cleartext uint64 — the contract can't decrypt its own
 *   confidential PUSDC balance on-chain. The OPERATOR must compute the stranded
 *   total OFF-CHAIN (≈ Σ WithdrawClaimed amounts − Σ recovered). At Phase 9
 *   deploy time this is ~$7-8 (the cumulative §5 smoke burns). Over-requesting
 *   reverts in the legacy contract (its own balance guard) → surfaced as
 *   `RecoverFailed`; no funds move on the start leg.
 *
 * Modes (mirrors seed-stable-usdc-reserve.ts conventions)
 * ───────────────────────────────────────────────────────
 *   VERIFY_ONLY=1   Read-only. Probe the legacy `unwrap(address,uint64)` +
 *                   `claimUnwrapped(uint256)` selectors on-chain, read owner /
 *                   reserve / pause flags, print stranded-amount guidance.
 *                   Broadcast nothing. RUN THIS FIRST on prod.
 *   (default)       START leg — `recoverStrandedPusdcStart(STRANDED_AMOUNT_USDC6)`.
 *                   Prints the emitted legacyClaimId for the claim leg.
 *   CLAIM_ID=<n>    CLAIM leg — `recoverStrandedPusdcClaim(CLAIM_ID)`.
 *   DRY_RUN=1       Print the planned call + state, broadcast nothing.
 *
 * Required env
 *   MUHAVEN_ENV               prod | staging | local (no default).
 *
 * Mode-specific env
 *   STRANDED_AMOUNT_USDC6     (start leg) USDC base-6 amount to recover. Must
 *                             fit uint64. Underscores accepted.
 *   CLAIM_ID                  (claim leg) the legacyClaimId returned by the
 *                             start leg.
 *
 * Optional env
 *   VERIFY_ONLY=1             Read-only pre-flight (see above).
 *   DRY_RUN=1                 No broadcast; print the planned call.
 *   CONFIRM_BROADCAST=1       Skip the interactive `yes` prompt (CI only).
 *
 * Usage
 *   # 1. Pre-flight (read-only) — confirm selectors + state:
 *   MUHAVEN_ENV=prod VERIFY_ONLY=1 \
 *     pnpm hardhat run scripts/recover-stranded-pusdc.ts --network arb-sepolia
 *   # 2. Start the recovery ($8 stranded = 8_000_000 base-6):
 *   MUHAVEN_ENV=prod STRANDED_AMOUNT_USDC6=8000000 \
 *     pnpm hardhat run scripts/recover-stranded-pusdc.ts --network arb-sepolia
 *   # ... wait ~30-60s for the legacy coprocessor decrypt ...
 *   # 3. Claim (id printed by step 2):
 *   MUHAVEN_ENV=prod CLAIM_ID=1 \
 *     pnpm hardhat run scripts/recover-stranded-pusdc.ts --network arb-sepolia
 */

import { ethers, network } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

const ARB_SEPOLIA_CHAIN_ID = 421614;

const STABLE_ABI = [
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
  "function paused() view returns (bool)",
  "function claimsPaused() view returns (bool)",
  "function legacyPusdc() view returns (address)",
  "function usdcReserveBalance() view returns (uint256)",
  "function recoverStrandedPusdcStart(uint64 amount) returns (uint256 legacyClaimId)",
  "function recoverStrandedPusdcClaim(uint256 legacyClaimId)",
  "event StrandedPusdcRecoveryStarted(uint64 amount, uint256 indexed legacyClaimId)",
  "event StrandedPusdcRecoveryClaimed(uint256 indexed legacyClaimId)",
];

// The legacy PUSDC selectors the contract calls. Mirrored here so VERIFY_ONLY
// can probe the deployed bytecode (codifies
// feedback_verify_coprocessor_selector_before_prod_cutover).
const LEGACY_SELECTOR_SIGS = [
  "unwrap(address,uint64)",
  "claimUnwrapped(uint256)",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : env === "local" ? ".local" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

function fmtUsd(base6: bigint): string {
  return `$${(Number(base6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

function safeLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

function parseBaseAmount(raw: string | undefined, label: string): bigint {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${label} is required for this leg (USDC base-6 integer).`);
  }
  const cleaned = raw.replace(/_/g, "").trim();
  if (!/^\d+$/.test(cleaned)) {
    throw new Error(`${label} must be a non-negative base-6 integer (got "${safeLog(raw)}").`);
  }
  return BigInt(cleaned);
}

/** Interactive y/N broadcast gate — same shape as seed-stable-usdc-reserve.ts.
 *  The wrapper has no timelock; the .env PRIVATE_KEY is the single point of
 *  compromise, so a typo'd command moves real value on prod. Bypass with
 *  CONFIRM_BROADCAST=1 (CI). Refuse on a non-TTY without the bypass. */
async function confirmBroadcast(summary: string): Promise<void> {
  if (/^(1|true|yes)$/i.test(process.env.CONFIRM_BROADCAST ?? "")) {
    console.log("CONFIRM_BROADCAST is set — skipping interactive prompt.");
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `Refusing to broadcast: stdin is not a TTY and CONFIRM_BROADCAST=1 is not set.`,
    );
  }
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n┌─ Broadcast confirmation ──────────────────────────────────");
    for (const line of summary.split("\n")) console.log(`│ ${line}`);
    console.log("└────────────────────────────────────────────────────────────");
    const answer: string = await new Promise((resolve) =>
      rl.question(`Type "yes" to broadcast, anything else to abort: `, resolve),
    );
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error(`Broadcast aborted by operator (answer: "${safeLog(answer)}").`);
    }
  } finally {
    rl.close();
  }
}

/** Probe the deployed legacy PUSDC bytecode for the recovery selectors. A hit
 *  is strong evidence the function exists (PUSH4 dispatcher constant); a miss
 *  means recovery WILL revert RecoverFailed — abort before broadcasting. */
async function probeLegacySelectors(legacyPusdc: string): Promise<boolean> {
  const code = (await ethers.provider.getCode(legacyPusdc)).toLowerCase();
  if (code === "0x") throw new Error(`No bytecode at legacyPusdc ${legacyPusdc}.`);
  console.log(`\nLegacy PUSDC selector probe (${legacyPusdc}, ${(code.length - 2) / 2} bytes):`);
  let allPresent = true;
  for (const sig of LEGACY_SELECTOR_SIGS) {
    const sel = ethers.id(sig).slice(0, 10);
    const present = code.includes(sel.slice(2));
    if (!present) allPresent = false;
    console.log(`  ${sel}  ${present ? "PRESENT" : "ABSENT "}  ${sig}`);
  }
  if (!allPresent) {
    console.log(
      `  ⚠ A required selector is ABSENT — recovery would revert RecoverFailed.\n` +
        `    Do NOT broadcast the start leg. Re-derive the legacy interface.`,
    );
  } else {
    console.log(
      `  ✓ Both recovery selectors present in the dispatcher bytecode.\n` +
        `    (Heuristic: a PUSH4 hit is necessary-but-not-sufficient — it confirms\n` +
        `     the selector exists, not the exact return shape. The start leg's\n` +
        `     abi.decode is bounded + loud-fails RecoverFailed on a mismatch, and\n` +
        `     no funds move on the start leg, so a surprise here is safe-fail.)`,
    );
  }
  return allPresent;
}

/** Broadcast an owner-only method via a STANDALONE wallet on the official
 *  Arbitrum sequencer RPC (NOT the hardhat-ethers signer). The configured
 *  ARB_SEPOLIA_RPC_URL serves reads but HANGS on `eth_sendRawTransaction`
 *  (diagnosed 2026-05-29 — same hang that froze the Phase 9 impl deploy +
 *  proxy upgrade). estimateGas simulates the call first, so an over-request
 *  (`RecoverFailed`) surfaces BEFORE broadcasting. Override with DEPLOY_RPC_URL. */
async function broadcastVia(
  signerAddr: string,
  contract: ethers.Contract,
  method: string,
  args: any[],
): Promise<any> {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env not set — needed for the standalone broadcast wallet.");
  const rpc = process.env.DEPLOY_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  if (wallet.address.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(`PRIVATE_KEY wallet ${wallet.address} != expected owner ${signerAddr}.`);
  }
  const cw = contract.connect(wallet) as any;
  console.log(`  broadcasting via ${rpc}…`);
  const [estGas, fee, nonce] = await Promise.all([
    cw[method].estimateGas(...args),
    provider.getFeeData(),
    provider.getTransactionCount(wallet.address, "pending"),
  ]);
  return cw[method](...args, {
    gasLimit: (estGas * 120n) / 100n,
    gasPrice: (fee.gasPrice ?? 100_000_000n) * 2n,
    nonce,
    type: 0,
  });
}

async function main() {
  const env = (process.env.MUHAVEN_ENV ?? "").toLowerCase();
  if (env !== "prod" && env !== "staging" && env !== "local") {
    throw new Error(`MUHAVEN_ENV must be prod|staging|local (got "${safeLog(env || "(unset)")}").`);
  }
  const verifyOnly = /^(1|true|yes)$/i.test(process.env.VERIFY_ONLY ?? "");
  const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");
  const claimIdRaw = process.env.CLAIM_ID;
  const isClaimLeg = claimIdRaw !== undefined && claimIdRaw.trim() !== "";

  // Network guard — refuse anything but Arb Sepolia for prod/staging.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (env !== "local" && chainId !== ARB_SEPOLIA_CHAIN_ID) {
    throw new Error(`Refusing to run: chainId=${chainId}, expected ${ARB_SEPOLIA_CHAIN_ID} (arb-sepolia).`);
  }

  const deployPath = deploymentPath(env);
  const dep = JSON.parse(readFileSync(deployPath, "utf8"));
  const proxy = dep.contracts?.MuHavenStable?.proxy as string;
  if (!proxy) throw new Error(`No MuHavenStable.proxy in ${deployPath}`);

  const [signer] = await ethers.getSigners();
  const stable = new ethers.Contract(proxy, STABLE_ABI, signer);

  // Pre-flight reads (always).
  const [owner, usdc, paused, claimsPaused, legacyPusdc, reserve] = await Promise.all([
    stable.owner() as Promise<string>,
    stable.usdc() as Promise<string>,
    stable.paused() as Promise<boolean>,
    stable.claimsPaused() as Promise<boolean>,
    stable.legacyPusdc() as Promise<string>,
    stable.usdcReserveBalance() as Promise<bigint>,
  ]);

  console.log(`── recover-stranded-pusdc ───────────────────────────────`);
  console.log(`Network        : ${network.name}`);
  console.log(`Env            : ${env}`);
  console.log(`Signer         : ${signer.address}`);
  console.log(`Proxy          : ${proxy}`);
  console.log(`owner()        : ${owner}`);
  console.log(`usdc()         : ${usdc}`);
  console.log(`legacyPusdc()  : ${legacyPusdc}`);
  console.log(`paused()       : ${paused}`);
  console.log(`claimsPaused() : ${claimsPaused}`);
  console.log(`reserve        : ${fmtUsd(reserve)} (${reserve})`);
  console.log(
    `Leg            : ${verifyOnly ? "VERIFY-ONLY" : isClaimLeg ? "CLAIM" : "START"}` +
      `${dryRun ? " (DRY-RUN)" : ""}`,
  );

  // ── VERIFY-ONLY ────────────────────────────────────────────────────────
  if (verifyOnly) {
    await probeLegacySelectors(legacyPusdc);
    if (usdc === ethers.ZeroAddress) {
      console.log(`\n⚠ usdc() is unset — recoverStrandedPusdcStart would revert UsdcReserveNotSet.`);
    }
    if (paused) {
      console.log(`\n⚠ paused() is true — recovery is blocked by whenNotPaused. Unpause first.`);
    }
    console.log(
      `\nStranded amount is NOT readable on-chain (the PUSDC balance is confidential).\n` +
        `Compute it off-chain: Σ WithdrawClaimed.amount since the W3 cutover − Σ already\n` +
        `recovered. Pass it as STRANDED_AMOUNT_USDC6 to the start leg.`,
    );
    console.log(`\n✓ VERIFY-ONLY complete — broadcast nothing.`);
    return;
  }

  // Owner pre-flight (both broadcast legs are onlyOwner).
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is NOT the wrapper owner (${owner}). Refusing.`);
  }
  if (paused) {
    throw new Error(`Wrapper is paused — recovery is blocked by whenNotPaused. Unpause first.`);
  }

  // ── CLAIM leg ──────────────────────────────────────────────────────────
  if (isClaimLeg) {
    const claimId = parseBaseAmount(claimIdRaw, "CLAIM_ID");
    const summary = [
      `Leg          : recoverStrandedPusdcClaim`,
      `legacyClaimId: ${claimId}`,
      `Proxy        : ${proxy}`,
      `Reserve now  : ${fmtUsd(reserve)} (expected to GROW by the recovered amount)`,
    ].join("\n");
    if (dryRun) {
      console.log(`\nDRY-RUN: would call recoverStrandedPusdcClaim(${claimId}). No broadcast.`);
      return;
    }
    await confirmBroadcast(summary);
    console.log(`\n[1/1] broadcasting recoverStrandedPusdcClaim(${claimId})…`);
    const tx = await broadcastVia(signer.address, stable, "recoverStrandedPusdcClaim", [claimId]);
    console.log(`  tx hash: ${tx.hash}`);
    console.log(`  track  : https://sepolia.arbiscan.io/tx/${tx.hash}`);
    const rc = await tx.wait();
    console.log(`  mined  : block ${rc?.blockNumber}, status=${rc?.status}`);
    const reserveAfter = (await stable.usdcReserveBalance()) as bigint;
    console.log(`  reserve: ${fmtUsd(reserve)} → ${fmtUsd(reserveAfter)} (Δ ${fmtUsd(reserveAfter - reserve)})`);
    console.log(`\n✓ Recovery claim settled.`);
    return;
  }

  // ── START leg ──────────────────────────────────────────────────────────
  if (usdc === ethers.ZeroAddress) {
    throw new Error(`usdc() is unset — recoverStrandedPusdcStart would revert UsdcReserveNotSet.`);
  }
  const amount = parseBaseAmount(process.env.STRANDED_AMOUNT_USDC6, "STRANDED_AMOUNT_USDC6");
  if (amount === 0n) throw new Error(`STRANDED_AMOUNT_USDC6 must be > 0.`);
  if (amount > (1n << 64n) - 1n) throw new Error(`STRANDED_AMOUNT_USDC6 exceeds uint64 max.`);

  // Selector pre-flight before any broadcast (cheap insurance).
  const ok = await probeLegacySelectors(legacyPusdc);
  if (!ok) {
    throw new Error(`Legacy selector probe FAILED — refusing to broadcast the start leg.`);
  }

  const summary = [
    `Leg          : recoverStrandedPusdcStart`,
    `amount       : ${fmtUsd(amount)} (${amount} base-6)`,
    `legacyPusdc  : ${legacyPusdc}`,
    `Proxy        : ${proxy}`,
    `NOTE         : USDC lands on the CLAIM leg (~30-60s later), not now.`,
  ].join("\n");
  if (dryRun) {
    console.log(`\nDRY-RUN: would call recoverStrandedPusdcStart(${amount}). No broadcast.`);
    return;
  }
  await confirmBroadcast(summary);
  console.log(`\n[1/1] broadcasting recoverStrandedPusdcStart(${amount})…`);
  const tx = await broadcastVia(signer.address, stable, "recoverStrandedPusdcStart", [amount]);
  console.log(`  tx hash: ${tx.hash}`);
  console.log(`  track  : https://sepolia.arbiscan.io/tx/${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  mined  : block ${rc?.blockNumber}, status=${rc?.status}`);

  // Parse the emitted legacyClaimId.
  let legacyClaimId: bigint | null = null;
  for (const log of rc?.logs ?? []) {
    try {
      const parsed = stable.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === "StrandedPusdcRecoveryStarted") {
        legacyClaimId = parsed.args.legacyClaimId as bigint;
        break;
      }
    } catch {
      /* not ours */
    }
  }
  if (legacyClaimId === null) {
    console.log(`\n⚠ Start mined but no StrandedPusdcRecoveryStarted event parsed — inspect the tx.`);
  } else {
    console.log(`\n✓ Recovery started. legacyClaimId = ${legacyClaimId}`);
    console.log(`  Wait ~30-60s for the legacy coprocessor decrypt, then claim:`);
    console.log(`    MUHAVEN_ENV=${env} CLAIM_ID=${legacyClaimId} \\`);
    console.log(`      pnpm hardhat run scripts/recover-stranded-pusdc.ts --network arb-sepolia`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
