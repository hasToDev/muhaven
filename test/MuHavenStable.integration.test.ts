/**
 * Phase 7.5-B regression — re-run the five Phase 2 Subscription integration
 * cases against a topology where the PUSDC pointer is `MuHavenStable` (not
 * legacy MockPUSDC). Locks in that the wrapper is a drop-in replacement
 * — silent-fail semantics, freshness gates, deviation gate behaviour all
 * survive the rotation.
 *
 * Mirrors `MuHavenSubscription.integration.test.ts` except the Subscription /
 * Treasury are deployed with `pusdc = mhUSDC` from the start. Investor +
 * issuer flows interact in mhUSDC; legacy PUSDC only surfaces as the
 * underlying collateral the wrapper holds 1:1.
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
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;
const STALENESS_WINDOW_SECONDS = 36n * 60n * 60n;
const FOREVER = 2n ** 47n - 1n;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function encUint64(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

async function deployWrapperFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

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

  // Legacy PUSDC + the wrapper that Subscription / Treasury will actually
  // talk to.
  const pusdc = await deployMockPUSDC();

  const Stable = await hre.ethers.getContractFactory("MuHavenStable");
  const mhUSDC = await upgrades.deployProxy(
    Stable,
    [
      "MuHaven Confidential USD",
      "mhUSDC",
      deployer.address,
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Real IssuerControlledOracle (matches the Phase 2 integration fixture).
  const OracleFactory = await hre.ethers.getContractFactory(
    "IssuerControlledOracle"
  );
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

  // Subscription wired to mhUSDC (not legacy PUSDC).
  const SubFactory = await hre.ethers.getContractFactory("MuHavenSubscription");
  const subscription = await upgrades.deployProxy(
    SubFactory,
    [
      deployer.address,
      await tokenRegistry.getAddress(),
      await kyc.getAddress(),
      await mhUSDC.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Treasury wired to mhUSDC.
  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      alice.address, // queue placeholder — not exercised in these cases
      issuer.address,
      await mhUSDC.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

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

  await token.setSubscription(await subscription.getAddress());

  await oracle.setNavWriter(await token.getAddress(), issuer.address);
  await oracle.setMaxDeviationBps(await token.getAddress(), 25n);

  // Investor pre-wraps PUSDC → mhUSDC so the subscription pulls work.
  // Mint 200 PUSDC, wrap 200 → 200 mhUSDC.
  await pusdc.mint(investor.address, 200n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await mhUSDC.getAddress(), FOREVER);

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  const eph = createEphemeralEOA();

  // Wrap full balance into mhUSDC.
  const encWrap = await encUint64(investorClient, 200n * ONE_PUSDC);
  await mhUSDC.connect(investor).wrap(encWrap, eph.address);

  // Investor approves Subscription as operator on mhUSDC (the new pull source).
  await mhUSDC
    .connect(investor)
    .setOperator(await subscription.getAddress(), FOREVER);

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
    mhUSDC,
    oracle,
    subscription,
    investorClient,
    issuerClient,
    eph,
  };
}

describe("Phase 7.5-B — Subscription integration against MuHavenStable", () => {
  it("Case 1 — fresh buy: investor purchases via mhUSDC", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

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

    // Treasury holds the mhUSDC — wrapper-side accounting.
    const treasuryBal = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryBal, shares * ONE_PUSDC);
  });

  it("Case 2 — subsequent buy: balance accumulates with NAV refresh", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    let enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Refresh NAV in-band (within 25 bps).
    const newNav = 1_002_400n;
    await oracle.connect(issuer).setNAV(await token.getAddress(), newNav);

    enc = await encUint128(investorClient, 4n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    const bal = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(bal, 9n);

    const treasuryBal = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(
      treasuryBal,
      5n * ONE_PUSDC + 4n * newNav
    );
  });

  it("Case 3 — stale NAV blocks purchase against the wrapper too", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Advance past staleness window.
    await time.increase(Number(STALENESS_WINDOW_SECONDS) + 60);

    const enc = await encUint128(investorClient, 5n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "StaleNAV");
  });

  it("Case 4 — silent-fail wrapper pull mirrors to zero-share mint (Phase 7.6 / ADR-043)", async () => {
    // The wrapper's silent-fail semantics on the pull leg mean a
    // short-balance purchase still executes without reverting. Phase 7.6 /
    // ADR-043 closes the A-6 audit finding: the share-mint side now
    // mirrors the cash-leg silent-fail via FHE.eq + FHE.select, so a
    // wrapper pull that moved 0 mhUSDC mints 0 shares (was: minted
    // `encSharesBounded` regardless, which let an investor mint shares
    // without paying — the original A-6 free-money branch).
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Investor has 200 mhUSDC. Try to buy 500 shares @ 1.0 = 500 mhUSDC cost.
    const enc = await encUint128(investorClient, 500n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, 500n, eph.address);

    // mhUSDC pull silent-failed: investor's balance is intact.
    const investorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(investorMh, 200n * ONE_PUSDC);

    // Treasury didn't receive anything (cash leg silent-failed).
    const treasuryMh = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryMh, 0n);

    // Share leg mirrors the cash leg → zero shares minted. This is the
    // Phase 7.6 fix — pre-fix this would have been 500 (free shares).
    const shares = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(shares, 0n);
  });

  // ── Phase 7.6 share/cash silent-fail mirror — purchase asymmetry ────────

  it("Case 6 — full-pay path mints exactly encSharesBounded (identity check)", async () => {
    // Mirror of Case 4 / Case 1 happy-path under the wrapper, framed as
    // an identity check on the new mirror. When `actualPaid == encCost`
    // (treasury fully receives), `actualShares = encSharesBounded`. The
    // mirror reduces to a no-op on the happy path.
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Buy 50 shares @ 1.0 NAV = 50 mhUSDC. Investor has 200 mhUSDC.
    const shares = 50n;
    const enc = await encUint128(investorClient, shares);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, shares, eph.address);

    // Identity: shares minted == encSharesBounded == requested 50.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      shares
    );
    // Cash moved exactly the cost.
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      shares * ONE_PUSDC
    );
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(investor.address),
      200n * ONE_PUSDC - shares * ONE_PUSDC
    );
  });

  it("Case 7 — ephemeralEOA decrypt grant survives silent-failed mint (Rule 2 + ADR-021)", async () => {
    // Locks in that the silent-failed branch still grants ephemeralEOA
    // ACL on the post-mint balance handle (mint with encrypted-zero still
    // creates a fresh handle). Without this, the investor's frontend
    // can't decrypt their (zero) share balance after the silent-fail —
    // forces a full ephemeralEOA refresh round-trip for what should be
    // a single read. Cheap regression check on the existing
    // mintFromSubscription ACL fan-out.
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // 500-share over-buy → cash silent-fails → share mints zero.
    const enc = await encUint128(investorClient, 500n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, 500n, eph.address);

    // ephemeralEOA must be allowed on the resulting balance handle.
    const balHandle = await token.encryptedBalanceOf(investor.address);
    const acl = await hre.cofhe.mocks.getMockACL();
    expect(await acl.isAllowed(BigInt(balHandle), eph.address)).to.equal(true);
  });

  it("Case 5 — deviation gate rejects → owner accepts → new NAV in force (wrapper-agnostic)", async () => {
    const {
      subscription,
      issuer,
      deployer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    // Seed NAV.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Try a 5% (500 bps) update — over the 25 bps gate.
    const newNav = (DEFAULT_NAV * 105n) / 100n;
    await oracle.connect(issuer).setNAV(await token.getAddress(), newNav);

    // Pending NAV parked; current NAV unchanged.
    const [navAfter, ] = await oracle.getNAV(await token.getAddress());
    expect(navAfter).to.equal(DEFAULT_NAV);

    // Purchase still works against the *prior* NAV.
    let enc = await encUint128(investorClient, 3n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);
    const bal = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(bal, 3n);

    // Owner accepts pending NAV → next purchase pays against the new NAV.
    await oracle.connect(deployer).acceptPendingNAV(await token.getAddress());
    const [navCommitted, ] = await oracle.getNAV(await token.getAddress());
    expect(navCommitted).to.equal(newNav);

    enc = await encUint128(investorClient, 2n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    const bal2 = await token.encryptedBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(bal2, 5n);
  });
});

// ── Phase 7.6 — Subscription.redeem refund-on-shortfall mirror ───────────

describe("Phase 7.6 — Subscription.redeem refund-on-shortfall", () => {
  /**
   * Phase 7.6 / ADR-043 reverse leg: when the wrapper's treasury → investor
   * pull silent-fails (treasury short of `actualBurned * nav`), the share
   * leg must refund the full `actualBurned` back to the investor via
   * `mintFromSubscription`. Net position: zero shares lost + zero mhUSDC
   * gained.
   *
   * The pre-Phase-7.6 path burned the shares first and then silently
   * underpaid through the legacy ADR-008 selector — the investor lost
   * shares without compensation. This case locks in the refund mirror.
   */

  it("Case 1 — refunds shares when treasury can't cover the redeem", async () => {
    const {
      subscription,
      treasury,
      issuer,
      investor,
      investorClient,
      issuerClient,
      token,
      mhUSDC,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Buy 100 shares costing 100 mhUSDC. After: investor has 100 mhUSDC + 100 shares;
    // treasury has 100 mhUSDC.
    const buyShares = 100n;
    const encBuy = await encUint128(investorClient, buyShares);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      buyShares
    );
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      buyShares * ONE_PUSDC
    );

    // Issuer drains 60 mhUSDC out of treasury via the legacy-shim withdraw
    // (silent-fail bounded by minFloat=0 → maxWithdraw = 100). Treasury
    // ends at 40 mhUSDC; less than the upcoming 100-mhUSDC redeem cost.
    const drainAmount = 60n * ONE_PUSDC;
    const encDrain = await encUint128(issuerClient, drainAmount);
    await treasury.connect(issuer).withdraw(encDrain);

    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      40n * ONE_PUSDC
    );

    // Snapshot pre-redeem investor mhUSDC for the net-zero invariant.
    const preInvestorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    await hre.cofhe.mocks.expectPlaintext(preInvestorMh, 100n * ONE_PUSDC);

    // Redeem the full 100 shares (cost would be 100 mhUSDC; treasury has 40).
    // Wrapper silent-fails the pull → actualPaid = 0 → fullPay = false →
    // refundShares = actualBurned = 100. Net position: investor still holds
    // 100 shares + 100 mhUSDC, treasury still holds 40 mhUSDC.
    const encRedeem = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .redeem(await token.getAddress(), encRedeem, 100n, eph.address);

    // Investor's share balance is restored via the refund mint.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      buyShares
    );

    // Investor's mhUSDC balance is unchanged.
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(investor.address),
      100n * ONE_PUSDC
    );

    // Treasury still holds the post-drain 40 mhUSDC.
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      40n * ONE_PUSDC
    );
  });

  it("Case 2 — refund mint preserves investor's holder-set membership (registry idempotent)", async () => {
    // The Phase 7.6 refund routes through `mintFromSubscription`, which
    // lands in `_mintInternal` → `addHolder`. addHolder is idempotent
    // (per ADR-022 `add-only` semantics + InvestorRegistry's duplicate
    // short-circuit), so a refund mint MUST NOT inflate the holder
    // count or fire a second registry registration.
    const {
      subscription,
      treasury,
      issuer,
      investor,
      investorClient,
      issuerClient,
      token,
      registry,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    const encBuy = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

    expect(await registry.holderCount(await token.getAddress())).to.equal(1n);

    // Drain treasury so the redeem leg refunds.
    const drainAmount = 60n * ONE_PUSDC;
    const encDrain = await encUint128(issuerClient, drainAmount);
    await treasury.connect(issuer).withdraw(encDrain);

    const encRedeem = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .redeem(await token.getAddress(), encRedeem, 100n, eph.address);

    // Holder count still 1 — refund mint short-circuited inside addHolder.
    expect(await registry.holderCount(await token.getAddress())).to.equal(1n);
    expect(
      await registry.isHolder(await token.getAddress(), investor.address)
    ).to.equal(true);
  });

  it("Case 3 — full-pay redeem identity check (cash leg succeeds → refundShares = 0)", async () => {
    const {
      subscription,
      treasury,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Buy 50 shares. Treasury holds 50 mhUSDC after.
    const encBuy = await encUint128(investorClient, 50n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

    // Redeem 50 — treasury can fully cover. Refund branch never fires.
    const encRedeem = await encUint128(investorClient, 50n);
    await subscription
      .connect(investor)
      .redeem(await token.getAddress(), encRedeem, 50n, eph.address);

    // Net: investor has 0 shares, full mhUSDC restored. Treasury empty.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      0n
    );
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(investor.address),
      200n * ONE_PUSDC
    );
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      0n
    );
  });
});

