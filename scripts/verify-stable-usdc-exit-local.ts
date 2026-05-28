/**
 * scripts/verify-stable-usdc-exit-local.ts
 *
 * Local hardhat-network end-to-end smoke for Wave 5 W3 (direct mhUSDC → USDC
 * exit). Phase-4 deliverable per `development/DEV_WAVE_5/W3_DIRECT_USDC_EXIT_PLAN.md`:
 *
 *   "Verify the upgrade + reserve flow on the hardhat network."
 *
 * What it covers
 * ──────────────
 * The 22-case contract suite (`test/MuHavenStableDirectUsdc.test.ts`) already
 * proves the contract logic. This script complements it by exercising the
 * exact OPERATOR FLOW that the prod runbook prescribes — using the real
 * `seedStableUsdcReserve` from `scripts/seed-stable-usdc-reserve.ts` against
 * a freshly-deployed `MuHavenStable` proxy, then driving a full
 * `withdrawToUsdc → claimUsdc` round-trip and asserting on USDC ledger
 * movement. If this script passes, the seed script + claim flow are wired
 * correctly together.
 *
 * Flow
 * ────
 *   1. Deploy MockPUSDC, MuHavenStable (transparent proxy w/ W3 impl), MockUSDC.
 *   2. Mint legacy PUSDC to "alice"; alice approves the stable as operator;
 *      alice `stable.wrap(...)` → holds mhUSDC.
 *   3. Mint USDC to the deployer/owner.
 *   4. Call `seedStableUsdcReserve({ verifyOnly:true })` — assert reserve unset.
 *   5. Call `seedStableUsdcReserve({ verifyOnly:false, seedAmount:$500 })` —
 *      configures the reserve token + funds it.
 *   6. Alice calls `withdrawToUsdc(req)` (clamp-to-balance) → claimId emitted.
 *   7. Advance time past the mock decrypt delay (`waitForDecrypt`).
 *   8. Alice calls `claimUsdc(claimId)` → asserts USDC moved 1:1, mhUSDC dropped,
 *      reserve drained, claim list pruned.
 *   9. (Idempotency) re-call the seed script → confirms it's a no-op on the
 *      already-configured token + adds a top-up.
 *
 * Usage
 * ─────
 *   pnpm hardhat run scripts/verify-stable-usdc-exit-local.ts --network hardhat
 *
 * The script is in-process: it deploys, exercises, asserts, and returns. No
 * deployment file is written or required (the seed script's main() requires
 * one — we bypass it by calling `seedStableUsdcReserve` directly).
 *
 * Exit code 0 ⇒ end-to-end passed. Any thrown assertion exits 1.
 */

import hre from "hardhat";
import { upgrades, ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { seedStableUsdcReserve } from "./seed-stable-usdc-reserve";

const ONE_USDC = 1_000_000n; // 6-dp, shared by mhUSDC + USDC
const FOREVER = 2n ** 47n - 1n;
const SEED_AMOUNT = 500n * ONE_USDC; // $500 — matches prod-runbook default
const DEPLOYER_USDC_MINT = SEED_AMOUNT * 2n; // 2× seed so step 9 can re-fund
const TOP_UP_AMOUNT = 100n * ONE_USDC; // step-9 idempotent top-up
const ALICE_WRAP_AMOUNT = 120n * ONE_USDC; // $120 mhUSDC float for alice
const WITHDRAW_AMOUNT = 80n * ONE_USDC; // $80 withdrawal (well under balance)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function assertEq(actual: bigint, expected: bigint, label: string) {
  if (actual !== expected) {
    throw new Error(`ASSERT: ${label}: expected ${expected}, got ${actual}`);
  }
}

