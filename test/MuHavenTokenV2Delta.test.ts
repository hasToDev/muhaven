/**
 * MuHavenToken Wave 3.5 delta tests.
 *
 * Covers the new behaviours introduced in Phase 2:
 *  - `SUBSCRIPTION_ROLE` + `mintFromSubscription` / `burnFromSubscription`
 *    (ADR-006 + ADR-021)
 *  - Trailing `ephemeralEOA` parameter on user-decrypt-producing mutations
 *    (ADR-021)
 *  - `InvestorRegistry.addHolder(token, recipient)` on `transfer` /
 *    `transferFrom` (ADR-022)
 *  - `authorizedReaders` Wave 4 reservation — setter works, no read path
 *    consumes it yet
 *  - Wave 3 issuer minter auto-grant is gone (ADR-006): a freshly-initialised
 *    token has no minters until the owner explicitly grants them
 *
 * `MuHavenSubscription` proper lands in a later Phase 2 sub-phase; this suite
 * uses `MockSubscription` (contracts/mocks/MockSubscription.sol) as a thin
 * InEuint128 → euint128 bridge so the Token delta can be exercised end-to-end
 * without the full Subscription wiring.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

/**
 * `withArgs` placeholder for the `euint128 amount` slot in the broadened
 * Phase 9.A `Transfer(from, to, amount)` event signature. Returns a matcher
 * that accepts any 32-byte hex handle without binding the exact handle bytes
 * (which are content-addressed and not knowable until the call lands).
 */
function anyHandle() {
  return (v: unknown) =>
    typeof v === "string" && v.startsWith("0x") && v.length === 66;
}

import {
  deployMuHavenFixture,
  deployKYCAdapter,
  deployRegistry,
  ONE_TOKEN,
  ZERO_ADDRESS,
} from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

async function deployMockSubscription() {
  const Factory = await hre.ethers.getContractFactory("MockSubscription");
  return Factory.deploy();
}

/**
 * Deploys a MuHavenToken without the post-init `grantMinter(issuer)` call
 * that the shared fixture applies. Used by the "no auto-grant" regression
 * test to assert the Wave 3.5 initialiser ships a mint-authorityless token.
 */
