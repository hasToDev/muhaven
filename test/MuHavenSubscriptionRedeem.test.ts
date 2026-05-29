/**
 * MuHavenSubscription.redeem unit tests.
 *
 * Phase 2 sub-phase 8 (`WAVE_3_5_REVISED.md`): ~15 tests for the atomic
 * instant-redeem path — KYC gate → oracle read → silent-fail hint →
 * cleartext cap accounting → burn via `MuHavenToken.burnFromSubscription` →
 * mirrored proceeds compute → PUSDC pull from treasury → ephemeralEOA grant
 * on the user's updated balance handle.
 *
 * Touch-points:
 *   - ADR-001 (atomic purchase/redeem via MuHavenSubscription)
 *   - ADR-004 (hybrid redemption: instant up to cap + queue overflow; cap
 *     consumes against `maxSharesHint * nav` cleartext)
 *   - ADR-008 (PUSDC legacy `euint64 = uint256` selector via low-level call)
 *   - ADR-021 (`ephemeralEOA` as trailing param)
 *   - ADR-024 (`TokenRegistry` separate contract)
 *   - ADR-025 (cleartext `minInvestment` floor on `maxSharesHint`)
 *   - `FHE_ACL_CONVENTIONS.md` rules 1–5 (silent-fail + ACL)
 *
 * Cap-exceeded behaviour is silent-escalate per ADR-004; Phase 4 will wire
 * the actual queue submission in-contract. These tests assert the Phase 2
 * placeholder semantics: `Redeemed(escalated=true)` event + no state change.
 *
 * Kernel/UserOp flow is covered by SDK integration + Playwright per M1.
 * These tests use EOA stand-ins for investor + issuer.
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import {
  deployKYCAdapter,
  deployRegistry,
  deployToken,
  deployMockPUSDC,
  ZERO_ADDRESS,
} from "./helpers/setup";
import {
  createEphemeralEOA,
  deployMockPriceOracle,
} from "./helpers/fixturesV2";

/** PUSDC has 6 decimals (matches mainnet USDC). */
const ONE_PUSDC = 1_000_000n;

/** Hint-space ceiling chosen to comfortably exceed any test purchase. */
const HINT_CAP = 1_000_000n;

/** NAV convention per `MockPriceOracle` — PUSDC base units per share unit. */
const DEFAULT_NAV = ONE_PUSDC;

/** Test epoch duration (1 hour). */
const EPOCH_DURATION = 60 * 60;

/**
 * Generous cap for instant redeem tests, in PUSDC base units. The cap is
 * consumed against `maxSharesHint * nav`; with `HINT_CAP = 1_000_000` and
 * `DEFAULT_NAV = ONE_PUSDC`, each redeem consumes 1M PUSDC of cap room.
 * 1B PUSDC ceiling is comfortably above any test that doesn't explicitly
 * tighten the cap to exercise the escalation path.
 */
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

/**
 * Full-stack fixture mirroring the purchase test fixture, but additionally
 * pre-seeds the investor with 100 shares of MuHavenToken (via a single
 * Subscription.purchase) and pre-seeds the treasury with 200 PUSDC so the
 * redeem path has both shares to burn and PUSDC to pay out. Returns every
 * helper a redeem test could want.
 *
 * After the seeding purchase, the investor's PUSDC balance is the residual
 * from minting (100 starting - 100 purchase = 0) plus a top-up (200 PUSDC).
 * Treasury holds the 100 PUSDC from the purchase plus a 100 PUSDC top-up.
 */
