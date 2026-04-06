import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import { deployMuHavenFixture, ONE_TOKEN } from "./helpers/setup";

describe("MuHavenVault", function () {
  // ── wrap() ────────────────────────────────────────────────────────────────

  describe("wrap()", function () {
    it("should lock ERC-20 and mint encrypted tokens to investor", async function () {
      const { vault, token, treasury, investor } = await loadFixture(deployMuHavenFixture);

      // Fund investor with 10 treasury tokens
      await treasury.mint(investor.address, 10n * ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), 10n * ONE_TOKEN);

      await vault.connect(investor).wrap(5n * ONE_TOKEN);

      expect(await vault.getLockedBalance(investor.address)).to.equal(5n * ONE_TOKEN);
      expect(await vault.totalLocked()).to.equal(5n * ONE_TOKEN);

      const balCtHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balCtHash, 5n * ONE_TOKEN);
    });

    it("should revert wrap with zero amount", async function () {
      const { vault, investor } = await loadFixture(deployMuHavenFixture);
      await expect(
        vault.connect(investor).wrap(0n)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert wrap below minInvestment", async function () {
      const { deployer, vault, treasury, investor } = await loadFixture(deployMuHavenFixture);
      await vault.connect(deployer).setMinInvestment(ONE_TOKEN);

      await treasury.mint(investor.address, ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), ONE_TOKEN);

      await expect(
        vault.connect(investor).wrap(1n)
      ).to.be.revertedWithCustomError(vault, "BelowMinimum");
    });
  });

  // ── unwrap() ──────────────────────────────────────────────────────────────

  describe("unwrap()", function () {
    it("should burn encrypted tokens and return ERC-20 to investor", async function () {
      const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

      await treasury.mint(investor.address, 10n * ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), 10n * ONE_TOKEN);
      await vault.connect(investor).wrap(5n * ONE_TOKEN);

      const balanceBefore = await treasury.balanceOf(investor.address);
      await vault.connect(investor).unwrap(3n * ONE_TOKEN);

      expect(await vault.getLockedBalance(investor.address)).to.equal(2n * ONE_TOKEN);
      expect(await vault.totalLocked()).to.equal(2n * ONE_TOKEN);
      expect(await treasury.balanceOf(investor.address)).to.equal(balanceBefore + 3n * ONE_TOKEN);
    });

    it("should revert unwrap exceeding locked balance", async function () {
      const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

      await treasury.mint(investor.address, ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), ONE_TOKEN);
      await vault.connect(investor).wrap(ONE_TOKEN);

      await expect(
        vault.connect(investor).unwrap(2n * ONE_TOKEN)
      ).to.be.revertedWithCustomError(vault, "ExceedsLockedBalance");
    });
  });

  // ── Pause / admin ─────────────────────────────────────────────────────────

  describe("pause()", function () {
    it("should revert wrap when paused", async function () {
      const { vault, treasury, deployer, investor } = await loadFixture(deployMuHavenFixture);
      await vault.connect(deployer).pause();

      await treasury.mint(investor.address, ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), ONE_TOKEN);

      await expect(
        vault.connect(investor).wrap(ONE_TOKEN)
      ).to.be.reverted;
    });
  });
});
