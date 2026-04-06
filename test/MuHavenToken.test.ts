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
