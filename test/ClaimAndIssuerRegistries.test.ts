/**
 * ClaimTopicsRegistry + TrustedIssuersRegistry unit tests (Phase 3).
 *
 * Both registries are minimal ERC-3643-shaped stores consumed by
 * `MuHavenIdentityRegistry.isVerified` once dev-mode is disabled. The tests
 * focus on admin + invariants; the hot-path consumer is tested in the
 * `MuHavenIdentityRegistry.test.ts` suite.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { expect } from "chai";
import { ZERO_ADDRESS } from "./helpers/setup";

async function deployClaimTopicsRegistry() {
  const [deployer] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("ClaimTopicsRegistry");
  const reg = await upgrades.deployProxy(Factory, [deployer.address], {
    kind: "transparent",
    initializer: "initialize",
  });
  return reg;
}

async function deployTrustedIssuersRegistry() {
  const [deployer] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("TrustedIssuersRegistry");
  const reg = await upgrades.deployProxy(Factory, [deployer.address], {
    kind: "transparent",
    initializer: "initialize",
  });
  return reg;
}

describe("ClaimTopicsRegistry", () => {
  it("owner can add a topic; getters + isRequired reflect it", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    await expect(reg.addClaimTopic(1))
      .to.emit(reg, "ClaimTopicAdded")
      .withArgs(1);

    expect(await reg.claimTopicCount()).to.equal(1n);
    expect(await reg.isRequired(1)).to.equal(true);
    expect(await reg.isRequired(2)).to.equal(false);
    const topics = await reg.getClaimTopics();
    expect(topics.length).to.equal(1);
    expect(topics[0]).to.equal(1n);
  });

  it("adding a duplicate topic reverts TopicAlreadyRequired", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    await reg.addClaimTopic(1);
    await expect(reg.addClaimTopic(1)).to.be.revertedWithCustomError(
      reg,
      "TopicAlreadyRequired"
    );
  });

  it("removing an unknown topic reverts TopicNotRequired", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    await expect(reg.removeClaimTopic(42)).to.be.revertedWithCustomError(
      reg,
      "TopicNotRequired"
    );
  });

  it("removeClaimTopic compacts the array via swap-and-pop", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    await reg.addClaimTopic(1);
    await reg.addClaimTopic(2);
    await reg.addClaimTopic(3);
    // Remove middle: last (3) swaps into the middle slot, array len 2.
    await expect(reg.removeClaimTopic(2))
      .to.emit(reg, "ClaimTopicRemoved")
      .withArgs(2);
    expect(await reg.claimTopicCount()).to.equal(2n);
    const topics = await reg.getClaimTopics();
    // Swap-and-pop doesn't preserve order; just confirm 1 + 3 remain.
    const sorted = [...topics].map(Number).sort();
    expect(sorted).to.deep.equal([1, 3]);
    expect(await reg.isRequired(2)).to.equal(false);
    expect(await reg.isRequired(3)).to.equal(true);
  });

  it("non-owner cannot add or remove", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    const [, stranger] = await hre.ethers.getSigners();
    await expect(
      reg.connect(stranger).addClaimTopic(7)
    ).to.be.revertedWithCustomError(reg, "OnlyOwner");
    await reg.addClaimTopic(7);
    await expect(
      reg.connect(stranger).removeClaimTopic(7)
    ).to.be.revertedWithCustomError(reg, "OnlyOwner");
  });

  it("transferOwnership rotates owner and rejects zero", async () => {
    const reg = await loadFixture(deployClaimTopicsRegistry);
    const [deployer, newOwner] = await hre.ethers.getSigners();
    await expect(
      reg.transferOwnership(ZERO_ADDRESS)
    ).to.be.revertedWithCustomError(reg, "ZeroAddress");

    await expect(reg.transferOwnership(newOwner.address))
      .to.emit(reg, "OwnershipTransferred")
      .withArgs(deployer.address, newOwner.address);
    expect(await reg.owner()).to.equal(newOwner.address);
  });
});

describe("TrustedIssuersRegistry", () => {
  it("add a trusted issuer with topics; views reflect it", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();
    await expect(reg.addTrustedIssuer(issuer.address, [1, 7]))
      .to.emit(reg, "TrustedIssuerAdded")
      .withArgs(issuer.address, [1n, 7n]);

    expect(await reg.isTrustedIssuer(issuer.address)).to.equal(true);
    expect(await reg.hasClaimTopic(issuer.address, 1)).to.equal(true);
    expect(await reg.hasClaimTopic(issuer.address, 7)).to.equal(true);
    expect(await reg.hasClaimTopic(issuer.address, 42)).to.equal(false);

    const topics = [...(await reg.getIssuerTopics(issuer.address))].map(Number);
    expect(topics.sort()).to.deep.equal([1, 7]);

    const issuersForTopic1 = await reg.getTrustedIssuersForClaimTopic(1);
    expect(issuersForTopic1).to.deep.equal([issuer.address]);
  });

  it("reverts EmptyTopicList when adding issuer with no topics", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();
    await expect(
      reg.addTrustedIssuer(issuer.address, [])
    ).to.be.revertedWithCustomError(reg, "EmptyTopicList");
  });

  it("reverts IssuerAlreadyTrusted on duplicate add", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();
    await reg.addTrustedIssuer(issuer.address, [1]);
    await expect(
      reg.addTrustedIssuer(issuer.address, [2])
    ).to.be.revertedWithCustomError(reg, "IssuerAlreadyTrusted");
  });

  it("removeTrustedIssuer cleans topic lists + reverse index", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuerA, issuerB] = await hre.ethers.getSigners();

    await reg.addTrustedIssuer(issuerA.address, [1, 7]);
    await reg.addTrustedIssuer(issuerB.address, [1]);

    await expect(reg.removeTrustedIssuer(issuerA.address))
      .to.emit(reg, "TrustedIssuerRemoved")
      .withArgs(issuerA.address);

    expect(await reg.isTrustedIssuer(issuerA.address)).to.equal(false);
    expect(await reg.hasClaimTopic(issuerA.address, 1)).to.equal(false);
    expect(await reg.hasClaimTopic(issuerA.address, 7)).to.equal(false);

    // Topic-1 reverse index should now only contain issuerB.
    const remainingFor1 = await reg.getTrustedIssuersForClaimTopic(1);
    expect(remainingFor1).to.deep.equal([issuerB.address]);

    // issuerA removed entirely.
    const forTopic7 = await reg.getTrustedIssuersForClaimTopic(7);
    expect(forTopic7.length).to.equal(0);
  });

  it("updateIssuerTopics replaces the set atomically", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();

    await reg.addTrustedIssuer(issuer.address, [1, 7]);

    await expect(reg.updateIssuerTopics(issuer.address, [2, 3]))
      .to.emit(reg, "IssuerTopicsUpdated")
      .withArgs(issuer.address, [2n, 3n]);

    expect(await reg.hasClaimTopic(issuer.address, 1)).to.equal(false);
    expect(await reg.hasClaimTopic(issuer.address, 7)).to.equal(false);
    expect(await reg.hasClaimTopic(issuer.address, 2)).to.equal(true);
    expect(await reg.hasClaimTopic(issuer.address, 3)).to.equal(true);

    // Reverse indices reflect the swap.
    expect(await reg.getTrustedIssuersForClaimTopic(1)).to.deep.equal([]);
    expect(await reg.getTrustedIssuersForClaimTopic(2)).to.deep.equal([
      issuer.address,
    ]);
  });

  it("updateIssuerTopics on unknown issuer reverts IssuerNotTrusted", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();
    await expect(
      reg.updateIssuerTopics(issuer.address, [1])
    ).to.be.revertedWithCustomError(reg, "IssuerNotTrusted");
  });

  it("deduplicates repeated topics in the input", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer] = await hre.ethers.getSigners();
    await reg.addTrustedIssuer(issuer.address, [1, 1, 1]);

    const topics = [...(await reg.getIssuerTopics(issuer.address))];
    expect(topics).to.deep.equal([1n]);

    // Reverse index on topic-1 also dedupes to a single entry.
    const revIdx = await reg.getTrustedIssuersForClaimTopic(1);
    expect(revIdx.length).to.equal(1);
    expect(revIdx[0]).to.equal(issuer.address);
  });

  it("non-owner cannot add, remove, or update issuers", async () => {
    const reg = await loadFixture(deployTrustedIssuersRegistry);
    const [, issuer, stranger] = await hre.ethers.getSigners();
    await expect(
      reg.connect(stranger).addTrustedIssuer(issuer.address, [1])
    ).to.be.revertedWithCustomError(reg, "OnlyOwner");
    await reg.addTrustedIssuer(issuer.address, [1]);
    await expect(
      reg.connect(stranger).removeTrustedIssuer(issuer.address)
    ).to.be.revertedWithCustomError(reg, "OnlyOwner");
    await expect(
      reg.connect(stranger).updateIssuerTopics(issuer.address, [2])
    ).to.be.revertedWithCustomError(reg, "OnlyOwner");
  });
});