async function encUint64(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

async function main() {
  console.log("╭─ Wave 5 W3 — local end-to-end verify (Phase 4) ──────────────────────");

  // Sanity-gate: this script intentionally only runs on the hardhat in-process
  // network (cofhe MOCK env). Refuse anything else so an operator who picks
  // the wrong --network can't accidentally broadcast.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) {
    throw new Error(
      `Refusing to run: chainId=${chainId}, expected 31337 (hardhat in-process). ` +
        `Use --network hardhat.`,
    );
  }

  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, alice] = await ethers.getSigners();
  console.log(`│ deployer (owner) = ${deployer.address}`);
  console.log(`│ alice  (investor) = ${alice.address}`);

  // ── 1. Deploy stack ──────────────────────────────────────────────────
  console.log("├─ [1/9] deploying MockPUSDC + MuHavenStable proxy + MockUSDC ...");
  const Pusdc = await ethers.getContractFactory("MockPUSDC");
  const pusdc = await Pusdc.deploy();
  await pusdc.waitForDeployment();

  const Stable = await ethers.getContractFactory("MuHavenStable");
  const stable = await upgrades.deployProxy(
    Stable,
    ["MuHaven Confidential USD", "mhUSDC", deployer.address, await pusdc.getAddress()],
    { kind: "transparent", initializer: "initialize" },
  );
  await stable.waitForDeployment();
  const stableAddr = await stable.getAddress();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log(`│   pusdc=${await pusdc.getAddress()}`);
  console.log(`│   stable=${stableAddr}`);
  console.log(`│   usdc=${usdcAddr}`);

  // ── 2. Seed alice with mhUSDC ─────────────────────────────────────────
  console.log("├─ [2/9] funding alice with mhUSDC via legacy-PUSDC wrap ...");
  await (await pusdc.mint(alice.address, ALICE_WRAP_AMOUNT)).wait();
  await (await pusdc.connect(alice).setOperator(stableAddr, FOREVER)).wait();
  const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
  const aliceEph = ethers.Wallet.createRandom().address;
  const encWrap = await encUint64(aliceClient, ALICE_WRAP_AMOUNT);
  await (await stable.connect(alice).wrap(encWrap, aliceEph)).wait();
  await hre.cofhe.mocks.expectPlaintext(
    await stable.confidentialBalanceOf(alice.address),
    ALICE_WRAP_AMOUNT,
  );
  console.log(`│   alice mhUSDC = $${Number(ALICE_WRAP_AMOUNT) / 1e6}`);

  // ── 3. Mint USDC to deployer (the "owner-funded" reserve story) ──────
  console.log("├─ [3/9] minting USDC to deployer (owner) for reserve seeding ...");
  // 2 × seed so step 9 can re-fund and exercise idempotency w/ top-up.
  await (await usdc.mint(deployer.address, DEPLOYER_USDC_MINT)).wait();
  assertEq(BigInt(await usdc.balanceOf(deployer.address)), DEPLOYER_USDC_MINT, "deployer USDC after mint");

  // ── 4. seed VERIFY_ONLY (reserve unset) ──────────────────────────────
  console.log("├─ [4/9] seedStableUsdcReserve verifyOnly=true (reserve UNSET) ...");
  const verifyResult = await seedStableUsdcReserve({
    stable: stableAddr,
    usdc: usdcAddr,
    seedAmount: SEED_AMOUNT,
    signer: deployer,
    verifyOnly: true,
    allowRotate: false,
  });
  assert(!verifyResult.set && !verifyResult.seeded, "verifyOnly should not mutate");
  assertEq(verifyResult.reserveBalanceBefore, 0n, "reserve balance before");
  assert(
    verifyResult.reserveTokenBefore.toLowerCase() === ethers.ZeroAddress.toLowerCase(),
    "reserve token should be unset",
  );

  // ── 5. seed for real (set token + fund) ──────────────────────────────
  console.log("├─ [5/9] seedStableUsdcReserve verifyOnly=false (set + fund $500) ...");
  const seedResult = await seedStableUsdcReserve({
    stable: stableAddr,
    usdc: usdcAddr,
    seedAmount: SEED_AMOUNT,
    signer: deployer,
    verifyOnly: false,
    allowRotate: false,
  });
  assert(seedResult.set, "set should be true on first seed");
  assert(seedResult.seeded, "seeded should be true");
  assert(!seedResult.rotated, "rotated should be false (first-time set)");
  assertEq(seedResult.reserveBalanceAfter, SEED_AMOUNT, "reserve balance after seed");
  assertEq(
    seedResult.signerUsdcAfter,
    DEPLOYER_USDC_MINT - SEED_AMOUNT,
    "deployer USDC after seed (=mint - seed)",
  );
  assertEq(BigInt(await stable.usdcReserveBalance()), SEED_AMOUNT, "wrapper.usdcReserveBalance");
  assert(
    ((await stable.usdc()) as string).toLowerCase() === usdcAddr.toLowerCase(),
    "wrapper.usdc() should be the configured reserve token",
  );

  // ── 6. alice requests withdrawal ─────────────────────────────────────
  console.log("├─ [6/9] alice withdrawToUsdc($80) → claimId emitted ...");
  const encWithdraw = await encUint64(aliceClient, WITHDRAW_AMOUNT);
  const wTx = await stable.connect(alice).withdrawToUsdc(encWithdraw, aliceEph);
  const wRc = await wTx.wait();
  let claimId: bigint | null = null;
  for (const log of wRc.logs) {
    try {
      const parsed = stable.interface.parseLog({ topics: log.topics, data: log.data });
      // Named-arg access (S-5 review): index-based access (`args[2]`) silently
      // pulls the wrong field if the event signature is ever reordered.
      // `parsed.args.claimId` is regression-proof against ABI changes.
      if (parsed && parsed.name === "WithdrawRequested") {
        claimId = parsed.args.claimId as bigint;
        break;
      }
    } catch {
      /* not ours */
    }
  }
  assert(claimId !== null, "WithdrawRequested event must be emitted");
  assertEq(claimId, 1n, "first claim should be monotonic id 1");

  // mhUSDC should have decremented immediately (burn on the request leg).
  await hre.cofhe.mocks.expectPlaintext(
    await stable.confidentialBalanceOf(alice.address),
    ALICE_WRAP_AMOUNT - WITHDRAW_AMOUNT,
  );

  // The user claim list should now hold exactly the new id.
  const pendingBefore = (await stable.getUserWithdrawClaims(alice.address)) as bigint[];
  assert(pendingBefore.length === 1 && pendingBefore[0] === claimId!, "pending list should contain claim 1");

  // Decrypt should not be ready yet.
  const [, ready0] = await stable.withdrawDecryptResult(claimId!);
  assert(!ready0, "decrypt should not be ready before time-warp");

  // ── 7. wait for the mock decrypt to land ─────────────────────────────
  console.log("├─ [7/9] waitForDecrypt (advance block-time past mock decrypt delay) ...");
  await time.increase(11);
  const [decryptedAmt, ready1] = await stable.withdrawDecryptResult(claimId!);
  assert(ready1, "decrypt should be ready after time-warp");
  assertEq(BigInt(decryptedAmt), WITHDRAW_AMOUNT, "decrypted amount should equal request");

  // ── 8. claim → USDC moves 1:1 ────────────────────────────────────────
  console.log("├─ [8/9] alice claimUsdc(1) → 1:1 USDC payout ...");
  const aliceUsdcBefore = BigInt(await usdc.balanceOf(alice.address));
  const reserveBefore = BigInt(await stable.usdcReserveBalance());
  await (await stable.connect(alice).claimUsdc(claimId!)).wait();

  const aliceUsdcAfter = BigInt(await usdc.balanceOf(alice.address));
  const reserveAfter = BigInt(await stable.usdcReserveBalance());
  assertEq(aliceUsdcAfter - aliceUsdcBefore, WITHDRAW_AMOUNT, "alice USDC delta should equal withdraw");
  assertEq(reserveBefore - reserveAfter, WITHDRAW_AMOUNT, "reserve drain should equal withdraw");

  const claimRecord = await stable.getWithdrawClaim(claimId!);
  assert(claimRecord.claimed, "claim record .claimed should flip true");
  assertEq(BigInt(claimRecord.amount), WITHDRAW_AMOUNT, "claim record .amount should equal withdrawn");

  const pendingAfter = (await stable.getUserWithdrawClaims(alice.address)) as bigint[];
  assert(pendingAfter.length === 0, "pending list should be empty after settle");

  // Double-claim should revert with WithdrawClaimAlreadyClaimed specifically
  // (a catch-all `catch` would mask wrong-method-name regressions like
  // "claimUsdc" being renamed — M1 review note). Use the contract's own
  // `Interface.parseError` rather than a hand-rolled error-data field-walk
  // (S-2 review): ethers v6 surfaces revert data at multiple paths
  // (`e.data`, `e.revert?.data`, `e.info?.error?.data`, ...) and a fixed
  // null-coalescing chain can silently false-positive if data lives in a
  // path it doesn't probe. `parseError` walks the standard ethers v6 paths
  // internally and either returns the parsed error or throws — both signals
  // are explicit.
  let doubleClaimErrorName: string | null = null;
  let doubleClaimErrorData: string | null = null;
  try {
    await stable.connect(alice).claimUsdc(claimId!);
  } catch (e: any) {
    // Ethers v6: collect every plausible location for revert data, then ask
    // the contract's interface to parse it. The redundant lookups + try
    // chain mean we surface "no data found" loudly rather than silently
    // matching the wrong selector.
    const candidates: string[] = [];
    for (const v of [e?.data, e?.revert?.data, e?.info?.error?.data, e?.error?.data]) {
      if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) candidates.push(v);
    }
    for (const data of candidates) {
      try {
        const parsed = stable.interface.parseError(data);
        if (parsed) {
          doubleClaimErrorName = parsed.name;
          doubleClaimErrorData = data;
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
  }
  assert(
    doubleClaimErrorName === "WithdrawClaimAlreadyClaimed",
    `second claimUsdc on the same claimId must revert WithdrawClaimAlreadyClaimed; ` +
      `got name="${doubleClaimErrorName}" data=${doubleClaimErrorData}`,
  );

  // ── 9. idempotent re-seed (top-up flow) ──────────────────────────────
  console.log("├─ [9/9] seedStableUsdcReserve (top-up) — idempotent on token, additive on amount ...");
  const topUpResult = await seedStableUsdcReserve({
    stable: stableAddr,
    usdc: usdcAddr,
    seedAmount: TOP_UP_AMOUNT,
    signer: deployer,
    verifyOnly: false,
    allowRotate: false,
  });
  assert(!topUpResult.set, "set should be false on re-seed (token already configured)");
  assert(!topUpResult.rotated, "rotated should be false (same target)");
  assert(topUpResult.seeded, "top-up should fund the reserve");
  assertEq(
    topUpResult.reserveBalanceAfter,
    reserveAfter + TOP_UP_AMOUNT,
    "reserve should grow by top-up amount",
  );

  console.log(
    `╰─ ✅ end-to-end PASSED — withdrew $${Number(WITHDRAW_AMOUNT) / 1e6} mhUSDC → ` +
      `$${Number(WITHDRAW_AMOUNT) / 1e6} USDC paid from the seeded reserve.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
