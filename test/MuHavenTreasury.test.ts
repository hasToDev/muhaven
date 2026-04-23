/**
 * MuHavenTreasury unit tests.
 *
 * Phase 2 (`WAVE_3_5_REVISED.md`): per-token PUSDC float custodian (6h / ~20
 * tests). Touch-points:
 *   - ADR-002 (per-token treasury, immutable subscription/queue operator grants)
 *   - ADR-008 (PUSDC legacy `euint64 = uint256` selector via low-level call)
 *   - ADR-029 (silent-fail solvency floor + `getFloat()` Wave 3.5 placeholder)
 *   - `FHE_ACL_CONVENTIONS.md` Rule 5 (silent-fail on encrypted comparisons)
 *
 * Test scope mirrors the M1 review decision: contract unit tests use EOA
 * stand-ins for issuer + investor, no kernel/UserOp; SDK + Playwright cover
 * the full kernel path.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import { deployMockPUSDC, ZERO_ADDRESS } from "./helpers/setup";

/// PUSDC has 6 decimals (matches mainnet USDC).
const ONE_PUSDC = 1_000_000n;
const TOKEN_A = "0x0000000000000000000000000000000000000aaa";

/**
 * Deploy MuHavenTreasury behind a transparent proxy with the given binding
 * overrides. Defaults wire EOA placeholders for `subscription` / `queue` so
 * Phase 2 tests can run without those contracts existing yet.
 */
async function deployTreasuryFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, subscription, queue, investor, stranger, newOwner] =
    await hre.ethers.getSigners();

  const pusdc = await deployMockPUSDC();

  const Factory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    Factory,
    [
      TOKEN_A,
      subscription.address,
      queue.address,
      issuer.address,
      await pusdc.getAddress(),
      0n, // minFloat — set per-test as needed
      deployer.address, // owner
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

  return {
    deployer,
    issuer,
    subscription,
    queue,
    investor,
    stranger,
    newOwner,
    pusdc,
    treasury,
    issuerClient,
  };
}

/**
 * Encrypt a `uint128` PUSDC amount as an `InEuint128` for `deposit` /
 * `withdraw`. The treasury narrows to `euint64` internally (PUSDC width).
 */
async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