// ── Phase 7.6 — RedemptionQueue.processEpoch refund-on-shortfall ─────────

describe("Phase 7.6 — RedemptionQueue refund-on-shortfall", () => {
  /**
   * Mirror of the Subscription.redeem refund cases above against the
   * RedemptionQueue settlement path. Phase 7.6 / ADR-043 collapses the
   * cash pull into processEpoch — when the wrapper silent-fails the
   * treasury → investor pull, the queue refunds `r.encShares` back to
   * the investor (instead of burning them) so the investor's net
   * position over submit + settlement is zero.
   *
   * MockPUSDC has no silent-fail, so the cash-short branch can only be
   * exercised against a real `MuHavenStable` fixture. Builds a full
   * Subscription + Treasury + Queue topology around the wrapper.
   */

  async function deployQueueWrapperFixture() {
    await hre.run("task:cofhe-mocks:deploy");

    const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

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

    // Wrapper.
    const Stable = await hre.ethers.getContractFactory("MuHavenStable");
    const mhUSDC = await upgrades.deployProxy(
      Stable,
      [
        "MuHaven Confidential USD",
        "mhUSDC",
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const OracleFactory = await hre.ethers.getContractFactory("MockPriceOracle");
    const oracle = await OracleFactory.deploy();

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
        await mhUSDC.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const QueueFactory = await hre.ethers.getContractFactory("RedemptionQueue");
    const queue = await upgrades.deployProxy(
      QueueFactory,
      [
        deployer.address,
        await token.getAddress(),
        await tokenRegistry.getAddress(),
        await subscription.getAddress(),
        await mhUSDC.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
    const treasury = await upgrades.deployProxy(
      TreasuryFactory,
      [
        await token.getAddress(),
        await subscription.getAddress(),
        await queue.getAddress(),
        issuer.address,
        await mhUSDC.getAddress(),
        0n,
        deployer.address,
      ],
      { kind: "transparent", initializer: "initialize" }
    );

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

    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, BigInt(now));

    // Investor pre-wraps PUSDC → mhUSDC.
    await pusdc.mint(investor.address, 200n * ONE_PUSDC);
    await pusdc
      .connect(investor)
      .setOperator(await mhUSDC.getAddress(), FOREVER);

    const investorClient = await hre.cofhe.createClientWithBatteries(investor);
    const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

    const eph = createEphemeralEOA();

    const encWrap = await encUint64(investorClient, 200n * ONE_PUSDC);
    await mhUSDC.connect(investor).wrap(encWrap, eph.address);

    await mhUSDC
      .connect(investor)
      .setOperator(await subscription.getAddress(), FOREVER);

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
      queue,
      pusdc,
      mhUSDC,
      oracle,
      subscription,
      investorClient,
      issuerClient,
      eph,
    };
  }

  it("Case 1 — refunds queue-locked shares when treasury can't cover", async () => {
    const {
      subscription,
      queue,
      treasury,
      issuer,
      investor,
      investorClient,
      issuerClient,
      token,
      mhUSDC,
      eph,
    } = await loadFixture(deployQueueWrapperFixture);

    // Buy 100 shares (cost 100 mhUSDC). Treasury holds 100 mhUSDC.
    const encBuy = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

    // Drain treasury to 40 mhUSDC.
    const encDrain = await encUint128(issuerClient, 60n * ONE_PUSDC);
    await treasury.connect(issuer).withdraw(encDrain);

    // Investor submits 100 shares to the queue.
    const encSubmit = await encUint128(investorClient, 100n);
    await queue.connect(investor).submit(encSubmit, HINT_CAP, eph.address);

    // Queue holds 100 shares; investor's balance is 0.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(await queue.getAddress()),
      100n
    );
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      0n
    );

    // Process epoch. Cash leg silent-fails (treasury short of 100 mhUSDC).
    // Queue burns 0, returns r.encShares = 100 back to investor.
    const epoch = await queue.currentEpoch();
    await queue.connect(issuer).processEpoch(epoch, 0, 1);

    // Investor balance restored to 100 (refund mint).
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      100n
    );
    // Queue holds 0 shares (returned).
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(await queue.getAddress()),
      0n
    );
    // Investor's mhUSDC balance unchanged from pre-redeem (cash-short).
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(investor.address),
      100n * ONE_PUSDC
    );
    // Treasury still holds the post-drain 40 mhUSDC.
    await hre.cofhe.mocks.expectPlaintext(
      await mhUSDC.confidentialBalanceOf(await treasury.getAddress()),
      40n * ONE_PUSDC
    );

    // Settlement flipped settled + claimed atomically.
    const r = await queue.getRequest(1n);
    expect(r.settled).to.equal(true);
    expect(r.claimed).to.equal(true);
  });

  it("Case 2 — Phase 7.6-E: investor's eph cannot decrypt treasury's mhUSDC after settlement", async () => {
    // Counterpart of Phase 7.6-E Case 1/Case 2 against the queue
    // settlement path. The wrapper's modern surface (Phase 7.6-E
    // 5-arg variant) must keep the treasury's post-settlement mhUSDC
    // handle out of the investor's session ACL.
    const {
      subscription,
      queue,
      treasury,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      eph,
    } = await loadFixture(deployQueueWrapperFixture);

    // Buy 50 shares (cost 50 mhUSDC) → treasury holds 50 mhUSDC.
    const encBuy = await encUint128(investorClient, 50n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), encBuy, HINT_CAP, eph.address);

    // Investor submits 30 shares to the queue.
    const encSubmit = await encUint128(investorClient, 30n);
    await queue.connect(investor).submit(encSubmit, HINT_CAP, eph.address);

    // Process epoch — happy path (treasury can cover).
    const epoch = await queue.currentEpoch();
    await queue.connect(issuer).processEpoch(epoch, 0, 1);

    const treasuryBal = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    const acl = await hre.cofhe.mocks.getMockACL();

    // Treasury's POST-settlement mhUSDC handle: investor's eph NOT granted.
    expect(await acl.isAllowed(BigInt(treasuryBal), eph.address)).to.equal(
      false
    );
    // Investor's mhUSDC handle: investor's eph IS granted (recipient leg).
    const investorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    expect(await acl.isAllowed(BigInt(investorMh), eph.address)).to.equal(
      true
    );
  });
});

