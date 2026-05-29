/**
 * Wave 5 W3 — `MuHavenStable` direct mhUSDC → USDC exit (two-phase async).
 *
 * Covers `development/DEV_WAVE_5/W3_DIRECT_USDC_EXIT_PLAN.md` Phase 2:
 *   - `withdrawToUsdc` clamps to balance via FHE.min (over-request burns the
 *     full balance, not zero) and requests async decryption; claims are keyed
 *     by a monotonic claimId (NOT the content-addressed burn handle).
 *   - `claimUsdc` pays real USDC from the contract reserve once the coprocessor
 *     result is ready (1:1, both 6-dp); permissionless; reserve-short is
 *     retriable; double-claim guarded; settlement kill-switch (`claimsPaused`).
 *   - per-user pending cap (`MAX_PENDING_WITHDRAWALS`).
 *   - reserve admin (set / fund / recover) is owner-gated.
 *   - claim survives a `pause` (burned funds always settle); request is paused.
 *
 * Verification mirrors `MuHavenStable.test.ts`: CoFHE mock ACL reads via
 * `hre.cofhe.mocks`, `time.increase(11)` (`waitForDecrypt`) for the async
 * decrypt, `expectPlaintext` for encrypted balances.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import { deployMockPUSDC, waitForDecrypt } from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_USDC = 1_000_000n; // 6-dp, shared by mhUSDC + raw USDC
const FOREVER = 2n ** 47n - 1n;
const RESERVE_SEED = 1_000_000n * ONE_USDC; // $1M reserve, plenty for tests

async function encUint64(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

function handleToUint(handle: any): bigint {
  return BigInt(handle);
}

async function deployFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, alice, bob, stranger] = await hre.ethers.getSigners();

  const pusdc = await deployMockPUSDC();

  const Stable = await hre.ethers.getContractFactory("MuHavenStable");
  const stable = await upgrades.deployProxy(
    Stable,
    ["MuHaven Confidential USD", "mhUSDC", deployer.address, await pusdc.getAddress()],
    { kind: "transparent", initializer: "initialize" }
  );

  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  // Owner sets the reserve token + funds the reserve (deployer = owner).
  await stable.connect(deployer).setUsdcReserveToken(await usdc.getAddress());
  await usdc.mint(deployer.address, RESERVE_SEED);
  await usdc.connect(deployer).approve(await stable.getAddress(), RESERVE_SEED);
  await stable.connect(deployer).fundUsdcReserve(RESERVE_SEED);

  const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
  const bobClient = await hre.cofhe.createClientWithBatteries(bob);
  const acl = await hre.cofhe.mocks.getMockACL();

  return { deployer, alice, bob, stranger, pusdc, stable, usdc, aliceClient, bobClient, acl };
}

/** Seed `holder` with legacy PUSDC + approve stable as operator, then wrap
 *  `amount` into mhUSDC so they hold a confidential balance. Returns the eph. */
async function seedAndWrap(pusdc: any, stable: any, holder: any, client: any, amount: bigint) {
  await pusdc.mint(holder.address, amount);
  await pusdc.connect(holder).setOperator(await stable.getAddress(), FOREVER);
  const eph = createEphemeralEOA();
  await stable.connect(holder).wrap(await encUint64(client, amount), eph.address);
  return eph;
}

/** Parse the latest WithdrawRequested event → { claimId, handle }. */
function parseRequested(stable: any, receipt: any): { claimId: bigint; handle: string } {
  for (const log of receipt.logs) {
    try {
      const parsed = stable.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "WithdrawRequested") {
        return { claimId: parsed.args[2] as bigint, handle: parsed.args[3] as string };
      }
    } catch {
      /* not ours */
    }
  }
  throw new Error("No WithdrawRequested event in receipt");
}

async function requestWithdraw(stable: any, holder: any, client: any, eph: any, amount: bigint) {
  const tx = await stable.connect(holder).withdrawToUsdc(await encUint64(client, amount), eph.address);
  return parseRequested(stable, await tx.wait());
}

