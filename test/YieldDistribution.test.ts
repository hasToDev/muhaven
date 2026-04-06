import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployMuHavenFixture,
  deployMockReineiraEscrow,
  ONE_TOKEN,
} from "./helpers/setup";
import { upgrades } from "hardhat";

describe("YieldDistributor + YieldGate", function () {
  async function deployYieldFixture() {
    const base = await loadFixture(deployMuHavenFixture);
    const { deployer, token, kyc, registry } = base;

    const escrow = await deployMockReineiraEscrow();

    // Deploy YieldGate
    const YieldGate = await hre.ethers.getContractFactory("YieldGate");
    const yieldGate = await YieldGate.deploy(
      await token.getAddress(),
      await kyc.getAddress()
    );

    // Deploy YieldDistributor
    const YieldDistributor = await hre.ethers.getContractFactory("YieldDistributor");
    const distributor = await upgrades.deployProxy(
      YieldDistributor,
      [
        await registry.getAddress(),
        await escrow.getAddress(),
        await yieldGate.getAddress(),
        deployer.address,
      ],
      { kind: "transparent", initializer: "initialize" }
    );

    return { ...base, escrow, yieldGate, distributor };
  }

  describe("startDistribution()", function () {
    it("should start a distribution and create a PENDING entry", async function () {
      const { distributor, deployer, issuer, investor, token, treasury } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      // Mint tokens so there is at least 1 investor
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Authorize distributor to pull yield from deployer
      await treasury.mint(deployer.address, 100n * ONE_TOKEN);
      await treasury.approve(await distributor.getAddress(), 100n * ONE_TOKEN);

      await distributor.startDistribution(await treasury.getAddress(), 10n * ONE_TOKEN);

      const dist = await distributor.getDistribution(1);
      expect(dist.investorCount).to.equal(1n);
      expect(dist.totalYield).to.equal(10n * ONE_TOKEN);
    });

    it("should revert startDistribution with zero yield", async function () {
      const { distributor, treasury } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.startDistribution(await treasury.getAddress(), 0n)
      ).to.be.reverted;
    });
  });

  describe("processBatch()", function () {
    it("should process a batch and mark distribution COMPLETED", async function () {
      const { distributor, deployer, issuer, investor, token, treasury, escrow } =
        await loadFixture(deployYieldFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await treasury.mint(deployer.address, 100n * ONE_TOKEN);
      await treasury.approve(await distributor.getAddress(), 100n * ONE_TOKEN);
      await distributor.startDistribution(await treasury.getAddress(), 10n * ONE_TOKEN);

      // processBatch is permissionless
      await distributor.processBatch(1, 10);

      expect(await distributor.isDistributionComplete(1)).to.be.true;
      expect(await escrow.escrowCount()).to.equal(1n);
    });
  });

  describe("setYieldGate() / setReineiraEscrow()", function () {
    it("should allow owner to swap yield gate", async function () {
      const { distributor, deployer, yieldGate } = await loadFixture(deployYieldFixture);
      await expect(
        distributor.connect(deployer).setYieldGate(await yieldGate.getAddress())
      ).to.not.be.reverted;
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
      const createTx = await escrow.create(investor.address, 0n, await yieldGate.getAddress());
      await createTx.wait();
      const escrowId = await escrow.escrowCount();

      await yieldGate.onConditionSet(escrowId, data);
      expect(await yieldGate.isConditionMet(escrowId)).to.be.true;
    });
  });
});
