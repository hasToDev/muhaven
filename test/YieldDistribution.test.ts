import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockReineiraEscrow,
  deployMockPUSDC,
  ONE_TOKEN,
  waitForDecrypt,
} from "./helpers/setup";
import { upgrades } from "hardhat";

/// @dev PUSDC uses 6 decimals (like USDC). 1 PUSDC = 1_000_000 units.
const ONE_PUSDC = 1_000_000n;

describe("YieldDistributor + YieldGate", function () {
  async function deployYieldFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, token, kyc, registry } = base;

    const escrow = await deployMockReineiraEscrow();
    const pusdc = await deployMockPUSDC();

    // Deploy YieldGate
    const YieldGate = await hre.ethers.getContractFactory("YieldGate");
    const yieldGate = await YieldGate.deploy(
      await token.getAddress(),
      await kyc.getAddress()
    );

    // Deploy YieldDistributor with PUSDC
    const YieldDistributor = await hre.ethers.getContractFactory("YieldDistributor");
    const distributor = await upgrades.deployProxy(
      YieldDistributor,
      [
        await registry.getAddress(),
        await escrow.getAddress(),
        await yieldGate.getAddress(),
        deployer.address,
        await pusdc.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    return { ...base, escrow, pusdc, yieldGate, distributor };
  }

  describe("startDistribution()", function () {
    it("should start a distribution via PUSDC confidentialTransferFrom", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      // Mint tokens so there is at least 1 investor
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Fund deployer with PUSDC and grant operator status to distributor
      const yieldAmount = 10n * ONE_PUSDC;
      await pusdc.mint(deployer.address, Number(yieldAmount));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      // Encrypt yield amount and pass as InEuint64
      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(yieldAmount)]).execute();
      await distributor.startDistribution(encYield);

      const dist = await distributor.getDistribution(1);
      expect(dist.investorCount).to.equal(1n);
      // totalYield is widened from euint64 (10 PUSDC) to euint128
      hre.cofhe.mocks.expectPlaintext(dist.encTotalYield, yieldAmount);
      // perInvestorYield = totalYield / investorCount = 10 PUSDC
      hre.cofhe.mocks.expectPlaintext(dist.encPerInvestorYield, yieldAmount);
      // status should be PENDING (0)
      expect(dist.status).to.equal(0n);
    });

    it("should revert startDistribution when no investors registered", async function () {
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

  describe("processBatch()", function () {
    it("should process a batch and mark distribution COMPLETED", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc, escrow } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await pusdc.mint(deployer.address, Number(10n * ONE_PUSDC));
      const distributorAddr = await distributor.getAddress();
      await pusdc.connect(deployer).setOperator(distributorAddr, 2000000000);

      const deployerClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encYield] = await deployerClient.encryptInputs([Encryptable.uint64(10n * ONE_PUSDC)]).execute();
      await distributor.startDistribution(encYield);

      // processBatch is permissionless
      await distributor.processBatch(1, 10);

      expect(await distributor.isDistributionComplete(1)).to.be.true;
      expect(await escrow.escrowCount()).to.equal(1n);
    });
  });

  describe("requestYieldDecrypt() + getYieldDecryptResult()", function () {
    it("should return decrypted yield amounts after time.increase(11)", async function () {
      const { distributor, deployer, issuer, investor, token, pusdc } =
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

      // Request async decrypt of yield amounts
      await distributor.connect(deployer).requestYieldDecrypt(1);
      await waitForDecrypt();

      const result = await distributor.getYieldDecryptResult(1);
      expect(result.totalYieldDecrypted).to.be.true;
      expect(result.totalYield).to.equal(yieldAmount);
      expect(result.perInvestorYieldDecrypted).to.be.true;
      expect(result.perInvestorYield).to.equal(yieldAmount); // 1 investor
    });
  });

  describe("setYieldGate() / setReineiraEscrow() / setPusdc()", function () {
    it("should allow owner to swap yield gate", async function () {
      const { distributor, deployer, yieldGate } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setYieldGate(await yieldGate.getAddress())
      ).to.not.be.reverted;
    });

    it("should allow owner to swap PUSDC address", async function () {
      const { distributor, deployer, pusdc } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setPusdc(await pusdc.getAddress())
      ).to.emit(distributor, "PusdcUpdated");
    });
  });

  describe("YieldGate.isConditionMet()", function () {
    it("should return true for investor with initialized balance", async function () {
      const { yieldGate, escrow, issuer, investor, token } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Create an escrow entry so the gate has a stored beneficiary
      const data = hre.ethers.AbiCoder.defaultAbiCoder().encode(["address"], [investor.address]);
      const createTx = await escrow.create(investor.address, hre.ethers.ZeroHash, await yieldGate.getAddress());
      await createTx.wait();
      const escrowId = await escrow.escrowCount();

      await yieldGate.onConditionSet(escrowId, data);
      expect(await yieldGate.isConditionMet(escrowId)).to.be.true;
    });
  });
});
