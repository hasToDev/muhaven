/**
 * Phase 1 fixture deploy test — gate for the phase's exit criteria:
 * "pnpm test -g 'fixture'" deploys every stub cleanly.
 *
 * Nothing here exercises contract behaviour; Phase 2 tests will. This file
 * only verifies that `deployV2Fixture` wires the Wave 3.5 mocked stack
 * without reverting.
 */

import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import {
  deployV2Fixture,
  createEphemeralEOA,
  deployMockPriceOracle,
} from "./helpers/fixturesV2";

describe("Wave 3.5 Phase 1 fixture", () => {
  it("deploys the full mocked stack without reverting", async () => {
    const f = await loadFixture(deployV2Fixture);

    expect(await f.token.getAddress()).to.properAddress;
    expect(await f.registry.getAddress()).to.properAddress;
    expect(await f.kyc.getAddress()).to.properAddress;
    expect(await f.vault.getAddress()).to.properAddress;
    expect(await f.pusdc.getAddress()).to.properAddress;
    expect(await f.oracle.getAddress()).to.properAddress;
  });

  it("pins a fresh NAV for the RWA token on the mock oracle", async () => {
    const f = await loadFixture(deployV2Fixture);

    const tokenAddr = await f.token.getAddress();
    const [nav, updatedAt] = await f.oracle.getNAV(tokenAddr);

    expect(nav).to.equal(1_000_000n);
    expect(updatedAt).to.be.greaterThan(0n);

    const maxStaleness = await f.oracle.getMaxStaleness(tokenAddr);
    expect(maxStaleness).to.equal(36n * 60n * 60n); // DEFAULT_MAX_STALENESS
  });

  it("produces an ephemeral EOA with a valid address (ADR-021 signer shape)", async () => {
    const eph = createEphemeralEOA();
    expect(eph.address).to.properAddress;
    expect(eph.privateKey).to.be.a("string").and.match(/^0x[0-9a-f]{64}$/i);
  });

  it("MockPriceOracle reads back a per-token staleness override", async () => {
    const oracle = await deployMockPriceOracle();
    const token = hre.ethers.Wallet.createRandom().address;

    await oracle.setMaxStaleness(token, 120);
    expect(await oracle.getMaxStaleness(token)).to.equal(120n);
  });

  it("MockPriceOracle reports staleness when updatedAt is in the past", async () => {
    const f = await loadFixture(deployV2Fixture);
    const tokenAddr = await f.token.getAddress();

    // Rewind the NAV publish timestamp to 48h ago → beyond default 36h staleness.
    const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
    await f.oracle.setNAV(tokenAddr, 1_000_000n, BigInt(now - 48 * 60 * 60));

    const [, updatedAt] = await f.oracle.getNAV(tokenAddr);
    const maxStaleness = await f.oracle.getMaxStaleness(tokenAddr);
    const staleness = BigInt(now) - updatedAt;

    expect(staleness).to.be.greaterThan(maxStaleness);
  });
});
