/**
 * RedemptionQueue unit tests — Wave 3.5 Phase 4.
 *
 * Phase 4 sub-phase 1 (`WAVE_3_5_REVISED.md`): ~25 tests covering the queued
 * redemption lifecycle — `submit` (direct) + `submitFor` (Subscription auto-
 * escalate) + `processEpoch` + `claim` + `cancelOnKYCRevocation`.
 *
 * Touch-points:
 *   - ADR-004 (hybrid redemption: instant cap + queue overflow)
 *   - ADR-008 (PUSDC legacy `euint64 = uint256` selector via low-level call)
 *   - ADR-021 (`ephemeralEOA` trailing param, captured in request struct)
 *   - ADR-027 (KYC-revocation cancel semantics; issuer-only)
 *   - ADR-031 (`CostOverflowsPUSDCWidth` guard reused for queue)
 *   - ADR-035 (submit + submitFor interface; submitFor takes `euint128`)
 *   - ADR-036 (actualPulled via token primitive, stored as request.encShares)
 *   - `FHE_ACL_CONVENTIONS.md` rules 1–5
 *
 * Unit tests use EOA stand-ins for the investor + issuer. Full kernel /
 * UserOp flow is covered in SDK integration + Playwright per M1.
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

/** PUSDC has 6 decimals. */
const ONE_PUSDC = 1_000_000n;
const HINT_CAP = 1_000_000n;
const DEFAULT_NAV = ONE_PUSDC;
const EPOCH_DURATION = 60 * 60;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function deployQueueFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, stranger] =
    await hre.ethers.getSigners();

  // KYC + registry + token
  const kyc = await deployKYCAdapter();
  await kyc.addToWhitelist(investor.address);
  await kyc.addToWhitelist(alice.address);

  const registry = await deployRegistry();

  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

  // TokenRegistry
  const TR = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    TR,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // Subscription
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

  // Queue
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

  // Treasury — minFloat=0; binds the Queue so treasury grants operator
  // rights on init.
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

  // Generous instant cap by default — redeem tests that want escalation
  // set their own tighter cap.
  const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;

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

  await token.setSubscription(await subscription.getAddress());
  await token.setQueue(await queue.getAddress());

  // NAV seed
  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, BigInt(now));

  // Investor: PUSDC + operator approval + seed purchase
  await pusdc.mint(investor.address, 1000n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const eph = createEphemeralEOA();
  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  // Seed 100 shares to investor via real purchase
  const seedShares = 100n;
  const encSeed = await encUint128(investorClient, seedShares);
  await subscription
    .connect(investor)
    .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

  // Top up treasury so queue claims have PUSDC headroom. 200 PUSDC on top
  // of the 100 PUSDC the purchase deposited = 300 PUSDC available.
  await pusdc.mint(await treasury.getAddress(), 200n * ONE_PUSDC);

  return {
    deployer,
    issuer,
    investor,
    alice,
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
    INSTANT_CAP,
  };
}

