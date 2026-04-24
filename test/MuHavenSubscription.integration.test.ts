/**
 * Wave 3.5 Phase 2 cross-contract integration tests.
 *
 * Phase 2 sub-phase 10 (`WAVE_3_5_REVISED.md`): five integration cases that
 * exercise the full TokenRegistry + IssuerControlledOracle + MuHavenTreasury
 * + MuHavenSubscription + MuHavenToken stack together. Unit-suite coverage
 * tests each contract in isolation; this file proves the wiring holds end
 * to end.
 *
 * Cases (per the WAVE_3_5_REVISED Phase 2 task list):
 *   1. Fresh buy — empty system → first investor purchases against a freshly
 *      seeded NAV.
 *   2. Subsequent buy — same investor buys again against a refreshed NAV;
 *      balance + treasury accumulate.
 *   3. Stale NAV blocks — purchase + redeem both revert `StaleNAV` once the
 *      oracle's `updatedAt` falls outside the staleness window.
 *   4. Treasury drain protection — issuer's `withdraw` honours the cleartext
 *      `minFloat` floor while a redeem is in flight.
 *   5. Deviation gate rejects — over-threshold NAV update parks `pendingNAV`;
 *      purchase still uses the prior committed NAV; owner accept commits.
 *
 * Tests use the **real** `IssuerControlledOracle` here (not the test
 * `MockPriceOracle`) so the deviation-gate + sequencer paths are exercised
 * against the production contract. PUSDC is the legacy `MockPUSDC` per
 * ADR-008.
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
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_PUSDC = 1_000_000n;
const HINT_CAP = 1_000_000n;
const DEFAULT_NAV = ONE_PUSDC;
const EPOCH_DURATION = 60 * 60;
/** Comfortable cap so that buy-side hint room never bottlenecks redeem cases. */
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;
/** 36h matches `IssuerControlledOracle.DEFAULT_MAX_STALENESS`. */
const STALENESS_WINDOW_SECONDS = 36n * 60n * 60n;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function deployIntegrationFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

  // KYC + registry + token (Wave 3 carry-over wiring)
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

  // PUSDC + real IssuerControlledOracle (not the mock — we want the deviation
  // gate + sequencer paths to be live here).
  const pusdc = await deployMockPUSDC();

  const OracleFactory = await hre.ethers.getContractFactory(
    "IssuerControlledOracle"
  );
  // No L2 sequencer feed in the hardhat env — pass `address(0)` per the
  // IssuerControlledOracle natspec so the sequencer leg of `isFresh`
  // short-circuits to true.
  const oracle = await upgrades.deployProxy(
    OracleFactory,
    [deployer.address, ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );

  const TR = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    TR,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

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

  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      alice.address, // queue placeholder — not exercised in Phase 2
      issuer.address,
      await pusdc.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // TokenRegistry registration
  await tokenRegistry.registerToken(await token.getAddress(), {
    active: true,
    treasury: await treasury.getAddress(),
    queue: alice.address,
    oracle: await oracle.getAddress(),
    issuer: issuer.address,
    minInvestment: 0n,
    instantRedeemCap: INSTANT_CAP,
    epochDuration: EPOCH_DURATION,
    paused: false,
  });

  // Subscription wired onto token's paid-settlement path.
  await token.setSubscription(await subscription.getAddress());

  // Oracle: grant the issuer hot-key NAV-write rights for this token.
  await oracle.setNavWriter(await token.getAddress(), issuer.address);
  // Tighten deviation gate to 25 bps (BUSINESS §9 TBILL1 default).
  await oracle.setMaxDeviationBps(await token.getAddress(), 25n);

  // Investor: PUSDC + operator approval.
  await pusdc.mint(investor.address, 200n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const eph = createEphemeralEOA();

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  return {
    deployer,
    issuer,
    investor,
    alice,
    kyc,
    registry,
    token,
    tokenRegistry,
    treasury,
    pusdc,
    oracle,
    subscription,
    investorClient,
    issuerClient,
    eph,
  };
}

describe("Wave 3.5 Phase 2 integration", () => {
  // ── Case 1: Fresh buy ───────────────────────────────────────────────────

  it("Case 1 — fresh buy: empty system, NAV seeded, investor purchases", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      pusdc,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    // Issuer publishes the first NAV (seed — bypasses deviation gate).
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Investor purchases 10 shares at 1 PUSDC/share.
    const shares = 10n;
    const enc = await encUint128(investorClient, shares);

    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    )
      .to.emit(subscription, "Purchased")
      .withArgs(await token.getAddress(), investor.address, HINT_CAP);

    const bal = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(bal, shares);

    const treasuryBal = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryBal, shares * ONE_PUSDC);
  });

  // ── Case 2: Subsequent buy ──────────────────────────────────────────────

  it("Case 2 — subsequent buy: NAV refreshed in-band, balance accumulates", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      pusdc,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    // Seed NAV @ 1.000 PUSDC/share.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // First buy — 5 shares @ 1.0 = 5 PUSDC.
    let enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Refresh NAV in-band (within 25 bps deviation): 1.0024 PUSDC/share.
    // 24 bps = 0.24% increase → 1_002_400 base units.
    const newNav = 1_002_400n;
    await oracle.connect(issuer).setNAV(await token.getAddress(), newNav);

    // Second buy — 4 shares @ new NAV = 4_009_600 base units.
    enc = await encUint128(investorClient, 4n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    const bal = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(bal, 9n); // 5 + 4 shares

    const treasuryBal = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(
      treasuryBal,
      5n * ONE_PUSDC + 4n * newNav
    );
  });

  // ── Case 3: Stale NAV blocks purchase + redeem ──────────────────────────

  it("Case 3 — stale NAV blocks both purchase and redeem", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    // Seed NAV.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Purchase succeeds while fresh.
    let enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Advance past the staleness window.
    await time.increase(Number(STALENESS_WINDOW_SECONDS) + 1);

    // Now both purchase and redeem revert StaleNAV.
    enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");

    enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");

    // Issuer refreshes NAV (in-band — same value within deviation cap).
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Purchase + redeem now work again.
    enc = await encUint128(investorClient, 1n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);
  });

  // ── Case 4: Treasury drain protection (minFloat) ────────────────────────

  it("Case 4 — treasury drain protection: redeem succeeds, withdraw silently bounds to spare", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      issuerClient,
      token,
      pusdc,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Investor buys 100 shares (consumes 100 PUSDC into treasury).
    let enc = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Issuer raises minFloat to 80 PUSDC. Treasury has 100 → spare = 20.
    await treasury.connect(issuer).setMinFloat(80n * ONE_PUSDC);

    // Investor redeems 10 shares — treasury → investor 10 PUSDC. Treasury
    // remaining = 90 PUSDC, still above minFloat.
    enc = await encUint128(investorClient, 10n);
    await subscription
      .connect(investor)
      .redeem(await token.getAddress(), enc, HINT_CAP, eph.address);

    const treasuryBal = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryBal, 90n * ONE_PUSDC);

    // ── Sub-case A: over-the-spare withdraw silent-fails to 0 ──
    // Spare = 90 - 80 = 10 PUSDC. Requesting 50 PUSDC violates the floor;
    // per ADR-029 (Rule 5 silent-fail), `actual` zeros out and the PUSDC
    // transfer moves nothing. Treasury stays at 90; no `BelowMinFloat`
    // revert (the error stays declared on the locked interface for ABI
    // stability but is intentionally never raised — see ADR-029).
    const overEnc = await encUint128(issuerClient, 50n * ONE_PUSDC);
    await treasury.connect(issuer).withdraw(overEnc);

    const treasuryAfterOver = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryAfterOver, 90n * ONE_PUSDC);

    // ── Sub-case B: at-the-spare withdraw drains down to exactly minFloat ──
    // Requesting exactly 10 PUSDC (== spare) satisfies the silent-fail
    // bound; the transfer commits.
    const fitEnc = await encUint128(issuerClient, 10n * ONE_PUSDC);
    await treasury.connect(issuer).withdraw(fitEnc);

    const treasuryAfterFit = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryAfterFit, 80n * ONE_PUSDC);

    // Issuer's balance handle now exists with exactly 10 PUSDC.
    const issuerAfter = await pusdc.confidentialBalanceOf(issuer.address);
    await hre.cofhe.mocks.expectPlaintext(issuerAfter, 10n * ONE_PUSDC);
  });

  // ── Case 6: Sequencer-uptime gate blocks purchase + redeem ──────────────

  it("Case 6 — sequencer down blocks purchase + redeem even with fresh NAV", async () => {
    // Catches the Phase-2 review bug: Subscription used to do a raw
    // `block.timestamp - updatedAt > maxStaleness` check that bypassed the
    // oracle's sequencer-uptime gate. On Arb One mainnet this would let
    // stale-during-outage quotes settle. Proving the fix: rotate the oracle
    // onto a MockSequencerUptimeFeed, flip it to DOWN, and confirm both
    // Subscription paths revert StaleNAV even though `getNAV` returns fresh
    // cleartext. Then flip the feed back UP (with grace elapsed) and confirm
    // both paths unblock.
    const {
      deployer,
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    // Seed NAV so the fresh-NAV leg is genuine — only the sequencer gate
    // can cause a StaleNAV revert in this test.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Wire a MockSequencerUptimeFeed; start UP so the first purchase works.
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    const Feed = await hre.ethers.getContractFactory("MockSequencerUptimeFeed");
    const feed = await Feed.deploy(0, now - 3600 - 10); // up, past grace
    await oracle.connect(deployer).setSequencerUptimeFeed(await feed.getAddress());

    // Baseline — first purchase succeeds.
    let enc = await encUint128(investorClient, 1n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Flip the sequencer to DOWN. Both Subscription paths must now revert
    // StaleNAV — `getNAV` still returns the fresh value, so pre-fix the
    // Subscription would have happily served it.
    const nowDown = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    await feed.setStatus(1, nowDown);

    enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");

    enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");

    // Recover the sequencer; must also clear the grace window (default 1h).
    const nowRecover = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    await feed.setStatus(0, nowRecover);
    // Inside the grace window — still not fresh.
    enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");

    // Advance past the 1h grace period — purchase unblocks.
    await time.increase(3600 + 1);
    enc = await encUint128(investorClient, 1n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);
  });

  // ── Case 5: Deviation gate rejects → owner accepts ──────────────────────

  it("Case 5 — deviation gate: over-threshold update parks pending; purchase still uses prior NAV; accept commits", async () => {
    const {
      deployer,
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      pusdc,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployIntegrationFixture);

    // Seed NAV at 1.000 PUSDC/share.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Issuer attempts a 100-bps move (1.01 PUSDC/share). 100 bps > 25 bps
    // gate → parks as pending. The committed NAV stays at 1.000.
    const overshootNav = 1_010_000n;
    await expect(
      oracle.connect(issuer).setNAV(await token.getAddress(), overshootNav)
    ).to.emit(oracle, "NAVPending");

    const [navAfter] = await oracle.getNAV(await token.getAddress());
    expect(navAfter).to.equal(DEFAULT_NAV);

    // Purchase uses the committed (pre-overshoot) NAV — investor pays 5 PUSDC
    // for 5 shares.
    const enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    const treasuryAfterPurchase = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(
      treasuryAfterPurchase,
      5n * ONE_PUSDC
    );

    // Owner accepts the pending NAV — committed NAV jumps to 1.01.
    await expect(
      oracle.connect(deployer).acceptPendingNAV(await token.getAddress())
    ).to.emit(oracle, "PendingNAVAccepted");

    const [navAfterAccept] = await oracle.getNAV(await token.getAddress());
    expect(navAfterAccept).to.equal(overshootNav);

    // Subsequent purchase uses the new NAV.
    const enc2 = await encUint128(investorClient, 2n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc2, HINT_CAP, eph.address);

    const treasuryFinal = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(
      treasuryFinal,
      5n * ONE_PUSDC + 2n * overshootNav
    );
  });
});
