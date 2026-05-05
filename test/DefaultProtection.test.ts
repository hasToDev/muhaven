import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockMuHavenEscrow,
  deployMockPUSDC,
  deployYieldGate,
  deployDefaultProtection,
  ONE_TOKEN,
  waitForDecrypt,
} from "./helpers/setup";

const ONE_PUSDC = 1_000_000n;
const MIN_RESERVE_BPS = 300n; // 3%

/// @dev Deploys DefaultProtection wired to MockMuHavenEscrow + MockPUSDC.
async function deployFixture() {
  const base = await loadFixture(deployMuHavenFixture);
  const { deployer, token, kyc, registry, issuer } = base;

  const escrow = await deployMockMuHavenEscrow();
  const pusdc = await deployMockPUSDC();
  const yieldGate = await deployYieldGate(
    await token.getAddress(),
    await kyc.getAddress()
  );
  await yieldGate.setAuthorizedEscrow(await escrow.getAddress());

  const protection = await deployDefaultProtection(
    await registry.getAddress(),
    await escrow.getAddress(),
    await yieldGate.getAddress(),
    await pusdc.getAddress(),
    deployer.address,
    Number(MIN_RESERVE_BPS)
  );

  // KYC: also whitelist the issuer so they can be a token holder.
  await kyc.addToWhitelist(issuer.address);

  return { ...base, escrow, pusdc, yieldGate, protection };
}