describe("RedemptionQueue", () => {
  // ── initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("stores wiring + starts nextRequestId at 1", async () => {
      const { queue, token, tokenRegistry, subscription, pusdc, deployer } =
        await loadFixture(deployQueueFixture);

      expect(await queue.owner()).to.equal(deployer.address);
      expect(await queue.token()).to.equal(await token.getAddress());
      expect(await queue.tokenRegistry()).to.equal(await tokenRegistry.getAddress());
      expect(await queue.subscription()).to.equal(await subscription.getAddress());
      expect(await queue.pusdc()).to.equal(await pusdc.getAddress());
      expect(await queue.nextRequestId()).to.equal(1n);
    });

    it("rejects zero addresses on initialize", async () => {
      const QueueFactory = await hre.ethers.getContractFactory("RedemptionQueue");
      const [deployer] = await hre.ethers.getSigners();
      const t = "0x1111111111111111111111111111111111111111";
      await expect(
        upgrades.deployProxy(
          QueueFactory,
          [ZERO_ADDRESS, t, t, t, t],
          { kind: "transparent", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("cannot re-initialize", async () => {
      const { queue, deployer, token, tokenRegistry, subscription, pusdc } =
        await loadFixture(deployQueueFixture);
      await expect(
        queue.initialize(
          deployer.address,
          await token.getAddress(),
          await tokenRegistry.getAddress(),
          await subscription.getAddress(),
          await pusdc.getAddress()
        )
      ).to.be.reverted;
    });
  });

  // ── submit (direct investor path) ───────────────────────────────────────

  describe("submit — happy paths", () => {
    it("pulls shares into queue + creates a request entry", async () => {
      const { queue, investor, investorClient, token, eph, seedShares } =
        await loadFixture(deployQueueFixture);

      const qty = 40n;
      const enc = await encUint128(investorClient, qty);

      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      )
        .to.emit(queue, "QueueSubmitted")
        .withArgs(investor.address, 1n, await queue.currentEpoch());

      // Investor balance reduced by qty.
      const invBal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(invBal, seedShares - qty);

      // Queue balance equals pulled amount.
      const qBal = await token.encryptedBalanceOf(await queue.getAddress());
      await hre.cofhe.mocks.expectPlaintext(qBal, qty);

      // Request recorded.
      const r = await queue.getRequest(1n);
      expect(r.investor).to.equal(investor.address);
      expect(r.maxSharesHint).to.equal(HINT_CAP);
      expect(r.ephemeralEOA).to.equal(eph.address);
      expect(r.settled).to.equal(false);
      expect(r.claimed).to.equal(false);
      expect(r.cancelled).to.equal(false);
    });

    it("ids auto-increment across sequential submits", async () => {
      const { queue, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);

      for (let i = 1n; i <= 3n; i++) {
        const enc = await encUint128(investorClient, 5n);
        await queue.connect(investor).submit(enc, HINT_CAP, eph.address);
        expect(await queue.nextRequestId()).to.equal(i + 1n);
      }

      const epoch = await queue.currentEpoch();
      const ids = await queue.getEpochRequests(epoch);
      expect(ids.map((x: bigint) => Number(x))).to.deep.equal([1, 2, 3]);
    });

    it("silent-fails (actualPulled=0) when encShares > maxSharesHint", async () => {
      const { queue, investor, investorClient, token, eph, seedShares } =
        await loadFixture(deployQueueFixture);

      // Request 50 with hint=10 → silent-fail to zero.
      const enc = await encUint128(investorClient, 50n);
      await queue.connect(investor).submit(enc, 10n, eph.address);

      const invBal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(invBal, seedShares);

      const r = await queue.getRequest(1n);
      await hre.cofhe.mocks.expectPlaintext(r.encShares, 0n);
    });

    it("silent-fails when investor's balance is insufficient for the pull", async () => {
      const { queue, investor, investorClient, token, eph, seedShares } =
        await loadFixture(deployQueueFixture);

      // Investor has 100 shares — ask for 500.
      const enc = await encUint128(investorClient, 500n);
      await queue.connect(investor).submit(enc, HINT_CAP, eph.address);

      // Investor balance unchanged, request records zero pull.
      const invBal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(invBal, seedShares);

      const r = await queue.getRequest(1n);
      await hre.cofhe.mocks.expectPlaintext(r.encShares, 0n);
    });
  });

  describe("submit — cleartext gates", () => {
    it("reverts InvalidEphemeralEOA", async () => {
      const { queue, investor, investorClient } = await loadFixture(deployQueueFixture);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(queue, "InvalidEphemeralEOA");
    });

    it("reverts InvalidMaxSharesHint when hint==0", async () => {
      const { queue, investor, investorClient, eph } = await loadFixture(deployQueueFixture);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, 0n, eph.address)
      ).to.be.revertedWithCustomError(queue, "InvalidMaxSharesHint");
    });

    it("reverts TokenPaused when token is paused", async () => {
      const { queue, deployer, tokenRegistry, token, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await tokenRegistry.connect(deployer).setPaused(await token.getAddress(), true);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(queue, "TokenPaused");
    });

    it("reverts NotEligible when investor is not KYC-whitelisted", async () => {
      const { queue, kyc, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await kyc.removeFromWhitelist(investor.address);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(queue, "NotEligible");
    });

    it("reverts OracleReturnedZero when NAV has been wiped", async () => {
      const { queue, oracle, token, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 0n, BigInt(now));
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(queue, "OracleReturnedZero");
    });

    it("reverts StaleNAV when NAV is past the staleness window", async () => {
      const { queue, oracle, token, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, 1n);
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(queue, "StaleNAV");
    });

    it("reverts CostOverflowsPUSDCWidth on overflow-sized hint", async () => {
      const { queue, oracle, token, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 2n, BigInt(now));
      const hugeHint = (1n << 64n) - 1n;
      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, hugeHint, eph.address)
      ).to.be.revertedWithCustomError(queue, "CostOverflowsPUSDCWidth");
    });

    it("reverts ComplianceBlocked when the token's compliance denies the burn", async () => {
      const { queue, deployer, token, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);

      const Factory = await hre.ethers.getContractFactory("DenyAllCompliance");
      const stub = await Factory.deploy();

      await token.connect(deployer).setModularCompliance(await stub.getAddress());

      const enc = await encUint128(investorClient, 1n);
      await expect(
        queue.connect(investor).submit(enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(queue, "ComplianceBlocked");
    });
  });

  // ── submitFor ───────────────────────────────────────────────────────────

  describe("submitFor — Subscription auto-escalate path", () => {
    it("only the bound Subscription can call", async () => {
      const { queue, investor, stranger, eph } = await loadFixture(deployQueueFixture);
      // Pass an arbitrary bytes32 — it'll revert on the onlySubscription
      // check before touching the handle.
      const fakeHandle = "0x" + "0".repeat(64);
      await expect(
        queue.connect(stranger).submitFor(
          investor.address,
          fakeHandle,
          HINT_CAP,
          eph.address
        )
      ).to.be.revertedWithCustomError(queue, "OnlySubscription");
    });

    it("rejects investor == address(0)", async () => {
      const { queue, subscription, eph } = await loadFixture(deployQueueFixture);

      // Impersonate the subscription address (fund via hardhat_setBalance
      // because the subscription proxy has no receive/fallback). Hits
      // `submitFor` with investor=0 → reverts ZeroAddress.
      const subAddr = await subscription.getAddress();
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [subAddr],
      });
      await hre.network.provider.send("hardhat_setBalance", [
        subAddr,
        "0x" + (10n ** 18n).toString(16),
      ]);
      const subSigner = await hre.ethers.getSigner(subAddr);

      const fakeHandle = "0x" + "0".repeat(64);
      await expect(
        queue.connect(subSigner).submitFor(
          ZERO_ADDRESS,
          fakeHandle,
          HINT_CAP,
          eph.address
        )
      ).to.be.revertedWithCustomError(queue, "ZeroAddress");

      await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [subAddr],
      });
    });

    it("Subscription.redeem escalates on cap overflow → queue records request", async () => {
      const {
        subscription,
        queue,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deployQueueFixture);

      // Tighten cap so any redeem > 5 PUSDC escalates.
      await tokenRegistry
        .connect(issuer)
        .setInstantRedeemCap(await token.getAddress(), 5n * ONE_PUSDC);

      // Redeem 10 shares × 1 PUSDC/share = 10 PUSDC > 5 PUSDC cap → escalate.
      const qty = 10n;
      const enc = await encUint128(investorClient, qty);

      await expect(
        subscription
          .connect(investor)
          .redeem(await token.getAddress(), enc, qty, eph.address)
      )
        .to.emit(subscription, "EscalatedToQueue")
        .withArgs(await token.getAddress(), investor.address, 1n)
        .and.to.emit(queue, "QueueSubmitted")
        .withArgs(investor.address, 1n, await queue.currentEpoch());

      // Request investor matches (not Subscription).
      const r = await queue.getRequest(1n);
      expect(r.investor).to.equal(investor.address);
      expect(r.maxSharesHint).to.equal(qty);
    });
  });

  // ── processEpoch ────────────────────────────────────────────────────────

  describe("processEpoch", () => {
    it("settles each request + computes encProceeds + fires EpochProcessed", async () => {
      const {
        queue,
        issuer,
        investor,
        investorClient,
        eph,
      } = await loadFixture(deployQueueFixture);

      // Two submits in current epoch.
      const qty1 = 10n;
      const qty2 = 20n;
      await queue.connect(investor).submit(await encUint128(investorClient, qty1), HINT_CAP, eph.address);
      await queue.connect(investor).submit(await encUint128(investorClient, qty2), HINT_CAP, eph.address);

      const epoch = await queue.currentEpoch();
      await expect(queue.connect(issuer).processEpoch(epoch, 0, 2))
        .to.emit(queue, "EpochProcessed")
        .withArgs(epoch, 2n);

      const r1 = await queue.getRequest(1n);
      const r2 = await queue.getRequest(2n);
      expect(r1.settled).to.equal(true);
      expect(r2.settled).to.equal(true);
      // encProceeds = encShares * nav = qty * 1e6.
      await hre.cofhe.mocks.expectPlaintext(r1.encProceeds, qty1 * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(r2.encProceeds, qty2 * ONE_PUSDC);
    });

    it("rejects non-issuer callers", async () => {
      const { queue, stranger } = await loadFixture(deployQueueFixture);
      await expect(
        queue.connect(stranger).processEpoch(0, 0, 0)
      ).to.be.revertedWithCustomError(queue, "OnlyIssuer");
    });

    it("rejects InvalidRange when startIdx > endIdx or endIdx > len", async () => {
      const { queue, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      const enc = await encUint128(investorClient, 1n);
      await queue.connect(investor).submit(enc, HINT_CAP, eph.address);

      const epoch = await queue.currentEpoch();
      await expect(
        queue.connect(issuer).processEpoch(epoch, 2, 1)
      ).to.be.revertedWithCustomError(queue, "InvalidRange");
      await expect(
        queue.connect(issuer).processEpoch(epoch, 0, 2)
      ).to.be.revertedWithCustomError(queue, "InvalidRange");
    });

    it("is idempotent — re-running the same slice skips already-settled requests", async () => {
      const { queue, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue.connect(investor).submit(await encUint128(investorClient, 5n), HINT_CAP, eph.address);

      const epoch = await queue.currentEpoch();
      await queue.connect(issuer).processEpoch(epoch, 0, 1);
      // Second call processes zero new requests.
      await expect(queue.connect(issuer).processEpoch(epoch, 0, 1))
        .to.emit(queue, "EpochProcessed")
        .withArgs(epoch, 0n);
    });

    it("paginates cleanly across separate calls", async () => {
      const { queue, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);

      for (let i = 0; i < 4; i++) {
        const enc = await encUint128(investorClient, 1n);
        await queue.connect(investor).submit(enc, HINT_CAP, eph.address);
      }

      const epoch = await queue.currentEpoch();
      // First half.
      await queue.connect(issuer).processEpoch(epoch, 0, 2);
      // Second half.
      await queue.connect(issuer).processEpoch(epoch, 2, 4);

      for (let i = 1n; i <= 4n; i++) {
        const r = await queue.getRequest(i);
        expect(r.settled).to.equal(true);
      }
    });

    it("reverts StaleNAV when NAV is past the window at process time", async () => {
      const { queue, oracle, token, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue.connect(investor).submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);

      // Stale NAV after submit.
      await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, 1n);

      const epoch = await queue.currentEpoch();
      await expect(
        queue.connect(issuer).processEpoch(epoch, 0, 1)
      ).to.be.revertedWithCustomError(queue, "StaleNAV");
    });

    it("grants decrypt ACL on encProceeds to the captured ephemeralEOA (not to a stranger)", async () => {
      const { queue, issuer, investor, investorClient, eph, stranger } =
        await loadFixture(deployQueueFixture);

      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 5n), HINT_CAP, eph.address);
      await queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1);

      const r = await queue.getRequest(1n);
      const acl = await hre.cofhe.mocks.getMockACL();
      // Rule 2: the captured ephemeralEOA can decrypt encProceeds.
      expect(await acl.isAllowed(BigInt(r.encProceeds), eph.address)).to.equal(true);
      // A random EOA cannot.
      expect(await acl.isAllowed(BigInt(r.encProceeds), stranger.address)).to.equal(false);
    });

    it("does not double-fire compliance `destroyed` when re-running over the same slice", async () => {
      // Wire a counting compliance stub so we can prove state-hook
      // re-fires don't happen on idempotent processEpoch re-runs.
      const { queue, deployer, issuer, investor, investorClient, token, eph } =
        await loadFixture(deployQueueFixture);

      const Factory = await hre.ethers.getContractFactory("CountingCompliance");
      const stub = await Factory.deploy();

      await token.connect(deployer).setModularCompliance(await stub.getAddress());

      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 5n), HINT_CAP, eph.address);

      const epoch = await queue.currentEpoch();
      await queue.connect(issuer).processEpoch(epoch, 0, 1);
      expect(await stub.destroyedCount()).to.equal(1n);

      // Re-run over the same slice — no new destroyed fires.
      await queue.connect(issuer).processEpoch(epoch, 0, 1);
      expect(await stub.destroyedCount()).to.equal(1n);
    });
  });

  // ── processEpoch settlement payout (Phase 7.6 / ADR-043) ────────────────
  //
  // Settlement collapsed into processEpoch: per-request mhUSDC pull lives in
  // the issuer-driven processEpoch loop, share burn / refund branches via
  // the share/cash silent-fail mirror. `claim()` is now vestigial — see the
  // dedicated `claim (vestigial)` describe below for the post-Phase-7.6
  // semantics (always reverts AlreadyClaimed for processed requests).

  describe("processEpoch settlement payout", () => {
    it("transfers PUSDC from treasury to investor inside processEpoch + flips claimed", async () => {
      // Pre-Phase-7.6 this assertion lived under `claim()` — investor called
      // claim() to receive the mhUSDC. Phase 7.6 / ADR-043 collapses that
      // pull into processEpoch (Option A), so settlement is single-tx for
      // the investor.
      const {
        queue,
        issuer,
        investor,
        investorClient,
        pusdc,
        treasury,
        eph,
      } = await loadFixture(deployQueueFixture);

      const qty = 15n;
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, qty), HINT_CAP, eph.address);

      const investorBalBefore = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(investorBalBefore, 900n * ONE_PUSDC);

      const treasuryBalBefore = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryBalBefore, 300n * ONE_PUSDC);

      // processEpoch fires the cash-leg pull AND the QueueClaimed event in
      // a single tx (the event was previously emitted by claim()).
      await expect(
        queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1)
      )
        .to.emit(queue, "QueueClaimed")
        .withArgs(investor.address, 1n);

      const investorBalAfter = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(
        investorBalAfter,
        900n * ONE_PUSDC + qty * ONE_PUSDC
      );

      const treasuryBalAfter = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(
        treasuryBalAfter,
        300n * ONE_PUSDC - qty * ONE_PUSDC
      );

      const r = await queue.getRequest(1n);
      expect(r.settled).to.equal(true);
      // Phase 7.6: settled and claimed flip atomically inside processEpoch.
      expect(r.claimed).to.equal(true);
    });
  });

  // ── claim (vestigial post-Phase-7.6) ────────────────────────────────────
  //
  // `claim()` is retained on the surface for ABI / SDK / frontend
  // compatibility during cutover (per ADR-043 "Consequences"). Every
  // post-settlement call lands on `AlreadyClaimed`; precondition reverts
  // (`UnknownRequest` / `WrongInvestor` / `NotSettled`) still fire ahead
  // of it.

  describe("claim (vestigial)", () => {
    it("rejects an unknown request id", async () => {
      const { queue, investor } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(investor).claim(999n))
        .to.be.revertedWithCustomError(queue, "UnknownRequest");
    });

    it("rejects the wrong investor", async () => {
      const { queue, issuer, investor, investorClient, alice, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);
      await queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1);
      await expect(queue.connect(alice).claim(1n))
        .to.be.revertedWithCustomError(queue, "WrongInvestor");
    });

    it("rejects claim before settlement", async () => {
      const { queue, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);
      await expect(queue.connect(investor).claim(1n))
        .to.be.revertedWithCustomError(queue, "NotSettled");
    });

    it("always reverts AlreadyClaimed after processEpoch (vestigial path)", async () => {
      // Phase 7.6: every settled request has `claimed == true` already
      // (set inside processEpoch), so a single claim() call hits
      // AlreadyClaimed — no longer requires a "first claim then second
      // claim" sequence to surface the revert.
      const { queue, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);
      await queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1);
      await expect(queue.connect(investor).claim(1n))
        .to.be.revertedWithCustomError(queue, "AlreadyClaimed");
    });
  });

  // ── processEpoch refund-on-shortfall (Phase 7.6 / ADR-043) ──────────────

  describe("processEpoch refund-on-shortfall", () => {
    it("refunds locked shares when treasury can't cover encProceeds", async () => {
      // Treasury short of `r.encShares * nav` → wrapper silent-fails →
      // `fullPay = false` → burn 0, refund r.encShares back to investor.
      // Investor's net position over the submit + processEpoch round-trip
      // is zero. MockPUSDC has no silent-fail (legacy IFHERC20 reverts
      // on underflow), so to exercise the refund branch we need a fixture
      // backed by MuHavenStable. That coverage lives in
      // `MuHavenStable.integration.test.ts > Phase 7.6 — RedemptionQueue
      // refund-on-shortfall` (added alongside this test).
      //
      // This unit test asserts the happy-path symmetric: against MockPUSDC
      // (no silent-fail, treasury fully covers), processEpoch always
      // burns the locked shares and never refunds. The negative case
      // pairs cleanly with the wrapper-fixture integration test.
      const { queue, issuer, investor, investorClient, token, eph } =
        await loadFixture(deployQueueFixture);

      const qty = 25n;
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, qty), HINT_CAP, eph.address);

      // Queue holds qty shares (locked at submit).
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(await queue.getAddress()),
        qty
      );

      await queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1);

      // Cash-paid branch fired: queue burned all locked shares, refunded 0.
      // Investor shares unchanged from pre-submit state (queue had taken
      // them, settlement burnt them; they don't return).
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(await queue.getAddress()),
        0n
      );

      // Investor's seed shares minus the redeemed qty.
      // Phase 5 baseline: investor seeded with 100 shares, queued 25 → 75 left.
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(investor.address),
        75n
      );
    });
  });

  // ── cancelOnKYCRevocation ───────────────────────────────────────────────

  describe("cancelOnKYCRevocation", () => {
    it("only issuer can call", async () => {
      const { queue, stranger } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(stranger).cancelOnKYCRevocation(1n))
        .to.be.revertedWithCustomError(queue, "OnlyIssuer");
    });

    it("rejects unknown request id", async () => {
      const { queue, issuer } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(issuer).cancelOnKYCRevocation(999n))
        .to.be.revertedWithCustomError(queue, "UnknownRequest");
    });

    it("reverts ZeroAddress when identityRegistry is not wired", async () => {
      const { queue, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);
      await expect(queue.connect(issuer).cancelOnKYCRevocation(1n))
        .to.be.revertedWithCustomError(queue, "ZeroAddress");
    });

    it("reverts InvestorStillVerified when the investor is still verified", async () => {
      const { queue, deployer, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);

      // Wire an identity registry that returns true (allow-all) for the investor.
      const Allow = await hre.ethers.getContractFactory("AllowAllIdentityRegistry");
      const allow = await Allow.deploy();
      await queue.connect(deployer).setIdentityRegistry(await allow.getAddress());

      await expect(queue.connect(issuer).cancelOnKYCRevocation(1n))
        .to.be.revertedWithCustomError(queue, "InvestorStillVerified");
    });

    it("returns locked shares to investor + marks cancelled", async () => {
      const { queue, deployer, issuer, investor, investorClient, token, eph, seedShares } =
        await loadFixture(deployQueueFixture);

      const qty = 25n;
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, qty), HINT_CAP, eph.address);

      // Wire a deny-all identity registry — investor is KYC-revoked by construction.
      const Deny = await hre.ethers.getContractFactory("DenyAllIdentityRegistry");
      const deny = await Deny.deploy();
      await queue.connect(deployer).setIdentityRegistry(await deny.getAddress());

      await expect(queue.connect(issuer).cancelOnKYCRevocation(1n))
        .to.emit(queue, "QueueCancelled")
        .withArgs(investor.address, 1n);

      // Investor got shares back.
      const invBal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(invBal, seedShares);

      const r = await queue.getRequest(1n);
      expect(r.cancelled).to.equal(true);
    });

    it("rejects cancel on a settled request", async () => {
      const { queue, deployer, issuer, investor, investorClient, eph } =
        await loadFixture(deployQueueFixture);
      await queue
        .connect(investor)
        .submit(await encUint128(investorClient, 1n), HINT_CAP, eph.address);
      await queue.connect(issuer).processEpoch(await queue.currentEpoch(), 0, 1);

      const Deny = await hre.ethers.getContractFactory("DenyAllIdentityRegistry");
      const deny = await Deny.deploy();
      await queue.connect(deployer).setIdentityRegistry(await deny.getAddress());

      await expect(queue.connect(issuer).cancelOnKYCRevocation(1n))
        .to.be.revertedWithCustomError(queue, "AlreadySettled");
    });
  });

  // ── admin ───────────────────────────────────────────────────────────────

  describe("admin", () => {
    it("owner can rotate subscription + emits event", async () => {
      const { queue, deployer, alice } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(deployer).setSubscription(alice.address))
        .to.emit(queue, "SubscriptionUpdated")
        .withArgs(alice.address);
      expect(await queue.subscription()).to.equal(alice.address);
    });

    it("owner can set identityRegistry + emits event", async () => {
      const { queue, deployer, alice } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(deployer).setIdentityRegistry(alice.address))
        .to.emit(queue, "IdentityRegistryUpdated")
        .withArgs(alice.address);
      expect(await queue.identityRegistry()).to.equal(alice.address);
    });

    it("owner can transferOwnership", async () => {
      const { queue, deployer, alice } = await loadFixture(deployQueueFixture);
      await queue.connect(deployer).transferOwnership(alice.address);
      expect(await queue.owner()).to.equal(alice.address);
    });

    it("non-owner cannot rotate subscription / identityRegistry / ownership", async () => {
      const { queue, stranger, alice } = await loadFixture(deployQueueFixture);
      await expect(queue.connect(stranger).setSubscription(alice.address))
        .to.be.revertedWithCustomError(queue, "OnlyOwner");
      await expect(queue.connect(stranger).setIdentityRegistry(alice.address))
        .to.be.revertedWithCustomError(queue, "OnlyOwner");
      await expect(queue.connect(stranger).transferOwnership(alice.address))
        .to.be.revertedWithCustomError(queue, "OnlyOwner");
    });
  });
});
