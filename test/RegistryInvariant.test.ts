/**
 * InvestorRegistry invariant tests.
 *
 * Invariant: investorCount() == number of unique addresses ever registered.
 * Invariant: isInvestor(addr) is true iff addr appears in getInvestorsPaginated.
 * Invariant: registering the same address twice does not change investorCount.
 */
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import { deployMuHavenFixture, ONE_TOKEN } from "./helpers/setup";

describe("RegistryInvariant", function () {
  it("investorCount increments exactly once per unique investor", async function () {
    const { token, registry, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
    const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

    expect(await registry.investorCount()).to.equal(0n);

    const [e1] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
    await token.connect(issuer).mint(investor.address, e1);
    expect(await registry.investorCount()).to.equal(1n);

    // Mint again to same investor — count must not change
    const [e2] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
    await token.connect(issuer).mint(investor.address, e2);
    expect(await registry.investorCount()).to.equal(1n);

    // Mint to alice — count increments
    const [e3] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
    await token.connect(issuer).mint(alice.address, e3);
    expect(await registry.investorCount()).to.equal(2n);
  });

  it("isInvestor is consistent with getInvestorsPaginated", async function () {
    const { token, registry, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
    const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

    const [e1] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
    await token.connect(issuer).mint(investor.address, e1);
    const [e2] = await issuerClient.encryptInputs([Encryptable.uint128(ONE_TOKEN)]).execute();
    await token.connect(issuer).mint(alice.address, e2);

    const count = Number(await registry.investorCount());
    const page = await registry.getInvestorsPaginated(0, count);

    // Every address in page must pass isInvestor
    for (const addr of page) {
      expect(await registry.isInvestor(addr)).to.be.true;
    }
    // Length must match investorCount
    expect(page.length).to.equal(count);
  });
});
