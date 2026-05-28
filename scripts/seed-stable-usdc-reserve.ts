/**
 * scripts/seed-stable-usdc-reserve.ts
 *
 * Operator-only (Wave 5 W3 · direct mhUSDC → USDC exit): configure the
 * `MuHavenStable` USDC reserve token and seed it with real USDC so
 * `claimUsdc` can settle from a funded reserve.
 *
 * Why this exists
 * ───────────────
 * W3 adds a direct mhUSDC→USDC withdrawal that pays USDC from a contract-held
 * reserve at claim time (see `development/DEV_WAVE_5/W3_DIRECT_USDC_EXIT_PLAN.md`
 * + `reference_mhusdc_usdc_exit_is_async_fhe`). After the proxy upgrade
 * (`scripts/upgrade-stable.ts`) lands the W3 implementation, two owner-only
 * steps are still required before the first withdrawal can settle:
 *   1. `setUsdcReserveToken(usdc)` — point the wrapper at the USDC ERC-20.
 *   2. `fundUsdcReserve(amount)`   — transfer USDC from the owner into the
 *      wrapper, with ERC-20 `approve` pre-flight.
 *
 * This script wraps both, idempotently and with a verify-only mode, so the
 * cutover is a single command instead of three transactions and a manual
 * read-back. Designed to mirror the conventions of `scripts/set-instant-cap.ts`
 * + `scripts/seed-treasury.ts`: explicit `MUHAVEN_ENV` (no default), DRY_RUN,
 * VERIFY_ONLY, read-after-write retry through load-balanced RPC staleness.
 *
 *   ⚠ The reserve is a ONE-WAY DRAIN by design (see the W3 reserve-model ADR
 *   in the plan): the PUSDC that backed each burned mhUSDC stays stranded in
 *   the wrapper. Re-run this script to top up; recover surplus via the owner's
 *   `withdrawUsdcReserve` (no script — small + rare).
 *
 *   ⚠ Reserve-token rotation is gated. If `usdc()` is already set to a
 *   DIFFERENT non-zero address, the script refuses unless `ALLOW_ROTATE=1` is
 *   passed — rotating with pending claims is an owner footgun (claims are
 *   implicitly 1:1 in the token they were created against). Bypass only when
 *   no claims are pending or the new token is a like-for-like 6-dp USDC.
 *
 * Authorization
 * ─────────────
 * `setUsdcReserveToken` + `fundUsdcReserve` are `onlyOwner`. Per
 * `deployments/arb-sepolia-v2.json` the prod owner == the deployer EOA
 * (0xe11E…6986). The script pre-flights `stable.owner() == signer` and aborts
 * loudly if the signer isn't the owner.
 *
 * Usage
 * ─────
 *   # Verify only — print owner, reserve token, reserve balance, signer USDC
 *   # balance + allowance, broadcast nothing:
 *   MUHAVEN_ENV=prod VERIFY_ONLY=1 \
 *   pnpm hardhat run scripts/seed-stable-usdc-reserve.ts --network arb-sepolia
 *
 *   # Default: set the reserve token (if unset) + seed it with $500 USDC:
 *   MUHAVEN_ENV=prod \
 *   pnpm hardhat run scripts/seed-stable-usdc-reserve.ts --network arb-sepolia
 *
 *   # Seed with a custom amount ($200 in base-6 = 200_000_000):
 *   MUHAVEN_ENV=prod SEED_AMOUNT_USDC6=200000000 \
 *   pnpm hardhat run scripts/seed-stable-usdc-reserve.ts --network arb-sepolia
 *
 *   # Skip the seed (e.g. only configure the reserve token):
 *   MUHAVEN_ENV=prod SEED_AMOUNT_USDC6=0 \
 *   pnpm hardhat run scripts/seed-stable-usdc-reserve.ts --network arb-sepolia
 *
 *   # Override the USDC token address (default: Circle USDC on Arb Sepolia):
 *   MUHAVEN_ENV=prod USDC_ADDRESS=0x… \
 *   pnpm hardhat run scripts/seed-stable-usdc-reserve.ts --network arb-sepolia
 *
 * Required env
 *   MUHAVEN_ENV          prod | staging | local (no default).
 *
 * Optional env
 *   SEED_AMOUNT_USDC6    USDC base-6 amount to fund the reserve with. Default
 *                        500_000_000 (= $500). 0 = skip the fund step (useful
 *                        for "just configure the reserve token"). Underscores
 *                        accepted (e.g. 500_000_000). Must fit uint256, but in
 *                        practice << signer USDC balance.
 *   USDC_ADDRESS         Reserve token address override. Defaults to the
 *                        canonical Circle USDC for the current chain (Arb
 *                        Sepolia = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d).
 *   ALLOW_NON_CANONICAL_USDC  "1"/"true" → permit a non-Circle USDC address.
 *                        Default: refuse. Required when USDC_ADDRESS or
 *                        deployment.external.usdc resolves to something
 *                        other than the canonical Circle USDC for the chain.
 *   ALLOW_ROTATE         Literal string "YES_I_HAVE_CHECKED_PENDING_CLAIMS"
 *                        → permit rotating an already-set reserve token. Old
 *                        shorthand (1/true/yes) is rejected — the long literal
 *                        is a deliberate friction point. Rotation is ALSO
 *                        refused if the prior reserve token still holds a
 *                        non-zero balance (drain via withdrawUsdcReserve first).
 *   VERIFY_ONLY          "1"/"true" → read + print state, no transactions.
 *   DRY_RUN              alias for VERIFY_ONLY (kept for parity with the other
 *                        ops scripts).
 *   CONFIRM_BROADCAST    "1"/"true" → skip the interactive y/N broadcast
 *                        confirmation. Intended for CI / scripted contexts
 *                        that have their own gate. Default: interactive
 *                        prompt requires literal "yes" on stdin; non-TTY
 *                        runs are refused outright unless this is set.
 *
 * Idempotent. Re-running with no changes:
 *   - `setUsdcReserveToken` is skipped if already at the target.
 *   - `fundUsdcReserve(0)` is skipped at the script layer (no zero-value tx).
 *   - `approve` is skipped if the current allowance already covers the seed.
 *
 * Exports `seedStableUsdcReserve(...)` for in-process re-use by the local
 * verify harness (`scripts/verify-stable-usdc-exit-local.ts`) — that script
 * skips the env/file IO layer entirely and calls the seed function directly
 * against an in-process deployment.
 */

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Circle's permissionless USDC faucet token on Arb Sepolia. 6 decimals,
// matches mhUSDC's base-6 — withdrawals are 1:1.
const DEFAULT_USDC_ARB_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

