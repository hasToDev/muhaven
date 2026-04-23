/**
 * ChainlinkFunctionsOracle unit tests.
 *
 * Covers the Phase 2 sub-phase "ChainlinkFunctionsOracle + tests (6h)" per
 * `development/DEV_WAVE_3_5/WAVE_3_5_REVISED.md`. Spec asks for ~12 tests;
 * we slightly exceed to cover every fulfillment edge case (malformed payload,
 * DON-side err, zero NAV, unknown requestId).
 *
 * Architectural touch-points:
 *   - ADR-003 (pluggable oracle interface)
 *   - ADR-014 (wrap existing rails + deviation + sequencer check)
 *   - ADR-015 (FRED DGS3MO / GOLDPMGBD228NLBM request profiles per token)
 *   - `FHE_ACL_CONVENTIONS.md` Rule 4 (cleartext gates before FHE ops — this
 *     oracle holds no encrypted state so the rule is vacuous)
 *
 * The deviation gate + sequencer uptime check mirror `IssuerControlledOracle`;
 * regression coverage for those is already in `IssuerControlledOracle.test.ts`.
 * These tests focus on the Functions-consumer-specific surface plus the
 * few interactions with the shared gate that the request/fulfill flow drives.
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

const TOKEN_A = "0x0000000000000000000000000000000000000aaa";
const TOKEN_B = "0x0000000000000000000000000000000000000bbb";

const DEFAULT_MAX_STALENESS = 36n * 60n * 60n;
const DEFAULT_SEQUENCER_GRACE_PERIOD = 60n * 60n;
const MAX_DEVIATION_BPS_CAP = 5_000n;

// Placeholder DON-ID + request body. Production deploys wire these to the
// real Arb Sepolia Functions profile; tests only need them to round-trip
// through setTokenConfig -> router.sendRequest.
const DON_ID = hre.ethers.encodeBytes32String("fun-sepolia-1");
const DON_ID_ALT = hre.ethers.encodeBytes32String("fun-sepolia-2");
const SAMPLE_CBOR = "0x7b22736f75726365223a224645445f44475333324f227d"; // "{\"source\":\"FED_DGS3MO\"}" hex
const SAMPLE_CBOR_ALT = "0x7b22736f75726365223a22474f4c44504d47424432323822"; // arbitrary sample
const SUB_ID = 42n;

async function deployMockRouter() {
  const Factory = await hre.ethers.getContractFactory("MockFunctionsRouter");
  return await Factory.deploy();
}

async function deployMockSequencer(answer: number, startedAt: bigint) {
  const Factory = await hre.ethers.getContractFactory("MockSequencerUptimeFeed");
  return await Factory.deploy(answer, startedAt);
}

async function latestTs(): Promise<bigint> {
  return BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
}

async function deployOracleBaseline() {
  const [deployer] = await hre.ethers.getSigners();
  const router = await deployMockRouter();
  const Factory = await hre.ethers.getContractFactory("ChainlinkFunctionsOracle");
  const oracle = await upgrades.deployProxy(
    Factory,
    [deployer.address, await router.getAddress(), ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );
  return { oracle, router };
}

function encodeUint(n: bigint | number) {
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
}

describe("ChainlinkFunctionsOracle", () => {
  // ── Initialize ──────────────────────────────────────────────────────────

  describe("initialize()", () => {
    it("stores owner, router, default sequencer grace period", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      const [deployer] = await hre.ethers.getSigners();

      expect(await oracle.owner()).to.equal(deployer.address);
      expect(await oracle.router()).to.equal(await router.getAddress());
      expect(await oracle.sequencerUptimeFeed()).to.equal(ZERO_ADDRESS);
      expect(await oracle.sequencerGracePeriod()).to.equal(DEFAULT_SEQUENCER_GRACE_PERIOD);
    });

    it("rejects a zero-address owner or zero-address router", async () => {
      const router = await deployMockRouter();
      const Factory = await hre.ethers.getContractFactory("ChainlinkFunctionsOracle");

      await expect(
        upgrades.deployProxy(Factory, [ZERO_ADDRESS, await router.getAddress(), ZERO_ADDRESS], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");

      const [deployer] = await hre.ethers.getSigners();
      await expect(
        upgrades.deployProxy(Factory, [deployer.address, ZERO_ADDRESS, ZERO_ADDRESS], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  // ── Token config ────────────────────────────────────────────────────────

  describe("setTokenConfig()", () => {
    it("persists config and emits TokenConfigured (owner-only)", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);

      await expect(
        oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR)
      )
        .to.emit(oracle, "TokenConfigured")
        .withArgs(TOKEN_A, SUB_ID, 300_000, DON_ID);

      const cfg = await oracle.getTokenConfig(TOKEN_A);
      expect(cfg.subscriptionId).to.equal(SUB_ID);
      expect(cfg.callbackGasLimit).to.equal(300_000);
      expect(cfg.donId).to.equal(DON_ID);
      expect(cfg.requestCBOR).to.equal(SAMPLE_CBOR);
    });

    it("rejects non-owner callers", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(
        oracle
          .connect(stranger)
          .setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");
    });

    it("rejects zero-value config fields", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);

      await expect(
        oracle.setTokenConfig(ZERO_ADDRESS, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR)
      ).to.be.revertedWithCustomError(oracle, "ZeroAddress");

      await expect(
        oracle.setTokenConfig(TOKEN_A, 0, 300_000, DON_ID, SAMPLE_CBOR)
      ).to.be.revertedWithCustomError(oracle, "InvalidConfig");

      await expect(
        oracle.setTokenConfig(TOKEN_A, SUB_ID, 0, DON_ID, SAMPLE_CBOR)
      ).to.be.revertedWithCustomError(oracle, "InvalidConfig");

      await expect(
        oracle.setTokenConfig(
          TOKEN_A,
          SUB_ID,
          300_000,
          hre.ethers.ZeroHash,
          SAMPLE_CBOR
        )
      ).to.be.revertedWithCustomError(oracle, "InvalidConfig");

      await expect(
        oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, "0x")
      ).to.be.revertedWithCustomError(oracle, "InvalidConfig");
    });

    it("rotation overwrites the CBOR body (second call replaces the first)", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      await oracle.setTokenConfig(
        TOKEN_A,
        SUB_ID + 1n,
        500_000,
        DON_ID_ALT,
        SAMPLE_CBOR_ALT
      );

      const cfg = await oracle.getTokenConfig(TOKEN_A);
      expect(cfg.subscriptionId).to.equal(SUB_ID + 1n);
      expect(cfg.callbackGasLimit).to.equal(500_000);
      expect(cfg.donId).to.equal(DON_ID_ALT);
      expect(cfg.requestCBOR).to.equal(SAMPLE_CBOR_ALT);
    });
  });

  describe("setRouter()", () => {
    it("rotates the router (owner-only, emits RouterUpdated)", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const newRouter = await deployMockRouter();
      const newAddr = await newRouter.getAddress();

      await expect(oracle.setRouter(newAddr))
        .to.emit(oracle, "RouterUpdated")
        .withArgs(newAddr);

      expect(await oracle.router()).to.equal(newAddr);
    });

    it("rejects non-owner and zero address", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(oracle.connect(stranger).setRouter(stranger.address))
        .to.be.revertedWithCustomError(oracle, "OnlyOwner");

      await expect(oracle.setRouter(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });
  });

  // ── Request / fulfillment ───────────────────────────────────────────────

  describe("requestNAV()", () => {
    it("reverts when the token has no Functions config", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      await expect(
        oracle.requestNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "TokenNotConfigured");
    });

    it("rejects callers that are neither owner nor navRequester", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      await expect(
        oracle.connect(stranger).requestNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwnerOrNavRequester");
    });

    it("the configured navRequester can trigger requestNAV", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      const [, cron] = await hre.ethers.getSigners();
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      await expect(oracle.setNavRequester(TOKEN_A, cron.address))
        .to.emit(oracle, "NavRequesterRotated")
        .withArgs(TOKEN_A, ZERO_ADDRESS, cron.address);
      expect(await oracle.getNavRequester(TOKEN_A)).to.equal(cron.address);

      const requestId = await oracle.connect(cron).requestNAV.staticCall(TOKEN_A);
      await expect(oracle.connect(cron).requestNAV(TOKEN_A))
        .to.emit(oracle, "NAVRequested")
        .withArgs(TOKEN_A, requestId);
      expect(await router.lastCaller()).to.equal(await oracle.getAddress());
    });

    it("setNavRequester is owner-only and rejects zero address", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger, cron] = await hre.ethers.getSigners();

      await expect(
        oracle.connect(stranger).setNavRequester(TOKEN_A, cron.address)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");

      await expect(
        oracle.setNavRequester(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });

    it("setTokenConfig preserves an existing navRequester across config rotations", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, cron] = await hre.ethers.getSigners();
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      await oracle.setNavRequester(TOKEN_A, cron.address);

      await oracle.setTokenConfig(TOKEN_A, SUB_ID + 1n, 400_000, DON_ID_ALT, SAMPLE_CBOR_ALT);
      expect(await oracle.getNavRequester(TOKEN_A)).to.equal(cron.address);
    });

    it("forwards the stored CBOR body to the router and records the request", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      // staticCall for the returned requestId
      const requestId = await oracle.requestNAV.staticCall(TOKEN_A);

      await expect(oracle.requestNAV(TOKEN_A))
        .to.emit(oracle, "NAVRequested")
        .withArgs(TOKEN_A, requestId);

      expect(await router.lastSubscriptionId()).to.equal(SUB_ID);
      expect(await router.lastCallbackGasLimit()).to.equal(300_000);
      expect(await router.lastDonId()).to.equal(DON_ID);
      expect(await router.lastDataVersion()).to.equal(1n);
      expect(await router.lastData()).to.equal(SAMPLE_CBOR);
      expect(await router.lastCaller()).to.equal(await oracle.getAddress());

      expect(await oracle.getPendingRequestToken(requestId)).to.equal(TOKEN_A);
    });
  });

  describe("handleOracleFulfillment()", () => {
    it("rejects any caller that is not the router (OnlyRouter)", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(
        oracle
          .connect(stranger)
          .handleOracleFulfillment(hre.ethers.ZeroHash, encodeUint(1), "0x")
      ).to.be.revertedWithCustomError(oracle, "OnlyRouter");
    });

    it("reverts on unknown requestId", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);

      // Route via the mock router which is msg.sender on handleOracleFulfillment
      const bogus = hre.ethers.id("bogus");
      await expect(
        router.fulfillRequest(await oracle.getAddress(), bogus, encodeUint(1), "0x")
      ).to.be.revertedWithCustomError(oracle, "UnknownRequestId");
    });

    it("first-ever fulfillment seeds NAV (bypasses deviation gate)", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      // Tight deviation gate — first write must still seed.
      await oracle.setMaxDeviationBps(TOKEN_A, 1n);

      const requestId = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);

      const tx = await router.fulfillRequest(
        await oracle.getAddress(),
        requestId,
        encodeUint(1_000_000n),
        "0x"
      );
      const receipt = await tx.wait();
      const block = await hre.ethers.provider.getBlock(receipt!.blockNumber);
      const ts = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(oracle, "NAVUpdated")
        .withArgs(TOKEN_A, 1_000_000n, ts)
        .and.to.emit(oracle, "NAVFulfilled")
        .withArgs(TOKEN_A, requestId, 1_000_000n);

      const [nav, updatedAt] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(1_000_000n);
      expect(updatedAt).to.equal(ts);

      // requestId mapping should be cleared after fulfillment
      expect(await oracle.getPendingRequestToken(requestId)).to.equal(ZERO_ADDRESS);
    });

    it("in-band follow-up fulfillment commits directly", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n); // 25 bps

      // seed
      const id1 = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      await router.fulfillRequest(
        await oracle.getAddress(),
        id1,
        encodeUint(10_000n),
        "0x"
      );

      // +0.1% → within 25bps → commits directly
      const id2 = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      await expect(
        router.fulfillRequest(
          await oracle.getAddress(),
          id2,
          encodeUint(10_010n),
          "0x"
        )
      ).to.emit(oracle, "NAVUpdated");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_010n);
      const [pending] = await oracle.getPendingNAV(TOKEN_A);
      expect(pending).to.equal(0n);
    });

    it("over-threshold fulfillment parks pending; owner can accept to commit", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);

      const id1 = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      await router.fulfillRequest(
        await oracle.getAddress(),
        id1,
        encodeUint(10_000n),
        "0x"
      );

      // +1% → exceeds 25 bps → parked pending
      const id2 = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      const tx = await router.fulfillRequest(
        await oracle.getAddress(),
        id2,
        encodeUint(10_100n),
        "0x"
      );
      const receipt = await tx.wait();
      const block = await hre.ethers.provider.getBlock(receipt!.blockNumber);
      const ts = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(oracle, "NAVPending")
        .withArgs(TOKEN_A, 10_100n, ts, 100n);

      // committed NAV unchanged
      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_000n);
      const [pending, pendingTs] = await oracle.getPendingNAV(TOKEN_A);
      expect(pending).to.equal(10_100n);
      expect(pendingTs).to.equal(ts);

      // Owner accepts
      await expect(oracle.acceptPendingNAV(TOKEN_A))
        .to.emit(oracle, "PendingNAVAccepted")
        .withArgs(TOKEN_A, 10_100n, ts);

      const [committed] = await oracle.getNAV(TOKEN_A);
      expect(committed).to.equal(10_100n);
    });

    it("DON-side err payload: skips update, emits NAVRequestFailed", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      const requestId = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);

      const err = "0xdeadbeef";
      await expect(
        router.fulfillRequest(await oracle.getAddress(), requestId, "0x", err)
      )
        .to.emit(oracle, "NAVRequestFailed")
        .withArgs(TOKEN_A, requestId, err)
        .and.not.to.emit(oracle, "NAVUpdated")
        .and.not.to.emit(oracle, "NAVFulfilled");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(0n);
      expect(await oracle.getPendingRequestToken(requestId)).to.equal(ZERO_ADDRESS);
    });

    it("malformed response (wrong length): skips update, emits NAVRequestFailed", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      const requestId = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);

      const bad = "0x1234"; // 2 bytes instead of 32
      await expect(
        router.fulfillRequest(await oracle.getAddress(), requestId, bad, "0x")
      ).to.emit(oracle, "NAVRequestFailed");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(0n);
    });

    it("zero NAV response: skips update, emits NAVRequestFailed", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      const requestId = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);

      await expect(
        router.fulfillRequest(
          await oracle.getAddress(),
          requestId,
          encodeUint(0),
          "0x"
        )
      ).to.emit(oracle, "NAVRequestFailed");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(0n);
    });

    it("concurrent requests from two tokens resolve independently", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      await oracle.setTokenConfig(TOKEN_B, SUB_ID + 1n, 300_000, DON_ID_ALT, SAMPLE_CBOR_ALT);

      const idA = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      const idB = await oracle.requestNAV.staticCall(TOKEN_B);
      await oracle.requestNAV(TOKEN_B);

      expect(idA).to.not.equal(idB);
      expect((await oracle.getPendingRequestToken(idA)).toLowerCase()).to.equal(TOKEN_A);
      expect((await oracle.getPendingRequestToken(idB)).toLowerCase()).to.equal(TOKEN_B);

      await router.fulfillRequest(
        await oracle.getAddress(),
        idB,
        encodeUint(2_222_000n),
        "0x"
      );
      await router.fulfillRequest(
        await oracle.getAddress(),
        idA,
        encodeUint(1_111_000n),
        "0x"
      );

      const [navA] = await oracle.getNAV(TOKEN_A);
      const [navB] = await oracle.getNAV(TOKEN_B);
      expect(navA).to.equal(1_111_000n);
      expect(navB).to.equal(2_222_000n);
    });
  });

  // ── Views + staleness interaction ───────────────────────────────────────

  describe("isFresh() + staleness + sequencer", () => {
    it("isFresh returns false for unpublished token, true after fresh fulfillment, false after staleness elapses", async () => {
      const { oracle, router } = await loadFixture(deployOracleBaseline);
      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);

      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);

      const id = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      await router.fulfillRequest(
        await oracle.getAddress(),
        id,
        encodeUint(1_000_000n),
        "0x"
      );

      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);

      // Tighten window and age past it
      await oracle.setMaxStaleness(TOKEN_A, 60n);
      expect(await oracle.getMaxStaleness(TOKEN_A)).to.equal(60n);
      await time.increase(120);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);
    });

    it("isFresh is false while sequencer is in grace window, true after it elapses", async () => {
      const [deployer] = await hre.ethers.getSigners();
      const router = await deployMockRouter();
      const start = await latestTs();
      const feed = await deployMockSequencer(0, Number(start));

      const Factory = await hre.ethers.getContractFactory("ChainlinkFunctionsOracle");
      const oracle = await upgrades.deployProxy(
        Factory,
        [deployer.address, await router.getAddress(), await feed.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );

      await oracle.setTokenConfig(TOKEN_A, SUB_ID, 300_000, DON_ID, SAMPLE_CBOR);
      const id = await oracle.requestNAV.staticCall(TOKEN_A);
      await oracle.requestNAV(TOKEN_A);
      await router.fulfillRequest(
        await oracle.getAddress(),
        id,
        encodeUint(1_000_000n),
        "0x"
      );

      // Inside grace window → not fresh
      expect(await oracle.isSequencerUp()).to.equal(false);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);

      await time.increase(Number(DEFAULT_SEQUENCER_GRACE_PERIOD) + 10);
      expect(await oracle.isSequencerUp()).to.equal(true);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);
    });

    it("EOA-configured sequencer feed fails closed", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, notAFeed] = await hre.ethers.getSigners();
      await oracle.setSequencerUptimeFeed(notAFeed.address);

      expect(await oracle.isSequencerUp()).to.equal(false);
    });
  });

  // ── Owner controls ──────────────────────────────────────────────────────

  describe("owner controls", () => {
    it("setMaxDeviationBps rejects values above 5000 bps cap", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      await expect(
        oracle.setMaxDeviationBps(TOKEN_A, MAX_DEVIATION_BPS_CAP + 1n)
      ).to.be.revertedWithCustomError(oracle, "DeviationBpsTooHigh");
    });

    it("setSequencerGracePeriod rejects values above 24h bound", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      await expect(
        oracle.setSequencerGracePeriod(24n * 60n * 60n + 1n)
      ).to.be.revertedWithCustomError(oracle, "GracePeriodTooLong");
    });

    it("transferOwnership rotates the owner (event-emitting, zero-rejecting)", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [deployer, newOwner] = await hre.ethers.getSigners();

      await expect(oracle.transferOwnership(newOwner.address))
        .to.emit(oracle, "OwnershipTransferred")
        .withArgs(deployer.address, newOwner.address);
      expect(await oracle.owner()).to.equal(newOwner.address);

      await expect(
        oracle.connect(newOwner).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });

    it("rejectPendingNAV and acceptPendingNAV both revert when no pending NAV exists", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      await expect(
        oracle.acceptPendingNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "NoPendingNAV");
      await expect(
        oracle.rejectPendingNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "NoPendingNAV");
    });

    it("setMaxStaleness is owner-only and emits MaxStalenessUpdated", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(oracle.setMaxStaleness(TOKEN_A, 120n))
        .to.emit(oracle, "MaxStalenessUpdated")
        .withArgs(TOKEN_A, 120n);
      expect(await oracle.getMaxStaleness(TOKEN_A)).to.equal(120n);

      await expect(
        oracle.connect(stranger).setMaxStaleness(TOKEN_A, 60n)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");
    });

    it("setSequencerUptimeFeed is owner-only and emits SequencerUptimeFeedUpdated", async () => {
      const { oracle } = await loadFixture(deployOracleBaseline);
      const [, stranger] = await hre.ethers.getSigners();
      const feed = await deployMockSequencer(0, await latestTs());
      const feedAddr = await feed.getAddress();

      await expect(oracle.setSequencerUptimeFeed(feedAddr))
        .to.emit(oracle, "SequencerUptimeFeedUpdated")
        .withArgs(feedAddr);
      expect(await oracle.sequencerUptimeFeed()).to.equal(feedAddr);

      await expect(
        oracle.connect(stranger).setSequencerUptimeFeed(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");
    });
  });
});