describe("MuHavenStable — direct mhUSDC → USDC exit (Wave 5 W3)", () => {
  // ── Happy path + clamp semantics ──────────────────────────────────────

  describe("withdrawToUsdc + claimUsdc", () => {
    it("requests, decrypts, then claims real USDC (1:1) and decrements mhUSDC", async () => {
      const { stable, pusdc, usdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 60n * ONE_USDC);

      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 20n * ONE_USDC);
      expect(claimId).to.equal(1n); // monotonic, 1-indexed

      // mhUSDC dropped immediately on the burn (request leg).
      await hre.cofhe.mocks.expectPlaintext(
        await stable.confidentialBalanceOf(alice.address),
        40n * ONE_USDC
      );
      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialTotalSupply(), 40n * ONE_USDC);

      // Decrypt not ready yet.
      const [, ready] = await stable.withdrawDecryptResult(claimId);
      expect(ready).to.equal(false);

      await waitForDecrypt();

      const [amount, ready2] = await stable.withdrawDecryptResult(claimId);
      expect(ready2).to.equal(true);
      expect(amount).to.equal(20n * ONE_USDC);

      const usdcBefore = await usdc.balanceOf(alice.address);
      await expect(stable.connect(alice).claimUsdc(claimId))
        .to.emit(stable, "WithdrawClaimed")
        .withArgs(alice.address, claimId, 20n * ONE_USDC);

      expect(await usdc.balanceOf(alice.address)).to.equal(usdcBefore + 20n * ONE_USDC);
    });

    it("over-request CLAMPS to balance (burns full balance, not zero)", async () => {
      const { stable, pusdc, usdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 60n * ONE_USDC);

      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 100n * ONE_USDC);

      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialBalanceOf(alice.address), 0n);
      await waitForDecrypt();

      const [amount] = await stable.withdrawDecryptResult(claimId);
      expect(amount).to.equal(60n * ONE_USDC); // full balance, NOT zero

      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(60n * ONE_USDC);
    });

    it("exact-balance request withdraws all", async () => {
      const { stable, pusdc, usdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 42n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 42n * ONE_USDC);
      await waitForDecrypt();
      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(42n * ONE_USDC);
      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialBalanceOf(alice.address), 0n);
    });

    it("under-balance request withdraws exactly the requested amount", async () => {
      const { stable, pusdc, usdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 60n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 15n * ONE_USDC);
      await waitForDecrypt();
      const [amount] = await stable.withdrawDecryptResult(claimId);
      expect(amount).to.equal(15n * ONE_USDC);
      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(15n * ONE_USDC);
      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialBalanceOf(alice.address), 45n * ONE_USDC);
    });

    it("emits WithdrawRequested with an audit handle decryptable by caller + eph", async () => {
      const { stable, pusdc, alice, aliceClient, acl } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);
      const { handle } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);

      expect(await acl.isAllowed(handleToUint(handle), alice.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(handle), eph.address)).to.equal(true);
      await hre.cofhe.mocks.expectPlaintext(handle, 10n * ONE_USDC);
    });

    it("two withdrawals get distinct, monotonic claimIds — each independently claimable (claimId-keyed, collision-safe)", async () => {
      // Regression for the content-addressed-handle hazard: even if two burns
      // produced the SAME ciphertext handle, each request gets its own claimId
      // backed by its own burn, so each settles exactly once (total burned ==
      // total paid). Here distinct amounts → distinct handles too; the point is
      // the claim RECORD is per-id, never shared.
      const { stable, pusdc, usdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 60n * ONE_USDC);

      const r1 = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      const r2 = await requestWithdraw(stable, alice, aliceClient, eph, 25n * ONE_USDC);
      expect(r2.claimId).to.equal(r1.claimId + 1n);

      // Balance burned = 10 + 25 = 35 → 25 left.
      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialBalanceOf(alice.address), 25n * ONE_USDC);

      await waitForDecrypt();
      await stable.connect(alice).claimUsdc(r1.claimId);
      await stable.connect(alice).claimUsdc(r2.claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(35n * ONE_USDC); // both paid
    });
  });

  // ── Claim guards ──────────────────────────────────────────────────────

  describe("claimUsdc guards", () => {
    it("reverts WithdrawClaimNotReady before the decrypt delay elapses", async () => {
      const { stable, pusdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      await expect(stable.connect(alice).claimUsdc(claimId)).to.be.revertedWithCustomError(
        stable,
        "WithdrawClaimNotReady"
      );
    });

    it("reverts WithdrawClaimNotFound for an unknown claimId", async () => {
      const { stable, alice } = await loadFixture(deployFixture);
      await expect(stable.connect(alice).claimUsdc(99999n)).to.be.revertedWithCustomError(
        stable,
        "WithdrawClaimNotFound"
      );
    });

    it("reverts WithdrawClaimAlreadyClaimed on a second claim", async () => {
      const { stable, pusdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      await waitForDecrypt();
      await stable.connect(alice).claimUsdc(claimId);
      await expect(stable.connect(alice).claimUsdc(claimId)).to.be.revertedWithCustomError(
        stable,
        "WithdrawClaimAlreadyClaimed"
      );
    });

    it("is permissionless: a stranger can settle a pending claim to the recipient", async () => {
      const { stable, pusdc, usdc, alice, bob, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      await waitForDecrypt();

      await stable.connect(bob).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(10n * ONE_USDC);
      expect(await usdc.balanceOf(bob.address)).to.equal(0n);
    });
  });

  // ── Settlement kill-switch ────────────────────────────────────────────

  describe("claimsPaused kill-switch", () => {
    it("blocks claimUsdc when engaged and resumes when cleared (owner-only)", async () => {
      const { stable, pusdc, usdc, deployer, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);
      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      await waitForDecrypt();

      await expect(stable.connect(alice).setClaimsPaused(true)).to.be.revertedWithCustomError(
        stable,
        "OnlyOwner"
      );
      await expect(stable.connect(deployer).setClaimsPaused(true))
        .to.emit(stable, "ClaimsPausedSet")
        .withArgs(true);
      expect(await stable.claimsPaused()).to.equal(true);

      await expect(stable.connect(alice).claimUsdc(claimId)).to.be.revertedWithCustomError(
        stable,
        "ClaimsPaused"
      );

      await stable.connect(deployer).setClaimsPaused(false);
      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(10n * ONE_USDC);
    });
  });

  // ── Reserve sufficiency (retriable) ───────────────────────────────────

  describe("reserve sufficiency", () => {
    it("reverts ReserveInsufficient when short, then succeeds after a top-up (retriable)", async () => {
      const { stable, pusdc, usdc, deployer, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 50n * ONE_USDC);

      const reserve = await stable.usdcReserveBalance();
      await stable.connect(deployer).withdrawUsdcReserve(deployer.address, reserve - 5n * ONE_USDC);
      expect(await stable.usdcReserveBalance()).to.equal(5n * ONE_USDC);

      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 40n * ONE_USDC);
      await waitForDecrypt();

      await expect(stable.connect(alice).claimUsdc(claimId)).to.be.revertedWithCustomError(
        stable,
        "ReserveInsufficient"
      );
      expect((await stable.getWithdrawClaim(claimId)).claimed).to.equal(false);

      await usdc.mint(deployer.address, 100n * ONE_USDC);
      await usdc.connect(deployer).approve(await stable.getAddress(), 100n * ONE_USDC);
      await stable.connect(deployer).fundUsdcReserve(100n * ONE_USDC);

      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(40n * ONE_USDC);
    });
  });

  // ── User claim list (re-discovery + pruning) ──────────────────────────

  describe("getUserWithdrawClaims", () => {
    it("tracks pending claims and prunes them on settle", async () => {
      const { stable, pusdc, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 60n * ONE_USDC);

      const r1 = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      const r2 = await requestWithdraw(stable, alice, aliceClient, eph, 20n * ONE_USDC);

      let pending = await stable.getUserWithdrawClaims(alice.address);
      expect(pending.length).to.equal(2);
      expect(pending.map((x: bigint) => x.toString())).to.have.members([
        r1.claimId.toString(),
        r2.claimId.toString(),
      ]);

      await waitForDecrypt();
      await stable.connect(alice).claimUsdc(r1.claimId);

      pending = await stable.getUserWithdrawClaims(alice.address);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(r2.claimId);

      await stable.connect(alice).claimUsdc(r2.claimId);
      expect((await stable.getUserWithdrawClaims(alice.address)).length).to.equal(0);
    });

    it("enforces MAX_PENDING_WITHDRAWALS per account", async () => {
      const { stable, pusdc, alice, aliceClient } = await loadFixture(deployFixture);
      const cap = Number(await stable.MAX_PENDING_WITHDRAWALS());
      // Wrap enough to make `cap` withdrawals of 1 unit each.
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, BigInt(cap + 5) * ONE_USDC);

      for (let i = 0; i < cap; i++) {
        await stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, ONE_USDC), eph.address);
      }
      expect((await stable.getUserWithdrawClaims(alice.address)).length).to.equal(cap);

      await expect(
        stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, ONE_USDC), eph.address)
      ).to.be.revertedWithCustomError(stable, "TooManyPendingWithdrawals");
    });
  });

  // ── Request-leg guards ────────────────────────────────────────────────

  describe("withdrawToUsdc guards", () => {
    it("reverts UsdcReserveNotSet when the reserve token isn't configured", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer, alice] = await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Stable = await hre.ethers.getContractFactory("MuHavenStable");
      const stable = await upgrades.deployProxy(
        Stable,
        ["mhUSDC", "mhUSDC", deployer.address, await pusdc.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );
      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 10n * ONE_USDC);

      await expect(
        stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, 5n * ONE_USDC), eph.address)
      ).to.be.revertedWithCustomError(stable, "UsdcReserveNotSet");
    });

    it("reverts NoBalance when caller never held mhUSDC", async () => {
      const { stable, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await expect(
        stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, 1n * ONE_USDC), eph.address)
      ).to.be.revertedWithCustomError(stable, "NoBalance");
    });

    it("reverts InvalidEphemeralEOA on zero eph", async () => {
      const { stable, pusdc, alice, aliceClient } = await loadFixture(deployFixture);
      await seedAndWrap(pusdc, stable, alice, aliceClient, 10n * ONE_USDC);
      await expect(
        stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, 1n * ONE_USDC), hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "InvalidEphemeralEOA");
    });
  });

  // ── Pause semantics ───────────────────────────────────────────────────

  describe("pause", () => {
    it("blocks withdrawToUsdc but ALLOWS claimUsdc (burned funds always settle)", async () => {
      const { stable, pusdc, usdc, deployer, alice, aliceClient } = await loadFixture(deployFixture);
      const eph = await seedAndWrap(pusdc, stable, alice, aliceClient, 30n * ONE_USDC);

      const { claimId } = await requestWithdraw(stable, alice, aliceClient, eph, 10n * ONE_USDC);
      await waitForDecrypt();

      await stable.connect(deployer).pause();

      await expect(
        stable.connect(alice).withdrawToUsdc(await encUint64(aliceClient, 5n * ONE_USDC), eph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");

      await stable.connect(alice).claimUsdc(claimId);
      expect(await usdc.balanceOf(alice.address)).to.equal(10n * ONE_USDC);
    });
  });

  // ── Reserve admin ─────────────────────────────────────────────────────

  describe("reserve admin", () => {
    it("setUsdcReserveToken is owner-only + rejects zero", async () => {
      const { stable, usdc, alice } = await loadFixture(deployFixture);
      await expect(
        stable.connect(alice).setUsdcReserveToken(await usdc.getAddress())
      ).to.be.revertedWithCustomError(stable, "OnlyOwner");
      await expect(stable.setUsdcReserveToken(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
        stable,
        "ZeroAddress"
      );
    });

    it("setUsdcReserveToken rejects a non-6-decimal reserve token (SecEng M-01)", async () => {
      const { stable, deployer } = await loadFixture(deployFixture);
      // TestTreasury is a plain 18-dp ERC-20 — a 1:1 reserve against it would
      // mint/pay mhUSDC at the wrong scale, so setUsdcReserveToken must reject it.
      const TestTreasury = await hre.ethers.getContractFactory("TestTreasury");
      const eighteenDp = await TestTreasury.deploy("Test RWA", "TRWA", 1_000n);
      await expect(
        stable.connect(deployer).setUsdcReserveToken(await eighteenDp.getAddress())
      ).to.be.revertedWithCustomError(stable, "ReserveTokenDecimalsMismatch");
      // A token with no decimals() (an EOA) also reverts the same way.
      await expect(
        stable.connect(deployer).setUsdcReserveToken(deployer.address)
      ).to.be.revertedWithCustomError(stable, "ReserveTokenDecimalsMismatch");
    });

    it("fundUsdcReserve is owner-only and increases the reserve", async () => {
      const { stable, usdc, deployer, alice } = await loadFixture(deployFixture);
      const before = await stable.usdcReserveBalance();
      await usdc.mint(deployer.address, 7n * ONE_USDC);
      await usdc.connect(deployer).approve(await stable.getAddress(), 7n * ONE_USDC);
      await expect(stable.connect(deployer).fundUsdcReserve(7n * ONE_USDC))
        .to.emit(stable, "UsdcReserveFunded")
        .withArgs(deployer.address, 7n * ONE_USDC);
      expect(await stable.usdcReserveBalance()).to.equal(before + 7n * ONE_USDC);

      await expect(stable.connect(alice).fundUsdcReserve(1n)).to.be.revertedWithCustomError(
        stable,
        "OnlyOwner"
      );
    });

    it("withdrawUsdcReserve is owner-only and recovers surplus", async () => {
      const { stable, usdc, deployer, alice } = await loadFixture(deployFixture);
      const before = await usdc.balanceOf(deployer.address);
      await expect(stable.connect(deployer).withdrawUsdcReserve(deployer.address, 5n * ONE_USDC))
        .to.emit(stable, "UsdcReserveWithdrawn")
        .withArgs(deployer.address, 5n * ONE_USDC);
      expect(await usdc.balanceOf(deployer.address)).to.equal(before + 5n * ONE_USDC);

      await expect(
        stable.connect(alice).withdrawUsdcReserve(alice.address, 1n)
      ).to.be.revertedWithCustomError(stable, "OnlyOwner");
    });

    it("usdcReserveBalance returns 0 when the reserve token is unset", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer] = await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Stable = await hre.ethers.getContractFactory("MuHavenStable");
      const stable = await upgrades.deployProxy(
        Stable,
        ["mhUSDC", "mhUSDC", deployer.address, await pusdc.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );
      expect(await stable.usdcReserveBalance()).to.equal(0n);
      expect(await stable.usdc()).to.equal(hre.ethers.ZeroAddress);
      expect(await stable.claimsPaused()).to.equal(false);
    });
  });

  // ── Phase 9: direct USDC → mhUSDC wrap (wrapUsdc) ─────────────────────

  describe("wrapUsdc (Phase 9 — direct deposit)", () => {
    /** Mint `amount` MockUSDC to `holder` and approve the stable to pull it. */
    async function mintAndApproveUsdc(usdc: any, stable: any, holder: any, amount: bigint) {
      await usdc.mint(holder.address, amount);
      await usdc.connect(holder).approve(await stable.getAddress(), amount);
    }

    it("happy path: pulls USDC into the reserve and mints 1:1 mhUSDC", async () => {
      const { stable, usdc, alice } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      const reserveBefore = await stable.usdcReserveBalance();
      const aliceUsdcBefore = await usdc.balanceOf(alice.address);

      await mintAndApproveUsdc(usdc, stable, alice, 50n * ONE_USDC);
      await stable.connect(alice).wrapUsdc(50n * ONE_USDC, eph.address);

      // mhUSDC minted 1:1.
      await hre.cofhe.mocks.expectPlaintext(
        await stable.confidentialBalanceOf(alice.address),
        50n * ONE_USDC
      );
      await hre.cofhe.mocks.expectPlaintext(await stable.confidentialTotalSupply(), 50n * ONE_USDC);
      // USDC moved from alice → reserve.
      expect(await usdc.balanceOf(alice.address)).to.equal(aliceUsdcBefore);
      expect(await stable.usdcReserveBalance()).to.equal(reserveBefore + 50n * ONE_USDC);
    });

    it("second wrap by the same user FHE.adds onto the existing balance", async () => {
      const { stable, usdc, alice } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await mintAndApproveUsdc(usdc, stable, alice, 30n * ONE_USDC);
      await stable.connect(alice).wrapUsdc(30n * ONE_USDC, eph.address);
      await mintAndApproveUsdc(usdc, stable, alice, 20n * ONE_USDC);
      await stable.connect(alice).wrapUsdc(20n * ONE_USDC, eph.address);
      await hre.cofhe.mocks.expectPlaintext(
        await stable.confidentialBalanceOf(alice.address),
        50n * ONE_USDC
      );
    });

    it("emits WrapUsdc with the public amount + a decryptable handle", async () => {
      const { stable, usdc, alice, acl } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await mintAndApproveUsdc(usdc, stable, alice, 17n * ONE_USDC);

      const tx = await stable.connect(alice).wrapUsdc(17n * ONE_USDC, eph.address);
      const rc = await tx.wait();
      let handle: string | null = null;
      for (const log of rc.logs) {
        try {
          const parsed = stable.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "WrapUsdc") {
            expect(parsed.args.from).to.equal(alice.address);
            expect(parsed.args.ephemeralEOA).to.equal(eph.address);
            expect(parsed.args.amount).to.equal(17n * ONE_USDC);
            handle = parsed.args.amountHandle as string;
          }
        } catch {
          /* not ours */
        }
      }
      expect(handle, "WrapUsdc event must be emitted").to.not.equal(null);
      // The amount handle is decryptable by caller + eph (Rule 2 grants).
      expect(await acl.isAllowed(handleToUint(handle), alice.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(handle), eph.address)).to.equal(true);
      await hre.cofhe.mocks.expectPlaintext(handle, 17n * ONE_USDC);
    });

    it("reverts ZeroAmount on a zero deposit", async () => {
      const { stable, alice } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await expect(
        stable.connect(alice).wrapUsdc(0n, eph.address)
      ).to.be.revertedWithCustomError(stable, "ZeroAmount");
    });

    it("reverts AmountOverflowsUint64 above type(uint64).max", async () => {
      const { stable, alice } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await expect(
        stable.connect(alice).wrapUsdc(1n << 64n, eph.address)
      ).to.be.revertedWithCustomError(stable, "AmountOverflowsUint64");
    });

    it("reverts InvalidEphemeralEOA on a zero ephemeral address", async () => {
      const { stable, alice } = await loadFixture(deployFixture);
      await expect(
        stable.connect(alice).wrapUsdc(1n * ONE_USDC, hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "InvalidEphemeralEOA");
    });

    it("reverts UsdcReserveNotSet when the reserve token isn't configured", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer, alice] = await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Stable = await hre.ethers.getContractFactory("MuHavenStable");
      const stable = await upgrades.deployProxy(
        Stable,
        ["mhUSDC", "mhUSDC", deployer.address, await pusdc.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );
      const eph = createEphemeralEOA();
      await expect(
        stable.connect(alice).wrapUsdc(1n * ONE_USDC, eph.address)
      ).to.be.revertedWithCustomError(stable, "UsdcReserveNotSet");
    });

    it("reverts PausedSurface when the wrapper is paused", async () => {
      const { stable, usdc, deployer, alice } = await loadFixture(deployFixture);
      const eph = createEphemeralEOA();
      await mintAndApproveUsdc(usdc, stable, alice, 5n * ONE_USDC);
      await stable.connect(deployer).pause();
      await expect(
        stable.connect(alice).wrapUsdc(5n * ONE_USDC, eph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");
    });
  });

  // ── Phase 9: stranded-PUSDC recovery (owner-only, two-phase) ──────────

  describe("recoverStrandedPusdc (Phase 9 — reserve replenishment)", () => {
    const STRANDED = 8n * ONE_USDC; // simulated stranded amount

    /** Wire the MockPUSDC's recovery stub to pay out `usdc` and pre-fund it. */
    async function wireRecovery(pusdc: any, usdc: any, amount: bigint) {
      await pusdc.setRecoveryUsdc(await usdc.getAddress());
      // The USDC that backs the stranded PUSDC lives in the legacy contract.
      await usdc.mint(await pusdc.getAddress(), amount);
    }

    it("start → claim lands recovered USDC in the reserve (owner-only, two-phase)", async () => {
      const { stable, pusdc, usdc, deployer } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      const reserveBefore = await stable.usdcReserveBalance();

      const startTx = await stable.connect(deployer).recoverStrandedPusdcStart(STRANDED);
      const startRc = await startTx.wait();
      let legacyClaimId: bigint | null = null;
      for (const log of startRc.logs) {
        try {
          const parsed = stable.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "StrandedPusdcRecoveryStarted") {
            expect(parsed.args.amount).to.equal(STRANDED);
            legacyClaimId = parsed.args.legacyClaimId as bigint;
          }
        } catch {
          /* not ours */
        }
      }
      expect(legacyClaimId, "StrandedPusdcRecoveryStarted must be emitted").to.equal(1n);

      // Reserve unchanged until the claim leg.
      expect(await stable.usdcReserveBalance()).to.equal(reserveBefore);

      await expect(stable.connect(deployer).recoverStrandedPusdcClaim(legacyClaimId!))
        .to.emit(stable, "StrandedPusdcRecoveryClaimed")
        .withArgs(legacyClaimId);
      expect(await stable.usdcReserveBalance()).to.equal(reserveBefore + STRANDED);
    });

    it("recoverStrandedPusdcStart is owner-only", async () => {
      const { stable, pusdc, usdc, alice } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      await expect(
        stable.connect(alice).recoverStrandedPusdcStart(STRANDED)
      ).to.be.revertedWithCustomError(stable, "OnlyOwner");
    });

    it("recoverStrandedPusdcStart reverts ZeroAmount on zero", async () => {
      const { stable, deployer } = await loadFixture(deployFixture);
      await expect(
        stable.connect(deployer).recoverStrandedPusdcStart(0n)
      ).to.be.revertedWithCustomError(stable, "ZeroAmount");
    });

    it("recoverStrandedPusdcStart reverts UsdcReserveNotSet pre-cutover", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer] = await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Stable = await hre.ethers.getContractFactory("MuHavenStable");
      const stable = await upgrades.deployProxy(
        Stable,
        ["mhUSDC", "mhUSDC", deployer.address, await pusdc.getAddress()],
        { kind: "transparent", initializer: "initialize" }
      );
      await expect(
        stable.connect(deployer).recoverStrandedPusdcStart(STRANDED)
      ).to.be.revertedWithCustomError(stable, "UsdcReserveNotSet");
    });

    it("recoverStrandedPusdcStart reverts RecoverFailed when the legacy unwrap reverts", async () => {
      const { stable, pusdc, usdc, deployer } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      await pusdc.setUnwrapShouldRevert(true);
      await expect(
        stable.connect(deployer).recoverStrandedPusdcStart(STRANDED)
      ).to.be.revertedWithCustomError(stable, "RecoverFailed");
    });

    it("recoverStrandedPusdcStart reverts PausedSurface when the wrapper is paused", async () => {
      const { stable, pusdc, usdc, deployer } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      await stable.connect(deployer).pause();
      await expect(
        stable.connect(deployer).recoverStrandedPusdcStart(STRANDED)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");
    });

    it("recoverStrandedPusdcClaim is owner-only", async () => {
      const { stable, pusdc, usdc, deployer, alice } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      await stable.connect(deployer).recoverStrandedPusdcStart(STRANDED);
      await expect(
        stable.connect(alice).recoverStrandedPusdcClaim(1n)
      ).to.be.revertedWithCustomError(stable, "OnlyOwner");
    });

    it("recoverStrandedPusdcClaim reverts RecoverClaimFailed on a double-claim", async () => {
      const { stable, pusdc, usdc, deployer } = await loadFixture(deployFixture);
      await wireRecovery(pusdc, usdc, STRANDED);
      await stable.connect(deployer).recoverStrandedPusdcStart(STRANDED);
      await stable.connect(deployer).recoverStrandedPusdcClaim(1n);
      // Legacy double-claim guard surfaces as RecoverClaimFailed.
      await expect(
        stable.connect(deployer).recoverStrandedPusdcClaim(1n)
      ).to.be.revertedWithCustomError(stable, "RecoverClaimFailed");
    });
  });
});