async function deployBareToken(
  kycAddr: string,
  registryAddr: string,
  issuerAddr: string
) {
  const Token = await hre.ethers.getContractFactory("MuHavenToken");
  return upgrades.deployProxy(
    Token,
    ["MuHaven RWA", "MHRWA", kycAddr, registryAddr, issuerAddr, ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );
}

/**
 * Wires a MockSubscription onto the shared fixture as the active
 * `MuHavenSubscription` contract. Returns the bridge plus a handle-encoder
 * helper for readability.
 */
async function wireMockSubscription() {
  const base = await loadFixture(deployMuHavenFixture);
  const mockSub = await deployMockSubscription();
  await base.token.connect(base.deployer).setSubscription(await mockSub.getAddress());
  return { ...base, mockSub };
}

describe("MuHavenToken Wave 3.5 delta", () => {
  describe("ADR-006 — issuer minter auto-grant removed at init", () => {
    it("leaves minters[issuer] = false after initialize", async () => {
      const [deployer, issuer, investor] = await hre.ethers.getSigners();

      const kyc = await deployKYCAdapter();
      await kyc.addToWhitelist(investor.address);

      const registry = await deployRegistry();
      const token = await deployBareToken(
        await kyc.getAddress(),
        await registry.getAddress(),
        issuer.address
      );

      expect(await token.minters(issuer.address)).to.equal(false);
      // Sanity: deployer (owner) is not auto-granted either — only the setter
      // can grant.
      expect(await token.minters(deployer.address)).to.equal(false);
    });

    it("owner can still grant the minter role via grantMinter()", async () => {
      const [, issuer, investor] = await hre.ethers.getSigners();

      const kyc = await deployKYCAdapter();
      await kyc.addToWhitelist(investor.address);

      const registry = await deployRegistry();
      const token = await deployBareToken(
        await kyc.getAddress(),
        await registry.getAddress(),
        issuer.address
      );
      await registry.setAuthorizedCaller(await token.getAddress(), true);

      await expect(token.grantMinter(issuer.address))
        .to.emit(token, "MinterGranted")
        .withArgs(issuer.address);

      expect(await token.minters(issuer.address)).to.equal(true);
    });
  });

  describe("setSubscription()", () => {
    it("owner can set + rotate the subscription address", async () => {
      const { token, deployer, alice } = await loadFixture(deployMuHavenFixture);
      const bob = (await hre.ethers.getSigners())[4];

      expect(await token.subscription()).to.equal(ZERO_ADDRESS);

      await expect(token.connect(deployer).setSubscription(alice.address))
        .to.emit(token, "SubscriptionUpdated")
        .withArgs(alice.address);

      expect(await token.subscription()).to.equal(alice.address);

      await token.connect(deployer).setSubscription(bob.address);
      expect(await token.subscription()).to.equal(bob.address);
    });

    it("reverts for non-owner", async () => {
      const { token, investor, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).setSubscription(alice.address)
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });
  });

  describe("mintFromSubscription()", () => {
    it("mints, grants ephemeralEOA ACL, adds per-token holder entry", async () => {
      const { token, investor, registry, mockSub } = await wireMockSubscription();

      const subClient = await hre.cofhe.createClientWithBatteries(
        (await hre.ethers.getSigners())[0]
      );
      const [encIn] = await subClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await expect(
        mockSub.mint(
          await token.getAddress(),
          investor.address,
          encIn,
          eph.address
        )
      )
        .to.emit(token, "Transfer")
        .withArgs(ZERO_ADDRESS, investor.address, anyHandle());

      const balHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balHash, ONE_TOKEN);

      // Per-token holder bookkeeping (ADR-022 / ADR-026)
      expect(await registry.isHolder(await token.getAddress(), investor.address))
        .to.equal(true);
      expect(await registry.holderCount(await token.getAddress())).to.equal(1n);
      // Legacy global set is populated too
      expect(await registry.isInvestor(investor.address)).to.equal(true);
    });

    it("reverts OnlySubscription when a non-subscription EOA tries to call", async () => {
      const { token, investor } = await wireMockSubscription();

      const client = await hre.cofhe.createClientWithBatteries(
        (await hre.ethers.getSigners())[0]
      );
      const [encIn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      // Raw bytes32 passed to mintFromSubscription from an EOA — must revert
      // on the access-control check BEFORE any FHE work happens. We use the
      // ctHash as a standin euint128 handle; OnlySubscription reverts first.
      const handle = hre.ethers.zeroPadValue(hre.ethers.toBeHex(encIn.ctHash), 32);
      await expect(
        token
          .connect((await hre.ethers.getSigners())[0])
          .mintFromSubscription(investor.address, handle, eph.address)
      ).to.be.revertedWithCustomError(token, "OnlySubscription");
    });

    it("reverts OnlySubscription when subscription is unset", async () => {
      const { token, deployer, investor } = await loadFixture(deployMuHavenFixture);
      const mockSub = await deployMockSubscription();

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encIn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      // Subscription NOT wired → MockSubscription call reverts on the
      // onlySubscription modifier.
      await expect(
        mockSub.mint(
          await token.getAddress(),
          investor.address,
          encIn,
          eph.address
        )
      ).to.be.revertedWithCustomError(token, "OnlySubscription");
    });

    it("reverts on zero ephemeralEOA", async () => {
      const { token, investor, mockSub } = await wireMockSubscription();

      const client = await hre.cofhe.createClientWithBatteries(
        (await hre.ethers.getSigners())[0]
      );
      const [encIn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();

      await expect(
        mockSub.mint(
          await token.getAddress(),
          investor.address,
          encIn,
          ZERO_ADDRESS
        )
      ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
    });

    it("reverts when paused", async () => {
      const { token, investor, deployer, mockSub } = await wireMockSubscription();
      await token.connect(deployer).pause();

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encIn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await expect(
        mockSub.mint(
          await token.getAddress(),
          investor.address,
          encIn,
          eph.address
        )
      ).to.be.reverted; // PausableUpgradeable emits a custom error
    });

    it("reverts on non-KYC recipient", async () => {
      const { token, mockSub } = await wireMockSubscription();
      const signers = await hre.ethers.getSigners();
      const nonKyc = signers[5];

      const client = await hre.cofhe.createClientWithBatteries(signers[0]);
      const [encIn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await expect(
        mockSub.mint(
          await token.getAddress(),
          nonKyc.address,
          encIn,
          eph.address
        )
      ).to.be.revertedWithCustomError(token, "RecipientNotKYC");
    });
  });

  describe("burnFromSubscription()", () => {
    it("burns existing balance via silent-fail pattern", async () => {
      const { token, issuer, investor, mockSub } = await wireMockSubscription();

      // Seed investor balance via the Wave 3 `mint` path (shared fixture
      // explicitly grants issuer the minter role).
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [seed] = await issuerClient
        .encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, seed);

      // Burn 1 token via Subscription path
      const [encBurn] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await expect(
        mockSub.connect(issuer).burn(
          await token.getAddress(),
          investor.address,
          encBurn,
          eph.address
        )
      )
        .to.emit(token, "Transfer")
        .withArgs(investor.address, ZERO_ADDRESS, anyHandle());

      const balHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balHash, ONE_TOKEN);
    });

    it("silent-fails when burn exceeds balance (balance stays unchanged)", async () => {
      const { token, issuer, investor, mockSub } = await wireMockSubscription();

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [seed] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, seed);

      const [encBurn] = await issuerClient
        .encryptInputs([Encryptable.uint128(5n * ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await mockSub.connect(issuer).burn(
        await token.getAddress(),
        investor.address,
        encBurn,
        eph.address
      );

      const balHash = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balHash, ONE_TOKEN);
    });

    it("reverts on zero ephemeralEOA", async () => {
      const { token, issuer, investor, mockSub } = await wireMockSubscription();

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const [seed] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, seed);

      const [encBurn] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();

      await expect(
        mockSub.connect(issuer).burn(
          await token.getAddress(),
          investor.address,
          encBurn,
          ZERO_ADDRESS
        )
      ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
    });

    it("reverts NoBalance when account has no prior balance", async () => {
      const { token, investor, mockSub } = await wireMockSubscription();

      const client = await hre.cofhe.createClientWithBatteries(
        (await hre.ethers.getSigners())[0]
      );
      const [encBurn] = await client
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await expect(
        mockSub.burn(
          await token.getAddress(),
          investor.address,
          encBurn,
          eph.address
        )
      ).to.be.revertedWithCustomError(token, "NoBalance");
    });
  });

  describe("transfer(to, enc, ephemeralEOA) — ADR-021 canonical overload", () => {
    it("moves balance, registers recipient as per-token holder, emits Transfer", async () => {
      const { token, issuer, investor, alice, registry } =
        await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encMint] = await issuerClient
        .encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const [encTransfer] = await investorClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await token
        .connect(investor)
        ["transfer(address,(uint256,uint8,uint8,bytes),address)"](
          alice.address,
          encTransfer,
          eph.address
        );

      const senderHash = await token.encryptedBalanceOf(investor.address);
      const recipientHash = await token.encryptedBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(senderHash, ONE_TOKEN);
      await hre.cofhe.mocks.expectPlaintext(recipientHash, ONE_TOKEN);

      expect(await registry.isHolder(await token.getAddress(), alice.address))
        .to.equal(true);
    });

    it("reverts on zero ephemeralEOA", async () => {
      const { token, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encMint] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const [encTransfer] = await investorClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();

      await expect(
        token
          .connect(investor)
          ["transfer(address,(uint256,uint8,uint8,bytes),address)"](
            alice.address,
            encTransfer,
            ZERO_ADDRESS
          )
      ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
    });

    it("Wave 3 legacy `transfer(to, enc)` overload still works and registers holder", async () => {
      const { token, issuer, investor, alice, registry } =
        await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);

      const [encMint] = await issuerClient
        .encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const [encTransfer] = await investorClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(investor).transfer(alice.address, encTransfer);

      expect(await registry.isHolder(await token.getAddress(), alice.address))
        .to.equal(true);
    });
  });

  describe("transferFrom(from, to, enc, ephemeralEOA) — ADR-021 canonical overload", () => {
    it("moves balance when allowance covers, registers recipient holder", async () => {
      const { token, issuer, investor, alice, kyc, registry } =
        await loadFixture(deployMuHavenFixture);
      const signers = await hre.ethers.getSigners();
      const bob = signers[4];
      // Whitelist bob so the transferFrom KYC gate passes.
      await kyc.addToWhitelist(bob.address);

      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

      const [encMint] = await issuerClient
        .encryptInputs([Encryptable.uint128(5n * ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const [encAllowance] = await investorClient
        .encryptInputs([Encryptable.uint128(3n * ONE_TOKEN)])
        .execute();
      await token.connect(investor).approve(alice.address, encAllowance);

      const [encPull] = await aliceClient
        .encryptInputs([Encryptable.uint128(2n * ONE_TOKEN)])
        .execute();
      const eph = createEphemeralEOA();

      await token
        .connect(alice)
        ["transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"](
          investor.address,
          bob.address,
          encPull,
          eph.address
        );

      const investorBal = await token.encryptedBalanceOf(investor.address);
      const bobBal = await token.encryptedBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(investorBal, 3n * ONE_TOKEN);
      await hre.cofhe.mocks.expectPlaintext(bobBal, 2n * ONE_TOKEN);

      expect(await registry.isHolder(await token.getAddress(), bob.address))
        .to.equal(true);
    });

    it("reverts on zero ephemeralEOA", async () => {
      const { token, issuer, investor, alice } = await loadFixture(deployMuHavenFixture);
      const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

      const [encMint] = await issuerClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(issuer).mint(investor.address, encMint);

      const [encAllowance] = await investorClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();
      await token.connect(investor).approve(alice.address, encAllowance);

      const [encPull] = await aliceClient
        .encryptInputs([Encryptable.uint128(ONE_TOKEN)])
        .execute();

      await expect(
        token
          .connect(alice)
          ["transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"](
            investor.address,
            alice.address,
            encPull,
            ZERO_ADDRESS
          )
      ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
    });
  });

  describe("setAuthorizedReader() — Wave 4 reservation", () => {
    it("owner can toggle and event + mapping reflect the update", async () => {
      const { token, deployer, alice } = await loadFixture(deployMuHavenFixture);

      expect(await token.authorizedReaders(alice.address)).to.equal(false);

      await expect(token.connect(deployer).setAuthorizedReader(alice.address, true))
        .to.emit(token, "AuthorizedReaderUpdated")
        .withArgs(alice.address, true);
      expect(await token.authorizedReaders(alice.address)).to.equal(true);

      await token.connect(deployer).setAuthorizedReader(alice.address, false);
      expect(await token.authorizedReaders(alice.address)).to.equal(false);
    });

    it("reverts OnlyOwner for non-owner callers", async () => {
      const { token, investor, alice } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(investor).setAuthorizedReader(alice.address, true)
      ).to.be.revertedWithCustomError(token, "OnlyOwner");
    });

    it("reverts on zero reader", async () => {
      const { token, deployer } = await loadFixture(deployMuHavenFixture);
      await expect(
        token.connect(deployer).setAuthorizedReader(ZERO_ADDRESS, true)
      ).to.be.revertedWithCustomError(token, "ZeroAddress");
    });
  });
});
