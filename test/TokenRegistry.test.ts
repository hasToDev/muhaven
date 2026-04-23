/**
 * TokenRegistry unit tests.
 *
 * Covers the ADR-024 separate-contract registry: registerToken, per-field
 * setters (owner vs issuer scope), pagination, views, and access-control
 * error paths.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

async function deployTokenRegistry() {
  const [deployer] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("TokenRegistry");
  const registry = await upgrades.deployProxy(Factory, [deployer.address], {
    kind: "transparent",
    initializer: "initialize",
  });
  return registry;
}

/**
 * Build a TokenConfig struct for test calls. Address slots are intentionally
 * non-zero so the `registerToken` zero-address guard stays triggerable in
 * the negative-path tests (which override individual slots).
 */
function buildConfig(overrides: Partial<{
  active: boolean;
  treasury: string;
  queue: string;
  oracle: string;
  issuer: string;
  minInvestment: bigint;
  instantRedeemCap: bigint;
  epochDuration: number;
  paused: boolean;
}> = {}) {
  return {
    active: overrides.active ?? false,
    treasury: overrides.treasury ?? "0x1000000000000000000000000000000000000000",
    queue: overrides.queue ?? "0x2000000000000000000000000000000000000000",
    oracle: overrides.oracle ?? "0x3000000000000000000000000000000000000000",
    issuer: overrides.issuer ?? "0x4000000000000000000000000000000000000000",
    minInvestment: overrides.minInvestment ?? 100n,
    instantRedeemCap: overrides.instantRedeemCap ?? 1_000_000n,
    epochDuration: overrides.epochDuration ?? 86400,
    paused: overrides.paused ?? false,
  };
}

const TOKEN_A = "0x0000000000000000000000000000000000000aaa";
const TOKEN_B = "0x0000000000000000000000000000000000000bbb";

