import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployMuHavenFixture, ZERO_ADDRESS } from "./helpers/setup";

describe("ERC3643KYCAdapter", function () {
  describe("isEligible()", function () {
    it("should return true for whitelisted investor", async function () {
      const { kyc, investor } = await loadFixture(deployMuHavenFixture);
      expect(await kyc.isEligible(investor.address)).to.be.true;
    });

    it("should return false for non-whitelisted address", async function () {
      const { kyc } = await loadFixture(deployMuHavenFixture);
      const [, , , , nonKyc] = await (await import("hardhat")).ethers.getSigners();
      expect(await kyc.isEligible(nonKyc.address)).to.be.false;
    });
  });

  describe("isEligibleForTier()", function () {
    it("tier 1: should return true for whitelisted investor", async function () {
      const { kyc, investor } = await loadFixture(deployMuHavenFixture);
      expect(await kyc.isEligibleForTier(investor.address, 1)).to.be.true;
    });

    it("tier 2: should return false without accredited status", async function () {
      const { kyc, investor } = await loadFixture(deployMuHavenFixture);
      expect(await kyc.isEligibleForTier(investor.address, 2)).to.be.false;
    });

    it("tier 2: should return true when whitelisted + accredited", async function () {
      const { kyc, deployer, investor } = await loadFixture(deployMuHavenFixture);
      await kyc.connect(deployer).addToAccreditedList(investor.address);
      expect(await kyc.isEligibleForTier(investor.address, 2)).to.be.true;
    });
  });

  describe("removeFromWhitelist()", function () {
    it("should clear both whitelist and accredited status", async function () {
      const { kyc, deployer, investor } = await loadFixture(deployMuHavenFixture);
      await kyc.connect(deployer).addToAccreditedList(investor.address);
      await kyc.connect(deployer).removeFromWhitelist(investor.address);
      expect(await kyc.isWhitelisted(investor.address)).to.be.false;
      expect(await kyc.isAccredited(investor.address)).to.be.false;
    });
  });

  describe("batchAddToWhitelist()", function () {
    it("should whitelist multiple addresses in one call", async function () {
      const { kyc, deployer } = await loadFixture(deployMuHavenFixture);
      const signers = await (await import("hardhat")).ethers.getSigners();
      const addresses = signers.slice(5, 8).map((s: any) => s.address);
      await kyc.connect(deployer).batchAddToWhitelist(addresses);
      for (const addr of addresses) {
        expect(await kyc.isWhitelisted(addr)).to.be.true;
      }
    });
  });

  describe("admin functions", function () {
    it("should revert admin call from non-admin", async function () {
      const { kyc, investor, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        kyc.connect(investor).addToWhitelist(alice.address)
      ).to.be.revertedWithCustomError(kyc, "OnlyAdmin");
    });

    it("should transfer admin", async function () {
      const { kyc, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await kyc.connect(deployer).transferAdmin(alice.address);
      // alice is now admin; deployer is not
      await expect(
        kyc.connect(deployer).addToWhitelist(alice.address)
      ).to.be.revertedWithCustomError(kyc, "OnlyAdmin");
    });
  });
});