// Canonical (Circle-issued) USDC addresses per chain. A `USDC_ADDRESS`
// override (or `deployment.external.usdc`) that does NOT match the
// canonical address for the current network is refused unless
// `ALLOW_NON_CANONICAL_USDC=1` is also passed (security review H-S1: a
// typo'd override that happens to hit any other 6-dp ERC-20 on the chain
// would silently configure that token as the reserve, then `claimUsdc`
// would pay out that token — semantic-level theft against users).
// Local-network runs (MUHAVEN_ENV=local) skip this gate because the
// verify harness deploys an ephemeral MockUSDC each run.
const CANONICAL_USDC_BY_CHAIN: Record<number, string> = {
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arb Sepolia (Circle testnet)
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arb One (Circle native)
};

// $500 in USDC base-6. Matches the W3 runbook's recommended initial seed
// for the prod cutover (operator-confirmed 2026-05-28).
const DEFAULT_SEED_USDC6 = 500_000_000n;

// ETH-balance floor enforced in main() pre-flight. Arb Sepolia gas is
// dust, but 3 sequential txs (setUsdcReserveToken + approve +
// fundUsdcReserve) can leave the operator stuck mid-flight if the signer
// is gas-starved. 0.001 ETH covers all three with margin (S-4 review).
const MIN_SIGNER_ETH_WEI = 1_000_000_000_000_000n; // 1e15 = 0.001 ETH

// Threshold below which a post-fund reserve-balance drift is logged as a
// minor NOTE (likely 1-wei donation griefing), above which it's a louder
// WARN. Prevents an attacker from training operators to ignore the drift
// note by repeatedly donating dust (security review M-S2).
const DRIFT_NOTE_THRESHOLD = 100_000n; // $0.10 in base-6

// Literal-string sentinel that must match `ALLOW_ROTATE` for a rotation
// to proceed — too long to copy-paste-without-reading (security review
// L-S2; same shape as Kubernetes `--force-delete-namespace` confirmations).
// Old shorthand values (`1`/`true`/`yes`) are no longer accepted.
const ALLOW_ROTATE_SENTINEL = "YES_I_HAVE_CHECKED_PENDING_CLAIMS";

