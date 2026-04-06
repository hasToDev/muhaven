import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import { deployMuHavenFixture, ZERO_ADDRESS } from "./helpers/setup";

describe("InvestorRegistry", function () {
  describe("register()", function () {
    it("should register an investor via authorized caller (token)", async function () {
      // Token calls registry.register() as a side-effect of mint
      const { token, registry, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const { Encryptable } = await import("@cofhe/sdk");

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(investor.address, encAmount);

      expect(await registry.isInvestor(investor.address)).to.be.true;
      expect(await registry.investorCount()).to.equal(1n);
    });

    it("should be idempotent (no duplicate registration)", async function () {
      const { token, registry, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const { Encryptable } = await import("@cofhe/sdk");

      const [enc1] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(investor.address, enc1);
      const [enc2] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(investor.address, enc2);

      expect(await registry.investorCount()).to.equal(1n);
    });

    it("should revert register() from unauthorized caller", async function () {
      const { registry, investor } = await loadFixture(deployMuHavenFixture);
      await expect(
        registry.connect(investor).register(investor.address)
      ).to.be.revertedWithCustomError(registry, "OnlyAuthorized");
    });
  });

  describe("getInvestorsPaginated()", function () {
    it("should return paginated investors", async function () {
      const { token, registry, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const { Encryptable } = await import("@cofhe/sdk");

      const [e1] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(investor.address, e1);
      const [e2] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(alice.address, e2);

      const page = await registry.getInvestorsPaginated(0, 1);
      expect(page.length).to.equal(1);
    });

    it("should return empty array when offset >= total", async function () {
      const { registry } = await loadFixture(deployMuHavenFixture);
      const page = await registry.getInvestorsPaginated(100, 10);
      expect(page.length).to.equal(0);
    });

    it("should clamp to remaining elements when offset + limit > total", async function () {
      const { token, registry, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const { Encryptable } = await import("@cofhe/sdk");

      const [e1] = await issuerClient.encryptInputs([Encryptable.uint128(1000n)]).execute();
      await token.connect(issuer).mint(investor.address, e1);

      const page = await registry.getInvestorsPaginated(0, 100);
      expect(page.length).to.equal(1);
    });
  });

  describe("setAuthorizedCaller() / transferOwnership()", function () {
    it("should allow owner to set authorized caller", async function () {
      const { registry, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        registry.connect(deployer).setAuthorizedCaller(alice.address, true)
      ).to.emit(registry, "AuthorizedCallerUpdated");
    });

    it("should revert setAuthorizedCaller from non-owner", async function () {
      const { registry, investor, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        registry.connect(investor).setAuthorizedCaller(alice.address, true)
      ).to.be.revertedWithCustomError(registry, "OnlyOwner");
    });

    it("should transfer ownership", async function () {
      const { registry, deployer, alice } = await loadFixture(deployMuHavenFixture);
      await registry.connect(deployer).transferOwnership(alice.address);
      expect(await registry.owner()).to.equal(alice.address);
    });
  });
});
