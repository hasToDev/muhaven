import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployMuHavenFixture, ZERO_ADDRESS } from "./helpers/setup";

describe("MuHavenToken — Access Control", function () {
  describe("grantMinter / revokeMinter", function () {
    it("should allow owner to grant minter role", async function () {
      const { token, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await token.connect(deployer).grantMinter(alice.address);
      expect(await token.minters(alice.address)).to.be.true;
    });

    it("should allow owner to revoke minter role", async function () {
      const { token, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await token.connect(deployer).grantMinter(alice.address);
      await token.connect(deployer).revokeMinter(alice.address);
      expect(await token.minters(alice.address)).to.be.false;
    });

    it("should revert grantMinter from non-owner", async function () {
      const { token, investor, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).grantMinter(alice.address)
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });

    it("should revert grantMinter to zero address", async function () {
      const { token, deployer } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(deployer).grantMinter(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });
  });

  describe("setKYCGate / setIssuer / setRegistry", function () {
    it("should allow owner to update KYC gate", async function () {
      const { token, deployer, kyc } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(deployer).setKYCGate(await kyc.getAddress())
      ).to.emit(token, "KYCGateUpdated");
    });

    it("should revert setKYCGate from non-owner", async function () {
      const { token, investor, kyc } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).setKYCGate(await kyc.getAddress())
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });
  });

  describe("transferOwnership", function () {
    it("should transfer ownership and emit event", async function () {
      const { token, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(deployer).transferOwnership(alice.address)
      )
        .to.emit(token, "OwnershipTransferred")
        .withArgs(deployer.address, alice.address);
      expect(await token.owner()).to.equal(alice.address);
    });

    it("should revert transferOwnership to zero address", async function () {
      const { token, deployer } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(deployer).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });
  });
});
