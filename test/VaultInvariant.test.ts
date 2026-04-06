/**
 * Vault invariant tests.
 *
 * Invariant: vault.totalLocked() === treasury.balanceOf(vault)
 *            at all times (after wrap and after unwrap).
 *
 * Invariant: vault.getLockedBalance(investor) <= vault.totalLocked()
 *            always holds.
 *
 * Invariant: an investor cannot unwrap more than they wrapped
 *            (ExceedsLockedBalance guard).
 */
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { deployMuHavenFixture, ONE_TOKEN } from "./helpers/setup";

describe("VaultInvariant", function () {
  it("totalLocked == ERC-20 balance of vault after wrap", async function () {
    const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, 5n * ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), 5n * ONE_TOKEN);
    await vault.connect(investor).wrap(5n * ONE_TOKEN);

    const totalLocked = await vault.totalLocked();
    const vaultBalance = await treasury.balanceOf(await vault.getAddress());
    expect(totalLocked).to.equal(vaultBalance);
  });

  it("totalLocked == ERC-20 balance of vault after unwrap", async function () {
    const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, 5n * ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), 5n * ONE_TOKEN);
    await vault.connect(investor).wrap(5n * ONE_TOKEN);
    await vault.connect(investor).unwrap(2n * ONE_TOKEN);

    const totalLocked = await vault.totalLocked();
    const vaultBalance = await treasury.balanceOf(await vault.getAddress());
    expect(totalLocked).to.equal(vaultBalance);
  });

  it("getLockedBalance(investor) == amount wrapped", async function () {
    const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, 3n * ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), 3n * ONE_TOKEN);
    await vault.connect(investor).wrap(3n * ONE_TOKEN);

    expect(await vault.getLockedBalance(investor.address)).to.equal(3n * ONE_TOKEN);
  });

  it("getLockedBalance decreases after unwrap", async function () {
    const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, 4n * ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), 4n * ONE_TOKEN);
    await vault.connect(investor).wrap(4n * ONE_TOKEN);
    await vault.connect(investor).unwrap(ONE_TOKEN);

    expect(await vault.getLockedBalance(investor.address)).to.equal(3n * ONE_TOKEN);
  });

  it("unwrapping more than locked reverts (prevents drain exploit)", async function () {
    const { vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), ONE_TOKEN);
    await vault.connect(investor).wrap(ONE_TOKEN);

    await expect(
      vault.connect(investor).unwrap(2n * ONE_TOKEN)
    ).to.be.revertedWithCustomError(vault, "ExceedsLockedBalance");
  });

  it("multiple investors: each lockedBalance is independent", async function () {
    const { vault, treasury, investor, alice } = await loadFixture(deployMuHavenFixture);

    await treasury.mint(investor.address, 3n * ONE_TOKEN);
    await treasury.connect(investor).approve(await vault.getAddress(), 3n * ONE_TOKEN);
    await vault.connect(investor).wrap(3n * ONE_TOKEN);

    await treasury.mint(alice.address, 2n * ONE_TOKEN);
    await treasury.connect(alice).approve(await vault.getAddress(), 2n * ONE_TOKEN);
    await vault.connect(alice).wrap(2n * ONE_TOKEN);

    expect(await vault.getLockedBalance(investor.address)).to.equal(3n * ONE_TOKEN);
    expect(await vault.getLockedBalance(alice.address)).to.equal(2n * ONE_TOKEN);
    expect(await vault.totalLocked()).to.equal(5n * ONE_TOKEN);
  });
});
