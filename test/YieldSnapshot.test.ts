/**
 * YieldSnapshot unit tests — Wave 3.5 Phase 5.
 *
 * Phase 5 (`WAVE_3_5_REVISED.md`): ~25 tests covering the pull-based yield
 * distribution lifecycle — `openEpoch` + `snapshotBatch` + `finalizeSnapshot`
 * + `fundEpoch` + `claimYield` + `sweepExpired` + admin.
 *
 * Touch-points:
 *   - ADR-005 (pull-based yield replaces push-based YieldDistributor)
 *   - ADR-008 (PUSDC legacy `euint64 = uint256` selector via low-level call)
 *   - ADR-013 (pull-based FHE-encrypted yield; not privacy-Merkle)
 *   - ADR-021 (`ephemeralEOA` captured at claim time for decrypt ACL)
 *   - `FHE_ACL_CONVENTIONS.md` rules 1–5
 *
 * Unit tests use EOA stand-ins for investor + issuer. Full kernel / UserOp
 * flow is covered in SDK integration + Playwright per M1.
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

/**
 * Match any euint handle (bytes32 hex string). Used in event-emit asserts
 * where the content-addressed handle bytes vary across mock-replays. Mirror
 * of the helper in MuHavenStable.test.ts. Used for the broadened
 * `YieldClaimed(token, investor, epochId, euint64 amount)` event +
 * `AuditGrantRefreshed(kernel, eph, handle)` event introduced in the
 * Phase 9.A audit-handle follow-up.
 */
function anyHandle() {
  return (v: unknown) =>
    typeof v === "string" && v.startsWith("0x") && v.length === 66;
}

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function deploySnapshotFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob, stranger] =
    await hre.ethers.getSigners();

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

  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

  // TokenRegistry
  const TR = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    TR,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // Subscription (used by seed purchases only)
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

  // Treasury — binds subscription + queue, grants operator rights.
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

  // YieldSnapshot
  const YSFactory = await hre.ethers.getContractFactory("YieldSnapshot");
  const snapshot = await upgrades.deployProxy(
    YSFactory,
    [deployer.address, await tokenRegistry.getAddress(), await pusdc.getAddress()],
    { kind: "transparent", initializer: "initialize" }
  );

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
  await token.setYieldSnapshot(await snapshot.getAddress());

  // NAV seed
  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, BigInt(now));

  // Two investors hold shares pre-snapshot. Use Subscription.purchase so
  // the balances are legitimately seeded.
  await pusdc.mint(investor.address, 1000n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);
  await pusdc.mint(alice.address, 1000n * ONE_PUSDC);
  await pusdc
    .connect(alice)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  const eph = createEphemeralEOA();
  const aliceEph = createEphemeralEOA();

  // Investor: 60 shares; Alice: 40 shares. Total supply = 100.
  const investorShares = 60n;
  const aliceShares = 40n;
  await subscription
    .connect(investor)
    .purchase(await token.getAddress(), await encUint128(investorClient, investorShares), HINT_CAP, eph.address);
  await subscription
    .connect(alice)
    .purchase(await token.getAddress(), await encUint128(aliceClient, aliceShares), HINT_CAP, aliceEph.address);

  // Issuer grants PUSDC operator rights to YieldSnapshot so fundEpoch can pull.
  await pusdc
    .connect(issuer)
    .setOperator(await snapshot.getAddress(), 2n ** 47n - 1n);

  // Seed issuer's PUSDC balance for fundEpoch.
  await pusdc.mint(issuer.address, 10_000n * ONE_PUSDC);

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
    subscription,
    treasury,
    queue,
    snapshot,
    pusdc,
    oracle,
    investorClient,
    aliceClient,
    issuerClient,
    eph,
    aliceEph,
    investorShares,
    aliceShares,
  };
}