// ── Phase 7.6-E / ADR-044 — split-grant treasury-leak fix ────────────────

describe("Phase 7.6-E — treasury-leak fix (split-grant transferFrom)", () => {
  /**
   * Closes audit-prep §A-9 surfaced during the Phase 7.6-D self-review:
   * before this fix, the wrapper's 4-arg `transferFrom` granted the
   * passed `ephemeralEOA` on BOTH legs, so contract-mediated paths
   * (Subscription.purchase, _settleRedeem, RedemptionQueue settlement)
   * leaked the treasury's mhUSDC balance handle to the investor's
   * session. Phase 7.6-E switches those call sites to the new 5-arg
   * variant which suppresses the counterparty leg's grant.
   *
   * These cases lock in the post-fix invariant: after a contract-
   * mediated transfer touching the treasury, the investor's eph has
   * NO ACL on the treasury's resulting mhUSDC balance handle.
   */

  it("Case 1 — purchase: investor's eph cannot decrypt treasury's post-pull mhUSDC", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    const enc = await encUint128(investorClient, 10n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    const treasuryBal = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    const acl = await hre.cofhe.mocks.getMockACL();

    // Investor's eph must NOT be granted on the treasury's mhUSDC handle.
    expect(await acl.isAllowed(BigInt(treasuryBal), eph.address)).to.equal(
      false
    );
    // Treasury's own kernel grant still fires.
    expect(
      await acl.isAllowed(BigInt(treasuryBal), await treasury.getAddress())
    ).to.equal(true);
    // Investor's eph IS granted on their own mhUSDC handle (sender leg).
    const investorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    expect(await acl.isAllowed(BigInt(investorMh), eph.address)).to.equal(
      true
    );
  });

  it("Case 2 — redeem: investor's eph cannot decrypt treasury's post-payout mhUSDC", async () => {
    const {
      subscription,
      issuer,
      investor,
      investorClient,
      token,
      mhUSDC,
      treasury,
      oracle,
      eph,
    } = await loadFixture(deployWrapperFixture);

    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Buy 10 shares → treasury accumulates 10 mhUSDC.
    let enc = await encUint128(investorClient, 10n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Redeem 5 shares → treasury → investor pull moves 5 mhUSDC.
    enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .redeem(await token.getAddress(), enc, HINT_CAP, eph.address);

    const treasuryBal = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    const acl = await hre.cofhe.mocks.getMockACL();

    // Treasury's POST-redeem balance handle: investor's eph NOT granted.
    expect(await acl.isAllowed(BigInt(treasuryBal), eph.address)).to.equal(
      false
    );
    // Investor's eph IS granted on their own mhUSDC handle (recipient leg).
    const investorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    expect(await acl.isAllowed(BigInt(investorMh), eph.address)).to.equal(
      true
    );
  });
});

// ── Phase 8 blocker fix — YieldSnapshot.claimYield split-grant ───────────

describe("Phase 8 — YieldSnapshot.claimYield split-grant (PHASE8_BLOCKER fix)", () => {
  /**
   * Closes `PHASE8_BLOCKER_YIELD_CLAIM_DECRYPT.md`. Pre-fix,
   * `YieldSnapshot.claimYield` paid out via `MuHavenStable`'s legacy
   * 2-arg `confidentialTransfer(address,uint256)` shim which hard-coded
   * both eph args to `address(0)`. The post-claim mhUSDC balance handle
   * had only a kernel ACL grant, so the investor's first `decryptForView`
   * 403'd and the frontend `refreshDecryptGrant` fallback couldn't fully
   * recover (cofhe SDK internal retry × TN ACL propagation lag → "indefinite
   * spinner"). Phase 8 switches the payout to the modern split-grant
   * `IMuHavenStable.transferFrom(self, investor, encShare64, address(0),
   * ephemeralEOA)` per ADR-044, planting the session-EOA grant on the
   * investor's grown mhUSDC handle in the same tx as the transfer.
   *
   * These cases lock in: (a) the investor's eph IS granted on their post-
   * claim mhUSDC (the "first decrypt succeeds" guarantee), and (b) the
   * snapshot's own mhUSDC float stays kernel-only — investors cannot
   * decrypt the float (mirrors A-9 treasury-leak invariant).
   */

  async function deploySnapshotWrapperFixture() {
    await hre.run("task:cofhe-mocks:deploy");

    const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

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

    const Stable = await hre.ethers.getContractFactory("MuHavenStable");
    const mhUSDC = await upgrades.deployProxy(
      Stable,
      [
        "MuHaven Confidential USD",
        "mhUSDC",
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const OracleFactory = await hre.ethers.getContractFactory(
      "IssuerControlledOracle"
    );
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

    // Subscription wired to mhUSDC so investors purchase via the wrapper.
    const SubFactory = await hre.ethers.getContractFactory(
      "MuHavenSubscription"
    );
    const subscription = await upgrades.deployProxy(
      SubFactory,
      [
        deployer.address,
        await tokenRegistry.getAddress(),
        await kyc.getAddress(),
        await mhUSDC.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    // Treasury wired to mhUSDC.
    const TreasuryFactory = await hre.ethers.getContractFactory(
      "MuHavenTreasury"
    );
    const treasury = await upgrades.deployProxy(
      TreasuryFactory,
      [
        await token.getAddress(),
        await subscription.getAddress(),
        alice.address,
        issuer.address,
        await mhUSDC.getAddress(),
        0n,
        deployer.address,
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    // Snapshot wired to mhUSDC — the contract under test for this suite.
    const YSFactory = await hre.ethers.getContractFactory("YieldSnapshot");
    const snapshot = await upgrades.deployProxy(
      YSFactory,
      [
        deployer.address,
        await tokenRegistry.getAddress(),
        await mhUSDC.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    // Register snapshot as a trusted payer on the wrapper so claimYield's
    // `IMuHavenStable.trustedPayout(...)` call is authorized (Phase 8
    // Option B / ADR-046). Without this, claimYield reverts NotTrustedPayer.
    await mhUSDC.setTrustedPayer(await snapshot.getAddress(), true);

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

    await token.setSubscription(await subscription.getAddress());
    await token.setYieldSnapshot(await snapshot.getAddress());

    await oracle.setNavWriter(await token.getAddress(), issuer.address);
    await oracle.setMaxDeviationBps(await token.getAddress(), 25n);
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    // Investor pre-wraps PUSDC → mhUSDC + buys 100 shares so they hold a
    // snapshottable balance.
    await pusdc.mint(investor.address, 200n * ONE_PUSDC);
    await pusdc
      .connect(investor)
      .setOperator(await mhUSDC.getAddress(), FOREVER);

    const investorClient = await hre.cofhe.createClientWithBatteries(investor);
    const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

    const eph = createEphemeralEOA();
    const investorWrapEph = createEphemeralEOA();

    const encWrap = await encUint64(investorClient, 200n * ONE_PUSDC);
    await mhUSDC.connect(investor).wrap(encWrap, investorWrapEph.address);

    await mhUSDC
      .connect(investor)
      .setOperator(await subscription.getAddress(), FOREVER);

    const encShares = await encUint128(investorClient, 100n);
    await subscription
      .connect(investor)
      .purchase(
        await token.getAddress(),
        encShares,
        HINT_CAP,
        investorWrapEph.address
      );

    // Issuer pre-wraps + grants the snapshot operator rights so fundEpoch
    // can pull the yield pool.
    await pusdc.mint(issuer.address, 200n * ONE_PUSDC);
    await pusdc
      .connect(issuer)
      .setOperator(await mhUSDC.getAddress(), FOREVER);
    const issuerWrapEph = createEphemeralEOA();
    const encIssuerWrap = await encUint64(issuerClient, 200n * ONE_PUSDC);
    await mhUSDC.connect(issuer).wrap(encIssuerWrap, issuerWrapEph.address);
    await mhUSDC
      .connect(issuer)
      .setOperator(await snapshot.getAddress(), FOREVER);

    return {
      deployer,
      issuer,
      investor,
      alice,
      token,
      tokenRegistry,
      treasury,
      pusdc,
      mhUSDC,
      oracle,
      subscription,
      snapshot,
      investorClient,
      issuerClient,
      eph,
    };
  }

  it("Case 1 — investor's eph IS granted on post-claim mhUSDC handle (decrypt-first-try guarantee)", async () => {
    const { snapshot, issuer, investor, token, mhUSDC, issuerClient, eph } =
      await loadFixture(deploySnapshotWrapperFixture);

    // Run a one-investor epoch end-to-end.
    await snapshot.connect(issuer).openEpoch(await token.getAddress());
    await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
    await snapshot.connect(issuer).finalizeSnapshot(1n);
    const encYield = await encUint128(issuerClient, 50n * ONE_PUSDC);
    // Phase 9.B / Option A — single-investor epoch (60 shares).
    // ratePerShare = floor(50e6 / 60) = 833_333.
    await snapshot.connect(issuer).fundEpoch(1n, encYield, (50n * ONE_PUSDC) / 60n);

    await snapshot.connect(investor).claimYield(1n, eph.address);

    // The investor's grown mhUSDC handle must have the eph ACL grant
    // baked in — pre-fix this would have been kernel-only (the legacy
    // shim path), forcing a refresh round-trip.
    const investorMh = await mhUSDC.confidentialBalanceOf(investor.address);
    const acl = await hre.cofhe.mocks.getMockACL();
    expect(await acl.isAllowed(BigInt(investorMh), eph.address)).to.equal(
      true
    );
    // Investor's own kernel grant still fires.
    expect(
      await acl.isAllowed(BigInt(investorMh), investor.address)
    ).to.equal(true);
  });

  it("Case 2 — snapshot's float stays kernel-only (treasury-leak invariant, A-9 mirror)", async () => {
    const { snapshot, issuer, investor, token, mhUSDC, issuerClient, eph } =
      await loadFixture(deploySnapshotWrapperFixture);

    await snapshot.connect(issuer).openEpoch(await token.getAddress());
    await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
    await snapshot.connect(issuer).finalizeSnapshot(1n);
    const encYield = await encUint128(issuerClient, 50n * ONE_PUSDC);
    // Phase 9.B / Option A — single-investor epoch (60 shares).
    // ratePerShare = floor(50e6 / 60) = 833_333.
    await snapshot.connect(issuer).fundEpoch(1n, encYield, (50n * ONE_PUSDC) / 60n);

    await snapshot.connect(investor).claimYield(1n, eph.address);

    // Snapshot's mhUSDC float (the leftover after paying the investor)
    // must NOT be decryptable by the investor's eph — mirrors the A-9
    // treasury-leak invariant for Subscription / RedemptionQueue.
    const snapshotMh = await mhUSDC.confidentialBalanceOf(
      await snapshot.getAddress()
    );
    const acl = await hre.cofhe.mocks.getMockACL();
    expect(await acl.isAllowed(BigInt(snapshotMh), eph.address)).to.equal(
      false
    );
    // Snapshot's own kernel grant still fires (it needs to spend its float).
    expect(
      await acl.isAllowed(BigInt(snapshotMh), await snapshot.getAddress())
    ).to.equal(true);
  });

  it("Case 3 — encShare128 grant on investor's eph survives (legacy ADR-021 guarantee)", async () => {
    const { snapshot, issuer, investor, token, issuerClient, eph } =
      await loadFixture(deploySnapshotWrapperFixture);

    await snapshot.connect(issuer).openEpoch(await token.getAddress());
    await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
    await snapshot.connect(issuer).finalizeSnapshot(1n);
    const encYield = await encUint128(issuerClient, 50n * ONE_PUSDC);
    // Phase 9.B / Option A — single-investor epoch (60 shares).
    // ratePerShare = floor(50e6 / 60) = 833_333.
    await snapshot.connect(issuer).fundEpoch(1n, encYield, (50n * ONE_PUSDC) / 60n);

    // The encShare128 ACL grant (per ADR-021) must still be present —
    // Phase 8 only changed the mhUSDC payout leg, not the share-handle
    // grant emitted alongside `YieldClaimed`. Locked in here so a future
    // refactor doesn't accidentally drop ADR-021's guarantee.
    const tx = await snapshot
      .connect(investor)
      .claimYield(1n, eph.address);
    await tx.wait();

    // Sanity — second claim still reverts AlreadyClaimed.
    await expect(
      snapshot.connect(investor).claimYield(1n, eph.address)
    ).to.be.revertedWithCustomError(snapshot, "AlreadyClaimed");
  });
});

// ── migrateToWrapper helper coverage ─────────────────────────────────────

describe("Phase 7.5-B — MuHavenTreasury.migrateToWrapper", () => {
  /**
   * Treasury starts wired to legacy PUSDC, holds a float, then migrates
   * to MuHavenStable in one tx. After migration:
   *   - `treasury.pusdc()` points at mhUSDC.
   *   - The wrapper holds the legacy PUSDC custody (1:1 backing).
   *   - The wrapper's totalSupply equals what the treasury just received.
   *   - The treasury's mhUSDC balance equals the migrated float.
   */
  async function deployMigrationFixture() {
    await hre.run("task:cofhe-mocks:deploy");

    const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

    const kyc = await deployKYCAdapter();
    await kyc.addToWhitelist(investor.address);

    const registry = await deployRegistry();
    const token = await deployToken(
      await kyc.getAddress(),
      await registry.getAddress(),
      issuer.address
    );
    await registry.setAuthorizedCaller(await token.getAddress(), true);

    const pusdc = await deployMockPUSDC();

    // Subscription pre-deployed (placeholder for Treasury init).
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
        await pusdc.getAddress(), // initial: legacy
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
    const treasury = await upgrades.deployProxy(
      TreasuryFactory,
      [
        await token.getAddress(),
        await subscription.getAddress(),
        alice.address, // queue placeholder
        issuer.address,
        await pusdc.getAddress(),
        0n,
        deployer.address,
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    // Seed treasury with legacy PUSDC float. MockPUSDC.mint is a test
    // helper that takes cleartext; in production the issuer would call
    // `confidentialTransfer` from their own balance, but the on-chain
    // outcome is the same — treasury holds an encrypted balance handle.
    await pusdc.mint(await treasury.getAddress(), 50n * ONE_PUSDC);

    // Wrapper deployed (post-treasury-fund).
    const Stable = await hre.ethers.getContractFactory("MuHavenStable");
    const mhUSDC = await upgrades.deployProxy(
      Stable,
      [
        "MuHaven Confidential USD",
        "mhUSDC",
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    return {
      deployer,
      issuer,
      investor,
      alice,
      treasury,
      subscription,
      pusdc,
      mhUSDC,
      token,
    };
  }

  it("migrateToWrapper wraps the float and rotates the pointer", async () => {
    const { treasury, issuer, alice, subscription, pusdc, mhUSDC } =
      await loadFixture(deployMigrationFixture);

    // Pre-state: treasury PUSDC balance handle is initialised.
    const preBalRaw = await pusdc.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(preBalRaw, 50n * ONE_PUSDC);

    await expect(treasury.connect(issuer).migrateToWrapper(await mhUSDC.getAddress()))
      .to.emit(treasury, "TreasuryMigrated")
      .withArgs(await pusdc.getAddress(), await mhUSDC.getAddress());

    // Pointer rotated.
    expect(await treasury.pusdc()).to.equal(await mhUSDC.getAddress());

    // Wrapper holds the legacy PUSDC.
    const wrapperPusdcBal = await pusdc.confidentialBalanceOf(
      await mhUSDC.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(wrapperPusdcBal, 50n * ONE_PUSDC);

    // Treasury's mhUSDC balance matches the migrated float.
    const treasuryMh = await mhUSDC.confidentialBalanceOf(
      await treasury.getAddress()
    );
    await hre.cofhe.mocks.expectPlaintext(treasuryMh, 50n * ONE_PUSDC);

    // Wrapper total supply == migrated float (1:1 invariant).
    const ts = await mhUSDC.confidentialTotalSupply();
    await hre.cofhe.mocks.expectPlaintext(ts, 50n * ONE_PUSDC);

    // Subscription / Queue gained operator rights on the wrapper.
    expect(
      await mhUSDC.isOperator(
        await treasury.getAddress(),
        await subscription.getAddress()
      )
    ).to.equal(true);
    expect(
      await mhUSDC.isOperator(await treasury.getAddress(), alice.address)
    ).to.equal(true);
  });

  it("migrateToWrapper rejects calling with the current pointer", async () => {
    const { treasury, issuer, pusdc } =
      await loadFixture(deployMigrationFixture);

    await expect(
      treasury.connect(issuer).migrateToWrapper(await pusdc.getAddress())
    ).to.be.revertedWithCustomError(treasury, "AlreadyMigrated");
  });

  it("migrateToWrapper rejects zero address", async () => {
    const { treasury, issuer } = await loadFixture(deployMigrationFixture);
    await expect(
      treasury.connect(issuer).migrateToWrapper(hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
  });

  it("migrateToWrapper is issuer-only", async () => {
    const { treasury, alice, mhUSDC } =
      await loadFixture(deployMigrationFixture);
    await expect(
      treasury.connect(alice).migrateToWrapper(await mhUSDC.getAddress())
    ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");
  });

  it("migrateToWrapper short-circuits on empty treasury (only rotates pointer)", async () => {
    // Fresh fixture without seeding the treasury.
    await hre.run("task:cofhe-mocks:deploy");
    const [deployer, issuer, investor, alice] = await hre.ethers.getSigners();

    const kyc = await deployKYCAdapter();
    await kyc.addToWhitelist(investor.address);
    const registry = await deployRegistry();
    const token = await deployToken(
      await kyc.getAddress(),
      await registry.getAddress(),
      issuer.address
    );
    await registry.setAuthorizedCaller(await token.getAddress(), true);

    const pusdc = await deployMockPUSDC();

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
        alice.address,
        issuer.address,
        await pusdc.getAddress(),
        0n,
        deployer.address,
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    const Stable = await hre.ethers.getContractFactory("MuHavenStable");
    const mhUSDC = await upgrades.deployProxy(
      Stable,
      [
        "MuHaven Confidential USD",
        "mhUSDC",
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    // Treasury never received PUSDC — short-circuit branch.
    await expect(treasury.connect(issuer).migrateToWrapper(await mhUSDC.getAddress()))
      .to.emit(treasury, "TreasuryMigrated");

    // Pointer rotated; wrapper supply still uninitialised.
    expect(await treasury.pusdc()).to.equal(await mhUSDC.getAddress());
    const ts = await mhUSDC.confidentialTotalSupply();
    expect(ts).to.equal(hre.ethers.ZeroHash);
  });
});
