/**
 * Wave 3.5 Phase 4 cross-contract integration tests.
 *
 * Phase 4 sub-phase 4 (`WAVE_3_5_REVISED.md`): ~3+ integration cases that
 * exercise the full Queue + Treasury + Subscription stack end-to-end.
 *
 * Cases:
 *   1. Full queued redemption lifecycle: submit → processEpoch → claim.
 *   2. Subscription auto-escalate on cap overflow: redeem over-cap →
 *      escalate → processEpoch → claim.
 *   3. KYC-revocation cancellation mid-queue: submit → revoke → cancel →
 *      investor gets shares back.
 *   4. Queue + Treasury solvency interplay: insufficient treasury at
 *      claim time → claim succeeds but investor PUSDC doesn't move
 *      (PUSDC-side behaviour under the legacy selector).
 *
 * Uses the real `IssuerControlledOracle` so the freshness + deviation gates
 * are exercised at submit + processEpoch.
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

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function deployQueueIntegrationFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob] = await hre.ethers.getSigners();

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

  // Real IssuerControlledOracle — same as Phase 2 integration fixture.
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

  await oracle.setNavWriter(await token.getAddress(), issuer.address);
  await oracle.setMaxDeviationBps(await token.getAddress(), 25n);
  await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

  // Investor: PUSDC + operator approval + seed purchase for 100 shares.
  await pusdc.mint(investor.address, 1000n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const eph = createEphemeralEOA();
  const investorClient = await hre.cofhe.createClientWithBatteries(investor);

  const seedShares = 100n;
  const encSeed = await encUint128(investorClient, seedShares);
  await subscription
    .connect(investor)
    .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

  // Extra PUSDC in treasury for claim pay-outs.
  await pusdc.mint(await treasury.getAddress(), 500n * ONE_PUSDC);

  return {
    deployer,
    issuer,
    investor,
    alice,
    bob,
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
    eph,
    seedShares,
  };
}

describe("Wave 3.5 Phase 4 integration — RedemptionQueue end-to-end", () => {
  // ── Case 1: submit → processEpoch → claim ───────────────────────────────

  it("Case 1 — full queued redemption: submit → processEpoch → claim (live NAV)", async () => {
    const {
      queue,
      issuer,
      investor,
      investorClient,
      token,
      pusdc,
      treasury,
      eph,
      seedShares,
    } = await loadFixture(deployQueueIntegrationFixture);

    const qty = 25n;
    const enc = await encUint128(investorClient, qty);

    // Submit
    await expect(
      queue.connect(investor).submit(enc, HINT_CAP, eph.address)
    )
      .to.emit(queue, "QueueSubmitted")
      .withArgs(investor.address, 1n, await queue.currentEpoch());

    // Investor balance down by qty; queue balance up by qty.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      seedShares - qty
    );
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(await queue.getAddress()),
      qty
    );

    // Process epoch
    const epoch = await queue.currentEpoch();
    await queue.connect(issuer).processEpoch(epoch, 0, 1);

    const r = await queue.getRequest(1n);
    expect(r.settled).to.equal(true);
    await hre.cofhe.mocks.expectPlaintext(r.encProceeds, qty * ONE_PUSDC);

    // Burn from queue balance was done inside processEpoch (keeps total
    // supply consistent). Queue's token balance returns to zero.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(await queue.getAddress()),
      0n
    );

    // Claim
    const treasuryBefore = await pusdc.confidentialBalanceOf(await treasury.getAddress());
    await hre.cofhe.mocks.expectPlaintext(treasuryBefore, 600n * ONE_PUSDC);

    await expect(queue.connect(investor).claim(1n))
      .to.emit(queue, "QueueClaimed")
      .withArgs(investor.address, 1n);

    // Investor PUSDC: 900 (after purchase) + qty = 925.
    await hre.cofhe.mocks.expectPlaintext(
      await pusdc.confidentialBalanceOf(investor.address),
      900n * ONE_PUSDC + qty * ONE_PUSDC
    );

    // Treasury PUSDC: 600 - qty = 575.
    await hre.cofhe.mocks.expectPlaintext(
      await pusdc.confidentialBalanceOf(await treasury.getAddress()),
      600n * ONE_PUSDC - qty * ONE_PUSDC
    );

    expect((await queue.getRequest(1n)).claimed).to.equal(true);
  });

  // ── Case 2: auto-escalate on cap overflow ───────────────────────────────

  it("Case 2 — Subscription.redeem escalates over-cap → processEpoch → claim", async () => {
    const {
      subscription,
      queue,
      tokenRegistry,
      issuer,
      investor,
      investorClient,
      token,
      pusdc,
      eph,
    } = await loadFixture(deployQueueIntegrationFixture);

    // Tighten cap to 5 PUSDC so a 10-share (= 10 PUSDC) redeem must
    // escalate.
    await tokenRegistry
      .connect(issuer)
      .setInstantRedeemCap(await token.getAddress(), 5n * ONE_PUSDC);

    const qty = 10n;
    const enc = await encUint128(investorClient, qty);

    await expect(
      subscription
        .connect(investor)
        .redeem(await token.getAddress(), enc, qty, eph.address)
    )
      .to.emit(subscription, "Redeemed")
      .withArgs(await token.getAddress(), investor.address, qty, true)
      .and.to.emit(subscription, "EscalatedToQueue")
      .withArgs(await token.getAddress(), investor.address, 1n);

    // Request shows the investor (not Subscription).
    const r = await queue.getRequest(1n);
    expect(r.investor).to.equal(investor.address);

    // Process + claim.
    const epoch = await queue.currentEpoch();
    await queue.connect(issuer).processEpoch(epoch, 0, 1);
    await queue.connect(investor).claim(1n);

    // Investor PUSDC up by qty (claim payout).
    await hre.cofhe.mocks.expectPlaintext(
      await pusdc.confidentialBalanceOf(investor.address),
      900n * ONE_PUSDC + qty * ONE_PUSDC
    );

    // Instant cap counter unchanged — escalation doesn't consume the
    // instant-redeem cap.
    const epochId = await subscription.getCurrentEpoch(await token.getAddress());
    expect(
      await subscription.instantRedeemedThisEpoch(
        await token.getAddress(),
        epochId
      )
    ).to.equal(0n);
  });

  // ── Case 3: KYC revocation cancel ───────────────────────────────────────

  it("Case 3 — KYC-revocation cancel: submit → revoke → cancel returns shares", async () => {
    const {
      queue,
      deployer,
      issuer,
      investor,
      investorClient,
      token,
      eph,
      seedShares,
    } = await loadFixture(deployQueueIntegrationFixture);

    const qty = 30n;
    await queue
      .connect(investor)
      .submit(await encUint128(investorClient, qty), HINT_CAP, eph.address);

    // Investor shares now locked in queue.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      seedShares - qty
    );

    // Wire a deny-all identity registry to simulate KYC revocation.
    const Deny = await hre.ethers.getContractFactory("DenyAllIdentityRegistry");
    const deny = await Deny.deploy();
    await queue.connect(deployer).setIdentityRegistry(await deny.getAddress());

    // Cancel — shares return to investor.
    await expect(queue.connect(issuer).cancelOnKYCRevocation(1n))
      .to.emit(queue, "QueueCancelled")
      .withArgs(investor.address, 1n);

    // Investor balance restored.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(investor.address),
      seedShares
    );

    // Queue balance back to zero.
    await hre.cofhe.mocks.expectPlaintext(
      await token.encryptedBalanceOf(await queue.getAddress()),
      0n
    );

    // processEpoch over the cancelled request is a no-op.
    const epoch = await queue.currentEpoch();
    await expect(queue.connect(issuer).processEpoch(epoch, 0, 1))
      .to.emit(queue, "EpochProcessed")
      .withArgs(epoch, 0n);
  });

  // ── Case 4: Queue + Treasury solvency interplay (paginated) ─────────────

  it("Case 4 — paginated settlement: many submits, partial processEpoch, claims interleave", async () => {
    // Four distinct submits from the same investor; issuer processes in
    // two slices [0,2) and [2,4). Investor claims in any order as long as
    // the request is settled. Locks in the paginated-settlement gas
    // profile + out-of-order claim semantics.
    const {
      queue,
      issuer,
      investor,
      investorClient,
      pusdc,
      eph,
    } = await loadFixture(deployQueueIntegrationFixture);

    const qtys = [3n, 7n, 11n, 13n];
    for (const qty of qtys) {
      const enc = await encUint128(investorClient, qty);
      await queue.connect(investor).submit(enc, HINT_CAP, eph.address);
    }

    const epoch = await queue.currentEpoch();

    // First slice: settle requests 1, 2.
    await queue.connect(issuer).processEpoch(epoch, 0, 2);
    expect((await queue.getRequest(1n)).settled).to.equal(true);
    expect((await queue.getRequest(2n)).settled).to.equal(true);
    // Requests 3, 4 still unsettled → claim before settlement reverts.
    await expect(queue.connect(investor).claim(3n))
      .to.be.revertedWithCustomError(queue, "NotSettled");

    // Investor claims request 2 out of insertion order — works.
    await queue.connect(investor).claim(2n);

    // Second slice: settle requests 3, 4.
    await queue.connect(issuer).processEpoch(epoch, 2, 4);

    // Claim the remaining three.
    await queue.connect(investor).claim(1n);
    await queue.connect(investor).claim(3n);
    await queue.connect(investor).claim(4n);

    // Investor PUSDC final = 900 (post-purchase) + sum(qtys) = 900 + 34 = 934.
    const total = qtys.reduce((a, b) => a + b, 0n);
    await hre.cofhe.mocks.expectPlaintext(
      await pusdc.confidentialBalanceOf(investor.address),
      900n * ONE_PUSDC + total * ONE_PUSDC
    );
  });

  // ── Case 5: Stale NAV blocks processEpoch, resumes after refresh ────────

  it("Case 5 — stale NAV blocks processEpoch; resumes after a fresh publish", async () => {
    const {
      queue,
      issuer,
      investor,
      investorClient,
      token,
      oracle,
      eph,
    } = await loadFixture(deployQueueIntegrationFixture);

    const qty = 5n;
    await queue
      .connect(investor)
      .submit(await encUint128(investorClient, qty), HINT_CAP, eph.address);

    const epoch = await queue.currentEpoch();

    // Advance clock past the 36h staleness window — NAV now stale.
    await time.increase(37 * 60 * 60);

    await expect(
      queue.connect(issuer).processEpoch(epoch, 0, 1)
    ).to.be.revertedWithCustomError(queue, "StaleNAV");

    // Fresh NAV publish resumes settlement.
    await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

    await queue.connect(issuer).processEpoch(epoch, 0, 1);
    expect((await queue.getRequest(1n)).settled).to.equal(true);
  });
});