async function deployRedeemFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob, stranger] =
    await hre.ethers.getSigners();

  // KYC + registry + token
  const kyc = await deployKYCAdapter();
  await kyc.addToWhitelist(investor.address);
  await kyc.addToWhitelist(alice.address);
  await kyc.addToWhitelist(bob.address);

  const registry = await deployRegistry();

  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  // Mocks
  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

  // TokenRegistry
  const RegistryFactory = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    RegistryFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // MuHavenSubscription
  const SubFactory = await hre.ethers.getContractFactory("MuHavenSubscription");
  const subscription = await upgrades.deployProxy(
    SubFactory,
    [
      deployer.address,
      await tokenRegistry.getAddress(),
      await kyc.getAddress(),
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // RedemptionQueue (Phase 4) — initialised before Treasury so Treasury
  // can grant the queue PUSDC operator rights at init.
  const QueueFactory = await hre.ethers.getContractFactory("RedemptionQueue");
  const queue = await upgrades.deployProxy(
    QueueFactory,
    [
      deployer.address,
      await token.getAddress(),
      await tokenRegistry.getAddress(),
      await subscription.getAddress(),
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Treasury (per-token) — minFloat=0 so the redeem PUSDC pull leg has no
  // solvency reservation to dance around. Treasury solvency-floor behaviour
  // belongs in MuHavenTreasury tests.
  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      await queue.getAddress(),
      issuer.address,
      await pusdc.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Wire: register token in TokenRegistry
  await tokenRegistry.registerToken(await token.getAddress(), {
    active: true,
    treasury: await treasury.getAddress(),
    queue: await queue.getAddress(),
    oracle: await oracle.getAddress(),
    issuer: issuer.address,
    minInvestment: 0n,
    instantRedeemCap: INSTANT_CAP,
    epochDuration: EPOCH_DURATION,
    paused: false,
  });

  // Authorise subscription + queue on token.
  await token.setSubscription(await subscription.getAddress());
  await token.setQueue(await queue.getAddress());

  // Pin NAV fresh
  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(
    await token.getAddress(),
    DEFAULT_NAV,
    BigInt(now)
  );

  // Seed investor + grant subscription as PUSDC operator
  await pusdc.mint(investor.address, 100n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const eph = createEphemeralEOA();

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  // ── Seed 100 shares to investor via a real purchase ──
  const seedShares = 100n;
  const encSeed = await encUint128(investorClient, seedShares);
  await subscription
    .connect(investor)
    .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

  // Top up investor's PUSDC + treasury so we have headroom for asserting
  // movement. Treasury also needs the operator-granted balance, but
  // setOperator was called by the treasury in its initialise.
  await pusdc.mint(investor.address, 200n * ONE_PUSDC);
  await pusdc.mint(await treasury.getAddress(), 100n * ONE_PUSDC);

  return {
    deployer,
    issuer,
    investor,
    alice,
    bob,
    stranger,
    kyc,
    registry,
    token,
    tokenRegistry,
    treasury,
    queue,
    pusdc,
    oracle,
    subscription,
    investorClient,
    issuerClient,
    eph,
    seedShares,
  };
}

describe("MuHavenSubscription.redeem", () => {
  // ── happy paths ─────────────────────────────────────────────────────────

  describe("happy paths", () => {
    it("burns shares from investor, pays PUSDC out of treasury, emits Redeemed(escalated=false)", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
        seedShares,
      } = await loadFixture(deployRedeemFixture);

      // Redeem 30 of the 100 seed shares at NAV 1e6 → 30 PUSDC payout.
      const qty = 30n;
      const enc = await encUint128(investorClient, qty);

      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      )
        .to.emit(subscription, "Redeemed")
        .withArgs(await token.getAddress(), investor.address, HINT_CAP, false);

      // Shares balance reduced by qty.
      const balHandle = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balHandle, seedShares - qty);

      // Investor PUSDC: starting from the post-purchase residual + topup.
      // Pre-redeem: 0 (after purchase) + 200 topup = 200 PUSDC.
      // Post-redeem: 200 + qty * 1 = 230 PUSDC.
      const investorPUSDC = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(
        investorPUSDC,
        200n * ONE_PUSDC + qty * ONE_PUSDC
      );

      // Treasury: 100 (from purchase) + 100 (topup) - qty = 170 PUSDC.
      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(
        treasuryPUSDC,
        100n * ONE_PUSDC + 100n * ONE_PUSDC - qty * ONE_PUSDC
      );
    });

    it("supports a chain of redeems — share + PUSDC ledgers stay consistent", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
        seedShares,
      } = await loadFixture(deployRedeemFixture);

      let cumulative = 0n;
      for (const qty of [10n, 5n, 25n]) {
        const enc = await encUint128(investorClient, qty);
        await subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address);
        cumulative += qty;
      }

      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, seedShares - cumulative);

      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(
        treasuryPUSDC,
        100n * ONE_PUSDC + 100n * ONE_PUSDC - cumulative * ONE_PUSDC
      );
    });

    it("redeems exactly when encShares == maxSharesHint (boundary case)", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
        seedShares,
      } = await loadFixture(deployRedeemFixture);

      const qty = 7n;
      const enc = await encUint128(investorClient, qty);
      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, qty, eph.address);

      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, seedShares - qty);

      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(
        treasuryPUSDC,
        100n * ONE_PUSDC + 100n * ONE_PUSDC - qty * ONE_PUSDC
      );
    });
  });

  // ── silent-fail hint gate ───────────────────────────────────────────────

  describe("silent-fail hint gate", () => {
    it("burns zero + pays zero PUSDC when encShares > maxSharesHint", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
        seedShares,
      } = await loadFixture(deployRedeemFixture);

      // Request 50 shares but commit only 10 — silent-fail.
      const enc = await encUint128(investorClient, 50n);

      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, 10n, eph.address);

      // Shares unchanged; PUSDC unchanged on both sides.
      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, seedShares);

      const investorPUSDC = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(investorPUSDC, 200n * ONE_PUSDC);

      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryPUSDC, 200n * ONE_PUSDC);
    });

    it("clamps to full balance (redeem-all) when over-requesting within a sufficient hint", async () => {
      // Slice 1.5b: burnFromSubscription now clamps via FHE.min, so an
      // over-balance instant redeem (within the hint) burns the FULL balance
      // and pays its proceeds — NOT a silent zero no-op. This is the common
      // "sell all" path (instant, under the cap), which the queue-only Slice
      // 1.5 clamp did not cover.
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
        seedShares,
      } = await loadFixture(deployRedeemFixture);

      // Investor has 100 shares; ask to redeem 500 with a hint that covers it
      // (HINT_CAP=1e6 >> 100). Gate A passes (500 <= 1e6); the clamp burns
      // min(100, 500) = 100 → redeems the whole position.
      const enc = await encUint128(investorClient, 500n);

      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, HINT_CAP, eph.address);

      // Investor fully redeemed: balance → 0.
      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, 0n);

      // proceeds = 100 shares * DEFAULT_NAV(1 PUSDC) = 100 PUSDC.
      // Treasury 200 → 100; investor 200 → 300.
      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(
        treasuryPUSDC,
        200n * ONE_PUSDC - seedShares * ONE_PUSDC
      );

      const investorPUSDC = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(
        investorPUSDC,
        200n * ONE_PUSDC + seedShares * ONE_PUSDC
      );
    });
  });

  // ── cap accounting (ADR-004) ────────────────────────────────────────────

  describe("cap accounting", () => {
    it("escalates with Redeemed(escalated=true) when hint*nav exceeds remaining cap", async () => {
      const {
        subscription,
        deployer,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      // Tighten cap to a small value: 5 PUSDC ceiling per epoch.
      await tokenRegistry
        .connect(issuer)
        .setInstantRedeemCap(await token.getAddress(), 5n * ONE_PUSDC);

      // Hint of 10 shares × NAV 1e6 = 10 PUSDC > 5 PUSDC cap → escalate.
      const enc = await encUint128(investorClient, 10n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 10n, eph.address)
      )
        .to.emit(subscription, "Redeemed")
        .withArgs(await token.getAddress(), investor.address, 10n, true);

      // No EscalatedToQueue event is emitted in Phase 2 (no real requestId).
      // Counter unchanged.
      const epoch = await subscription.getCurrentEpoch(await token.getAddress());
      expect(
        await subscription.instantRedeemedThisEpoch(
          await token.getAddress(),
          epoch
        )
      ).to.equal(0n);
    });

    it("consumes the cap against maxSharesHint*nav (not actual burn) on success", async () => {
      const {
        subscription,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      // Cap = 50 PUSDC. Two redeems, each hint=10 → consumes 10+10=20 PUSDC.
      await tokenRegistry
        .connect(issuer)
        .setInstantRedeemCap(await token.getAddress(), 50n * ONE_PUSDC);

      for (const qty of [3n, 4n]) {
        const enc = await encUint128(investorClient, qty);
        await subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 10n, eph.address);
      }

      const epoch = await subscription.getCurrentEpoch(await token.getAddress());
      expect(
        await subscription.instantRedeemedThisEpoch(
          await token.getAddress(),
          epoch
        )
      ).to.equal(2n * 10n * ONE_PUSDC);

      // Remaining cap = 50 - 20 = 30 PUSDC (in PUSDC base units).
      expect(
        await subscription.getInstantCapRemaining(await token.getAddress())
      ).to.equal(30n * ONE_PUSDC);
    });

    it("counter resets across epoch boundaries (cap reused next epoch)", async () => {
      const {
        subscription,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      // Cap = 5 PUSDC. Hint=5 → first redeem fills it; second redeem hits
      // cap-exceeded path; advance one epoch, third redeem succeeds again.
      await tokenRegistry
        .connect(issuer)
        .setInstantRedeemCap(await token.getAddress(), 5n * ONE_PUSDC);

      // First — fills cap exactly.
      let enc = await encUint128(investorClient, 1n);
      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, 5n, eph.address);

      // Second — cap full, escalate.
      enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 5n, eph.address)
      )
        .to.emit(subscription, "Redeemed")
        .withArgs(await token.getAddress(), investor.address, 5n, true);

      // Advance one full epoch.
      await time.increase(EPOCH_DURATION + 1);

      // Third — new epoch, cap fresh.
      enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 5n, eph.address)
      )
        .to.emit(subscription, "Redeemed")
        .withArgs(await token.getAddress(), investor.address, 5n, false);
    });

    it("escalates immediately when instantRedeemCap is zero (no instant lane)", async () => {
      const {
        subscription,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      await tokenRegistry
        .connect(issuer)
        .setInstantRedeemCap(await token.getAddress(), 0n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 1n, eph.address)
      )
        .to.emit(subscription, "Redeemed")
        .withArgs(await token.getAddress(), investor.address, 1n, true);
    });
  });

  // ── cleartext gate reverts ──────────────────────────────────────────────

  describe("cleartext gate reverts", () => {
    it("reverts InvalidEphemeralEOA when ephemeralEOA == 0", async () => {
      const { subscription, investor, investorClient, token } =
        await loadFixture(deployRedeemFixture);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "InvalidEphemeralEOA");
    });

    it("reverts InvalidMaxSharesHint when hint == 0", async () => {
      const { subscription, investor, investorClient, token, eph } =
        await loadFixture(deployRedeemFixture);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 0n, eph.address)
      ).to.be.revertedWithCustomError(subscription, "InvalidMaxSharesHint");
    });

    it("reverts TokenNotRegistered for an unknown token", async () => {
      const { subscription, investor, investorClient, eph } =
        await loadFixture(deployRedeemFixture);
      const enc = await encUint128(investorClient, 1n);
      const bogus = "0x1111111111111111111111111111111111111111";
      await expect(
        subscription
          .connect(investor)
          .redeem(bogus, enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "TokenNotRegistered");
    });

    it("reverts TokenPaused when the token is paused", async () => {
      const {
        subscription,
        tokenRegistry,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      await tokenRegistry
        .connect(deployer)
        .setPaused(await token.getAddress(), true);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "TokenPaused");
    });

    it("reverts BelowMinInvestment when hint < minInvestment", async () => {
      const {
        subscription,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      await tokenRegistry
        .connect(issuer)
        .setMinInvestment(await token.getAddress(), 50n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, 10n, eph.address)
      ).to.be.revertedWithCustomError(subscription, "BelowMinInvestment");
    });

    it("reverts NotEligible when investor is not KYC-whitelisted", async () => {
      const { subscription, kyc, investor, investorClient, token, eph } =
        await loadFixture(deployRedeemFixture);

      // Drop the investor from the whitelist after the seeding purchase.
      await kyc.removeFromWhitelist(investor.address);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "NotEligible");
    });

    it("reverts OracleReturnedZero when NAV has been wiped to 0", async () => {
      const { subscription, oracle, investor, investorClient, token, eph } =
        await loadFixture(deployRedeemFixture);

      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 0n, BigInt(now));

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "OracleReturnedZero");
    });

    it("reverts StaleNAV when NAV is older than the staleness window", async () => {
      const { subscription, oracle, investor, investorClient, token, eph } =
        await loadFixture(deployRedeemFixture);

      await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, 1n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "StaleNAV");
    });

    it("reverts CostOverflowsPUSDCWidth when maxSharesHint * nav exceeds PUSDC's euint64 width", async () => {
      // Mirror of the purchase-side guard. Without it, `encProceeds =
      // FHE.asEuint64(encProceeds128)` would silently truncate on an
      // overflow-sized hint, letting the share burn fire for the full
      // amount while the PUSDC payout shrank — an investor-UX loss even
      // though the direction isn't exploitable.
      const { subscription, oracle, investor, investorClient, token, eph } =
        await loadFixture(deployRedeemFixture);

      // Re-pin NAV to a tiny value so we can drive `hint * nav` over 2^64-1
      // with a still-legal uint128 hint. Fresh timestamp to clear staleness.
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 2n, BigInt(now));

      const hugeHint = (1n << 64n) - 1n;
      const enc = await encUint128(investorClient, 1n);

      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, hugeHint, eph.address)
      ).to.be.revertedWithCustomError(subscription, "CostOverflowsPUSDCWidth");
    });

    it("reverts ComplianceBlocked when wired compliance denies the redeem", async () => {
      const {
        subscription,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      const Factory = await hre.ethers.getContractFactory("DenyAllCompliance");
      const stub = await Factory.deploy();

      await subscription
        .connect(deployer)
        .setModularCompliance(await stub.getAddress());

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "ComplianceBlocked");
    });
  });

  // ── compliance direction (mint vs burn convention) ─────────────────────

  describe("compliance direction", () => {
    it("calls compliance with the burn convention (to == address(0)) — locks in the redeem direction fix", async () => {
      const {
        subscription,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      // Stub allows mint (from == 0) but denies burn (to == 0). If redeem
      // mistakenly used the mint convention (from == 0), this stub would
      // permit the call and the test would fail — proves the redeem path
      // passes (msg.sender, address(0), hint) to `canTransfer`.
      const Factory = await hre.ethers.getContractFactory(
        "BurnOnlyDenyCompliance"
      );
      const stub = await Factory.deploy();

      await subscription
        .connect(deployer)
        .setModularCompliance(await stub.getAddress());

      // Purchase still works under the stub (mint convention is allowed).
      const encBuy = await encUint128(investorClient, 2n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

      // Redeem reverts because the burn convention is denied.
      const encSell = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), encSell, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "ComplianceBlocked");
    });
  });

  // ── identity-registry supersession ──────────────────────────────────────

  describe("identity-registry supersession", () => {
    it("uses identityRegistry.isVerified when wired (supersedes legacy KYC)", async () => {
      const {
        subscription,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployRedeemFixture);

      // Deny-all identity registry — investor whitelisted on legacy gate but
      // identity registry rejects.
      const Factory = await hre.ethers.getContractFactory(
        "DenyAllIdentityRegistry"
      );
      const stub = await Factory.deploy();
      await subscription
        .connect(deployer)
        .setIdentityRegistry(await stub.getAddress());

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "NotEligible");
    });
  });
});
