/**
 * IssuerControlledOracle unit tests.
 *
 * Covers Phase 2 sub-phases (`WAVE_3_5_REVISED.md`):
 *   - IPriceOracle + IssuerControlledOracle base flow (5h / ~15 tests)
 *   - Oracle deviation gate (2h / ~6 tests)
 *   - Sequencer uptime check (1h / ~3 tests)
 *
 * Architectural touch-points:
 *   - ADR-003 (pluggable oracle interface)
 *   - ADR-014 (wrap existing rails + deviation + sequencer check)
 *   - BUSINESS §9 (25 bps TBILL1 / 50 bps GOLD1 defaults)
 *   - `FHE_ACL_CONVENTIONS.md` Rule 4 (cleartext gates before FHE ops)
 *
 * Design note: the oracle holds no encrypted state. All assertions are on
 * cleartext storage + event emission; no FHE mock client is needed.
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

async function deployOracle(sequencerFeed?: string) {
  const [deployer] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("IssuerControlledOracle");
  const oracle = await upgrades.deployProxy(
    Factory,
    [deployer.address, sequencerFeed ?? ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );
  return oracle;
}

async function deployOracleNoSequencer() {
  return deployOracle(ZERO_ADDRESS);
}

async function deployMockSequencer(answer: number, startedAt: bigint) {
  const Factory = await hre.ethers.getContractFactory("MockSequencerUptimeFeed");
  const mock = await Factory.deploy(answer, startedAt);
  return mock;
}

async function latestTs(): Promise<bigint> {
  return BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
}

describe("IssuerControlledOracle", () => {
  describe("initialize()", () => {
    it("sets owner and default sequencer grace period", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [deployer] = await hre.ethers.getSigners();

      expect(await oracle.owner()).to.equal(deployer.address);
      expect(await oracle.sequencerUptimeFeed()).to.equal(ZERO_ADDRESS);
      expect(await oracle.sequencerGracePeriod()).to.equal(DEFAULT_SEQUENCER_GRACE_PERIOD);
    });

    it("rejects a zero-address owner", async () => {
      const Factory = await hre.ethers.getContractFactory("IssuerControlledOracle");
      await expect(
        upgrades.deployProxy(Factory, [ZERO_ADDRESS, ZERO_ADDRESS], {
          kind: "transparent",
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  // ── Base oracle flow (IPriceOracle + setters) ───────────────────────────

  describe("setNavWriter() + first NAV write", () => {
    it("owner can rotate the NAV writer (emits NavWriterRotated)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();

      await expect(oracle.setNavWriter(TOKEN_A, writer.address))
        .to.emit(oracle, "NavWriterRotated")
        .withArgs(TOKEN_A, ZERO_ADDRESS, writer.address);

      expect(await oracle.getNavWriter(TOKEN_A)).to.equal(writer.address);
    });

    it("setNavWriter rejects non-owner", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, stranger, writer] = await hre.ethers.getSigners();

      await expect(
        oracle.connect(stranger).setNavWriter(TOKEN_A, writer.address)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");
    });

    it("setNavWriter rejects zero address", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      await expect(
        oracle.setNavWriter(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });

    it("setNAV(first write) seeds NAV + updatedAt and emits NAVUpdated", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);

      const tx = await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);
      const receipt = await tx.wait();
      const block = await hre.ethers.provider.getBlock(receipt!.blockNumber);
      const ts = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(oracle, "NAVUpdated")
        .withArgs(TOKEN_A, 1_000_000n, ts);

      const [nav, updatedAt] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(1_000_000n);
      expect(updatedAt).to.equal(ts);
    });

    it("setNAV rejects non-navWriter caller (OnlyNavWriter)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer, stranger] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);

      await expect(
        oracle.connect(stranger).setNAV(TOKEN_A, 1_000_000n)
      ).to.be.revertedWithCustomError(oracle, "OnlyNavWriter");

      // Owner is not the writer unless explicitly assigned
      await expect(
        oracle.setNAV(TOKEN_A, 1_000_000n)
      ).to.be.revertedWithCustomError(oracle, "OnlyNavWriter");
    });

    it("setNAV with zero NAV reverts (ZeroNAV)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);

      await expect(
        oracle.connect(writer).setNAV(TOKEN_A, 0)
      ).to.be.revertedWithCustomError(oracle, "ZeroNAV");
    });
  });

  describe("setMaxStaleness()", () => {
    it("owner can set a per-token override (emits MaxStalenessUpdated)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const CUSTOM = 120n;

      await expect(oracle.setMaxStaleness(TOKEN_A, CUSTOM))
        .to.emit(oracle, "MaxStalenessUpdated")
        .withArgs(TOKEN_A, CUSTOM);

      expect(await oracle.getMaxStaleness(TOKEN_A)).to.equal(CUSTOM);
    });

    it("getMaxStaleness returns default when no override is set", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      expect(await oracle.getMaxStaleness(TOKEN_A)).to.equal(DEFAULT_MAX_STALENESS);
    });

    it("setMaxStaleness rejects non-owner", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(
        oracle.connect(stranger).setMaxStaleness(TOKEN_A, 60)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");
    });
  });

  describe("isFresh() — base staleness window", () => {
    it("returns true when NAV is fresh and no sequencer configured", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);

      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);
    });

    it("returns false for a token that never had a NAV published", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);
    });

    it("returns false once the NAV has aged past the per-token staleness window", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxStaleness(TOKEN_A, 60n); // 60s window
      await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);

      await time.increase(120);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);
    });
  });

  describe("transferOwnership()", () => {
    it("rotates the owner (emits OwnershipTransferred)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [deployer, newOwner] = await hre.ethers.getSigners();

      await expect(oracle.transferOwnership(newOwner.address))
        .to.emit(oracle, "OwnershipTransferred")
        .withArgs(deployer.address, newOwner.address);

      expect(await oracle.owner()).to.equal(newOwner.address);
    });

    it("rejects non-owner and zero address", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(
        oracle.connect(stranger).transferOwnership(stranger.address)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");

      await expect(
        oracle.transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
    });
  });

  // ── Deviation gate ──────────────────────────────────────────────────────

  describe("deviation gate", () => {
    it("setMaxDeviationBps persists the per-token cap and emits an event", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      await expect(oracle.setMaxDeviationBps(TOKEN_A, 25n))
        .to.emit(oracle, "MaxDeviationBpsUpdated")
        .withArgs(TOKEN_A, 25n);
      expect(await oracle.getMaxDeviationBps(TOKEN_A)).to.equal(25n);
    });

    it("setMaxDeviationBps rejects values above the 5000 bps cap", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      await expect(
        oracle.setMaxDeviationBps(TOKEN_A, MAX_DEVIATION_BPS_CAP + 1n)
      ).to.be.revertedWithCustomError(oracle, "DeviationBpsTooHigh");
    });

    it("the first NAV write is never gated — even when maxDeviationBps is tight", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 1n); // 0.01%

      await expect(oracle.connect(writer).setNAV(TOKEN_A, 10_000n))
        .to.emit(oracle, "NAVUpdated");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_000n);
    });

    it("a NAV within the deviation threshold commits immediately", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n); // 25 bps = 0.25%

      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);
      // Move +0.2% → within threshold (25bps)
      await expect(oracle.connect(writer).setNAV(TOKEN_A, 10_020n))
        .to.emit(oracle, "NAVUpdated");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_020n);
    });

    it("a NAV above the threshold is parked as pending (emits NAVPending)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);

      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);

      // Move +1% → exceeds 25 bps
      const tx = await oracle.connect(writer).setNAV(TOKEN_A, 10_100n);
      const receipt = await tx.wait();
      const block = await hre.ethers.provider.getBlock(receipt!.blockNumber);
      const ts = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(oracle, "NAVPending")
        .withArgs(TOKEN_A, 10_100n, ts, 100n);

      // Committed NAV is unchanged
      const [committedNav] = await oracle.getNAV(TOKEN_A);
      expect(committedNav).to.equal(10_000n);

      const [pendingNav, pendingUpdatedAt] = await oracle.getPendingNAV(TOKEN_A);
      expect(pendingNav).to.equal(10_100n);
      expect(pendingUpdatedAt).to.equal(ts);
    });

    it("acceptPendingNAV commits the parked value (owner-only)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer, stranger] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_100n);

      const [pendingBefore, pendingTsBefore] = await oracle.getPendingNAV(TOKEN_A);
      expect(pendingBefore).to.equal(10_100n);

      await expect(
        oracle.connect(stranger).acceptPendingNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "OnlyOwner");

      await expect(oracle.acceptPendingNAV(TOKEN_A))
        .to.emit(oracle, "PendingNAVAccepted")
        .withArgs(TOKEN_A, 10_100n, pendingTsBefore)
        .and.to.emit(oracle, "NAVUpdated")
        .withArgs(TOKEN_A, 10_100n, pendingTsBefore);

      const [nav, updatedAt] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_100n);
      expect(updatedAt).to.equal(pendingTsBefore);

      const [pendingAfter] = await oracle.getPendingNAV(TOKEN_A);
      expect(pendingAfter).to.equal(0n);
    });

    it("rejectPendingNAV drops the parked value (owner-only)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_100n);

      await expect(oracle.rejectPendingNAV(TOKEN_A))
        .to.emit(oracle, "PendingNAVRejected")
        .withArgs(TOKEN_A, 10_100n);

      const [pending] = await oracle.getPendingNAV(TOKEN_A);
      expect(pending).to.equal(0n);

      // Committed NAV is untouched
      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_000n);
    });

    it("acceptPendingNAV / rejectPendingNAV revert when no pending NAV exists", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      await expect(
        oracle.acceptPendingNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "NoPendingNAV");
      await expect(
        oracle.rejectPendingNAV(TOKEN_A)
      ).to.be.revertedWithCustomError(oracle, "NoPendingNAV");
    });

    it("a subsequent in-band NAV clears any existing pending state", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);
      // Park one pending
      await oracle.connect(writer).setNAV(TOKEN_A, 10_100n);
      expect((await oracle.getPendingNAV(TOKEN_A))[0]).to.equal(10_100n);

      // Follow with an in-band move (+0.1% → within 25 bps) — pending should clear
      await oracle.connect(writer).setNAV(TOKEN_A, 10_010n);

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(10_010n);
      const [pending] = await oracle.getPendingNAV(TOKEN_A);
      expect(pending).to.equal(0n);
    });

    it("maxDeviationBps == 0 disables the gate (all post-seed writes commit)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      // Don't set maxDeviationBps → stays 0
      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);

      // 1000% jump should still commit when gate disabled
      await expect(oracle.connect(writer).setNAV(TOKEN_A, 100_000n))
        .to.emit(oracle, "NAVUpdated")
        .and.not.to.emit(oracle, "NAVPending");

      const [nav] = await oracle.getNAV(TOKEN_A);
      expect(nav).to.equal(100_000n);
    });

    it("deviation is symmetric across up and down moves", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.setMaxDeviationBps(TOKEN_A, 25n);
      await oracle.connect(writer).setNAV(TOKEN_A, 10_000n);

      // −1% → exceeds 25 bps
      const tx = await oracle.connect(writer).setNAV(TOKEN_A, 9_900n);
      await expect(tx)
        .to.emit(oracle, "NAVPending")
        .withArgs(TOKEN_A, 9_900n, anyUint(), 100n);
    });
  });

  // ── Sequencer uptime check ──────────────────────────────────────────────

  describe("sequencer uptime", () => {
    // loadFixture cannot accept anonymous functions; these tests instantiate
    // the feed + oracle directly without loadFixture because each case drives
    // the feed state differently across calls to `time.increase()` and
    // `setStatus()`.

    it("isFresh returns false when the sequencer is reported down (answer != 0)", async () => {
      const start = await latestTs();
      const feed = await deployMockSequencer(0, Number(start - 7200n)); // up, past grace
      const Factory = await hre.ethers.getContractFactory("IssuerControlledOracle");
      const [deployer, writer] = await hre.ethers.getSigners();
      const oracle = await upgrades.deployProxy(
        Factory,
        [deployer.address, await feed.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );

      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);

      // Fresh NAV + sequencer up → isFresh true
      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);
      expect(await oracle.isSequencerUp()).to.equal(true);

      // Flip sequencer to DOWN right now
      const now = await latestTs();
      await feed.setStatus(1, now);
      expect(await oracle.isSequencerUp()).to.equal(false);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);
    });

    it("isFresh returns false during the post-recovery grace window and true after it elapses", async () => {
      const start = await latestTs();
      // Sequencer just "came back up" right now
      const feed = await deployMockSequencer(0, Number(start));
      const Factory = await hre.ethers.getContractFactory("IssuerControlledOracle");
      const [deployer, writer] = await hre.ethers.getSigners();
      const oracle = await upgrades.deployProxy(
        Factory,
        [deployer.address, await feed.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );

      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);

      // Still inside grace period (default 1h) → not fresh
      expect(await oracle.isSequencerUp()).to.equal(false);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(false);

      // Advance past grace window
      await time.increase(Number(DEFAULT_SEQUENCER_GRACE_PERIOD) + 10);
      expect(await oracle.isSequencerUp()).to.equal(true);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);
    });

    it("isFresh returns true when no sequencer feed is configured (unconfigured → up)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, writer] = await hre.ethers.getSigners();
      await oracle.setNavWriter(TOKEN_A, writer.address);
      await oracle.connect(writer).setNAV(TOKEN_A, 1_000_000n);

      expect(await oracle.isSequencerUp()).to.equal(true);
      expect(await oracle.isFresh(TOKEN_A)).to.equal(true);
    });

    it("setSequencerUptimeFeed rewires the feed (owner-only, event-emitting)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const feed = await deployMockSequencer(0, await latestTs());
      const feedAddr = await feed.getAddress();

      await expect(oracle.setSequencerUptimeFeed(feedAddr))
        .to.emit(oracle, "SequencerUptimeFeedUpdated")
        .withArgs(feedAddr);
      expect(await oracle.sequencerUptimeFeed()).to.equal(feedAddr);
    });

    it("setSequencerGracePeriod bounds (0 ≤ x ≤ 24h)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);

      await expect(oracle.setSequencerGracePeriod(120n))
        .to.emit(oracle, "SequencerGracePeriodUpdated")
        .withArgs(120n);
      expect(await oracle.sequencerGracePeriod()).to.equal(120n);

      await expect(
        oracle.setSequencerGracePeriod(24n * 60n * 60n + 1n)
      ).to.be.revertedWithCustomError(oracle, "GracePeriodTooLong");
    });

    it("a mis-configured (EOA) sequencer feed fails closed (isSequencerUp == false)", async () => {
      const oracle = await loadFixture(deployOracleNoSequencer);
      const [, notAFeed] = await hre.ethers.getSigners();
      await oracle.setSequencerUptimeFeed(notAFeed.address);

      // Fails closed: no contract at that address → isSequencerUp returns false
      expect(await oracle.isSequencerUp()).to.equal(false);
    });
  });
});

// ── chai matcher helpers ────────────────────────────────────────────────────

/**
 * `withArgs` placeholder for `uint256` values we don't want to bind —
 * matches anything that looks like a BigInt from the event decoder.
 */
function anyUint() {
  return (v: unknown) => typeof v === "bigint" || typeof v === "number";
}
