import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { expect } from "chai";
import { deployMuHavenFixture, ONE_TOKEN, waitForDecrypt } from "./helpers/setup";

describe("MuHavenToken", function () {
  // ── Mint ────────────────────────────────────────────────────────────────────

  describe("mint()", function () {
    it("should mint encrypted tokens to a KYC-eligible investor", async function () {
      const { token, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encAmount);

      const ctHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(ctHash, ONE_TOKEN);
    });

    it("should revert mint to non-KYC address", async function () {
      const { token, issuer } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [nonKyc] = (await hre.ethers.getSigners()).slice(5);

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await expect(
        token.connect(issuer).mint(nonKyc.address, encAmount)
      ).to.be.revertedWithCustomError(token, "RecipientNotKYC");
    });

    it("should revert mint from non-minter", async function () {
      const { token, investor } = await loadFixture(deployMuHavenFixture);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encAmount] = await investorClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await expect(
        token.connect(investor).mint(investor.address, encAmount)
      ).to.be.revertedWithCustomError(token, "OnlyMinter");
    });
  });

  // ── Transfer ────────────────────────────────────────────────────────────────

  describe("transfer()", function () {
    it("should transfer encrypted tokens between KYC-eligible investors", async function () {
      const { token, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      // Mint 2 tokens to investor
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Transfer 1 token from investor to alice
      const [encTransfer] = await investorClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(investor).transfer(alice.address, encTransfer);

      const senderCtHash = await token.encryptedBalanceOf(investor.address);
      const receiverCtHash = await token.encryptedBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(senderCtHash, ONE_TOKEN);
      await hre.cofhe.mocks.expectPlaintext(receiverCtHash, ONE_TOKEN);
    });

    it("should use silent-failure when transfer amount exceeds balance", async function () {
      const { token, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      // Mint 1 token to investor
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      // Attempt to transfer 2 tokens — silent failure: transfers 0
      const [encOverTransfer] = await investorClient.encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)]).execute();
      await token.connect(investor).transfer(alice.address, encOverTransfer);

      const senderCtHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(senderCtHash, ONE_TOKEN);
    });
  });

  // ── Total supply visibility toggle ──────────────────────────────────────────

  describe("setTotalSupplyPublic()", function () {
    it("should toggle totalSupplyPublic to true", async function () {
      const { token, deployer, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      // Mint so there is a non-zero total supply
      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encAmount);

      expect(await token.totalSupplyPublic()).to.be.false;

      await expect(token.connect(deployer).setTotalSupplyPublic())
        .to.emit(token, "TotalSupplyMadePublic");

      expect(await token.totalSupplyPublic()).to.be.true;
    });

    it("should revert if already public", async function () {
      const { token, deployer } = await loadFixture(deployMuHavenFixture);
      await token.connect(deployer).setTotalSupplyPublic();
      await expect(
        token.connect(deployer).setTotalSupplyPublic()
      ).to.be.revertedWithCustomError(token, "AlreadyPublic");
    });

    it("should revert if called by non-owner", async function () {
      const { token, investor } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).setTotalSupplyPublic()
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });
  });

  // ── Pausable ────────────────────────────────────────────────────────────────

  describe("pause() / unpause()", function () {
    it("should revert mint when paused", async function () {
      const { token, deployer, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      await token.connect(deployer).pause();

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await expect(
        token.connect(issuer).mint(investor.address, encAmount)
      ).to.be.reverted;
    });

    it("should revert transfer when paused", async function () {
      const { token, deployer, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      // Mint first (before pause)
      const [encMint] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encMint);

      await token.connect(deployer).pause();

      const [encTransfer] = await investorClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await expect(
        token.connect(investor).transfer(alice.address, encTransfer)
      ).to.be.reverted;
    });

    it("should allow mint after unpause", async function () {
      const { token, deployer, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      await token.connect(deployer).pause();
      await token.connect(deployer).unpause();

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await expect(
        token.connect(issuer).mint(investor.address, encAmount)
      ).to.not.be.reverted;
    });

    it("should NOT gate burnFromVault when paused (exit path preserved)", async function () {
      const { token, deployer, vault, treasury, investor } = await loadFixture(deployMuHavenFixture);

      // Fund investor and wrap (before pause)
      await treasury.mint(investor.address, 10n * ONE_TOKEN);
      await treasury.connect(investor).approve(await vault.getAddress(), 10n * ONE_TOKEN);
      await vault.connect(investor).wrap(5n * ONE_TOKEN);

      // Pause the TOKEN (not the vault)
      await token.connect(deployer).pause();

      // burnFromVault should still work — called by vault.unwrap()
      // The vault calls token.burnFromVault() which is NOT gated by whenNotPaused
      await expect(
        vault.connect(investor).unwrap(3n * ONE_TOKEN)
      ).to.not.be.reverted;
    });

    it("should revert pause from non-owner", async function () {
      const { token, investor } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).pause()
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });
  });

  // ── Async decrypt ────────────────────────────────────────────────────────────

  describe("requestBalanceDecrypt() + getBalanceDecryptResult()", function () {
    it("should return decrypted balance after time.increase(11)", async function () {
      const { token, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encAmount);

      await token.connect(investor).requestBalanceDecrypt();
      await waitForDecrypt();

      const [value, ready] = await token.getBalanceDecryptResult(investor.address);
      expect(ready).to.be.true;
      expect(value).to.equal(ONE_TOKEN);
    });

    it("should return (0, false) before time delay elapses", async function () {
      const { token, issuer, investor } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

      const [encAmount] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
      await token.connect(issuer).mint(investor.address, encAmount);

      await token.connect(investor).requestBalanceDecrypt();
      // Do NOT call time.increase — result should not be ready yet
      const [, ready] = await token.getBalanceDecryptResult(investor.address);
      expect(ready).to.be.false;
    });

    it("should revert requestBalanceDecrypt when balance is uninitialized", async function () {
      const { token, investor } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).requestBalanceDecrypt()
      ).to.be.revertedWithCustomError(token, "NoBalance");
    });
  });
});