const STABLE_ABI = [
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
  "function claimsPaused() view returns (bool)",
  "function usdcReserveBalance() view returns (uint256)",
  "function setUsdcReserveToken(address usdc_)",
  "function fundUsdcReserve(uint256 amount)",
  // Event sigs (used to parse the fund tx's authoritative landed amount —
  // see H1 review note: the live `usdcReserveBalance()` is the on-chain
  // ERC-20 balance, which can drift between the pre-read and the post-read
  // due to a concurrent `claimUsdc` settle or `withdrawUsdcReserve` recover.
  // The `UsdcReserveFunded` event is the wrapper's own record of "this
  // many USDC just moved IN via fundUsdcReserve" and is collision-proof.)
  "event UsdcReserveFunded(address indexed from, uint256 amount)",
  "event UsdcReserveTokenSet(address indexed usdc)",
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function deploymentPath(env: string): string {
  const suffix = env === "staging" ? ".staging" : env === "local" ? ".local" : "";
  return join(__dirname, "..", "deployments", `arb-sepolia-v2${suffix}.json`);
}

function fmtUsd(base6: bigint): string {
  return `$${(Number(base6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ASCII control characters from any env-derived string before logging.
 *  Mitigates a poisoned shell history / sourced `.envrc` injecting ANSI
 *  escapes into one of the env vars to fake the "Mode: VERIFY-ONLY" line on
 *  a real broadcast (security review L-S1). Reachability requires a
 *  separately-compromised shell, so the gate is informational-defense. */
function safeLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

/** Interactive y/N confirmation before broadcasting an owner-only tx (security
 *  review M-S1). The contract has no timelock, the `.env` PRIVATE_KEY is the
 *  single point of compromise, and a typo'd command line directly moves real
 *  USDC on prod. Print a summary, require literal `yes`. Bypass with
 *  `CONFIRM_BROADCAST=1` (CI + scripted contexts). Refuse outright if stdin
 *  isn't a TTY AND no bypass — prevents a non-interactive shell from
 *  hanging or accidentally broadcasting on stdin EOF. */
async function confirmBroadcast(summary: string): Promise<void> {
  if (/^(1|true|yes)$/i.test(process.env.CONFIRM_BROADCAST ?? "")) {
    console.log("CONFIRM_BROADCAST is set — skipping interactive prompt.");
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `Refusing to broadcast: stdin is not a TTY and CONFIRM_BROADCAST=1 is not set. ` +
        `Either run this from an interactive terminal, or explicitly opt in by setting ` +
        `CONFIRM_BROADCAST=1 (intended for CI / scripted contexts that have their own gate).`,
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

/** Read the configured reserve token back, retrying through RPC
 *  read-after-write staleness — the load-balanced Arbitrum RPC can serve a
 *  node a block behind the just-mined `setUsdcReserveToken` tx, returning
 *  the old (zero or prior) address for a few seconds. Returns the last value
 *  read (== `expected` as soon as a node catches up). The post-fund reserve
 *  *balance* deliberately is NOT retried this way (H1 review): the balance
 *  is the live `IERC20.balanceOf(this)` which can legitimately drift due to
 *  concurrent `claimUsdc` settles or stray ERC-20 transfers — we assert on
 *  the wrapper's `UsdcReserveFunded` event instead. */
async function readReserveTokenWithRetry(
  stable: ethers.Contract,
  expected: string,
  attempts = 8,
  delayMs = 2500,
): Promise<string> {
  let last = ethers.ZeroAddress;
  const want = expected.toLowerCase();
  for (let i = 0; i < attempts; i++) {
    last = ((await stable.usdc()) as string).toLowerCase();
    if (last === want) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
}

export interface SeedReserveOptions {
  /** MuHavenStable proxy address. */
  stable: string;
  /** USDC reserve token address. */
  usdc: string;
  /** Amount to fund in USDC base-6 units. 0 = skip the fund step. */
  seedAmount: bigint;
  /** Signer (must equal the wrapper's owner). */
  signer: ethers.Signer;
  /** True ⇒ read + log only, no transactions. */
  verifyOnly: boolean;
  /** True ⇒ allow rotating an already-set reserve token to a different address. */
  allowRotate: boolean;
}

/**
 * Configure + seed the wrapper's USDC reserve.
 *
 * Steps:
 *   1. Pre-flight: signer is owner, claims kill-switch state, current reserve
 *      token, current reserve balance, signer USDC balance + allowance.
 *   2. If `verifyOnly`: log and return.
 *   3. If `stable.usdc()` is unset → `setUsdcReserveToken(usdc)`.
 *      If set to a different non-zero address → refuse unless `allowRotate`.
 *      If already at the target → skip.
 *   4. If `seedAmount > 0`:
 *        - require signer USDC balance >= seedAmount.
 *        - approve USDC for the wrapper iff current allowance < seedAmount.
 *        - call `fundUsdcReserve(seedAmount)`.
 *        - read-back the reserve balance with retry through RPC staleness.
 *      If the post-fund delta != seedAmount, throw (e.g. a concurrent owner
 *      withdrawUsdcReserve raced the seed — surface loudly).
 *   5. If `seedAmount == 0`: skip the fund step entirely.
 *
 * Returns a summary that the CLI wrapper prints; the verify harness asserts
 * on it.
 */
export async function seedStableUsdcReserve(opts: SeedReserveOptions): Promise<{
  ownerAddress: string;
  signerAddress: string;
  reserveTokenBefore: string;
  reserveTokenAfter: string;
  reserveBalanceBefore: bigint;
  reserveBalanceAfter: bigint;
  signerUsdcBefore: bigint;
  signerUsdcAfter: bigint;
  seedAmount: bigint;
  seeded: boolean;
  rotated: boolean;
  set: boolean;
  claimsPaused: boolean;
}> {
  const stable = new ethers.Contract(opts.stable, STABLE_ABI, opts.signer);
  const usdc = new ethers.Contract(opts.usdc, USDC_ABI, opts.signer);
  const signerAddress = await opts.signer.getAddress();

  // ── Pre-flight reads ─────────────────────────────────────────────────
  const ownerAddress: string = await stable.owner();
  const reserveTokenBefore: string = await stable.usdc();
  const reserveBalanceBefore: bigint = await stable.usdcReserveBalance();
  const claimsPaused: boolean = await stable.claimsPaused();

  // USDC reads. `decimals()` is load-bearing — the 6-dp check below is the
  // safety gate that prevents accidentally seeding an 18-dp ERC-20 as if it
  // were USDC. A non-readable `decimals()` must be a hard failure (M6 review
  // note: silently defaulting to 6 lets a misconfigured stub bypass the gate).
  let usdcDecimals: number;
  try {
    usdcDecimals = Number(await usdc.decimals());
  } catch (e) {
    throw new Error(
      `USDC reserve token at ${opts.usdc} does not implement decimals() — ` +
        `refusing to seed an unverifiable token. Original: ${(e as Error).message ?? e}`,
    );
  }
  const signerUsdcBefore: bigint = await usdc.balanceOf(signerAddress);
  const allowanceBefore: bigint = await usdc.allowance(signerAddress, opts.stable);

  // ── Pre-flight invariants ────────────────────────────────────────────
  if (ownerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddress} is not the MuHavenStable owner (${ownerAddress}). ` +
        `setUsdcReserveToken + fundUsdcReserve are onlyOwner — rotate signer.`,
    );
  }
  if (usdcDecimals !== 6) {
    throw new Error(
      `USDC token at ${opts.usdc} reports decimals=${usdcDecimals}, expected 6. ` +
        `mhUSDC↔USDC is 1:1 only at matching decimals — refusing to seed.`,
    );
  }

  const wantToken = opts.usdc.toLowerCase();
  const haveToken = reserveTokenBefore.toLowerCase();
  const noTokenSet = haveToken === ethers.ZeroAddress.toLowerCase();
  const tokenAtTarget = haveToken === wantToken;
  const tokenIsDifferent = !noTokenSet && !tokenAtTarget;

  if (tokenIsDifferent && !opts.allowRotate) {
    throw new Error(
      `MuHavenStable.usdc() is already set to ${reserveTokenBefore}, ` +
        `which differs from the target ${opts.usdc}. Rotating a configured reserve ` +
        `with pending claims is an owner footgun (claims are implicitly 1:1 in the ` +
        `token they were created against). Pass ALLOW_ROTATE=${ALLOW_ROTATE_SENTINEL} ` +
        `only after confirming no claims are pending and the prior reserve is drained.`,
    );
  }

  // Rotation-and-prior-reserve-is-non-zero refusal (H-A review). If the
  // operator rotates while the OLD reserve token still holds USDC in the
  // wrapper, that USDC is silently abandoned: `usdcReserveBalance()` flips
  // to read the new token's balance (likely 0), and the old token's
  // balance is unrecoverable except via a *pre-rotation* withdrawUsdcReserve.
  // Always refuse — there is no legitimate reason to skip a recover-first
  // step, and ALLOW_ROTATE is an operator gate, not a "yolo" flag.
  if (tokenIsDifferent && opts.allowRotate && reserveBalanceBefore > 0n) {
    throw new Error(
      `Refusing to rotate the reserve token while the current reserve holds ` +
        `${fmtUsd(reserveBalanceBefore)} (${reserveBalanceBefore} base-6). ` +
        `That balance becomes unrecoverable after rotation (usdcReserveBalance ` +
        `re-points at the new token's balance). Drain the current reserve via ` +
        `withdrawUsdcReserve FIRST, then re-run the seed script with ` +
        `ALLOW_ROTATE=${ALLOW_ROTATE_SENTINEL}.`,
    );
  }

  if (claimsPaused) {
    console.log(
      `   ℹ claimsPaused() == true — settlement is currently halted. The seed itself is ` +
        `unaffected, but no claimUsdc will settle until the owner calls setClaimsPaused(false).`,
    );
  }

  console.log(`Owner         : ${ownerAddress}`);
  console.log(`Signer        : ${signerAddress}  (== owner ✓)`);
  console.log(
    `Reserve token : ${reserveTokenBefore}${
      noTokenSet ? "  (UNSET — will configure)" : tokenAtTarget ? "  (== target ✓)" : "  (DIFFERENT — rotation gated)"
    }`,
  );
  console.log(`Target token  : ${opts.usdc}`);
  console.log(
    `Reserve balance: ${reserveBalanceBefore} base-6 (= ${fmtUsd(reserveBalanceBefore)})`,
  );
  console.log(
    `Signer USDC   : ${signerUsdcBefore} base-6 (= ${fmtUsd(signerUsdcBefore)})  · allowance ${allowanceBefore}`,
  );
  console.log(`Seed amount   : ${opts.seedAmount} base-6 (= ${fmtUsd(opts.seedAmount)})`);
  console.log(`Mode          : ${opts.verifyOnly ? "VERIFY-ONLY (no broadcast)" : "WRITE"}`);
  console.log();

  if (opts.verifyOnly) {
    console.log("VERIFY-ONLY — done. No transactions broadcast.");
    return {
      ownerAddress,
      signerAddress,
      reserveTokenBefore,
      reserveTokenAfter: reserveTokenBefore,
      reserveBalanceBefore,
      reserveBalanceAfter: reserveBalanceBefore,
      signerUsdcBefore,
      signerUsdcAfter: signerUsdcBefore,
      seedAmount: opts.seedAmount,
      seeded: false,
      rotated: false,
      set: false,
      claimsPaused,
    };
  }

  // ── Step 1: configure the reserve token if needed ───────────────────
  let set = false;
  let rotated = false;
  if (noTokenSet || (tokenIsDifferent && opts.allowRotate)) {
    rotated = tokenIsDifferent;
    console.log(
      `[1/2] setUsdcReserveToken(${opts.usdc})${rotated ? "  (ROTATION — ALLOW_ROTATE=1)" : ""} ...`,
    );
    const tx = await stable.setUsdcReserveToken(opts.usdc);
    const rc = await tx.wait();
    console.log(`      tx ${rc.hash} (block ${rc.blockNumber})`);
    const observed = await readReserveTokenWithRetry(stable, opts.usdc);
    if (observed !== wantToken) {
      // Canonicalised pair so the operator isn't comparing different casings —
      // `observed` is already lowercased by the helper; lowercase `opts.usdc`
      // here so the human-readable diff is apples-to-apples. (H2 review note.)
      throw new Error(
        `Post-write reserve-token read-back is ${observed}, expected ${wantToken} after retries. ` +
          `The tx ${rc.hash} mined — re-run (idempotent) once the RPC catches up; if it persists, ` +
          `investigate the wrapper proxy.`,
      );
    }
    console.log(`      ✓ verified usdc() = ${opts.usdc}`);
    set = true;
  } else {
    console.log(`[1/2] reserve token already at target — skipped.`);
  }

  // ── Step 2: fund the reserve ────────────────────────────────────────
  let reserveBalanceAfter = reserveBalanceBefore;
  let signerUsdcAfter = signerUsdcBefore;
  let seeded = false;

  if (opts.seedAmount === 0n) {
    console.log(`[2/2] SEED_AMOUNT_USDC6=0 — skipping fund step.`);
  } else {
    if (signerUsdcBefore < opts.seedAmount) {
      throw new Error(
        `Signer USDC balance ${fmtUsd(signerUsdcBefore)} < seed ${fmtUsd(opts.seedAmount)}. ` +
          `Top up the signer (e.g. https://faucet.circle.com on Arb Sepolia) before retrying.`,
      );
    }

    if (allowanceBefore < opts.seedAmount) {
      // USDT-safe approve sequence (S-1 review): a handful of widely-used
      // 6-dp stablecoins (USDT being the prototype) revert when `approve`
      // is called from a non-zero allowance to another non-zero value. The
      // canonical Circle USDC handles this fine — but `USDC_ADDRESS` is
      // operator-overridable, so the safe path is to zero a pre-existing
      // non-zero allowance first, then approve the target. One extra tx in
      // the rare partial-allowance case; eliminates the footgun on overrides.
      if (allowanceBefore > 0n) {
        console.log(
          `[2a-pre] approve(${opts.stable}, 0) — zeroing existing allowance ${allowanceBefore} ` +
            `for USDT-style non-zero-to-non-zero safety ...`,
        );
        const zeroTx = await usdc.approve(opts.stable, 0n);
        const zeroRc = await zeroTx.wait();
        console.log(`      tx ${zeroRc.hash} (block ${zeroRc.blockNumber})`);
      }
      console.log(
        `[2a] approve(${opts.stable}, ${opts.seedAmount}) — current allowance ${allowanceBefore} insufficient ...`,
      );
      const apTx = await usdc.approve(opts.stable, opts.seedAmount);
      const apRc = await apTx.wait();
      console.log(`      tx ${apRc.hash} (block ${apRc.blockNumber})`);
    } else {
      console.log(`[2a] approve skipped — existing allowance ${allowanceBefore} ≥ ${opts.seedAmount}.`);
    }

    console.log(`[2b] fundUsdcReserve(${opts.seedAmount}) ...`);
    const fundTx = await stable.fundUsdcReserve(opts.seedAmount);
    const fundRc = await fundTx.wait();
    console.log(`      tx ${fundRc.hash} (block ${fundRc.blockNumber})`);

    // Authoritative seed-landed assertion: parse the wrapper's own
    // `UsdcReserveFunded(from, amount)` event from this tx's receipt. This is
    // collision-proof against concurrent `claimUsdc` settles and
    // `withdrawUsdcReserve` recovers that would corrupt a post-balance
    // "exact delta" check. (H1 review note: `usdcReserveBalance()` is just
    // the live `IERC20.balanceOf(this)` — anyone can push it up via a stray
    // ERC-20 transfer, and `claimUsdc` pulls it down, so the live read can
    // legitimately differ from `before + seedAmount` without the fund tx
    // misbehaving.)
    const fundIface = new ethers.Interface([
      "event UsdcReserveFunded(address indexed from, uint256 amount)",
    ]);
    let landedAmount: bigint | null = null;
    for (const log of fundRc.logs ?? []) {
      try {
        const parsed = fundIface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed && parsed.name === "UsdcReserveFunded") {
          landedAmount = BigInt(parsed.args[1]);
          break;
        }
      } catch {
        /* not ours */
      }
    }
    if (landedAmount === null) {
      throw new Error(
        `fundUsdcReserve tx ${fundRc.hash} mined but emitted no UsdcReserveFunded event — ` +
          `the wrapper proxy may be on the wrong implementation. Investigate before proceeding.`,
      );
    }
    if (landedAmount !== opts.seedAmount) {
      throw new Error(
        `UsdcReserveFunded.amount = ${landedAmount}, expected ${opts.seedAmount}. ` +
          `Inconsistent with the called arg — investigate (the wrapper currently records the ` +
          `arg verbatim, so any divergence indicates a contract bug or wrong ABI).`,
      );
    }

    // Informational read-back of the live reserve + signer balance. Note this
    // can drift from `before + seed`: a concurrent claimUsdc settle (drains
    // reserve) or a stray ERC-20 transfer to the wrapper (raises it) is a
    // valid on-chain state — NOT a fund-tx failure. We surface the divergence
    // as a NOTE so the operator can investigate if it's surprising.
    reserveBalanceAfter = BigInt(await stable.usdcReserveBalance());
    signerUsdcAfter = BigInt(await usdc.balanceOf(signerAddress));
    const expectedAfter = reserveBalanceBefore + opts.seedAmount;
    const reserveDelta = reserveBalanceAfter - reserveBalanceBefore;
    const signerDelta = signerUsdcAfter - signerUsdcBefore;
    console.log(
      `      reserve balance: ${reserveBalanceBefore} → ${reserveBalanceAfter} (Δ ${reserveDelta >= 0n ? "+" : ""}${reserveDelta})`,
    );
    console.log(
      `      signer USDC   : ${signerUsdcBefore} → ${signerUsdcAfter} (Δ ${signerDelta >= 0n ? "+" : ""}${signerDelta})`,
    );
    console.log(
      `      ✓ UsdcReserveFunded.amount = ${landedAmount} (matches the seed)`,
    );
    if (reserveBalanceAfter !== expectedAfter) {
      // Distinguish minor drift (likely 1-wei donation griefing — an attacker
      // can push a stray ERC-20 transfer for the cost of one tx, training
      // operators to ignore the divergence note) from larger drift that
      // genuinely warrants triage (security review M-S2).
      const drift = reserveBalanceAfter - expectedAfter;
      const driftAbs = drift < 0n ? -drift : drift;
      if (driftAbs < DRIFT_NOTE_THRESHOLD) {
        console.log(
          `      ℹ NOTE: minor reserve drift ${drift >= 0n ? "+" : ""}${drift} ` +
            `(< ${DRIFT_NOTE_THRESHOLD} base-6 / $0.10). Likely cause: a stray ERC-20 ` +
            `donation. Fund tx itself landed correctly (UsdcReserveFunded above).`,
        );
      } else {
        console.log(
          `      ⚠ WARN: reserve drift ${drift >= 0n ? "+" : ""}${drift} ` +
            `exceeds ${DRIFT_NOTE_THRESHOLD} base-6 / $0.10. Likely cause: a concurrent ` +
            `claimUsdc settle (drain) or a substantial donation. Re-run with VERIFY_ONLY=1 ` +
            `to confirm the new state matches expectations. The fund tx itself landed ` +
            `correctly (UsdcReserveFunded above).`,
        );
      }
    }
    seeded = true;
  }

  return {
    ownerAddress,
    signerAddress,
    reserveTokenBefore,
    reserveTokenAfter: opts.usdc,
    reserveBalanceBefore,
    reserveBalanceAfter,
    signerUsdcBefore,
    signerUsdcAfter,
    seedAmount: opts.seedAmount,
    seeded,
    rotated,
    set,
    claimsPaused,
  };
}

