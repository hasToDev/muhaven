import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockMuHavenEscrow,
  deployMockPUSDC,
  deployYieldGate,
  deployYieldDistributor,
  ONE_TOKEN,
  ZERO_ADDRESS,
} from "./helpers/setup";

/// @dev PUSDC uses 6 decimals (like USDC). 1 PUSDC = 1_000_000 units.
const ONE_PUSDC = 1_000_000n;

/// @dev abi.encode(address) payload used as resolverData for YieldGate.
function encodeBeneficiary(addr: string): string {
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]);
}

describe("YieldDistributor", function () {
  /**
   * Deploys the distributor wired to a MockMuHavenEscrow (simplest stand-in —
   * no PUSDC transfer, no access control). Full redemption / silent-failure
   * coverage lives in `MuHavenEscrow.test.ts`; this suite focuses on the
   * distributor's own responsibilities: pulling PUSDC via the operator model,
   * computing per-investor splits as euint64, and calling fundFrom in order.
   */
  async function deployYieldFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, token, kyc, registry } = base;

    const escrow = await deployMockMuHavenEscrow();
    const pusdc = await deployMockPUSDC();
    const yieldGate = await deployYieldGate(await token.getAddress(), await kyc.getAddress());

    // Authorize the (mock) escrow to call YieldGate.onConditionSet during batchCreate
    await yieldGate.setAuthorizedEscrow(await escrow.getAddress());

    const distributor = await deployYieldDistributor(
      await registry.getAddress(),
      await escrow.getAddress(),
      await yieldGate.getAddress(),
      deployer.address,
      await pusdc.getAddress()
    );

    return { ...base, escrow, pusdc, yieldGate, distributor };
  }

  /**
   * Helper: create N escrows owned by `beneficiary` via escrow.batchCreate
   * and return the sequential IDs. Mock escrow has no access control, so
   * any signer may call this.
   */
  async function createEscrowsFor(
    escrow: any,
    yieldGate: any,
    signer: any,
    beneficiaries: string[]
  ): Promise<number[]> {
    const client = await hre.cofhe.createClientWithBatteries(signer);
    const encInputs = beneficiaries.map((b) => Encryptable.address(b));
    const encOwners = await client.encryptInputs(encInputs).execute();
    const data = beneficiaries.map((b) => encodeBeneficiary(b));
    const startId = Number(await escrow.escrowCount());
    await escrow.batchCreate(encOwners, await yieldGate.getAddress(), data);
    return beneficiaries.map((_, i) => startId + 1 + i);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // startDistribution()
  // ────────────────────────────────────────────────────────────────────────────

  describe("startDistribution()", function () {
    it("starts a distribution via PUSDC confidentialTransferFrom", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      // Register investor via mint
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const yieldAmount = 10n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);

      const dist = await distributor.getDistribution(1);
      expect(dist.investorCount).to.equal(1n);
      // Types are now euint64 throughout — no widening to euint128.
      hre.cofhe.mocks.expectPlaintext(dist.encTotalYield, yieldAmount);
      // perInvestorYield = total / investorCount = yieldAmount for a single investor
      hre.cofhe.mocks.expectPlaintext(dist.encPerInvestorYield, yieldAmount);
      expect(dist.status).to.equal(0n); // PENDING
    });

    it("forwards the pulled PUSDC onward to MuHavenEscrow (redeem payout pool)", async function () {
      // Regression guard for the 19D.3 fix: processBatch + fundFrom only updates
      // the escrow's encrypted per-investor counter — it does NOT move tokens.
      // startDistribution must push the pulled cUSDC to MuHavenEscrow so redeem
      // has a pool to draw from. If this ever regresses, redeem silently pays 0
      // on mainnet (escrow balance = 0 so confidentialTransfer fails).
      const { distributor, deployer, issuer, investor, token, pusdc, escrow } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const yieldAmount = 7n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      await pusdc.connect(deployer).setOperator(await distributor.getAddress(), 2_000_000_000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);

      // After startDistribution: escrow should hold the full yieldAmount
      // (cleartext-equivalent handle, encrypted). Distributor balance = 0.
      hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await escrow.getAddress()),
        yieldAmount,
      );
      hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await distributor.getAddress()),
        0n,
      );
    });

    it("starts a distribution from contract balance (two-step workaround)", async function () {
      const { distributor, issuer, investor, token, pusdc } = await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const yieldAmount = 5n * ONE_PUSDC;
      const distributorAddr = await distributor.getAddress();
      await pusdc.mint(distributorAddr, Number(yieldAmount));

      await distributor.startDistributionFromBalance();

      const dist = await distributor.getDistribution(1);
      expect(dist.investorCount).to.equal(1n);
      hre.cofhe.mocks.expectPlaintext(dist.encTotalYield, yieldAmount);
      hre.cofhe.mocks.expectPlaintext(dist.encPerInvestorYield, yieldAmount);
      expect(dist.status).to.equal(0n);
    });

    it("reverts NoInvestors when registry is empty", async function () {
      const { distributor, deployer, pusdc } = await loadFixture(deployYieldFixture);

      await pusdc.mint(deployer.address, Number(10n * ONE_PUSDC));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(10n * ONE_PUSDC)]).execute();

      await expect(
        distributor.startDistribution(encYield)
      ).to.be.revertedWithCustomError(distributor, "NoInvestors");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // setEscrowIds()
  // ────────────────────────────────────────────────────────────────────────────

  describe("setEscrowIds()", function () {
    async function startedDistribution() {
      const ctx = await loadFixture(deployYieldFixture);
      const { distributor, deployer, issuer, investor, token, pusdc } = ctx;
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await pusdc.mint(deployer.address, Number(10n * ONE_PUSDC));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(10n * ONE_PUSDC)]).execute();
      await distributor.startDistribution(encYield);
      return ctx;
    }

    it("attaches escrow IDs and emits EscrowIdsAttached", async function () {
      const { distributor } = await startedDistribution();
      await expect(distributor.setEscrowIds(1, [1]))
        .to.emit(distributor, "EscrowIdsAttached")
        .withArgs(1n, 1n);
      const ids = await distributor.getEscrowIds(1);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(1n);
    });

    it("reverts EscrowIdsLengthMismatch if array length != investorCount", async function () {
      const { distributor } = await startedDistribution();
      await expect(distributor.setEscrowIds(1, [1, 2]))
        .to.be.revertedWithCustomError(distributor, "EscrowIdsLengthMismatch");
    });

    it("reverts EscrowIdsAlreadySet on second call", async function () {
      const { distributor } = await startedDistribution();
      await distributor.setEscrowIds(1, [1]);
      await expect(distributor.setEscrowIds(1, [2]))
        .to.be.revertedWithCustomError(distributor, "EscrowIdsAlreadySet");
    });

    it("reverts InvalidDistribution for unknown distributionId", async function () {
      const { distributor } = await loadFixture(deployYieldFixture);
      await expect(distributor.setEscrowIds(999, []))
        .to.be.revertedWithCustomError(distributor, "InvalidDistribution");
    });

    it("reverts Unauthorized when non-owner calls", async function () {
      const { distributor, alice } = await startedDistribution();
      await expect(distributor.connect(alice).setEscrowIds(1, [1]))
        .to.be.revertedWithCustomError(distributor, "Unauthorized");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // processBatch()
  // ────────────────────────────────────────────────────────────────────────────

  describe("processBatch()", function () {
    it("funds escrows via fundFrom and marks distribution COMPLETED", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc, escrow, yieldGate } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const yieldAmount = 10n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);

      // SDK-style: batchCreate escrows, then attach IDs
      const ids = await createEscrowsFor(escrow, yieldGate, deployer, [investor.address]);
      await distributor.setEscrowIds(1, ids);

      await distributor.processBatch(1, 10);

      expect(await distributor.isDistributionComplete(1)).to.be.true;
      expect(await escrow.escrowCount()).to.equal(1n);

      // Verify fundFrom actually moved the encrypted per-investor yield into the escrow
      const paid = await escrow.getPaidAmount(ids[0]);
      hre.cofhe.mocks.expectPlaintext(paid, yieldAmount);
    });

    it("reverts EscrowIdsNotSet if processBatch runs before setEscrowIds", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc } = await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await pusdc.mint(deployer.address, Number(ONE_PUSDC));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();
      await distributor.startDistribution(encYield);

      await expect(distributor.processBatch(1, 10))
        .to.be.revertedWithCustomError(distributor, "EscrowIdsNotSet");
    });

    it("processes multi-investor distributions across batches", async function () {
      const { distributor, deployer, issuer, investor, alice, token, pusdc, escrow, yieldGate } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      // Register 2 investors
      const [encMintA] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMintA);
      const [encMintB] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(alice.address, encMintB);

      const yieldAmount = 20n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);

      const ids = await createEscrowsFor(escrow, yieldGate, deployer, [
        investor.address,
        alice.address,
      ]);
      await distributor.setEscrowIds(1, ids);

      // batchSize=1 — two calls needed
      await distributor.processBatch(1, 1);
      expect(await distributor.isDistributionComplete(1)).to.be.false;
      await distributor.processBatch(1, 1);
      expect(await distributor.isDistributionComplete(1)).to.be.true;

      // Each investor's escrow funded with yieldAmount / 2
      const perInvestor = yieldAmount / 2n;
      hre.cofhe.mocks.expectPlaintext(await escrow.getPaidAmount(ids[0]), perInvestor);
      hre.cofhe.mocks.expectPlaintext(await escrow.getPaidAmount(ids[1]), perInvestor);
    });

    it("reverts AlreadyCompleted if called on a finished distribution", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc, escrow, yieldGate } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await pusdc.mint(deployer.address, Number(ONE_PUSDC));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();
      await distributor.startDistribution(encYield);

      const ids = await createEscrowsFor(escrow, yieldGate, deployer, [investor.address]);
      await distributor.setEscrowIds(1, ids);
      await distributor.processBatch(1, 10);

      await expect(distributor.processBatch(1, 10))
        .to.be.revertedWithCustomError(distributor, "AlreadyCompleted");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // grantYieldDecryptAccess()
  // ────────────────────────────────────────────────────────────────────────────

  describe("grantYieldDecryptAccess()", function () {
    async function startedDistribution() {
      const ctx = await loadFixture(deployYieldFixture);
      const { distributor, deployer, issuer, investor, token, pusdc } = ctx;
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const yieldAmount = 10n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);
      return ctx;
    }

    it("owner grants decrypt access + emits YieldDecryptAccessGranted", async function () {
      const { distributor, deployer, alice } = await startedDistribution();
      await expect(distributor.connect(deployer).grantYieldDecryptAccess(1, alice.address))
        .to.emit(distributor, "YieldDecryptAccessGranted")
        .withArgs(1n, alice.address);
    });

    it("reverts OnlyOwner when non-owner calls", async function () {
      const { distributor, alice } = await startedDistribution();
      await expect(distributor.connect(alice).grantYieldDecryptAccess(1, alice.address))
        .to.be.revertedWithCustomError(distributor, "OnlyOwner");
    });

    it("reverts InvalidDistribution for unknown distributionId", async function () {
      const { distributor, deployer, alice } = await startedDistribution();
      await expect(distributor.connect(deployer).grantYieldDecryptAccess(999, alice.address))
        .to.be.revertedWithCustomError(distributor, "InvalidDistribution");
      await expect(distributor.connect(deployer).grantYieldDecryptAccess(0, alice.address))
        .to.be.revertedWithCustomError(distributor, "InvalidDistribution");
    });

    it("reverts ZeroAddress when viewer is zero", async function () {
      const { distributor, deployer } = await startedDistribution();
      await expect(distributor.connect(deployer).grantYieldDecryptAccess(1, ZERO_ADDRESS))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("is idempotent — second grant succeeds and emits again", async function () {
      const { distributor, deployer, alice } = await startedDistribution();
      await distributor.connect(deployer).grantYieldDecryptAccess(1, alice.address);
      // Second call succeeds (FHE.allow is idempotent) and emits again for audit trail.
      await expect(distributor.connect(deployer).grantYieldDecryptAccess(1, alice.address))
        .to.emit(distributor, "YieldDecryptAccessGranted")
        .withArgs(1n, alice.address);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Admin setters
  // ────────────────────────────────────────────────────────────────────────────

  describe("admin setters", function () {
    it("setYieldGate: owner succeeds + emits event", async function () {
      const { distributor, deployer, yieldGate } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setYieldGate(await yieldGate.getAddress())
      ).to.emit(distributor, "YieldGateUpdated");
    });

    it("setMuHavenEscrow: owner succeeds + emits event", async function () {
      const { distributor, deployer, escrow } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setMuHavenEscrow(await escrow.getAddress())
      ).to.emit(distributor, "MuHavenEscrowUpdated");
    });

    it("setPusdc: owner succeeds + emits event", async function () {
      const { distributor, deployer, pusdc } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setPusdc(await pusdc.getAddress())
      ).to.emit(distributor, "PusdcUpdated");
    });

    it("setMuHavenEscrow: non-owner reverts", async function () {
      const { distributor, alice, escrow } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(alice).setMuHavenEscrow(await escrow.getAddress())
      ).to.be.revertedWithCustomError(distributor, "OnlyOwner");
    });
  });
});