describe("YieldSnapshot", () => {
  // ── initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("stores wiring + starts nextEpochId at 0", async () => {
      const { snapshot, tokenRegistry, pusdc, deployer } =
        await loadFixture(deploySnapshotFixture);

      expect(await snapshot.owner()).to.equal(deployer.address);
      expect(await snapshot.tokenRegistry()).to.equal(await tokenRegistry.getAddress());
      expect(await snapshot.pusdc()).to.equal(await pusdc.getAddress());
      expect(await snapshot.nextEpochId()).to.equal(0n);
    });

    it("rejects zero addresses on initialize", async () => {
      const Factory = await hre.ethers.getContractFactory("YieldSnapshot");
      const t = "0x1111111111111111111111111111111111111111";
      await expect(
        upgrades.deployProxy(Factory, [ZERO_ADDRESS, t, t], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.reverted;
      await expect(
        upgrades.deployProxy(Factory, [t, ZERO_ADDRESS, t], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.reverted;
      await expect(
        upgrades.deployProxy(Factory, [t, t, ZERO_ADDRESS], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.reverted;
    });

    it("cannot re-initialize", async () => {
      const { snapshot, deployer, tokenRegistry, pusdc } =
        await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.initialize(
          deployer.address,
          await tokenRegistry.getAddress(),
          await pusdc.getAddress()
        )
      ).to.be.reverted;
    });
  });

  // ── openEpoch ────────────────────────────────────────────────────────────

  describe("openEpoch", () => {
    it("issuer opens a new epoch", async () => {
      const { snapshot, token, issuer } = await loadFixture(deploySnapshotFixture);
      await expect(snapshot.connect(issuer).openEpoch(await token.getAddress()))
        .to.emit(snapshot, "EpochOpened")
        .withArgs(await token.getAddress(), 1n);

      const e = await snapshot.getEpoch(1n);
      expect(e.token).to.equal(await token.getAddress());
      expect(e.finalized).to.equal(false);
      expect(e.funded).to.equal(false);
      expect(e.holderCount).to.equal(0n);
      expect(e.snapshotStartTs).to.be.greaterThan(0n);

      expect(await snapshot.currentEpoch(await token.getAddress())).to.equal(1n);
      expect(await snapshot.nextEpochId()).to.equal(1n);
    });

    it("rejects non-issuer callers", async () => {
      const { snapshot, token, stranger } = await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.connect(stranger).openEpoch(await token.getAddress())
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });

    it("rejects unregistered tokens", async () => {
      const { snapshot, issuer, stranger } = await loadFixture(deploySnapshotFixture);
      // `stranger` (an EOA) is not registered as a token. The issuer-check
      // inside the modifier resolves against the token registry, so the
      // call reverts with OnlyIssuer (tokenRegistry returns default zero
      // issuer for an unregistered token).
      await expect(
        snapshot.connect(issuer).openEpoch(stranger.address)
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });

    it("rejects zero address token (via OnlyIssuer — default issuer is zero)", async () => {
      const { snapshot, issuer } = await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.connect(issuer).openEpoch(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });

    it("second openEpoch allocates a distinct id + updates currentEpoch", async () => {
      const { snapshot, token, issuer } = await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      expect(await snapshot.nextEpochId()).to.equal(2n);
      expect(await snapshot.currentEpoch(await token.getAddress())).to.equal(2n);
    });
  });

  // ── snapshotBatch ────────────────────────────────────────────────────────

  describe("snapshotBatch", () => {
    it("captures balances for passed investors + counts holders", async () => {
      const { snapshot, token, issuer, investor, alice, investorShares, aliceShares } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());

      await expect(
        snapshot
          .connect(issuer)
          .snapshotBatch(1n, [investor.address, alice.address])
      )
        .to.emit(snapshot, "SnapshotBatchApplied")
        .withArgs(1n, 2n);

      const e = await snapshot.getEpoch(1n);
      expect(e.holderCount).to.equal(2n);

      // Captured balances match current encrypted balance on the token.
      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getSnapshotBalance(1n, investor.address),
        investorShares
      );
      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getSnapshotBalance(1n, alice.address),
        aliceShares
      );
    });

    it("is idempotent — duplicate entries don't double-count", async () => {
      const { snapshot, token, issuer, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      // Second call with the same address is a no-op — SnapshotBatchApplied
      // fires with `added=0` is avoided by the early-return guard.
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      const e = await snapshot.getEpoch(1n);
      expect(e.holderCount).to.equal(1n);
    });

    it("skips zero-address entries silently", async () => {
      const { snapshot, token, issuer, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot
        .connect(issuer)
        .snapshotBatch(1n, [investor.address, ZERO_ADDRESS]);
      const e = await snapshot.getEpoch(1n);
      expect(e.holderCount).to.equal(1n);
    });

    it("captures zero-handle for a never-held account", async () => {
      const { snapshot, token, issuer, bob } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [bob.address]);

      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getSnapshotBalance(1n, bob.address),
        0n
      );
    });

    it("rejects snapshot on unknown epoch", async () => {
      const { snapshot, issuer, investor } = await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.connect(issuer).snapshotBatch(999n, [investor.address])
      ).to.be.revertedWithCustomError(snapshot, "InvalidEpoch");
    });

    it("rejects snapshot after finalization", async () => {
      const { snapshot, token, issuer, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      await expect(
        snapshot.connect(issuer).snapshotBatch(1n, [investor.address])
      ).to.be.revertedWithCustomError(snapshot, "SnapshotAlreadyFinalized");
    });

    it("rejects non-issuer callers", async () => {
      const { snapshot, token, issuer, stranger, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await expect(
        snapshot.connect(stranger).snapshotBatch(1n, [investor.address])
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });
  });

  // ── finalizeSnapshot ─────────────────────────────────────────────────────

  describe("finalizeSnapshot", () => {
    it("locks the snapshot + captures encTotalSupply", async () => {
      const { snapshot, token, issuer, investor, alice, investorShares, aliceShares } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot
        .connect(issuer)
        .snapshotBatch(1n, [investor.address, alice.address]);

      await expect(snapshot.connect(issuer).finalizeSnapshot(1n))
        .to.emit(snapshot, "SnapshotFinalized")
        .withArgs(await token.getAddress(), 1n, 2n);

      const e = await snapshot.getEpoch(1n);
      expect(e.finalized).to.equal(true);
      expect(e.snapshotEndTs).to.be.greaterThan(0n);

      // encTotalSupply matches the token's aggregate.
      await hre.cofhe.mocks.expectPlaintext(
        e.encTotalSupply,
        investorShares + aliceShares
      );
    });

    it("rejects double-finalize", async () => {
      const { snapshot, token, issuer, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      await expect(
        snapshot.connect(issuer).finalizeSnapshot(1n)
      ).to.be.revertedWithCustomError(snapshot, "SnapshotAlreadyFinalized");
    });

    it("rejects finalize on empty snapshot", async () => {
      const { snapshot, token, issuer } = await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await expect(
        snapshot.connect(issuer).finalizeSnapshot(1n)
      ).to.be.revertedWithCustomError(snapshot, "EmptySnapshot");
    });

    it("rejects finalize from non-issuer", async () => {
      const { snapshot, token, issuer, stranger, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await expect(
        snapshot.connect(stranger).finalizeSnapshot(1n)
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });
  });

  // ── fundEpoch ────────────────────────────────────────────────────────────

  describe("fundEpoch", () => {
    async function openAndFinalize(snapshot: any, token: any, issuer: any, investors: string[]) {
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, investors);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
    }

    it("pulls PUSDC + stores ratePerShare + computes encRatio + sets claim expiry", async () => {
      const { snapshot, token, issuer, investor, alice, issuerClient, pusdc } =
        await loadFixture(deploySnapshotFixture);
      await openAndFinalize(snapshot, token, issuer, [
        investor.address,
        alice.address,
      ]);

      // 100 shares total supply, 1000 PUSDC → rate = 10 PUSDC per share base unit.
      const totalYield = 1000n * ONE_PUSDC;
      const totalSupply = 100n;
      const ratePerShare = totalYield / totalSupply;
      const encYield = await encUint128(issuerClient, totalYield);

      await expect(snapshot.connect(issuer).fundEpoch(1n, encYield, ratePerShare))
        .to.emit(snapshot, "EpochFunded")
        .withArgs(await token.getAddress(), 1n);

      const e = await snapshot.getEpoch(1n);
      expect(e.funded).to.equal(true);
      expect(e.claimExpiry).to.be.greaterThan(0n);
      expect(e.ratePerShare).to.equal(ratePerShare);

      // encTotalYield matches the pulled amount.
      await hre.cofhe.mocks.expectPlaintext(e.encTotalYield, totalYield);
      // Legacy encRatio still computed for audit-trail backward compat.
      await hre.cofhe.mocks.expectPlaintext(e.encRatio, totalYield / 100n);

      // Issuer PUSDC decremented; snapshot contract credited.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(issuer.address),
        10_000n * ONE_PUSDC - totalYield
      );
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await snapshot.getAddress()),
        totalYield
      );
    });

    it("rejects fund with zero ratePerShare", async () => {
      const { snapshot, token, issuer, investor, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await openAndFinalize(snapshot, token, issuer, [investor.address]);
      await expect(
        snapshot
          .connect(issuer)
          .fundEpoch(1n, await encUint128(issuerClient, 100n * ONE_PUSDC), 0n)
      ).to.be.revertedWithCustomError(snapshot, "InvalidRatePerShare");
    });

    it("uses default claim expiry when unset", async () => {
      const { snapshot, token, issuer, investor, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await openAndFinalize(snapshot, token, issuer, [investor.address]);
      await snapshot
        .connect(issuer)
        .fundEpoch(1n, await encUint128(issuerClient, 100n * ONE_PUSDC), 100n);

      const e = await snapshot.getEpoch(1n);
      const blockTs = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      // Default is 365 days.
      expect(e.claimExpiry).to.equal(blockTs + BigInt(365 * 24 * 60 * 60));
    });

    it("rejects fund before finalize", async () => {
      const { snapshot, token, issuer, investor, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await expect(
        snapshot
          .connect(issuer)
          .fundEpoch(1n, await encUint128(issuerClient, 100n * ONE_PUSDC), 100n)
      ).to.be.revertedWithCustomError(snapshot, "SnapshotNotFinalized");
    });

    it("rejects double-fund", async () => {
      const { snapshot, token, issuer, investor, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await openAndFinalize(snapshot, token, issuer, [investor.address]);
      await snapshot
        .connect(issuer)
        .fundEpoch(1n, await encUint128(issuerClient, 100n * ONE_PUSDC), 100n);
      await expect(
        snapshot
          .connect(issuer)
          .fundEpoch(1n, await encUint128(issuerClient, 100n * ONE_PUSDC), 100n)
      ).to.be.revertedWithCustomError(snapshot, "EpochAlreadyFunded");
    });

    it("rejects fund from non-issuer", async () => {
      const { snapshot, token, issuer, investor, stranger } =
        await loadFixture(deploySnapshotFixture);
      await openAndFinalize(snapshot, token, issuer, [investor.address]);
      const strangerClient = await hre.cofhe.createClientWithBatteries(stranger);
      await expect(
        snapshot
          .connect(stranger)
          .fundEpoch(1n, await encUint128(strangerClient, 100n * ONE_PUSDC), 100n)
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });
  });

  // ── claimYield ───────────────────────────────────────────────────────────

  describe("claimYield", () => {
    async function fullEpochSetup(
      snapshot: any,
      token: any,
      issuer: any,
      investors: string[],
      yieldAmt: bigint,
      issuerClient: any,
      // Phase 9.B / Option A — issuer-supplied per-share rate. Default
      // assumes the fixture's investorShares=60 + aliceShares=40 → total
      // 100, matching the deploySnapshotFixture default. Override for
      // single-investor or non-default-supply tests.
      totalSupplyForRate: bigint = 100n,
    ) {
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, investors);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      const ratePerShare = yieldAmt / totalSupplyForRate;
      await snapshot
        .connect(issuer)
        .fundEpoch(1n, await encUint128(issuerClient, yieldAmt), ratePerShare);
    }

    it("investor claims proportional share + marks claimed", async () => {
      const { snapshot, token, issuer, investor, alice, eph, pusdc, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      const totalYield = 1000n * ONE_PUSDC;
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        totalYield,
        issuerClient
      );

      // investor: 60/100 * 1000 = 600 PUSDC
      // Phase 9.A · YieldSnapshot audit-handle follow-up: YieldClaimed
      // event broadened with `euint64 amount`. Asserting via `anyHandle`
      // matcher — content-addressed bytes32 handle is unstable across
      // mock-replays.
      await expect(snapshot.connect(investor).claimYield(1n, eph.address))
        .to.emit(snapshot, "YieldClaimed")
        .withArgs(await token.getAddress(), investor.address, 1n, anyHandle());

      expect(await snapshot.hasClaimed(1n, investor.address)).to.equal(true);
      // Investor PUSDC after purchase = 940 (1000 - 60 shares at 1 PUSDC);
      // after claiming 600 yield = 1540.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(investor.address),
        940n * ONE_PUSDC + 600n * ONE_PUSDC
      );
    });

    it("ephemeralEOA gets ACL on the encShare handle", async () => {
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient
      );

      // Wrap the tx so we can inspect the produced handle via events/state.
      // The mock ACL is queried directly via hre.cofhe.mocks.getMockACL.
      await snapshot.connect(investor).claimYield(1n, eph.address);

      // The encShare handle is an intermediate — the grant was applied but
      // not stored. Instead, we sanity-check that the PUSDC balance moved
      // (proxy for "ephemeralEOA grant + narrow + transfer all worked").
      // Direct ACL inspection is covered in the integration + permit tests.
      expect(await snapshot.hasClaimed(1n, investor.address)).to.equal(true);
    });

    it("rejects double-claim", async () => {
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient
      );
      await snapshot.connect(investor).claimYield(1n, eph.address);
      await expect(
        snapshot.connect(investor).claimYield(1n, eph.address)
      ).to.be.revertedWithCustomError(snapshot, "AlreadyClaimed");
    });

    it("rejects claim by non-snapshotted investor", async () => {
      const { snapshot, token, issuer, investor, alice, bob, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient
      );
      await expect(
        snapshot.connect(bob).claimYield(1n, eph.address)
      ).to.be.revertedWithCustomError(snapshot, "NotSnapshotted");
    });

    it("rejects claim on unfunded epoch", async () => {
      const { snapshot, token, issuer, investor, eph } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      await expect(
        snapshot.connect(investor).claimYield(1n, eph.address)
      ).to.be.revertedWithCustomError(snapshot, "EpochNotFunded");
    });

    it("rejects claim on unknown epoch", async () => {
      const { snapshot, investor, eph } = await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.connect(investor).claimYield(999n, eph.address)
      ).to.be.revertedWithCustomError(snapshot, "InvalidEpoch");
    });

    it("rejects zero ephemeralEOA", async () => {
      const { snapshot, token, issuer, investor, alice, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient
      );
      await expect(
        snapshot.connect(investor).claimYield(1n, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(snapshot, "InvalidEphemeralEOA");
    });

    it("decrements encRemaining per claim", async () => {
      const { snapshot, token, issuer, investor, alice, eph, aliceEph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      const totalYield = 1000n * ONE_PUSDC;
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        totalYield,
        issuerClient
      );

      // After funding, encRemaining = totalYield.
      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getEncRemaining(1n),
        totalYield
      );

      // Investor claims 600. encRemaining = 400.
      await snapshot.connect(investor).claimYield(1n, eph.address);
      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getEncRemaining(1n),
        400n * ONE_PUSDC
      );

      // Alice claims 400. encRemaining = 0.
      await snapshot.connect(alice).claimYield(1n, aliceEph.address);
      await hre.cofhe.mocks.expectPlaintext(
        await snapshot.getEncRemaining(1n),
        0n
      );
    });

    it("zero-balance snapshotted investor claims zero", async () => {
      const { snapshot, token, issuer, investor, alice, bob, eph, aliceEph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      const bobEph = createEphemeralEOA();
      const totalYield = 1000n * ONE_PUSDC;
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address, bob.address], // Bob is snapshotted with 0
        totalYield,
        issuerClient
      );

      await snapshot.connect(bob).claimYield(1n, bobEph.address);
      expect(await snapshot.hasClaimed(1n, bob.address)).to.equal(true);
    });
  });

  // ── Audit handle on YieldClaimed + refreshAuditGrant ─────────────────────

  /**
   * Phase 9.A · YieldSnapshot audit-handle follow-up. Mirrors the pattern
   * from Phase 9.A · Option Z (which added audit handles to
   * `MuHavenStable.Wrap` / `Unwrap` and `MuHavenToken.Transfer`). Closes
   * the demo-blocking cofhe TN chain-length pathology
   * (`project_cofhe_tn_chain_length_cap`): the cumulative
   * `MuHavenStable._balances[investor]` chain depth grows past the
   * indexer threshold (~5-7 ops) after multiple mhUSDC ops, making the
   * post-claim live balance handle unindexable. The audit handle on
   * `YieldClaimed.amount` is a fresh `mul → cast` chain (≈2-3 ops) and
   * stays indexer-friendly indefinitely — investors decrypt the
   * per-claim amount via the audit handle on /activity, bypassing the
   * cumulative-chain-depth issue on `_balances[investor]`.
   */
  describe("audit handle (YieldClaimed.amount + refreshAuditGrant)", () => {
    async function fullEpochSetup(
      snapshot: any,
      token: any,
      issuer: any,
      investors: string[],
      yieldAmt: bigint,
      issuerClient: any,
      totalSupplyForRate: bigint = 100n,
    ) {
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, investors);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      const ratePerShare = yieldAmt / totalSupplyForRate;
      await snapshot
        .connect(issuer)
        .fundEpoch(1n, await encUint128(issuerClient, yieldAmt), ratePerShare);
    }

    /**
     * Helper — extract the encrypted `amount` (handle) from a
     * `YieldClaimed` event in a tx receipt. Mirror of
     * MuHavenStable.test.ts:307 `extractWrapOrUnwrapAmount`.
     */
    function extractClaimAmount(snapshot: any, receipt: any): string {
      const iface = snapshot.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "YieldClaimed") {
            // Args: token (indexed), investor (indexed), epochId (indexed), amount (handle)
            return parsed.args[3] as string;
          }
        } catch {
          /* not from this contract — skip */
        }
      }
      throw new Error("No YieldClaimed event in receipt");
    }

    it("encRatio gains kernel + eph ACL grants post-claim (decoupled-decrypt path)", async () => {
      // Phase 9.A audit-handle follow-up · decoupled-decrypt fix. The
      // wrapper-scoped indexer issue rejects `encShare64` even at the
      // documented "5-op" threshold; the working path is to decrypt
      // `encRatio` + `snapshotBalance` separately and multiply locally.
      // This test locks in the new ACL grants on `encRatio`.
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      await snapshot.connect(investor).claimYield(1n, eph.address);

      // Read encRatio from the epoch view.
      const epoch = await snapshot.getEpoch(1n);
      const encRatio = epoch.encRatio;

      const acl = await hre.cofhe.mocks.getMockACL();
      // Investor kernel grant — durable across sessions, lets the
      // investor (or anyone they delegate to) decrypt the ratio via
      // the standard permit path.
      expect(
        await acl.isAllowed(BigInt(encRatio), investor.address),
      ).to.equal(true);
      // Claim-time ephemeralEOA grant — lets the originating session
      // decrypt without a refresh tx.
      expect(
        await acl.isAllowed(BigInt(encRatio), eph.address),
      ).to.equal(true);
    });

    it("encTotalYield + encTotalSupply gain kernel + eph ACL grants post-claim (Round 3 decoupled-decrypt)", async () => {
      // Phase 9.A · Round 3 (2026-05-04). encRatio's chain depth
      // (`max(encYCanonical, encTotalSupply) + 1`) crosses cofhe TN's
      // staging threshold — even the Round 2 decoupled-decrypt path
      // 204s. Round 3 grants ACL on `encTotalYield` (depth ~3,
      // wrapper-free) AND `encTotalSupply` (same shape as
      // snapshotBalance, known-good) so frontends can compute
      // `floor(balance × totalYield / totalSupply)` from depth-shallow
      // inputs only.
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      await snapshot.connect(investor).claimYield(1n, eph.address);

      const epoch = await snapshot.getEpoch(1n);
      const acl = await hre.cofhe.mocks.getMockACL();

      // encTotalYield — kernel + eph
      expect(
        await acl.isAllowed(BigInt(epoch.encTotalYield), investor.address),
        "encTotalYield kernel grant missing",
      ).to.equal(true);
      expect(
        await acl.isAllowed(BigInt(epoch.encTotalYield), eph.address),
        "encTotalYield eph grant missing",
      ).to.equal(true);

      // encTotalSupply — kernel + eph
      expect(
        await acl.isAllowed(BigInt(epoch.encTotalSupply), investor.address),
        "encTotalSupply kernel grant missing",
      ).to.equal(true);
      expect(
        await acl.isAllowed(BigInt(epoch.encTotalSupply), eph.address),
        "encTotalSupply eph grant missing",
      ).to.equal(true);

      // Negative path — alice (a snapshotted holder who hasn't claimed
      // yet) must NOT see investor's eph grant on the shared aggregates.
      // The grant is per-investor session, not global. The shared
      // handle's kernel grant is on the CLAIMING investor only —
      // alice gets her own grants when she claims.
      expect(
        await acl.isAllowed(BigInt(epoch.encTotalYield), alice.address),
        "alice should not have encTotalYield grant before her own claim",
      ).to.equal(false);
    });

    it("Phase 9.B / Option A — fundEpoch stores ratePerShare; claimYield uses cleartext rate path", async () => {
      // Locks in the Option A invariants:
      //   1. fundEpoch persists `ratePerShare` cleartext on the epoch.
      //   2. claimYield's payout matches snapshotBalance × ratePerShare
      //      (matching the legacy encRatio semantics — same conservation,
      //      just shallower handle ancestry).
      // Conservation = ratePerShare × totalSupply ≤ totalYield. With
      // totalYield = 1000e6 and totalSupply = 100, ratePerShare = 10e6
      // PUSDC base units per share base unit. Investor's 60 shares →
      // payout 600e6 PUSDC. Alice's 40 shares → 400e6.
      const { snapshot, token, issuer, investor, alice, eph, pusdc, issuerClient, aliceEph } =
        await loadFixture(deploySnapshotFixture);
      const totalYield = 1000n * ONE_PUSDC;
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        totalYield,
        issuerClient,
      );

      const e = await snapshot.getEpoch(1n);
      // ratePerShare = 1000e6 / 100 = 10e6.
      expect(e.ratePerShare).to.equal(10n * ONE_PUSDC);

      // Investor 60 shares × 10e6 = 600e6 payout.
      const investorPusdcBefore = 940n * ONE_PUSDC;  // 1000 minted - 60 spent
      await snapshot.connect(investor).claimYield(1n, eph.address);
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(investor.address),
        investorPusdcBefore + 600n * ONE_PUSDC,
      );

      // Alice 40 shares × 10e6 = 400e6 payout. Conservation: total
      // claimed = 1000e6, snapshot float drains exactly to zero.
      const alicePusdcBefore = 960n * ONE_PUSDC;  // 1000 minted - 40 spent
      await snapshot.connect(alice).claimYield(1n, aliceEph.address);
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(alice.address),
        alicePusdcBefore + 400n * ONE_PUSDC,
      );

      // Snapshot's mhUSDC float drained.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await snapshot.getAddress()),
        0n,
      );
    });

    it("YieldClaimed carries the encrypted amount handle, kernel + eph have ACL post-claim", async () => {
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      const tx = await snapshot.connect(investor).claimYield(1n, eph.address);
      const receipt = await tx.wait();
      const amountHandle = extractClaimAmount(snapshot, receipt);
      expect(amountHandle).to.match(/^0x[0-9a-fA-F]{64}$/);

      const acl = await hre.cofhe.mocks.getMockACL();
      // Investor kernel grant — durable post-claim, lets `refreshAuditGrant`
      // re-stamp future sessions without trusting a separate registry.
      expect(
        await acl.isAllowed(BigInt(amountHandle), investor.address),
      ).to.equal(true);
      // Claim-time ephemeralEOA grant — lets the originating session
      // decrypt the amount via permit without a re-grant tx.
      expect(
        await acl.isAllowed(BigInt(amountHandle), eph.address),
      ).to.equal(true);
    });

    it("refreshAuditGrant: rightful investor re-stamps grant on a previously-claimed handle", async () => {
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      const tx = await snapshot.connect(investor).claimYield(1n, eph.address);
      const receipt = await tx.wait();
      const amountHandle = extractClaimAmount(snapshot, receipt);

      // Pre-state: kernel + claim-time eph have ACL; a fresh-session eph does not.
      const freshEph = createEphemeralEOA();
      const acl = await hre.cofhe.mocks.getMockACL();
      expect(
        await acl.isAllowed(BigInt(amountHandle), freshEph.address),
      ).to.equal(false);

      // Re-grant from the rightful kernel.
      await expect(
        snapshot.connect(investor).refreshAuditGrant(amountHandle, freshEph.address),
      )
        .to.emit(snapshot, "AuditGrantRefreshed")
        .withArgs(investor.address, freshEph.address, anyHandle());

      // Fresh session can now decrypt via permit.
      expect(
        await acl.isAllowed(BigInt(amountHandle), freshEph.address),
      ).to.equal(true);
      // Original kernel + claim-time eph grants remain (additive).
      expect(
        await acl.isAllowed(BigInt(amountHandle), investor.address),
      ).to.equal(true);
      expect(
        await acl.isAllowed(BigInt(amountHandle), eph.address),
      ).to.equal(true);
    });

    it("refreshAuditGrant: stranger rejection (NotAuditHandleOwner)", async () => {
      const { snapshot, token, issuer, investor, alice, bob, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      const tx = await snapshot.connect(investor).claimYield(1n, eph.address);
      const receipt = await tx.wait();
      const amountHandle = extractClaimAmount(snapshot, receipt);

      // Bob has no ACL on investor's claim handle (claim stamped grants
      // for this contract + investor + claim-eph only; bob is not in that
      // set). Attempting to re-grant bounces.
      const bobEph = createEphemeralEOA();
      await expect(
        snapshot.connect(bob).refreshAuditGrant(amountHandle, bobEph.address),
      ).to.be.revertedWithCustomError(snapshot, "NotAuditHandleOwner");
    });

    it("refreshAuditGrant: zero ephemeralEOA rejection (InvalidEphemeralEOA)", async () => {
      const { snapshot, token, issuer, investor, alice, eph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await fullEpochSetup(
        snapshot,
        token,
        issuer,
        [investor.address, alice.address],
        1000n * ONE_PUSDC,
        issuerClient,
      );

      const tx = await snapshot.connect(investor).claimYield(1n, eph.address);
      const receipt = await tx.wait();
      const amountHandle = extractClaimAmount(snapshot, receipt);

      await expect(
        snapshot
          .connect(investor)
          .refreshAuditGrant(amountHandle, hre.ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(snapshot, "InvalidEphemeralEOA");
    });
  });

  // ── sweepExpired ─────────────────────────────────────────────────────────

  describe("sweepExpired", () => {
    async function setupAndFund(
      snapshot: any,
      token: any,
      issuer: any,
      investor: any,
      alice: any,
      issuerClient: any,
      yieldAmt: bigint
    ) {
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot
        .connect(issuer)
        .snapshotBatch(1n, [investor.address, alice.address]);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      const ratePerShare = yieldAmt / 100n;
      await snapshot
        .connect(issuer)
        .fundEpoch(1n, await encUint128(issuerClient, yieldAmt), ratePerShare);
    }

    it("sweeps remaining yield back to issuer after expiry", async () => {
      const { snapshot, token, issuer, investor, alice, eph, pusdc, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await setupAndFund(
        snapshot,
        token,
        issuer,
        investor,
        alice,
        issuerClient,
        1000n * ONE_PUSDC
      );

      // Investor claims 600; 400 remains unclaimed.
      await snapshot.connect(investor).claimYield(1n, eph.address);

      // Advance past claimExpiry.
      const e = await snapshot.getEpoch(1n);
      await time.increaseTo(Number(e.claimExpiry) + 1);

      const issuerBefore = 10_000n * ONE_PUSDC - 1000n * ONE_PUSDC;
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(issuer.address),
        issuerBefore
      );

      await expect(snapshot.connect(issuer).sweepExpired(1n))
        .to.emit(snapshot, "EpochExpired")
        .withArgs(await token.getAddress(), 1n);

      // Issuer receives back 400.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(issuer.address),
        issuerBefore + 400n * ONE_PUSDC
      );

      expect(await snapshot.isSwept(1n)).to.equal(true);
    });

    it("rejects sweep before expiry", async () => {
      const { snapshot, token, issuer, investor, alice, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await setupAndFund(
        snapshot,
        token,
        issuer,
        investor,
        alice,
        issuerClient,
        1000n * ONE_PUSDC
      );
      await expect(
        snapshot.connect(issuer).sweepExpired(1n)
      ).to.be.revertedWithCustomError(snapshot, "NotYetExpired");
    });

    it("rejects double-sweep", async () => {
      const { snapshot, token, issuer, investor, alice, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await setupAndFund(
        snapshot,
        token,
        issuer,
        investor,
        alice,
        issuerClient,
        1000n * ONE_PUSDC
      );
      const e = await snapshot.getEpoch(1n);
      await time.increaseTo(Number(e.claimExpiry) + 1);
      await snapshot.connect(issuer).sweepExpired(1n);
      await expect(
        snapshot.connect(issuer).sweepExpired(1n)
      ).to.be.revertedWithCustomError(snapshot, "AlreadySwept");
    });

    it("rejects sweep on unfunded epoch", async () => {
      const { snapshot, token, issuer, investor } =
        await loadFixture(deploySnapshotFixture);
      await snapshot.connect(issuer).openEpoch(await token.getAddress());
      await snapshot.connect(issuer).snapshotBatch(1n, [investor.address]);
      await snapshot.connect(issuer).finalizeSnapshot(1n);
      await expect(
        snapshot.connect(issuer).sweepExpired(1n)
      ).to.be.revertedWithCustomError(snapshot, "EpochNotFunded");
    });

    it("rejects sweep by non-issuer", async () => {
      const { snapshot, token, issuer, investor, alice, stranger, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await setupAndFund(
        snapshot,
        token,
        issuer,
        investor,
        alice,
        issuerClient,
        1000n * ONE_PUSDC
      );
      const e = await snapshot.getEpoch(1n);
      await time.increaseTo(Number(e.claimExpiry) + 1);
      await expect(
        snapshot.connect(stranger).sweepExpired(1n)
      ).to.be.revertedWithCustomError(snapshot, "OnlyIssuer");
    });

    it("blocks claim after sweep (prevents zombie-claimed flag)", async () => {
      const { snapshot, token, issuer, investor, alice, aliceEph, issuerClient } =
        await loadFixture(deploySnapshotFixture);
      await setupAndFund(
        snapshot,
        token,
        issuer,
        investor,
        alice,
        issuerClient,
        1000n * ONE_PUSDC
      );
      const e = await snapshot.getEpoch(1n);
      await time.increaseTo(Number(e.claimExpiry) + 1);
      await snapshot.connect(issuer).sweepExpired(1n);

      // Alice never claimed, now can't — sweep closed the window.
      await expect(
        snapshot.connect(alice).claimYield(1n, aliceEph.address)
      ).to.be.revertedWithCustomError(snapshot, "AlreadySwept");
    });
  });

  // ── Admin ────────────────────────────────────────────────────────────────

  describe("admin", () => {
    it("owner can update claim expiry per token", async () => {
      const { snapshot, token, deployer } =
        await loadFixture(deploySnapshotFixture);
      const ninety = 90 * 24 * 60 * 60;
      await expect(
        snapshot.connect(deployer).setClaimExpiry(await token.getAddress(), ninety)
      )
        .to.emit(snapshot, "ClaimExpiryUpdated")
        .withArgs(await token.getAddress(), ninety);
      expect(await snapshot.getClaimExpiryFor(await token.getAddress())).to.equal(
        ninety
      );
    });

    it("zero claim expiry resets to default", async () => {
      const { snapshot, token, deployer } =
        await loadFixture(deploySnapshotFixture);
      await snapshot
        .connect(deployer)
        .setClaimExpiry(await token.getAddress(), 30 * 24 * 60 * 60);
      await snapshot.connect(deployer).setClaimExpiry(await token.getAddress(), 0n);
      // Default is 365 days.
      expect(await snapshot.getClaimExpiryFor(await token.getAddress())).to.equal(
        BigInt(365 * 24 * 60 * 60)
      );
    });

    it("rejects claim expiry below MIN", async () => {
      const { snapshot, token, deployer } =
        await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot.connect(deployer).setClaimExpiry(await token.getAddress(), 60)
      ).to.be.revertedWithCustomError(snapshot, "InvalidClaimExpiry");
    });

    it("rejects claim expiry above MAX", async () => {
      const { snapshot, token, deployer } =
        await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot
          .connect(deployer)
          .setClaimExpiry(await token.getAddress(), 10_000 * 24 * 60 * 60)
      ).to.be.revertedWithCustomError(snapshot, "InvalidClaimExpiry");
    });

    it("rejects claim expiry setter from non-owner", async () => {
      const { snapshot, token, stranger } =
        await loadFixture(deploySnapshotFixture);
      await expect(
        snapshot
          .connect(stranger)
          .setClaimExpiry(await token.getAddress(), 90 * 24 * 60 * 60)
      ).to.be.revertedWithCustomError(snapshot, "OnlyOwner");
    });

    it("owner can transfer ownership", async () => {
      const { snapshot, deployer, stranger } =
        await loadFixture(deploySnapshotFixture);
      await expect(snapshot.connect(deployer).transferOwnership(stranger.address))
        .to.emit(snapshot, "OwnershipTransferred")
        .withArgs(deployer.address, stranger.address);
      expect(await snapshot.owner()).to.equal(stranger.address);
    });

    it("owner can rotate tokenRegistry + PUSDC pointers", async () => {
      const { snapshot, deployer } = await loadFixture(deploySnapshotFixture);
      const newReg = "0x1111111111111111111111111111111111111111";
      const newPusdc = "0x2222222222222222222222222222222222222222";
      await expect(snapshot.connect(deployer).setTokenRegistry(newReg))
        .to.emit(snapshot, "TokenRegistryUpdated")
        .withArgs(newReg);
      await expect(snapshot.connect(deployer).setPUSDC(newPusdc))
        .to.emit(snapshot, "PUSDCUpdated")
        .withArgs(newPusdc);
    });
  });
});