describe("TokenRegistry", () => {
  describe("initialize()", () => {
    it("sets owner", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [deployer] = await hre.ethers.getSigners();
      expect(await registry.owner()).to.equal(deployer.address);
    });
  });

  describe("registerToken()", () => {
    it("records the config and emits TokenRegistered", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const cfg = buildConfig();

      await expect(registry.registerToken(TOKEN_A, cfg))
        .to.emit(registry, "TokenRegistered")
        .withArgs(TOKEN_A, cfg.issuer);

      const stored = await registry.getConfig(TOKEN_A);
      expect(stored.active).to.equal(true);
      expect(stored.treasury).to.equal(cfg.treasury);
      expect(stored.queue).to.equal(cfg.queue);
      expect(stored.oracle).to.equal(cfg.oracle);
      expect(stored.issuer).to.equal(cfg.issuer);
      expect(stored.minInvestment).to.equal(cfg.minInvestment);
      expect(stored.instantRedeemCap).to.equal(cfg.instantRedeemCap);
      expect(stored.epochDuration).to.equal(cfg.epochDuration);
      expect(stored.paused).to.equal(false);

      expect(await registry.registeredTokenCount()).to.equal(1n);
    });

    it("rejects a non-owner caller", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, stranger] = await hre.ethers.getSigners();
      await expect(
        registry.connect(stranger).registerToken(TOKEN_A, buildConfig())
      ).to.be.revertedWithCustomError(registry, "OnlyOwner");
    });

    it("rejects a second registration for the same token", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());
      await expect(
        registry.registerToken(TOKEN_A, buildConfig())
      ).to.be.revertedWithCustomError(registry, "TokenAlreadyRegistered");
    });

    it("rejects a zero token address", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await expect(
        registry.registerToken(ZERO_ADDRESS, buildConfig())
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("rejects a config with a zero treasury / queue / oracle / issuer", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      for (const slot of ["treasury", "queue", "oracle", "issuer"] as const) {
        await expect(
          registry.registerToken(
            TOKEN_A,
            buildConfig({ [slot]: ZERO_ADDRESS } as Record<typeof slot, string>)
          )
        ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      }
    });

    it("rejects zero epochDuration", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await expect(
        registry.registerToken(TOKEN_A, buildConfig({ epochDuration: 0 }))
      ).to.be.revertedWithCustomError(registry, "ZeroEpochDuration");
    });

    it("honours a paused=true config at registration time", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig({ paused: true }));

      const stored = await registry.getConfig(TOKEN_A);
      expect(stored.paused).to.equal(true);
      expect(stored.active).to.equal(true);
      // A paused token is registered but not "open for business".
      expect(await registry.isActive(TOKEN_A)).to.equal(false);
    });
  });

  describe("setters — access control and effects", () => {
    it("setIssuer rotates the issuer (owner-only)", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, , newIssuer] = await hre.ethers.getSigners();

      await registry.registerToken(TOKEN_A, buildConfig());
      const beforeIssuer = (await registry.getConfig(TOKEN_A)).issuer;

      await expect(registry.setIssuer(TOKEN_A, newIssuer.address))
        .to.emit(registry, "IssuerUpdated")
        .withArgs(TOKEN_A, beforeIssuer, newIssuer.address);

      expect((await registry.getConfig(TOKEN_A)).issuer).to.equal(newIssuer.address);
    });

    it("setIssuer reverts for non-owner", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, stranger, newIssuer] = await hre.ethers.getSigners();

      await registry.registerToken(TOKEN_A, buildConfig());
      await expect(
        registry.connect(stranger).setIssuer(TOKEN_A, newIssuer.address)
      ).to.be.revertedWithCustomError(registry, "OnlyOwner");
    });

    it("setPaused can be called by owner OR issuer", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [owner, issuer] = await hre.ethers.getSigners();

      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      // Owner path
      await expect(registry.connect(owner).setPaused(TOKEN_A, true))
        .to.emit(registry, "PausedUpdated")
        .withArgs(TOKEN_A, true);
      expect((await registry.getConfig(TOKEN_A)).paused).to.equal(true);

      // Issuer path
      await expect(registry.connect(issuer).setPaused(TOKEN_A, false))
        .to.emit(registry, "PausedUpdated")
        .withArgs(TOKEN_A, false);
      expect((await registry.getConfig(TOKEN_A)).paused).to.equal(false);
    });

    it("setPaused reverts for neither-owner-nor-issuer", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, issuer, stranger] = await hre.ethers.getSigners();

      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      await expect(
        registry.connect(stranger).setPaused(TOKEN_A, true)
      ).to.be.revertedWithCustomError(registry, "OnlyIssuerOrOwner");
    });

    it("setMinInvestment is issuer-only", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [owner, issuer] = await hre.ethers.getSigners();

      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      await expect(registry.connect(issuer).setMinInvestment(TOKEN_A, 500n))
        .to.emit(registry, "MinInvestmentUpdated")
        .withArgs(TOKEN_A, 500n);
      expect((await registry.getConfig(TOKEN_A)).minInvestment).to.equal(500n);

      // Owner is explicitly NOT in the scope
      await expect(
        registry.connect(owner).setMinInvestment(TOKEN_A, 600n)
      ).to.be.revertedWithCustomError(registry, "OnlyIssuer");
    });

    it("setInstantRedeemCap is issuer-only", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, issuer, stranger] = await hre.ethers.getSigners();
      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      await expect(registry.connect(issuer).setInstantRedeemCap(TOKEN_A, 5_000_000n))
        .to.emit(registry, "InstantRedeemCapUpdated")
        .withArgs(TOKEN_A, 5_000_000n);

      await expect(
        registry.connect(stranger).setInstantRedeemCap(TOKEN_A, 1n)
      ).to.be.revertedWithCustomError(registry, "OnlyIssuer");
    });

    it("setEpochDuration is issuer-only and rejects zero", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, issuer] = await hre.ethers.getSigners();
      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      await expect(registry.connect(issuer).setEpochDuration(TOKEN_A, 3600))
        .to.emit(registry, "EpochDurationUpdated")
        .withArgs(TOKEN_A, 3600);

      await expect(
        registry.connect(issuer).setEpochDuration(TOKEN_A, 0)
      ).to.be.revertedWithCustomError(registry, "ZeroEpochDuration");
    });

    it("setOracle / setTreasury / setQueue are owner-only and reject zero", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, issuer] = await hre.ethers.getSigners();
      await registry.registerToken(TOKEN_A, buildConfig({ issuer: issuer.address }));

      const newAddr = "0x9000000000000000000000000000000000000000";

      await expect(registry.setOracle(TOKEN_A, newAddr))
        .to.emit(registry, "OracleUpdated")
        .withArgs(TOKEN_A, newAddr);

      await expect(registry.setTreasury(TOKEN_A, newAddr))
        .to.emit(registry, "TreasuryUpdated")
        .withArgs(TOKEN_A, newAddr);

      await expect(registry.setQueue(TOKEN_A, newAddr))
        .to.emit(registry, "QueueUpdated")
        .withArgs(TOKEN_A, newAddr);

      // Non-owner paths
      await expect(
        registry.connect(issuer).setOracle(TOKEN_A, newAddr)
      ).to.be.revertedWithCustomError(registry, "OnlyOwner");

      // Zero-address guards
      await expect(
        registry.setOracle(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        registry.setTreasury(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        registry.setQueue(TOKEN_A, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("setters revert TokenNotRegistered for unregistered tokens", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [owner, issuer] = await hre.ethers.getSigners();

      await expect(
        registry.setIssuer(TOKEN_A, issuer.address)
      ).to.be.revertedWithCustomError(registry, "TokenNotRegistered");

      await expect(
        registry.setPaused(TOKEN_A, true)
      ).to.be.revertedWithCustomError(registry, "TokenNotRegistered");

      await expect(
        registry.connect(issuer).setMinInvestment(TOKEN_A, 100n)
      ).to.be.revertedWithCustomError(registry, "TokenNotRegistered");

      await expect(
        registry.setOracle(TOKEN_A, owner.address)
      ).to.be.revertedWithCustomError(registry, "TokenNotRegistered");
    });
  });

  describe("isActive()", () => {
    it("returns false for unregistered tokens", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      expect(await registry.isActive(TOKEN_A)).to.equal(false);
    });

    it("returns true when registered and not paused", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());
      expect(await registry.isActive(TOKEN_A)).to.equal(true);
    });

    it("returns false after pause and true again after unpause", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());

      await registry.setPaused(TOKEN_A, true);
      expect(await registry.isActive(TOKEN_A)).to.equal(false);

      await registry.setPaused(TOKEN_A, false);
      expect(await registry.isActive(TOKEN_A)).to.equal(true);
    });
  });

  describe("pagination", () => {
    it("getRegisteredTokens walks the full list in slices", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());
      await registry.registerToken(TOKEN_B, buildConfig());

      expect(await registry.registeredTokenCount()).to.equal(2n);

      const page1 = await registry.getRegisteredTokens(0, 1);
      expect(page1.length).to.equal(1);
      expect(page1[0].toLowerCase()).to.equal(TOKEN_A.toLowerCase());

      const page2 = await registry.getRegisteredTokens(1, 1);
      expect(page2.length).to.equal(1);
      expect(page2[0].toLowerCase()).to.equal(TOKEN_B.toLowerCase());
    });

    it("getRegisteredTokens returns empty when offset >= total", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());
      const page = await registry.getRegisteredTokens(10, 5);
      expect(page.length).to.equal(0);
    });

    it("getRegisteredTokens clamps to remaining elements when limit overruns", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      await registry.registerToken(TOKEN_A, buildConfig());
      const page = await registry.getRegisteredTokens(0, 1_000);
      expect(page.length).to.equal(1);
    });
  });

  describe("transferOwnership()", () => {
    it("rotates owner and emits OwnershipTransferred", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [deployer, newOwner] = await hre.ethers.getSigners();

      await expect(registry.transferOwnership(newOwner.address))
        .to.emit(registry, "OwnershipTransferred")
        .withArgs(deployer.address, newOwner.address);

      expect(await registry.owner()).to.equal(newOwner.address);
    });

    it("reverts for non-owner and zero address", async () => {
      const registry = await loadFixture(deployTokenRegistry);
      const [, stranger] = await hre.ethers.getSigners();

      await expect(
        registry.connect(stranger).transferOwnership(stranger.address)
      ).to.be.revertedWithCustomError(registry, "OnlyOwner");

      await expect(
        registry.transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });
});
