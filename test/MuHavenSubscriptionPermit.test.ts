/**
 * Permit/decrypt grant audit tests for the Wave 3.5 Phase 2 mutation
 * surface — proves `FHE.allow(handle, ephemeralEOA)` fires on every handle
 * the investor is expected to decrypt via `cofheClient.decryptForView()`.
 *
 * Phase 2 sub-phase 9 (`WAVE_3_5_REVISED.md`): per `FHE_ACL_CONVENTIONS.md`
 * Rule 2 + ADR-021 (`ephemeralEOA` as trailing param), every mutation
 * producing user-decryptable state must grant the user's session-scoped
 * ephemeral EOA. This file is the regression net for that contract.
 *
 * Verification approach:
 *   - Use `hre.cofhe.getMockACL()` to read the mock ACL directly. The
 *     `isAllowed(handle, account)` view is the authoritative check.
 *   - Each test exercises one mutation site (purchase mint balance, redeem
 *     burn balance, paid-settlement burn return handle, legacy paths that
 *     deliberately do *not* grant ephemeralEOA to lock in the legacy/canonical
 *     contract per the overload split documented in `DEV_LOG.md` 2026-04-23
 *     Phase 2 entry).
 *   - Negative assertions cover the "stranger EOA does not get grants"
 *     property — defensive against accidental over-grants that would let any
 *     observer decrypt a handle they shouldn't.
 *
 * Out of scope (lazy-grant pattern per ADR-028):
 *   - YieldSnapshot grants — happen at `claimYield` time (Phase 5), not here.
 *   - RedemptionQueue grants — happen at `submit`/`processEpoch` (Phase 4).
 *   - Treasury grants — by design no per-investor decryptable state.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import {
  deployKYCAdapter,
  deployRegistry,
  deployToken,
  deployMockPUSDC,
} from "./helpers/setup";
import {
  createEphemeralEOA,
  deployMockPriceOracle,
} from "./helpers/fixturesV2";

/** PUSDC has 6 decimals (matches mainnet USDC). */
const ONE_PUSDC = 1_000_000n;

/** Hint-space ceiling chosen to comfortably exceed any test purchase. */
const HINT_CAP = 1_000_000n;

/** NAV convention per `MockPriceOracle` — PUSDC base units per share unit. */
const DEFAULT_NAV = ONE_PUSDC;

/** Test epoch duration (1 hour). */
const EPOCH_DURATION = 60 * 60;

/** Generous cap for instant redeem tests. */
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

/** ACL handle ↔ uint256 conversion — euint128 wraps bytes32. */
function handleToUint(handle: any): bigint {
  // ethers v6 returns the raw bytes32 as a hex string for euint typed values.
  return BigInt(handle);
}

/**
 * Same fixture shape as the redeem tests: investor seeded with 100 shares,
 * subscription wired to token, treasury seeded with PUSDC, oracle pinned.
 */
async function deployPermitFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob, stranger] =
    await hre.ethers.getSigners();

  const kyc = await deployKYCAdapter();
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

  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

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

  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      bob.address,
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
    queue: bob.address,
    oracle: await oracle.getAddress(),
    issuer: issuer.address,
    minInvestment: 0n,
    instantRedeemCap: INSTANT_CAP,
    epochDuration: EPOCH_DURATION,
    paused: false,
  });

  await token.setSubscription(await subscription.getAddress());

  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, BigInt(now));

  await pusdc.mint(investor.address, 200n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);
  await pusdc.mint(await treasury.getAddress(), 200n * ONE_PUSDC);

  const eph = createEphemeralEOA();
  const stranger2 = createEphemeralEOA();

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const acl = await hre.cofhe.mocks.getMockACL();

  return {
    deployer,
    issuer,
    investor,
    alice,
    bob,
    stranger,
    kyc,
    registry,
    token,
    tokenRegistry,
    treasury,
    pusdc,
    oracle,
    subscription,
    investorClient,
    eph,
    stranger2,
    acl,
  };
}

