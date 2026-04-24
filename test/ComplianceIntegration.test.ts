/**
 * Phase 3 compliance integration tests.
 *
 * End-to-end proof that the Wave 3.5 ERC-3643 topology wires through
 * `MuHavenSubscription` + `MuHavenToken` correctly:
 *
 *   - Dev-mode on + no modules bound ⇒ every caller passes (demo flow).
 *   - Dev-mode off + no whitelist + no claims ⇒ purchase reverts NotEligible.
 *   - Dev-mode off + whitelisted investor ⇒ purchase succeeds (Wave 3 carry-over).
 *   - Dev-mode on + MaxHolders bound (cap=1) ⇒ second investor's purchase
 *     reverts ComplianceBlocked.
 *   - MaxHolders state hooks fire on purchase (stateful counter moves).
 *
 * The tests run against the **real** `ModularCompliance` + `MuHavenIdentityRegistry`
 * contracts wired through `MuHavenSubscription.purchase`.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import {
  deployRegistry,
  deployToken,
  deployMockPUSDC,
  ZERO_ADDRESS,
} from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_PUSDC = 1_000_000n;
const HINT_CAP = 1_000_000n;
const DEFAULT_NAV = ONE_PUSDC;
const EPOCH_DURATION = 60 * 60;
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

async function deployFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob] = await hre.ethers.getSigners();

  // Phase 3 identity stack
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
      true, // devMode on initially
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  const CompFactory = await hre.ethers.getContractFactory("ModularCompliance");
  const compliance = await upgrades.deployProxy(
    CompFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // Wave-3-style KYC adapter still present (fallback when identityRegistry=0).
  const KYCFactory = await hre.ethers.getContractFactory("ERC3643KYCAdapter");
  const kyc = await KYCFactory.deploy(deployer.address);
  await kyc.addToWhitelist(investor.address);
  await kyc.addToWhitelist(alice.address);
  await kyc.addToWhitelist(bob.address);

  const registry = await deployRegistry();

  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  // Wire identity + compliance into the token (P2P path).
  await token.setIdentityRegistry(await identityReg.getAddress());
  await token.setModularCompliance(await compliance.getAddress());

  // PUSDC + real IssuerControlledOracle
  const pusdc = await deployMockPUSDC();

  const OracleFactory = await hre.ethers.getContractFactory("IssuerControlledOracle");
  const oracle = await upgrades.deployProxy(
    OracleFactory,
    [deployer.address, ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );

  const TR = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    TR,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  const SubFactory = await hre.ethers.getContractFactory("MuHavenSubscription");
  const subscription = await upgrades.deployProxy(
    SubFactory,
    [
      deployer.address,
      await tokenRegistry.getAddress(),
      await kyc.getAddress(),
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Wire Phase 3 identity + compliance into subscription.
  await subscription.setIdentityRegistry(await identityReg.getAddress());
  await subscription.setModularCompliance(await compliance.getAddress());

  // Authorize Subscription + Token to fire state hooks on the compliance
  // coordinator for the token. Without this, `compliance.created(...)` etc.
  // reverts NotAuthorizedCaller.
  await compliance.setAuthorizedCaller(
    await token.getAddress(),
    await subscription.getAddress(),
    true
  );
  await compliance.setAuthorizedCaller(
    await token.getAddress(),
    await token.getAddress(),
    true
  );

  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      alice.address, // queue placeholder
      issuer.address,
      await pusdc.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  await tokenRegistry.registerToken(await token.getAddress(), {
    active: true,
    treasury: await treasury.getAddress(),
    queue: alice.address,
    oracle: await oracle.getAddress(),
    issuer: issuer.address,
    minInvestment: 0n,
    instantRedeemCap: INSTANT_CAP,
    epochDuration: EPOCH_DURATION,
    paused: false,
  });

  await token.setSubscription(await subscription.getAddress());

  // Oracle: issuer as NAV writer + seed NAV.
  await oracle.setNavWriter(await token.getAddress(), issuer.address);
  await oracle.setMaxDeviationBps(await token.getAddress(), 1000n);
  await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

  // Investor: PUSDC + operator approval.
  await pusdc.mint(investor.address, 200n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  await pusdc.mint(alice.address, 200n * ONE_PUSDC);
  await pusdc
    .connect(alice)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  const eph = createEphemeralEOA();
  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

  return {
    deployer,
    issuer,
    investor,
    alice,
    bob,
    kyc,
    topicsReg,
    issuersReg,
    identityReg,
    compliance,
    token,
    tokenRegistry,
    treasury,
    pusdc,
    oracle,
    subscription,
    registry,
    investorClient,
    aliceClient,
    eph,
  };
}

describe("Wave 3.5 Phase 3 compliance integration", () => {
  it("dev-mode on + no modules bound ⇒ purchase succeeds (baseline)", async () => {
    const { subscription, investor, investorClient, token, eph } =
      await loadFixture(deployFixture);

    const enc = await encUint128(investorClient, 5n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.emit(subscription, "Purchased");
  });

  it("dev-mode off + no whitelist + no claims ⇒ purchase reverts NotEligible", async () => {
    const {
      subscription,
      investor,
      investorClient,
      identityReg,
      token,
      eph,
    } = await loadFixture(deployFixture);

    // Flip dev-mode off before any purchase.
    await identityReg.setDevMode(false);

    const enc = await encUint128(investorClient, 5n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "NotEligible");
  });

  it("dev-mode off + whitelisted investor ⇒ purchase succeeds (Wave 3 carry-over)", async () => {
    const {
      subscription,
      investor,
      investorClient,
      identityReg,
      token,
      eph,
    } = await loadFixture(deployFixture);

    await identityReg.setDevMode(false);
    await identityReg.addWhitelisted([investor.address]);

    const enc = await encUint128(investorClient, 5n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.emit(subscription, "Purchased");
  });

  it("MaxHolders bound with cap=1 ⇒ second investor's purchase reverts ComplianceBlocked", async () => {
    const {
      deployer,
      subscription,
      investor,
      alice,
      investorClient,
      aliceClient,
      registry,
      identityReg,
      compliance,
      token,
      eph,
    } = await loadFixture(deployFixture);

    // Deploy + wire MaxHolders with cap 1 for non-accredited investors.
    const MaxHolders = await hre.ethers.getContractFactory("MaxHolders");
    const maxHolders = await upgrades.deployProxy(
      MaxHolders,
      [
        deployer.address,
        await compliance.getAddress(),
        await identityReg.getAddress(),
        await registry.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );
    await compliance.bindModule(await token.getAddress(), await maxHolders.getAddress());
    await maxHolders.setMaxNonAccredited(await token.getAddress(), 1);

    // First investor passes + gets counted.
    let enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    // Second investor hits the cap.
    const enc2 = await encUint128(aliceClient, 5n);
    await expect(
      subscription
        .connect(alice)
        .purchase(await token.getAddress(), enc2, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "ComplianceBlocked");
  });

  it("MaxHolders state hooks fire on purchase (counter moves)", async () => {
    const {
      deployer,
      subscription,
      investor,
      investorClient,
      registry,
      identityReg,
      compliance,
      token,
      eph,
    } = await loadFixture(deployFixture);

    const MaxHolders = await hre.ethers.getContractFactory("MaxHolders");
    const maxHolders = await upgrades.deployProxy(
      MaxHolders,
      [
        deployer.address,
        await compliance.getAddress(),
        await identityReg.getAddress(),
        await registry.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );
    await compliance.bindModule(await token.getAddress(), await maxHolders.getAddress());
    await maxHolders.setMaxNonAccredited(await token.getAddress(), 10);

    expect(await maxHolders.nonAccreditedHolders(await token.getAddress())).to.equal(0n);

    const enc = await encUint128(investorClient, 5n);
    await subscription
      .connect(investor)
      .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

    expect(await maxHolders.nonAccreditedHolders(await token.getAddress())).to.equal(1n);
    expect(await maxHolders.counted(await token.getAddress(), investor.address)).to.equal(
      true
    );
  });

  it("CountryRestrict blocks purchase from a restricted-country investor", async () => {
    const {
      deployer,
      subscription,
      investor,
      investorClient,
      identityReg,
      compliance,
      token,
      eph,
    } = await loadFixture(deployFixture);

    const COUNTRY_IR = 364;
    await identityReg.setCountry(investor.address, COUNTRY_IR);

    const Restrict = await hre.ethers.getContractFactory("CountryRestrict");
    const module = await upgrades.deployProxy(
      Restrict,
      [
        deployer.address,
        await compliance.getAddress(),
        await identityReg.getAddress(),
      ],
      { kind: "transparent", initializer: "initialize" }
    );
    await compliance.bindModule(await token.getAddress(), await module.getAddress());
    await module.setRestricted(await token.getAddress(), COUNTRY_IR, true);

    const enc = await encUint128(investorClient, 1n);
    await expect(
      subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
    ).to.be.revertedWithCustomError(subscription, "ComplianceBlocked");
  });
});
