/**
 * MuHavenIdentityRegistry unit tests (Phase 3).
 *
 * Covers:
 *   - devMode bypass + irreversible latch (ADR-023)
 *   - Whitelist fast path (Wave 3 bulk-import, MIGRATION.md)
 *   - Production-mode claim verification (topics × trusted issuers × expiry)
 *   - Country + accreditation setters consumed by compliance modules
 *   - Owner / issuer access control on claim storage
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

async function deployStackCore(devMode: boolean) {
  const [deployer] = await hre.ethers.getSigners();

  const TopicsFactory = await hre.ethers.getContractFactory("ClaimTopicsRegistry");
  const topicsReg = await upgrades.deployProxy(
    TopicsFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const IssuersFactory = await hre.ethers.getContractFactory("TrustedIssuersRegistry");
  const issuersReg = await upgrades.deployProxy(
    IssuersFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const IdentityFactory = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
  const identityReg = await upgrades.deployProxy(
    IdentityFactory,
    [
      deployer.address,
      await topicsReg.getAddress(),
      await issuersReg.getAddress(),
      devMode,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  return { deployer, topicsReg, issuersReg, identityReg };
}

async function deployStackDevMode() {
  return deployStackCore(true);
}

async function deployStackProdMode() {
  return deployStackCore(false);
}

describe("MuHavenIdentityRegistry", () => {
  describe("initialization", () => {
    it("records owner + registries + devMode", async () => {
      const { deployer, topicsReg, issuersReg, identityReg } =
        await loadFixture(deployStackDevMode);
      expect(await identityReg.owner()).to.equal(deployer.address);
      expect(await identityReg.devMode()).to.equal(true);
      expect(await identityReg.devModeDisabled()).to.equal(false);
      expect(await identityReg.claimTopicsRegistry()).to.equal(
        await topicsReg.getAddress()
      );
      expect(await identityReg.trustedIssuersRegistry()).to.equal(
        await issuersReg.getAddress()
      );
    });

    it("accepts zero registry addresses (production-flip can wire later)", async () => {
      const [deployer] = await hre.ethers.getSigners();
      const Factory = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
      const reg = await upgrades.deployProxy(
        Factory,
        [deployer.address, ZERO_ADDRESS, ZERO_ADDRESS, true],
        { kind: "transparent", initializer: "initialize" }
      );
      expect(await reg.claimTopicsRegistry()).to.equal(ZERO_ADDRESS);
      expect(await reg.trustedIssuersRegistry()).to.equal(ZERO_ADDRESS);
    });

    it("rejects zero owner", async () => {
      const Factory = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
      await expect(
        upgrades.deployProxy(
          Factory,
          [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, true],
          { kind: "transparent", initializer: "initialize" }
        )
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  describe("dev-mode bypass + latch (ADR-023)", () => {
    it("dev-mode on: any address is verified", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, , random] = await hre.ethers.getSigners();
      expect(await identityReg.isVerified(random.address)).to.equal(true);
      expect(await identityReg.isVerified(ZERO_ADDRESS)).to.equal(true);
    });

    it("setDevMode emits DevModeToggled and toggles the flag", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      await expect(identityReg.setDevMode(false)).to.emit(
        identityReg,
        "DevModeToggled"
      );
      expect(await identityReg.devMode()).to.equal(false);
    });

    it("disableDevModeForever latches; setDevMode(true) reverts after", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      await expect(identityReg.disableDevModeForever())
        .to.emit(identityReg, "DevModeDisabledForever");
      expect(await identityReg.devModeDisabled()).to.equal(true);
      expect(await identityReg.devMode()).to.equal(false);

      await expect(
        identityReg.setDevMode(true)
      ).to.be.revertedWithCustomError(identityReg, "DevModeIrreversiblyDisabled");
      await expect(
        identityReg.setDevMode(false)
      ).to.be.revertedWithCustomError(identityReg, "DevModeIrreversiblyDisabled");
    });

    it("non-owner cannot toggle or disable", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, stranger] = await hre.ethers.getSigners();
      await expect(
        identityReg.connect(stranger).setDevMode(false)
      ).to.be.revertedWithCustomError(identityReg, "OnlyOwner");
      await expect(
        identityReg.connect(stranger).disableDevModeForever()
      ).to.be.revertedWithCustomError(identityReg, "OnlyOwner");
    });
  });

  describe("whitelist (Wave 3 bulk-import)", () => {
    it("addWhitelisted bulk-adds + dedupes", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, a, b] = await hre.ethers.getSigners();
      await identityReg.addWhitelisted([a.address, b.address, a.address]);
      expect(await identityReg.isWhitelisted(a.address)).to.equal(true);
      expect(await identityReg.isWhitelisted(b.address)).to.equal(true);
    });

    it("whitelisted address is verified even with devMode off", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, a] = await hre.ethers.getSigners();
      expect(await identityReg.isVerified(a.address)).to.equal(false);
      await identityReg.addWhitelisted([a.address]);
      expect(await identityReg.isVerified(a.address)).to.equal(true);
    });

    it("removeWhitelisted reverses verification", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, a] = await hre.ethers.getSigners();
      await identityReg.addWhitelisted([a.address]);
      await identityReg.removeWhitelisted(a.address);
      expect(await identityReg.isWhitelisted(a.address)).to.equal(false);
      expect(await identityReg.isVerified(a.address)).to.equal(false);
    });

    it("rejects zero address in batch", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      await expect(
        identityReg.addWhitelisted([ZERO_ADDRESS])
      ).to.be.revertedWithCustomError(identityReg, "ZeroAddress");
    });
  });

  describe("production-mode claim verification", () => {
    it("returns false when no topics required (no whitelist / no claims)", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, a] = await hre.ethers.getSigners();
      expect(await identityReg.isVerified(a.address)).to.equal(false);
    });

    it("returns true when all required topics have valid claims from trusted issuers", async () => {
      const { identityReg, topicsReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();

      // Require topic 1 (KYC). Trust the issuer for that topic.
      await topicsReg.addClaimTopic(1);
      await issuersReg.addTrustedIssuer(issuer.address, [1]);

      // Owner-path claim store: validUntil in the future.
      const validUntil = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await identityReg.addClaim(investor.address, 1, issuer.address, validUntil);

      expect(await identityReg.isVerified(investor.address)).to.equal(true);
    });

    it("returns false when one required topic is missing", async () => {
      const { identityReg, topicsReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();

      await topicsReg.addClaimTopic(1);
      await topicsReg.addClaimTopic(7);
      await issuersReg.addTrustedIssuer(issuer.address, [1, 7]);

      const validUntil = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await identityReg.addClaim(investor.address, 1, issuer.address, validUntil);
      // Missing claim for topic 7.

      expect(await identityReg.isVerified(investor.address)).to.equal(false);
    });

    it("returns false when claim is expired (validUntil < block.timestamp)", async () => {
      const { identityReg, topicsReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();

      await topicsReg.addClaimTopic(1);
      await issuersReg.addTrustedIssuer(issuer.address, [1]);

      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      const validUntil = now + 100;
      await identityReg.addClaim(investor.address, 1, issuer.address, validUntil);

      expect(await identityReg.isVerified(investor.address)).to.equal(true);

      // Fast-forward past expiry.
      await time.increase(200);

      expect(await identityReg.isVerified(investor.address)).to.equal(false);
    });

    it("returns false when the signing issuer is no longer trusted for the topic", async () => {
      const { identityReg, topicsReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();

      await topicsReg.addClaimTopic(1);
      await issuersReg.addTrustedIssuer(issuer.address, [1]);

      const validUntil = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await identityReg.addClaim(investor.address, 1, issuer.address, validUntil);
      expect(await identityReg.isVerified(investor.address)).to.equal(true);

      // Revoke the issuer's topic authorisation.
      await issuersReg.updateIssuerTopics(issuer.address, [7]);
      expect(await identityReg.isVerified(investor.address)).to.equal(false);
    });

    it("returns false when registries are not wired", async () => {
      const [deployer] = await hre.ethers.getSigners();
      const Factory = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
      const reg = await upgrades.deployProxy(
        Factory,
        [deployer.address, ZERO_ADDRESS, ZERO_ADDRESS, false],
        { kind: "transparent", initializer: "initialize" }
      );
      const [, investor] = await hre.ethers.getSigners();
      expect(await reg.isVerified(investor.address)).to.equal(false);
    });
  });

  describe("claim add/remove access control", () => {
    it("owner can add + remove claims", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [deployer, investor, issuer] = await hre.ethers.getSigners();

      const validUntil = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      await expect(
        identityReg.addClaim(investor.address, 1, issuer.address, validUntil)
      )
        .to.emit(identityReg, "ClaimAdded")
        .withArgs(investor.address, 1, issuer.address, validUntil);

      const [storedIssuer, storedValidUntil] = await identityReg.getClaim(
        investor.address,
        1
      );
      expect(storedIssuer).to.equal(issuer.address);
      expect(storedValidUntil).to.equal(BigInt(validUntil));

      await expect(identityReg.removeClaim(investor.address, 1))
        .to.emit(identityReg, "ClaimRemoved")
        .withArgs(investor.address, 1);
    });

    it("trusted issuer can self-attest for a topic they hold", async () => {
      const { identityReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();
      await issuersReg.addTrustedIssuer(issuer.address, [1]);

      const validUntil = Math.floor(Date.now() / 1000) + 1_000;
      await expect(
        identityReg
          .connect(issuer)
          .addClaim(investor.address, 1, issuer.address, validUntil)
      ).to.emit(identityReg, "ClaimAdded");
    });

    it("non-owner non-trusted caller cannot add a claim", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer, stranger] = await hre.ethers.getSigners();
      const validUntil = Math.floor(Date.now() / 1000) + 1_000;
      await expect(
        identityReg
          .connect(stranger)
          .addClaim(investor.address, 1, issuer.address, validUntil)
      ).to.be.revertedWithCustomError(identityReg, "NotOwnerOrTrustedIssuer");
    });

    it("trusted issuer cannot attest on someone else's behalf", async () => {
      const { identityReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuerA, issuerB] = await hre.ethers.getSigners();
      await issuersReg.addTrustedIssuer(issuerA.address, [1]);
      await issuersReg.addTrustedIssuer(issuerB.address, [1]);

      const validUntil = Math.floor(Date.now() / 1000) + 1_000;
      // A tries to add a claim signed "by" B — rejected.
      await expect(
        identityReg
          .connect(issuerA)
          .addClaim(investor.address, 1, issuerB.address, validUntil)
      ).to.be.revertedWithCustomError(identityReg, "InvalidIssuer");
    });

    it("addClaim rejects past validUntil", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();
      await expect(
        identityReg.addClaim(investor.address, 1, issuer.address, 1)
      ).to.be.revertedWithCustomError(identityReg, "InvalidValidUntil");
    });

    it("removeClaim can be called by claim issuer", async () => {
      const { identityReg, issuersReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer] = await hre.ethers.getSigners();
      await issuersReg.addTrustedIssuer(issuer.address, [1]);
      const validUntil = Math.floor(Date.now() / 1000) + 1_000;
      await identityReg
        .connect(issuer)
        .addClaim(investor.address, 1, issuer.address, validUntil);

      await expect(identityReg.connect(issuer).removeClaim(investor.address, 1))
        .to.emit(identityReg, "ClaimRemoved")
        .withArgs(investor.address, 1);
    });

    it("removeClaim by a third party reverts", async () => {
      const { identityReg } = await loadFixture(deployStackProdMode);
      const [, investor, issuer, stranger] = await hre.ethers.getSigners();
      const validUntil = Math.floor(Date.now() / 1000) + 1_000;
      await identityReg.addClaim(investor.address, 1, issuer.address, validUntil);
      await expect(
        identityReg.connect(stranger).removeClaim(investor.address, 1)
      ).to.be.revertedWithCustomError(identityReg, "NotOwnerOrTrustedIssuer");
    });
  });

  describe("country + accreditation setters (compliance inputs)", () => {
    it("setCountry updates the per-account country", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, investor] = await hre.ethers.getSigners();
      await expect(identityReg.setCountry(investor.address, 840))
        .to.emit(identityReg, "CountryUpdated")
        .withArgs(investor.address, 840);
      expect(await identityReg.countryOf(investor.address)).to.equal(840);
    });

    it("setCountryBatch updates many accounts", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, a, b] = await hre.ethers.getSigners();
      await identityReg.setCountryBatch([a.address, b.address], [840, 250]);
      expect(await identityReg.countryOf(a.address)).to.equal(840);
      expect(await identityReg.countryOf(b.address)).to.equal(250);
    });

    it("setCountryBatch reverts on length mismatch", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, a, b] = await hre.ethers.getSigners();
      await expect(
        identityReg.setCountryBatch([a.address, b.address], [840])
      ).to.be.revertedWithCustomError(identityReg, "ArrayLengthMismatch");
    });

    it("setAccredited toggles the flag + emits", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, investor] = await hre.ethers.getSigners();
      await expect(identityReg.setAccredited(investor.address, true))
        .to.emit(identityReg, "AccreditedUpdated")
        .withArgs(investor.address, true);
      expect(await identityReg.isAccredited(investor.address)).to.equal(true);
    });
  });

  describe("registry pointer setters", () => {
    it("setClaimTopicsRegistry / setTrustedIssuersRegistry emit and rotate", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, newPtr] = await hre.ethers.getSigners();
      await expect(identityReg.setClaimTopicsRegistry(newPtr.address))
        .to.emit(identityReg, "ClaimTopicsRegistryUpdated");
      await expect(identityReg.setTrustedIssuersRegistry(newPtr.address))
        .to.emit(identityReg, "TrustedIssuersRegistryUpdated");
    });

    it("non-owner cannot rotate the registry pointers", async () => {
      const { identityReg } = await loadFixture(deployStackDevMode);
      const [, stranger] = await hre.ethers.getSigners();
      await expect(
        identityReg.connect(stranger).setClaimTopicsRegistry(stranger.address)
      ).to.be.revertedWithCustomError(identityReg, "OnlyOwner");
    });
  });
});