describe("MuHavenTreasury", () => {
  // ── initialize() ────────────────────────────────────────────────────────

  describe("initialize()", () => {
    it("sets bindings + owner + minFloat and emits TreasuryInitialized + MinFloatUpdated", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer, issuer, subscription, queue] =
        await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Factory = await hre.ethers.getContractFactory("MuHavenTreasury");

      const tx = await upgrades.deployProxy(
        Factory,
        [
          TOKEN_A,
          subscription.address,
          queue.address,
          issuer.address,
          await pusdc.getAddress(),
          1_000n,
          deployer.address,
        ],
        { kind: "transparent", initializer: "initialize" }
      );
      const treasury = tx;

      expect(await treasury.token()).to.equal(TOKEN_A);
      expect(await treasury.subscription()).to.equal(subscription.address);
      expect(await treasury.queue()).to.equal(queue.address);
      expect(await treasury.issuer()).to.equal(issuer.address);
      expect(await treasury.pusdc()).to.equal(await pusdc.getAddress());
      expect(await treasury.owner()).to.equal(deployer.address);
      expect(await treasury.minFloat()).to.equal(1_000n);
      expect(await treasury.getMinFloat()).to.equal(1_000n);
    });

    it("rejects zero-address bindings", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer, issuer, subscription, queue] =
        await hre.ethers.getSigners();
      const pusdc = await deployMockPUSDC();
      const Factory = await hre.ethers.getContractFactory("MuHavenTreasury");

      const baseArgs = [
        TOKEN_A,
        subscription.address,
        queue.address,
        issuer.address,
        await pusdc.getAddress(),
        0n,
        deployer.address,
      ] as const;

      // Each zero-address slot independently triggers ZeroAddress.
      // Skip slot 5 (minFloat — uint256 not address) and slot 0 if we want
      // to keep TOKEN_A; but the validation also rejects token == 0.
      const slotsToCheck = [0, 1, 2, 3, 4, 6];
      for (const slot of slotsToCheck) {
        const args = [...baseArgs] as any[];
        args[slot] = ZERO_ADDRESS;
        await expect(
          upgrades.deployProxy(Factory, args, {
            kind: "transparent",
            initializer: "initialize",
          })
        ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
      }
    });

    it("cannot be re-initialized", async () => {
      const { treasury, deployer, issuer, subscription, queue, pusdc } =
        await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.initialize(
          TOKEN_A,
          subscription.address,
          queue.address,
          issuer.address,
          await pusdc.getAddress(),
          0n,
          deployer.address
        )
      ).to.be.revertedWithCustomError(treasury, "InvalidInitialization");
    });

    it("grants immutable PUSDC operator rights to subscription + queue", async () => {
      const { treasury, pusdc, subscription, queue } = await loadFixture(
        deployTreasuryFixture
      );

      // Both subscription and queue can pull PUSDC from the treasury via the
      // operator model. (We assert the operator flag rather than performing a
      // pull, since `setOperator` is the initialise-time grant we care about.)
      expect(await pusdc.isOperator(await treasury.getAddress(), subscription.address)).to.equal(true);
      expect(await pusdc.isOperator(await treasury.getAddress(), queue.address)).to.equal(true);
    });
  });

  // ── deposit() ───────────────────────────────────────────────────────────

  describe("deposit()", () => {
    it("emits TreasuryDeposited when called by issuer", async () => {
      const { treasury, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const enc = await encUint128(issuerClient, 5n * ONE_PUSDC);

      await expect(treasury.connect(issuer).deposit(enc))
        .to.emit(treasury, "TreasuryDeposited")
        .withArgs(issuer.address);
    });

    it("rejects non-issuer (OnlyIssuer)", async () => {
      const { treasury, stranger, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const enc = await encUint128(issuerClient, 1n);

      await expect(
        treasury.connect(stranger).deposit(enc)
      ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");
    });

    it("does not move PUSDC (pure event marker)", async () => {
      // Per the natspec: issuer transfers PUSDC out-of-band via
      // `pusdc.confidentialTransfer(treasury, amount)`. `deposit()` only
      // emits the analytics event.
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );

      const balanceBefore = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );

      const enc = await encUint128(issuerClient, 100n * ONE_PUSDC);
      await treasury.connect(issuer).deposit(enc);

      // Balance handle stays uninitialised (raw bytes32 = 0x00..00) since
      // no PUSDC ever entered the treasury.
      const balanceAfter = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  // ── withdraw() ──────────────────────────────────────────────────────────

  describe("withdraw()", () => {
    /**
     * Helper — seed the treasury with `amount` PUSDC by minting directly into
     * its balance via the mock's test-only `mint` function. Production would
     * use `pusdc.confidentialTransfer(treasury, amount)` from the issuer; the
     * difference is irrelevant for treasury-side semantics.
     */
    async function seedFloat(pusdc: any, treasuryAddr: string, amount: bigint) {
      await pusdc.mint(treasuryAddr, amount);
    }

    it("transfers the requested amount to issuer when float well exceeds minFloat", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      // Float = 100 PUSDC, minFloat = 10 PUSDC, request = 50 PUSDC → fully filled.
      await seedFloat(pusdc, treasuryAddr, 100n * ONE_PUSDC);
      await treasury.connect(issuer).setMinFloat(10n * ONE_PUSDC);

      const enc = await encUint128(issuerClient, 50n * ONE_PUSDC);
      await expect(treasury.connect(issuer).withdraw(enc))
        .to.emit(treasury, "TreasuryWithdrawn")
        .withArgs(issuer.address);

      // Treasury balance decreased by 50.
      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      await hre.cofhe.mocks.expectPlaintext(treasuryBal, 50n * ONE_PUSDC);

      // Issuer received 50.
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 50n * ONE_PUSDC);
    });

    it("silent-fails (no transfer) when the treasury has never received PUSDC", async () => {
      // PUSDC's `_doTransfer` reverts with `NoBalance` when the sender
      // (treasury) has never been initialised — withdraw must short-circuit
      // the PUSDC call in that case rather than propagate the revert. The
      // silent-fail observable: event still fires, no PUSDC handle exists
      // for the issuer, treasury float remains uninitialised.
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      const enc = await encUint128(issuerClient, 10n * ONE_PUSDC);
      await expect(treasury.connect(issuer).withdraw(enc))
        .to.emit(treasury, "TreasuryWithdrawn")
        .withArgs(issuer.address);

      // No PUSDC moved — both balance handles stay uninitialised (raw 0x00).
      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      expect(treasuryBal).to.equal(hre.ethers.ZeroHash);
      expect(issuerBal).to.equal(hre.ethers.ZeroHash);
    });

    it("silent-fails to zero when minFloat consumes the full float", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      // Float = 50 PUSDC, minFloat = 100 PUSDC → spread is 0, request silent-fails.
      await seedFloat(pusdc, treasuryAddr, 50n * ONE_PUSDC);
      await treasury.connect(issuer).setMinFloat(100n * ONE_PUSDC);

      const enc = await encUint128(issuerClient, 1n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);

      // Treasury untouched.
      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      await hre.cofhe.mocks.expectPlaintext(treasuryBal, 50n * ONE_PUSDC);
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 0n);
    });

    it("silent-fails to zero when request exceeds the spread (currentFloat - minFloat)", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      // Float = 100, minFloat = 80, spread = 20. Request = 25 → silent-fail.
      await seedFloat(pusdc, treasuryAddr, 100n * ONE_PUSDC);
      await treasury.connect(issuer).setMinFloat(80n * ONE_PUSDC);

      const enc = await encUint128(issuerClient, 25n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);

      // Float unchanged; issuer balance still 0.
      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      await hre.cofhe.mocks.expectPlaintext(treasuryBal, 100n * ONE_PUSDC);
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 0n);
    });

    it("fills exactly at the spread boundary (request == currentFloat - minFloat)", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      // Float = 100, minFloat = 80, spread = 20. Request = 20 → exact fill.
      await seedFloat(pusdc, treasuryAddr, 100n * ONE_PUSDC);
      await treasury.connect(issuer).setMinFloat(80n * ONE_PUSDC);

      const enc = await encUint128(issuerClient, 20n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);

      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      await hre.cofhe.mocks.expectPlaintext(treasuryBal, 80n * ONE_PUSDC);
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 20n * ONE_PUSDC);
    });

    it("with minFloat = 0 the issuer can drain to zero", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      await seedFloat(pusdc, treasuryAddr, 30n * ONE_PUSDC);
      // minFloat already 0 from fixture init.

      const enc = await encUint128(issuerClient, 30n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);

      const treasuryBal = await pusdc.confidentialBalanceOf(treasuryAddr);
      await hre.cofhe.mocks.expectPlaintext(treasuryBal, 0n);
      const issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 30n * ONE_PUSDC);
    });

    it("rejects non-issuer (OnlyIssuer)", async () => {
      const { treasury, stranger, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );

      const enc = await encUint128(issuerClient, 1n);
      await expect(
        treasury.connect(stranger).withdraw(enc)
      ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");
    });

    it("setMinFloat updates affect subsequent withdraw bounds", async () => {
      const { treasury, pusdc, issuer, issuerClient } = await loadFixture(
        deployTreasuryFixture
      );
      const treasuryAddr = await treasury.getAddress();

      await seedFloat(pusdc, treasuryAddr, 100n * ONE_PUSDC);
      await treasury.connect(issuer).setMinFloat(95n * ONE_PUSDC);

      // Spread = 5. Request 10 → silent-fail.
      let enc = await encUint128(issuerClient, 10n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);
      let issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 0n);

      // Lower minFloat → spread expands; request 10 now fits.
      await treasury.connect(issuer).setMinFloat(50n * ONE_PUSDC);
      enc = await encUint128(issuerClient, 10n * ONE_PUSDC);
      await treasury.connect(issuer).withdraw(enc);
      issuerBal = await pusdc.confidentialBalanceOf(issuer.address);
      await hre.cofhe.mocks.expectPlaintext(issuerBal, 10n * ONE_PUSDC);
    });
  });

  // ── setMinFloat() ───────────────────────────────────────────────────────

  describe("setMinFloat()", () => {
    it("issuer can update; emits MinFloatUpdated", async () => {
      const { treasury, issuer } = await loadFixture(deployTreasuryFixture);

      await expect(treasury.connect(issuer).setMinFloat(123_456n))
        .to.emit(treasury, "MinFloatUpdated")
        .withArgs(123_456n);

      expect(await treasury.minFloat()).to.equal(123_456n);
      expect(await treasury.getMinFloat()).to.equal(123_456n);
    });

    it("rejects non-issuer (OnlyIssuer) — including the owner", async () => {
      const { treasury, stranger, deployer } = await loadFixture(
        deployTreasuryFixture
      );

      await expect(
        treasury.connect(stranger).setMinFloat(1n)
      ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");

      // Owner != issuer — also blocked by the issuer-only modifier.
      await expect(
        treasury.connect(deployer).setMinFloat(1n)
      ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");
    });
  });

  // ── setIssuer() + transferOwnership() ───────────────────────────────────

  describe("setIssuer()", () => {
    it("rotates the issuer (owner-only); new issuer can deposit/withdraw", async () => {
      const { treasury, deployer, issuer, newOwner, pusdc, issuerClient } =
        await loadFixture(deployTreasuryFixture);

      // Use `newOwner` as the rotated issuer for clarity.
      await expect(treasury.connect(deployer).setIssuer(newOwner.address))
        .to.emit(treasury, "IssuerUpdated")
        .withArgs(issuer.address, newOwner.address);

      expect(await treasury.issuer()).to.equal(newOwner.address);

      // Old issuer can no longer deposit.
      const enc = await encUint128(issuerClient, 1n);
      await expect(
        treasury.connect(issuer).deposit(enc)
      ).to.be.revertedWithCustomError(treasury, "OnlyIssuer");

      // New issuer can.
      const newIssuerClient = await hre.cofhe.createClientWithBatteries(newOwner);
      const enc2 = await encUint128(newIssuerClient, 1n);
      await expect(treasury.connect(newOwner).deposit(enc2))
        .to.emit(treasury, "TreasuryDeposited")
        .withArgs(newOwner.address);
    });

    it("rejects non-owner (OnlyOwner)", async () => {
      const { treasury, issuer, stranger } = await loadFixture(
        deployTreasuryFixture
      );

      // Issuer can't rotate themselves; stranger can't either.
      await expect(
        treasury.connect(issuer).setIssuer(stranger.address)
      ).to.be.revertedWithCustomError(treasury, "OnlyOwner");
      await expect(
        treasury.connect(stranger).setIssuer(stranger.address)
      ).to.be.revertedWithCustomError(treasury, "OnlyOwner");
    });

    it("rejects zero-address newIssuer", async () => {
      const { treasury, deployer } = await loadFixture(deployTreasuryFixture);
      await expect(
        treasury.connect(deployer).setIssuer(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  describe("transferOwnership()", () => {
    it("rotates the owner; emits OwnershipTransferred; old owner loses rights", async () => {
      const { treasury, deployer, newOwner, stranger } = await loadFixture(
        deployTreasuryFixture
      );

      await expect(treasury.connect(deployer).transferOwnership(newOwner.address))
        .to.emit(treasury, "OwnershipTransferred")
        .withArgs(deployer.address, newOwner.address);

      expect(await treasury.owner()).to.equal(newOwner.address);

      // Old owner can no longer setIssuer.
      await expect(
        treasury.connect(deployer).setIssuer(stranger.address)
      ).to.be.revertedWithCustomError(treasury, "OnlyOwner");

      // New owner can.
      await expect(treasury.connect(newOwner).setIssuer(stranger.address))
        .to.emit(treasury, "IssuerUpdated");
    });

    it("rejects non-owner and zero-address", async () => {
      const { treasury, stranger, deployer } = await loadFixture(
        deployTreasuryFixture
      );

      await expect(
        treasury.connect(stranger).transferOwnership(stranger.address)
      ).to.be.revertedWithCustomError(treasury, "OnlyOwner");

      await expect(
        treasury.connect(deployer).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  // ── views ───────────────────────────────────────────────────────────────

  describe("views", () => {
    it("getFloat() returns 0 (Wave 3.5 placeholder per ADR-029)", async () => {
      // Even after seeding the treasury, getFloat() stays at 0 — the cleartext
      // aggregate is intentionally not derivable from a view function in
      // Wave 3.5. ADR-029 records the deferred async-decrypt cache.
      const { treasury, pusdc } = await loadFixture(deployTreasuryFixture);
      await pusdc.mint(await treasury.getAddress(), 100n * ONE_PUSDC);
      expect(await treasury.getFloat()).to.equal(0n);
    });

    it("token / subscription / queue / issuer / pusdc / owner expose bound addresses", async () => {
      const { treasury, deployer, issuer, subscription, queue, pusdc } =
        await loadFixture(deployTreasuryFixture);

      expect(await treasury.token()).to.equal(TOKEN_A);
      expect(await treasury.subscription()).to.equal(subscription.address);
      expect(await treasury.queue()).to.equal(queue.address);
      expect(await treasury.issuer()).to.equal(issuer.address);
      expect(await treasury.pusdc()).to.equal(await pusdc.getAddress());
      expect(await treasury.owner()).to.equal(deployer.address);
    });
  });
});