async function main() {
  // ── Env resolution (explicit, no default) ────────────────────────────
  const rawEnv = process.env.MUHAVEN_ENV;
  if (!rawEnv || rawEnv.trim() === "") {
    throw new Error(
      `MUHAVEN_ENV is required (must be "prod", "staging", or "local"). ` +
        `No default — set it explicitly so envs can never be confused.`,
    );
  }
  const env = rawEnv.toLowerCase();
  if (env !== "prod" && env !== "staging" && env !== "local") {
    throw new Error(`MUHAVEN_ENV must be "prod", "staging", or "local"; got "${rawEnv}"`);
  }

  // Seed amount: default $500 base-6; "0" means "skip the fund step".
  // Tolerate `_` separators (e.g. `500_000_000`) so an operator pasting the
  // JS-literal style from the runbook table doesn't trip the validator (H4
  // review note). Decimals + scientific notation + hex are still rejected.
  const rawSeed = process.env.SEED_AMOUNT_USDC6;
  let seedAmount: bigint;
  if (rawSeed === undefined || rawSeed === "") {
    seedAmount = DEFAULT_SEED_USDC6;
  } else {
    const normalised = rawSeed.replace(/_/g, "");
    if (normalised === "0") {
      seedAmount = 0n;
    } else if (/^[1-9]\d*$/.test(normalised)) {
      seedAmount = BigInt(normalised);
    } else {
      throw new Error(
        `SEED_AMOUNT_USDC6 must be a non-negative integer in mhUSDC/USDC base-6 (got "${rawSeed}"). ` +
          `No decimals, hex, or scientific notation; underscores allowed (e.g. 500_000_000 for $500). ` +
          `Use 0 to skip the fund step.`,
      );
    }
  }

  const verifyOnly =
    /^(1|true|yes)$/i.test(process.env.VERIFY_ONLY ?? "") ||
    /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");

  // ALLOW_ROTATE now requires a literal sentinel string (security review
  // L-S2 — `1`/`true`/`yes` is too easy to copy-paste-without-thinking).
  // Any non-empty value other than the sentinel is an error so old shorthand
  // doesn't silently fail open.
  const rawAllowRotate = process.env.ALLOW_ROTATE?.trim();
  let allowRotate = false;
  if (rawAllowRotate) {
    if (rawAllowRotate === ALLOW_ROTATE_SENTINEL) {
      allowRotate = true;
    } else {
      throw new Error(
        `ALLOW_ROTATE must be exactly the sentinel "${ALLOW_ROTATE_SENTINEL}" ` +
          `(got "${safeLog(rawAllowRotate)}"). The long literal is a deliberate ` +
          `friction point — see the runbook §"Rotation" before passing it.`,
      );
    }
  }

  const allowNonCanonicalUsdc = /^(1|true|yes)$/i.test(
    process.env.ALLOW_NON_CANONICAL_USDC ?? "",
  );

  // ── Resolve deployment + addresses ───────────────────────────────────
  const path = deploymentPath(env);
  if (!existsSync(path)) {
    throw new Error(
      `Deployment file not found: ${path}. Deploy the platform first ` +
        `(pnpm run deploy:v2:testnet[:stage]) or, for local, run the verify harness.`,
    );
  }
  const deployment = JSON.parse(readFileSync(path, "utf-8"));

  const stableAddr: string = deployment.contracts?.MuHavenStable?.proxy;
  if (!stableAddr || stableAddr === ethers.ZeroAddress) {
    throw new Error(`MuHavenStable proxy not configured in ${path}.`);
  }

  // USDC: env override > deployments[external.usdc] > Arb Sepolia default.
  // The default is intentional (we currently only target Arb Sepolia); on
  // local the verify harness writes external.usdc into the temp deploy file.
  // The resolution source is logged below so the operator can spot a stale
  // `deployment.external.usdc` silently winning over the expected default
  // (H3 review note).
  const envUsdc = process.env.USDC_ADDRESS?.trim();
  const deployUsdc = deployment.external?.usdc as string | undefined;
  let usdcAddr: string;
  let usdcSource: string;
  if (envUsdc) {
    usdcAddr = envUsdc;
    usdcSource = "USDC_ADDRESS env override";
  } else if (deployUsdc) {
    usdcAddr = deployUsdc;
    usdcSource = `${path} → external.usdc`;
  } else {
    usdcAddr = DEFAULT_USDC_ARB_SEPOLIA;
    usdcSource = "DEFAULT_USDC_ARB_SEPOLIA (Circle testnet USDC)";
  }
  if (!ethers.isAddress(usdcAddr) || usdcAddr === ethers.ZeroAddress) {
    throw new Error(
      `Invalid USDC reserve token address "${safeLog(usdcAddr)}" (resolved from ${usdcSource}). ` +
        `Set USDC_ADDRESS, or add external.usdc to ${path}.`,
    );
  }

  // Canonical-USDC allowlist gate (security review H-S1). Skip for local
  // (the verify harness deploys an ephemeral MockUSDC each run). On
  // prod/staging, refuse a `USDC_ADDRESS` (or `deployment.external.usdc`)
  // that differs from the canonical Circle USDC for this chain unless the
  // operator explicitly opts in via ALLOW_NON_CANONICAL_USDC=1. The contract
  // can't enforce this — rotation must remain flexible — so the script is
  // the right place for the gate.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const canonicalUsdc = CANONICAL_USDC_BY_CHAIN[chainId];
  if (env !== "local" && canonicalUsdc) {
    if (usdcAddr.toLowerCase() !== canonicalUsdc.toLowerCase() && !allowNonCanonicalUsdc) {
      throw new Error(
        `USDC reserve token ${usdcAddr} (resolved from ${usdcSource}) is NOT the ` +
          `canonical Circle USDC for chainId ${chainId} (expected ${canonicalUsdc}). ` +
          `If this is a deliberate non-Circle USDC, set ALLOW_NON_CANONICAL_USDC=1 ` +
          `after triple-checking the address. Misconfiguring this routes future ` +
          `claimUsdc payouts through that token — user-funds-at-risk.`,
      );
    }
  }

  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();

  // ETH-balance pre-flight (S-4 review). Three sequential owner-txs; a
  // gas-starved signer leaves the script mid-flight (idempotent, but
  // confusing for an operator triaging). Skip for local (auto-funded).
  if (env !== "local") {
    const ethBalance = await ethers.provider.getBalance(signerAddress);
    if (ethBalance < MIN_SIGNER_ETH_WEI) {
      throw new Error(
        `Signer ${signerAddress} has ${ethBalance} wei ETH (< ${MIN_SIGNER_ETH_WEI} = 0.001 ETH). ` +
          `Top up before re-running — the script broadcasts up to 3 owner-txs and can ` +
          `partially complete if gas runs out mid-flight.`,
      );
    }
  }

  console.log(`── MuHavenStable USDC reserve seed (Wave 5 W3) ──────────`);
  console.log(`Network       : ${safeLog(network.name)}  (chainId ${chainId})`);
  console.log(`Env           : ${env}`);
  console.log(`MuHavenStable : ${stableAddr}`);
  // Deployment-file integrity hint (I-S1 review). The on-chain owner read
  // happens inside `seedStableUsdcReserve`; here we surface the deployment
  // file's metadata so an operator can spot a stale local checkout
  // ("deployer" + "timestamp" should match operator expectations) before any
  // tx fires.
  if (deployment.deployer) {
    console.log(`Deploy meta   : deployer=${deployment.deployer}  written=${deployment.timestamp ?? "(no timestamp)"}`);
  }
  console.log(`USDC token    : ${safeLog(usdcAddr)}`);
  console.log(`  source      : ${safeLog(usdcSource)}`);
  if (allowRotate) console.log(`ALLOW_ROTATE  : enabled — rotation of a different reserve token will proceed.`);
  if (allowNonCanonicalUsdc) {
    console.log(`ALLOW_NON_CANONICAL_USDC : enabled — non-Circle USDC accepted.`);
  }
  console.log();

  // Confirmation prompt for any non-verify-only run (M-S1 review). Verify-
  // only never broadcasts → no prompt needed.
  if (!verifyOnly) {
    const summary =
      `Network         : ${safeLog(network.name)} (chainId ${chainId})\n` +
      `Env             : ${env}\n` +
      `MuHavenStable   : ${stableAddr}\n` +
      `USDC reserve    : ${safeLog(usdcAddr)}  (${safeLog(usdcSource)})\n` +
      `Signer          : ${signerAddress}\n` +
      `Seed amount     : ${seedAmount} base-6 (= ${fmtUsd(seedAmount)})${seedAmount === 0n ? " — fund step will be SKIPPED" : ""}\n` +
      `ALLOW_ROTATE    : ${allowRotate ? "ENABLED (rotation may proceed)" : "off"}\n` +
      `ALLOW_NON_CANONICAL_USDC : ${allowNonCanonicalUsdc ? "ENABLED (non-Circle USDC accepted)" : "off"}\n` +
      `Up to 3 owner-only txs may broadcast (setUsdcReserveToken / approve / fundUsdcReserve).`;
    await confirmBroadcast(summary);
  }

  const result = await seedStableUsdcReserve({
    stable: stableAddr,
    usdc: usdcAddr,
    seedAmount,
    signer,
    verifyOnly,
    allowRotate,
  });

  console.log();
  console.log("─".repeat(72));
  console.log(
    verifyOnly
      ? `VERIFY-ONLY complete. Reserve token = ${result.reserveTokenAfter}; balance = ${fmtUsd(result.reserveBalanceAfter)}.`
      : `Done.  set=${result.set}  rotated=${result.rotated}  seeded=${result.seeded}  ` +
          `reserve=${fmtUsd(result.reserveBalanceAfter)}`,
  );
  console.log("─".repeat(72));

  if (!verifyOnly && result.seeded) {
    console.log(
      `\nReminder: the reserve is a ONE-WAY DRAIN. Re-run this script to top up. ` +
        `Recover surplus via the owner's withdrawUsdcReserve(to, amount).`,
    );
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