describe("Wave 3.5 permit/decrypt grants — FHE.allow(handle, ephemeralEOA)", () => {
  // ── purchase: balance handle ────────────────────────────────────────────

  describe("MuHavenSubscription.purchase", () => {
    it("grants ephemeralEOA decrypt on the new MuHavenToken balance handle", async () => {
      const { subscription, investor, investorClient, token, eph, acl } =
        await loadFixture(deployPermitFixture);

      const enc = await encUint128(investorClient, 5n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

      const balHandle = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(balHandle), eph.address)).to.equal(
        true
      );
      // Legacy kernel grant still present (Wave 3 back-compat).
      expect(await acl.isAllowed(handleToUint(balHandle), investor.address)).to.equal(
        true
      );
      // Token contract retains its own ACL for downstream FHE math.
      expect(await acl.isAllowed(handleToUint(balHandle), await token.getAddress())).to.equal(
        true
      );
    });

    it("does not grant a stranger EOA on the investor's balance handle", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        eph,
        stranger2,
        acl,
      } = await loadFixture(deployPermitFixture);

      const enc = await encUint128(investorClient, 5n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

      const balHandle = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(balHandle), stranger2.address)).to.equal(
        false
      );
    });

    it("each ephemeralEOA only decrypts the balance after its own purchase", async () => {
      const { subscription, investor, investorClient, token, acl } =
        await loadFixture(deployPermitFixture);

      const eph1 = createEphemeralEOA();
      const eph2 = createEphemeralEOA();

      // First purchase under eph1 — only eph1 should decrypt the resulting handle.
      const enc1 = await encUint128(investorClient, 3n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc1, HINT_CAP, eph1.address);

      const handleAfter1 = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(handleAfter1), eph1.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(handleAfter1), eph2.address)).to.equal(false);

      // Second purchase under eph2 — `_balances[to]` becomes a NEW handle
      // (FHE.add creates a new handle) and only eph2 is granted on the new
      // handle. eph1 retains access to the old (now stale) handle but cannot
      // decrypt the current balance.
      const enc2 = await encUint128(investorClient, 4n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc2, HINT_CAP, eph2.address);

      const handleAfter2 = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(handleAfter2), eph2.address)).to.equal(true);
      // Critical assertion: eph1 has no ACL on the *new* handle. This is the
      // session-rotation property — losing a session loses decrypt on
      // subsequent state mutations.
      expect(await acl.isAllowed(handleToUint(handleAfter2), eph1.address)).to.equal(false);
    });
  });

  // ── redeem: balance handle (post-burn) ──────────────────────────────────

  describe("MuHavenSubscription.redeem", () => {
    it("grants ephemeralEOA decrypt on the post-burn balance handle", async () => {
      const { subscription, investor, investorClient, token, eph, acl } =
        await loadFixture(deployPermitFixture);

      // Seed via purchase under eph.
      const encSeed = await encUint128(investorClient, 50n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

      // Redeem under same eph.
      const encRedeem = await encUint128(investorClient, 20n);
      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), encRedeem, HINT_CAP, eph.address);

      const balHandle = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(balHandle), eph.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(balHandle), investor.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(balHandle), await token.getAddress())).to.equal(
        true
      );
    });

    it("rotates the grant when redeem uses a fresh ephemeralEOA", async () => {
      const { subscription, investor, investorClient, token, acl } =
        await loadFixture(deployPermitFixture);

      const eph1 = createEphemeralEOA();
      const eph2 = createEphemeralEOA();

      const encSeed = await encUint128(investorClient, 50n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encSeed, HINT_CAP, eph1.address);

      // Redeem under a different ephemeral key — only eph2 gets the new handle.
      const encRedeem = await encUint128(investorClient, 10n);
      await subscription
        .connect(investor)
        .redeem(await token.getAddress(), encRedeem, HINT_CAP, eph2.address);

      const balHandle = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(balHandle), eph2.address)).to.equal(true);
      expect(await acl.isAllowed(handleToUint(balHandle), eph1.address)).to.equal(false);
    });
  });

  // ── MuHavenToken canonical Wave 3.5 transfer overload ───────────────────

  describe("MuHavenToken.transfer (3-arg, ephemeralEOA-aware)", () => {
    it("grants ephemeralEOA decrypt on the sender's updated balance handle", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        alice,
        eph,
        acl,
      } = await loadFixture(deployPermitFixture);

      // Seed investor with 50 shares.
      const encSeed = await encUint128(investorClient, 50n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

      // Use the canonical Wave 3.5 three-arg transfer.
      const ephTransfer = createEphemeralEOA();
      const encXfer = await encUint128(investorClient, 5n);
      await token
        .connect(investor)
        ["transfer(address,(uint256,uint8,uint8,bytes),address)"](
          alice.address,
          encXfer,
          ephTransfer.address
        );

      const senderBal = await token.encryptedBalanceOf(investor.address);
      expect(await acl.isAllowed(handleToUint(senderBal), ephTransfer.address)).to.equal(
        true
      );
      expect(await acl.isAllowed(handleToUint(senderBal), investor.address)).to.equal(true);
    });

    it("recipient's balance handle gets only a kernel grant per ADR-028 (no eph)", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        alice,
        eph,
        acl,
      } = await loadFixture(deployPermitFixture);

      const encSeed = await encUint128(investorClient, 50n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

      const ephTransfer = createEphemeralEOA();
      const encXfer = await encUint128(investorClient, 5n);
      await token
        .connect(investor)
        ["transfer(address,(uint256,uint8,uint8,bytes),address)"](
          alice.address,
          encXfer,
          ephTransfer.address
        );

      const aliceBal = await token.encryptedBalanceOf(alice.address);
      // Recipient gets kernel grant ...
      expect(await acl.isAllowed(handleToUint(aliceBal), alice.address)).to.equal(true);
      // ... but the sender's ephemeralEOA cannot decrypt the recipient's balance
      // (privacy boundary: the sender doesn't get to peek at recipient state).
      expect(await acl.isAllowed(handleToUint(aliceBal), ephTransfer.address)).to.equal(
        false
      );
    });
  });

  // ── Wave 3 legacy mutation paths — no ephemeralEOA grant ────────────────

  describe("Wave 3 legacy paths (no ephemeralEOA grant — locked behaviour)", () => {
    it("legacy 2-arg transfer does NOT grant any ephemeralEOA on the new handle", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        alice,
        eph,
        acl,
      } = await loadFixture(deployPermitFixture);

      const encSeed = await encUint128(investorClient, 50n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encSeed, HINT_CAP, eph.address);

      // Legacy 2-arg transfer overload — no ephemeralEOA param.
      const encXfer = await encUint128(investorClient, 3n);
      await token
        .connect(investor)
        ["transfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encXfer);

      const senderBal = await token.encryptedBalanceOf(investor.address);
      // Only kernel + token contract have ACL; no random EOA gets grants.
      expect(await acl.isAllowed(handleToUint(senderBal), investor.address)).to.equal(
        true
      );
      expect(await acl.isAllowed(handleToUint(senderBal), eph.address)).to.equal(false);
    });
  });

  // ── Aggregate handle grants are NOT user-scoped ─────────────────────────

  describe("Aggregate handles (Rule 3 — no per-investor allowPublic)", () => {
    it("encryptedTotalSupply is NOT granted to either investor's ephemeralEOA", async () => {
      const { subscription, investor, alice, token, eph, acl, pusdc } =
        await loadFixture(deployPermitFixture);

      // With a single minter, the very first mint aliases the supply handle
      // to the investor's balance handle (both assigned to the input `amount`
      // handle), so any test on a single-investor flow trivially passes the
      // grant check by coincidence. To exercise the grant model honestly, run
      // two purchases under **different** ephemeralEOAs from two distinct
      // investors — the second purchase forces `_encryptedTotalSupply =
      // FHE.add(supply_old, amount_alice)` which produces a fresh, isolated
      // aggregate handle.
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

      // Arm alice with PUSDC + operator approval (the fixture only does this
      // for `investor`).
      await pusdc.mint(alice.address, 50n * ONE_PUSDC);
      await pusdc
        .connect(alice)
        .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

      const ephAlice = createEphemeralEOA();

      const encInv = await encUint128(investorClient, 5n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), encInv, HINT_CAP, eph.address);

      const encAlice = await encUint128(aliceClient, 3n);
      await subscription
        .connect(alice)
        .purchase(await token.getAddress(), encAlice, HINT_CAP, ephAlice.address);

      const supply = await token.encryptedTotalSupply();
      // Token contract has ACL (so it can run downstream FHE math) ...
      expect(await acl.isAllowed(handleToUint(supply), await token.getAddress())).to.equal(
        true
      );
      // ... but neither investor's ephemeralEOA gets grant — totalSupply is
      // an aggregate that stays private until the issuer toggles via
      // `setTotalSupplyPublic()` (FHE.allowPublic path).
      expect(await acl.isAllowed(handleToUint(supply), eph.address)).to.equal(false);
      expect(await acl.isAllowed(handleToUint(supply), ephAlice.address)).to.equal(false);
    });
  });
});