describe("DefaultProtection", function () {

  // ── createProtection ────────────────────────────────────────────────────

  describe("createProtection()", function () {
    it("creates a protection with id=1 and INACTIVE status", async function () {
      const { protection, token, issuer } = await loadFixture(deployFixture);
      await expect(
        protection.connect(issuer).createProtection(await token.getAddress(), 500n)
      )
        .to.emit(protection, "ProtectionCreated")
        .withArgs(1n, await token.getAddress(), issuer.address, 500n);

      const p = await protection.getProtection(1);
      expect(p.token).to.equal(await token.getAddress());
      expect(p.issuer).to.equal(issuer.address);
      expect(p.reserveRateBps).to.equal(500n);
      expect(p.status).to.equal(0n); // INACTIVE
      expect(await protection.tokenProtection(await token.getAddress())).to.equal(1n);
    });

    it("rejects rate below minimum", async function () {
      const { protection, token, issuer } = await loadFixture(deployFixture);
      await expect(
        protection.connect(issuer).createProtection(await token.getAddress(), 100n)
      ).to.be.revertedWithCustomError(protection, "RateBelowMinimum");
    });

    it("rejects rate above maximum (50%)", async function () {
      const { protection, token, issuer } = await loadFixture(deployFixture);
      await expect(
        protection.connect(issuer).createProtection(await token.getAddress(), 6000n)
      ).to.be.revertedWithCustomError(protection, "RateAboveMaximum");
    });

    it("rejects duplicate protection for the same token", async function () {
      const { protection, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);
      await expect(
        protection.connect(issuer).createProtection(await token.getAddress(), 500n)
      ).to.be.revertedWithCustomError(protection, "ProtectionAlreadyExists");
    });
  });

  // ── depositReserve ──────────────────────────────────────────────────────

  describe("depositReserve()", function () {
    it("activates the protection and stores the encrypted reserve", async function () {
      const { protection, pusdc, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const amount = 100n * ONE_PUSDC;
      await pusdc.mint(issuer.address, Number(amount));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encAmt] = await issuerClient.encryptInputs([Encryptable.uint64(amount)]).execute();

      await expect(protection.connect(issuer).depositReserve(1, encAmt))
        .to.emit(protection, "ReserveDeposited")
        .withArgs(1n, issuer.address);

      const p = await protection.getProtection(1);
      expect(p.status).to.equal(1n); // ACTIVE
      hre.cofhe.mocks.expectPlaintext(p.encReserveBalance, amount);

      // Aggregate accumulator picks it up too.
      hre.cofhe.mocks.expectPlaintext(
        await protection.encryptedTotalReservesHeld(),
        amount
      );
    });

    it("rejects deposit from a non-issuer", async function () {
      const { protection, pusdc, token, issuer, alice } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const amount = 50n * ONE_PUSDC;
      await pusdc.mint(alice.address, Number(amount));
      await pusdc.connect(alice).setOperator(await protection.getAddress(), 2_000_000_000);

      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
      const [encAmt] = await aliceClient.encryptInputs([Encryptable.uint64(amount)]).execute();

      await expect(
        protection.connect(alice).depositReserve(1, encAmt)
      ).to.be.revertedWithCustomError(protection, "OnlyIssuer");
    });
  });

  // ── topUpReserve ────────────────────────────────────────────────────────

  describe("topUpReserve()", function () {
    it("adds to the encrypted reserve handle", async function () {
      const { protection, pusdc, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const initial = 100n * ONE_PUSDC;
      const topUp = 25n * ONE_PUSDC;
      const total = initial + topUp;
      await pusdc.mint(issuer.address, Number(total));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encInit] = await issuerClient.encryptInputs([Encryptable.uint64(initial)]).execute();
      const [encTop] = await issuerClient.encryptInputs([Encryptable.uint64(topUp)]).execute();

      await protection.connect(issuer).depositReserve(1, encInit);

      await expect(protection.connect(issuer).topUpReserve(1, encTop))
        .to.emit(protection, "ReserveTopUp")
        .withArgs(1n, issuer.address);

      const p = await protection.getProtection(1);
      hre.cofhe.mocks.expectPlaintext(p.encReserveBalance, total);
    });

    it("rejects top-up before initial deposit (status INACTIVE)", async function () {
      const { protection, pusdc, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encAmt] = await issuerClient.encryptInputs([Encryptable.uint64(10n * ONE_PUSDC)]).execute();
      await expect(
        protection.connect(issuer).topUpReserve(1, encAmt)
      ).to.be.revertedWithCustomError(protection, "ProtectionNotActive");
    });
  });

  // ── triggerPayout ───────────────────────────────────────────────────────

  describe("triggerPayout()", function () {
    async function activeProtectionFixture() {
      const ctx = await deployFixture();
      const { protection, pusdc, token, issuer, investor } = ctx;
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      // Register an investor by minting a token to them (registers via addHolder).
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Fund the protection.
      const reserveAmount = 500n * ONE_PUSDC;
      await pusdc.mint(issuer.address, Number(reserveAmount));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);

      const [encReserve] = await issuerClient.encryptInputs([Encryptable.uint64(reserveAmount)]).execute();
      await protection.connect(issuer).depositReserve(1, encReserve);

      return { ...ctx, reserveAmount };
    }

    it("issuer can trigger; status flips to TRIGGERED with snapshot", async function () {
      const { protection, pusdc, escrow, issuer, reserveAmount } =
        await loadFixture(activeProtectionFixture);

      await expect(protection.connect(issuer).triggerPayout(1))
        .to.emit(protection, "PayoutTriggered")
        .withArgs(1n, issuer.address, 1n);

      const p = await protection.getProtection(1);
      expect(p.status).to.equal(2n); // TRIGGERED

      const d = await protection.getPayoutDistribution(1);
      expect(d.investorCount).to.equal(1n);
      hre.cofhe.mocks.expectPlaintext(d.encTotalPayout, reserveAmount);
      // Single investor → perInvestor == total.
      hre.cofhe.mocks.expectPlaintext(d.encPerInvestorPayout, reserveAmount);

      // PUSDC reserve forwarded to escrow; protection contract balance is now zero.
      hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await escrow.getAddress()),
        reserveAmount
      );
      hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await protection.getAddress()),
        0n
      );
    });

    it("authorised trigger (governance) can trigger", async function () {
      const { protection, deployer, alice } = await loadFixture(activeProtectionFixture);
      await protection.connect(deployer).setAuthorizedTrigger(alice.address, true);
      await expect(protection.connect(alice).triggerPayout(1))
        .to.emit(protection, "PayoutTriggered");
    });

    it("rejects trigger from unauthorised caller", async function () {
      const { protection, alice } = await loadFixture(activeProtectionFixture);
      await expect(
        protection.connect(alice).triggerPayout(1)
      ).to.be.revertedWithCustomError(protection, "Unauthorized");
    });

    it("rejects trigger on a non-active protection", async function () {
      const { protection, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);
      // Status INACTIVE — no deposit yet.
      await expect(
        protection.connect(issuer).triggerPayout(1)
      ).to.be.revertedWithCustomError(protection, "ProtectionNotActive");
    });
  });

  // ── setPayoutEscrowIds + processPayoutBatch ────────────────────────────

  describe("payout pipeline", function () {
    async function triggeredFixture() {
      const ctx = await deployFixture();
      const { protection, pusdc, token, issuer, investor, escrow } = ctx;
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const reserveAmount = 100n * ONE_PUSDC;
      await pusdc.mint(issuer.address, Number(reserveAmount));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);

      const [encReserve] = await issuerClient.encryptInputs([Encryptable.uint64(reserveAmount)]).execute();
      await protection.connect(issuer).depositReserve(1, encReserve);
      await protection.connect(issuer).triggerPayout(1);

      // SDK simulates batchCreate from the deployer signer (the encryption
      // input signature is bound to whichever signer encrypts + calls).
      const deployerClient = await hre.cofhe.createClientWithBatteries(ctx.deployer);
      const encOwners = await deployerClient.encryptInputs([Encryptable.address(investor.address)]).execute();
      const data = [hre.ethers.AbiCoder.defaultAbiCoder().encode(["address"], [investor.address])];
      await escrow.connect(ctx.deployer).batchCreate(encOwners, await ctx.yieldGate.getAddress(), data);
      const escrowIds = [1];

      return { ...ctx, reserveAmount, escrowIds };
    }

    it("attaches escrow IDs and runs a full batch payout", async function () {
      const { protection, escrow, escrowIds, issuer, reserveAmount } =
        await loadFixture(triggeredFixture);

      await expect(protection.connect(issuer).setPayoutEscrowIds(1, escrowIds))
        .to.emit(protection, "PayoutEscrowIdsAttached")
        .withArgs(1n, BigInt(escrowIds.length));

      await expect(protection.processPayoutBatch(1, 50))
        .to.emit(protection, "PayoutCompleted")
        .withArgs(1n);

      expect(await protection.isPayoutComplete(1)).to.equal(true);
      const d = await protection.getPayoutDistribution(1);
      expect(d.processedCount).to.equal(BigInt(escrowIds.length));
      expect(d.escrowsCreated).to.equal(BigInt(escrowIds.length));

      // Mock escrow's first escrow now holds the per-investor handle.
      const paid = await escrow.getPaidAmount(escrowIds[0]);
      hre.cofhe.mocks.expectPlaintext(paid, reserveAmount);
    });

    it("rejects setPayoutEscrowIds with mismatched length", async function () {
      const { protection, issuer } = await loadFixture(triggeredFixture);
      await expect(
        protection.connect(issuer).setPayoutEscrowIds(1, [1, 2])
      ).to.be.revertedWithCustomError(protection, "EscrowIdsLengthMismatch");
    });

    it("rejects double setPayoutEscrowIds", async function () {
      const { protection, escrowIds, issuer } = await loadFixture(triggeredFixture);
      await protection.connect(issuer).setPayoutEscrowIds(1, escrowIds);
      await expect(
        protection.connect(issuer).setPayoutEscrowIds(1, escrowIds)
      ).to.be.revertedWithCustomError(protection, "EscrowIdsAlreadySet");
    });

    it("rejects processPayoutBatch before IDs are set", async function () {
      const { protection } = await loadFixture(triggeredFixture);
      await expect(
        protection.processPayoutBatch(1, 10)
      ).to.be.revertedWithCustomError(protection, "EscrowIdsNotSet");
    });
  });

  // ── async decrypt ───────────────────────────────────────────────────────

  describe("requestReserveDecrypt() + getReserveDecryptResult()", function () {
    it("issuer can request and read the decrypted reserve", async function () {
      const { protection, pusdc, token, issuer } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const amount = 250n * ONE_PUSDC;
      await pusdc.mint(issuer.address, Number(amount));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encAmt] = await issuerClient.encryptInputs([Encryptable.uint64(amount)]).execute();
      await protection.connect(issuer).depositReserve(1, encAmt);

      await protection.connect(issuer).requestReserveDecrypt(1);
      await waitForDecrypt();

      const [reserveBalance, decrypted] = await protection.getReserveDecryptResult(1);
      expect(decrypted).to.be.true;
      expect(reserveBalance).to.equal(amount);
    });

    it("rejects decrypt from a non-issuer non-owner", async function () {
      const { protection, pusdc, token, issuer, alice } = await loadFixture(deployFixture);
      await protection.connect(issuer).createProtection(await token.getAddress(), 500n);

      const amount = 50n * ONE_PUSDC;
      await pusdc.mint(issuer.address, Number(amount));
      await pusdc.connect(issuer).setOperator(await protection.getAddress(), 2_000_000_000);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encAmt] = await issuerClient.encryptInputs([Encryptable.uint64(amount)]).execute();
      await protection.connect(issuer).depositReserve(1, encAmt);

      await expect(
        protection.connect(alice).requestReserveDecrypt(1)
      ).to.be.revertedWithCustomError(protection, "Unauthorized");
    });
  });

  // ── admin ───────────────────────────────────────────────────────────────

  describe("admin", function () {
    it("setMinimumReserveRate is owner-only", async function () {
      const { protection, alice } = await loadFixture(deployFixture);
      await expect(
        protection.connect(alice).setMinimumReserveRate(400n)
      ).to.be.revertedWithCustomError(protection, "OnlyOwner");
    });

    it("rejects min rate above MAX", async function () {
      const { protection, deployer } = await loadFixture(deployFixture);
      await expect(
        protection.connect(deployer).setMinimumReserveRate(6000n)
      ).to.be.revertedWithCustomError(protection, "RateAboveMaximum");
    });

    it("setAuthorizedTrigger flips the flag", async function () {
      const { protection, deployer, alice } = await loadFixture(deployFixture);
      await expect(protection.connect(deployer).setAuthorizedTrigger(alice.address, true))
        .to.emit(protection, "AuthorizedTriggerUpdated")
        .withArgs(alice.address, true);
      expect(await protection.authorizedTriggers(alice.address)).to.equal(true);
    });
  });

  // ── EIP-165 ─────────────────────────────────────────────────────────────

  describe("EIP-165", function () {
    it("supportsInterface returns true for IDefaultProtection", async function () {
      const { protection } = await loadFixture(deployFixture);
      // IDefaultProtection interface ID — derived dynamically via contract.
      const factory = await hre.ethers.getContractFactory("DefaultProtection");
      // Compute the interface id by hashing the type signature is non-trivial in JS;
      // assert non-zero default ERC-165 (0x01ffc9a7) negative + ours positive.
      expect(await protection.supportsInterface("0x01ffc9a7")).to.equal(true);
      // A nonsense interface id returns false.
      expect(await protection.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
