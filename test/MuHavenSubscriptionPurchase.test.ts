/**
 * MuHavenSubscription.purchase unit tests.
 *
 * Phase 2 sub-phase 7 (`WAVE_3_5_REVISED.md`): ~20 tests for the atomic buy
 * path — KYC gate → oracle read → silent-fail hint → FHE.mul → PUSDC pull →
 * mint via `MuHavenToken.mintFromSubscription` → ephemeralEOA grant.
 *
 * Touch-points:
 *   - ADR-001 (atomic purchase/redeem via MuHavenSubscription)
 *   - ADR-008 (PUSDC legacy `euint64 = uint256` selector via low-level call)
 *   - ADR-021 (`ephemeralEOA` as trailing param)
 *   - ADR-024 (`TokenRegistry` separate contract)
 *   - ADR-025 (cleartext `minInvestment` floor on `maxSharesHint`)
 *   - `FHE_ACL_CONVENTIONS.md` rules 1–5 (silent-fail + ACL)
 *
 * Kernel/UserOp flow is covered by SDK integration + Playwright per M1.
 * These tests use EOA stand-ins for investor + issuer.
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
  ZERO_ADDRESS,
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

/** Default per-token staleness — matches `MockPriceOracle.DEFAULT_MAX_STALENESS`. */
const THIRTY_SIX_HOURS = 36n * 60n * 60n;

/** Test epoch duration (1 hour). */
const EPOCH_DURATION = 60 * 60;

/** Generous cap for instant redeem tests. */
const INSTANT_CAP = 100_000n * ONE_PUSDC;

async function encUint128(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint128(value)]).execute();
  return enc;
}

/**
 * Full-stack fixture: KYC + InvestorRegistry + MuHavenToken + TokenRegistry
 * + Treasury + MockPUSDC + MockPriceOracle + MuHavenSubscription, wired end
 * to end. Defaults:
 *   - `investor` is KYC-whitelisted + holds 100 PUSDC.
 *   - PUSDC `confidentialTransferFrom` is operator-authorised for the
 *     subscription contract (so purchases can pull PUSDC).
 *   - Oracle pinned to `DEFAULT_NAV` with a fresh `block.timestamp`.
 *   - TokenRegistry config: active, not paused, minInvestment=0,
 *     instantRedeemCap=INSTANT_CAP, epochDuration=EPOCH_DURATION.
 *   - Subscription wired onto MuHavenToken via `setSubscription`.
 */
async function deploySubscriptionFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, investor, alice, bob, stranger] =
    await hre.ethers.getSigners();

  // KYC + registry + token
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

  // Mocks
  const pusdc = await deployMockPUSDC();
  const oracle = await deployMockPriceOracle();

  // TokenRegistry
  const RegistryFactory = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await upgrades.deployProxy(
    RegistryFactory,
    [deployer.address],
    { kind: "transparent", initializer: "initialize" }
  );

  // MuHavenSubscription
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

  // Treasury (per-token) — binds to (token, subscription, queue=bob EOA
  // placeholder, issuer, pusdc, minFloat=0, owner=deployer).
  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      bob.address, // queue placeholder — not exercised by purchase
      issuer.address,
      await pusdc.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Wire: register token in TokenRegistry
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

  // Subscription authorised to register holders via token path (MuHavenToken
  // is already authorised; Subscription itself does not call addHolder
  // directly — _mintInternal inside MuHavenToken does).
  // Allow subscription contract to mint through the token's paid-settlement path.
  await token.setSubscription(await subscription.getAddress());

  // Oracle: pin NAV fresh
  const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
  await oracle.setNAV(
    await token.getAddress(),
    DEFAULT_NAV,
    BigInt(now)
  );

  // Seed investor PUSDC + grant subscription operator status
  await pusdc.mint(investor.address, 100n * ONE_PUSDC);
  await pusdc
    .connect(investor)
    .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

  // Ephemeral session EOA (ADR-021)
  const eph = createEphemeralEOA();

  const investorClient = await hre.cofhe.createClientWithBatteries(investor);
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);

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
    issuerClient,
    eph,
  };
}

describe("MuHavenSubscription.purchase", () => {
  // ── initialize() ────────────────────────────────────────────────────────

  describe("initialize()", () => {
    it("sets bindings + owner and emits SubscriptionInitialized", async () => {
      const { subscription, deployer, tokenRegistry, kyc, pusdc } =
        await loadFixture(deploySubscriptionFixture);

      expect(await subscription.owner()).to.equal(deployer.address);
      expect(await subscription.tokenRegistry()).to.equal(
        await tokenRegistry.getAddress()
      );
      expect(await subscription.kycGate()).to.equal(await kyc.getAddress());
      expect(await subscription.pusdc()).to.equal(await pusdc.getAddress());
      expect(await subscription.identityRegistry()).to.equal(ZERO_ADDRESS);
      expect(await subscription.modularCompliance()).to.equal(ZERO_ADDRESS);
    });

    it("rejects zero-address constructor args", async () => {
      await hre.run("task:cofhe-mocks:deploy");
      const [deployer] = await hre.ethers.getSigners();
      const Factory = await hre.ethers.getContractFactory("MuHavenSubscription");

      // A real addr for each non-targeted slot; zero the one under test.
      const kyc = await deployKYCAdapter();
      const tokenRegistry = await (async () => {
        const F = await hre.ethers.getContractFactory("TokenRegistry");
        return upgrades.deployProxy(F, [deployer.address], {
          kind: "transparent",
          initializer: "initialize",
        });
      })();
      const pusdc = await deployMockPUSDC();

      const base = [
        deployer.address,
        await tokenRegistry.getAddress(),
        await kyc.getAddress(),
        await pusdc.getAddress(),
      ] as const;

      for (let slot = 0; slot < base.length; slot++) {
        const args = [...base] as any[];
        args[slot] = ZERO_ADDRESS;
        await expect(
          upgrades.deployProxy(Factory, args, {
            kind: "transparent",
            initializer: "initialize",
          })
        ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
      }
    });

    it("cannot be re-initialized", async () => {
      const { subscription, deployer, tokenRegistry, kyc, pusdc } =
        await loadFixture(deploySubscriptionFixture);

      await expect(
        subscription.initialize(
          deployer.address,
          await tokenRegistry.getAddress(),
          await kyc.getAddress(),
          await pusdc.getAddress()
        )
      ).to.be.revertedWithCustomError(subscription, "InvalidInitialization");
    });
  });

  // ── purchase(): happy paths ─────────────────────────────────────────────

  describe("purchase(): happy paths", () => {
    it("mints shares to investor, pulls PUSDC to treasury, emits Purchased", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Buy 5 shares at NAV 1_000_000 → cost 5 PUSDC.
      const shares = 5n;
      const enc = await encUint128(investorClient, shares);

      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      )
        .to.emit(subscription, "Purchased")
        .withArgs(await token.getAddress(), investor.address, HINT_CAP);

      // Shares balance = 5 (scale matches encrypted integer)
      const balHandle = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(balHandle, shares);

      // PUSDC: investor down by 5 * ONE_PUSDC, treasury up.
      const investorPUSDC = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(investorPUSDC, 95n * ONE_PUSDC);
      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryPUSDC, 5n * ONE_PUSDC);
    });

    it("registers the investor as a per-token holder on first purchase", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        registry,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      const enc = await encUint128(investorClient, 3n);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);

      expect(
        await registry.isHolder(await token.getAddress(), investor.address)
      ).to.equal(true);
      expect(await registry.holderCount(await token.getAddress())).to.equal(1n);
      expect(await registry.isInvestor(investor.address)).to.equal(true);
    });

    it("supports repeat purchases — balances accumulate, holder stays unique", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        registry,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      for (const qty of [4n, 6n, 10n]) {
        const enc = await encUint128(investorClient, qty);
        await subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address);
      }

      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, 20n);

      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryPUSDC, 20n * ONE_PUSDC);

      // Holder set still has exactly one entry.
      expect(await registry.holderCount(await token.getAddress())).to.equal(1n);
    });
  });

  // ── purchase(): silent-fail hint gate ───────────────────────────────────

  describe("purchase(): silent-fail hint gate", () => {
    it("mints zero + moves zero PUSDC when encShares > maxSharesHint", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Request 50 shares but commit only up to 10 — silent-fail.
      const enc = await encUint128(investorClient, 50n);

      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, 10n, eph.address);

      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, 0n);

      // PUSDC untouched (cost mirrors to zero via bounded-shares = 0). The
      // treasury's balance handle initialises during the transfer (PUSDC
      // credits `amount = 0` to an uninitialised recipient) — plaintext
      // value is what matters, not handle existence.
      const investorPUSDC = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(investorPUSDC, 100n * ONE_PUSDC);
      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryPUSDC, 0n);
    });

    it("mints exactly when encShares == maxSharesHint (boundary case)", async () => {
      const {
        subscription,
        investor,
        investorClient,
        token,
        pusdc,
        treasury,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      const qty = 7n;
      const enc = await encUint128(investorClient, qty);
      await subscription
        .connect(investor)
        .purchase(await token.getAddress(), enc, qty, eph.address);

      const bal = await token.encryptedBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, qty);

      const treasuryPUSDC = await pusdc.confidentialBalanceOf(
        await treasury.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(treasuryPUSDC, qty * ONE_PUSDC);
    });
  });

  // ── purchase(): cleartext gate reverts ──────────────────────────────────

  describe("purchase(): cleartext gate reverts", () => {
    it("reverts InvalidEphemeralEOA when ephemeralEOA == 0", async () => {
      const { subscription, investor, investorClient, token } =
        await loadFixture(deploySubscriptionFixture);
      const enc = await encUint128(investorClient, 1n);

      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "InvalidEphemeralEOA");
    });

    it("reverts InvalidMaxSharesHint when hint == 0", async () => {
      const { subscription, investor, investorClient, token, eph } =
        await loadFixture(deploySubscriptionFixture);
      const enc = await encUint128(investorClient, 1n);

      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, 0n, eph.address)
      ).to.be.revertedWithCustomError(subscription, "InvalidMaxSharesHint");
    });

    it("reverts TokenNotRegistered for an unknown token", async () => {
      const { subscription, investor, investorClient, eph } =
        await loadFixture(deploySubscriptionFixture);
      const enc = await encUint128(investorClient, 1n);
      const bogus = "0x1111111111111111111111111111111111111111";

      await expect(
        subscription
          .connect(investor)
          .purchase(bogus, enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "TokenNotRegistered");
    });

    it("reverts TokenPaused when the token is paused in the registry", async () => {
      const {
        subscription,
        tokenRegistry,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      await tokenRegistry
        .connect(deployer)
        .setPaused(await token.getAddress(), true);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "TokenPaused");
    });

    it("reverts BelowMinInvestment when hint < minInvestment", async () => {
      const {
        subscription,
        tokenRegistry,
        issuer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      await tokenRegistry
        .connect(issuer)
        .setMinInvestment(await token.getAddress(), 50n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, 10n, eph.address)
      ).to.be.revertedWithCustomError(subscription, "BelowMinInvestment");
    });

    it("reverts NotEligible when investor is not KYC-whitelisted", async () => {
      const {
        subscription,
        stranger,
        investorClient,
        token,
        pusdc,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Arm operator for stranger so we exercise the KYC gate, not an
      // operator-not-set path.
      await pusdc
        .connect(stranger)
        .setOperator(await subscription.getAddress(), 2n ** 47n - 1n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(stranger)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "NotEligible");
    });

    it("reverts OracleReturnedZero when NAV has never been published", async () => {
      const {
        subscription,
        oracle,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Wipe NAV (pin to zero with a fresh timestamp — zero reverts before
      // staleness check).
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 0n, BigInt(now));

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "OracleReturnedZero");
    });

    it("reverts StaleNAV when NAV is older than the staleness window", async () => {
      const {
        subscription,
        oracle,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Pin NAV with an ancient timestamp (> 36h old).
      await oracle.setNAV(await token.getAddress(), DEFAULT_NAV, 1n);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "StaleNAV");
    });

    it("reverts CostOverflowsPUSDCWidth when maxSharesHint * nav exceeds PUSDC's euint64 width", async () => {
      // Catches the Phase-2 review bug: `encCost = FHE.asEuint64(encCost128)`
      // silently truncates when `encSharesBounded * nav > 2^64 - 1`, which
      // would let an investor mint the full hint's worth of shares while the
      // PUSDC leg only transferred the truncated (smaller) amount. The
      // cleartext guard at entry forces the tx to revert loudly so the
      // silent-fail semantics only ever operate within PUSDC's legitimate
      // width.
      const { subscription, oracle, investor, investorClient, token, eph } =
        await loadFixture(deploySubscriptionFixture);

      // nav = 2 · (type(uint64).max) would overflow. We pick nav = 2 and
      // maxSharesHint = type(uint64).max so the product is 2^65 - 2 (exceeds
      // uint64 width but still comfortably within uint256, so Solidity's
      // unchecked overflow panic doesn't fire before our explicit revert).
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 2n, BigInt(now));

      const enc = await encUint128(investorClient, 1n);
      const hugeHint = (1n << 64n) - 1n;

      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, hugeHint, eph.address)
      ).to.be.revertedWithCustomError(subscription, "CostOverflowsPUSDCWidth");
    });

    it("accepts a boundary hint where hint * nav == type(uint64).max (no revert)", async () => {
      // Complement to the overflow test above: the exact boundary case
      // where the product fits in uint64 exactly must not revert. Proves
      // the guard is `>` not `>=`.
      const {
        subscription,
        oracle,
        investor,
        investorClient,
        token,
        pusdc,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // nav = 1, hint = type(uint64).max → product = type(uint64).max
      // (exactly — does not trigger the guard). Sufficient PUSDC must be
      // available for the pull; give the investor a tiny purchase instead.
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      await oracle.setNAV(await token.getAddress(), 1n, BigInt(now));

      // Mint additional PUSDC to the investor so the 1-share purchase clears
      // cleanly against the new 1-unit NAV.
      await pusdc.mint(investor.address, 1n);

      const boundaryHint = (1n << 64n) - 1n; // type(uint64).max
      const enc = await encUint128(investorClient, 1n);

      // No revert expected — purchase passes through all gates.
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, boundaryHint, eph.address)
      )
        .to.emit(subscription, "Purchased")
        .withArgs(await token.getAddress(), investor.address, boundaryHint);
    });

    it("reverts PaymentTransferFailed when investor hasn't set subscription as PUSDC operator", async () => {
      const { subscription, investor, investorClient, token, pusdc, eph } =
        await loadFixture(deploySubscriptionFixture);

      // Revoke the operator grant by setting to 0.
      await pusdc
        .connect(investor)
        .setOperator(await subscription.getAddress(), 0);

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "PaymentTransferFailed");
    });
  });

  // ── purchase(): compliance gate (Phase 3 wiring, Phase 2 off) ───────────

  describe("purchase(): modular compliance gate", () => {
    it("skips the compliance check when modularCompliance is unset", async () => {
      // Fixture leaves modularCompliance = 0. Happy path proves the zero
      // pointer is treated as "no gate" (happy-path test above); here we
      // just re-assert the default state.
      const { subscription } = await loadFixture(deploySubscriptionFixture);
      expect(await subscription.modularCompliance()).to.equal(ZERO_ADDRESS);
    });

    it("reverts ComplianceBlocked when a non-trivial compliance denies the purchase", async () => {
      const {
        subscription,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Deploy a tiny stub that always denies canTransfer.
      const Factory = await hre.ethers.getContractFactory("DenyAllCompliance");
      const stub = await Factory.deploy();

      await subscription
        .connect(deployer)
        .setModularCompliance(await stub.getAddress());

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "ComplianceBlocked");
    });
  });

  // ── admin setters ───────────────────────────────────────────────────────

  describe("admin setters", () => {
    it("setTokenRegistry rotates + emits", async () => {
      const { subscription, deployer, alice } = await loadFixture(
        deploySubscriptionFixture
      );
      await expect(
        subscription.connect(deployer).setTokenRegistry(alice.address)
      )
        .to.emit(subscription, "TokenRegistryUpdated")
        .withArgs(alice.address);
      expect(await subscription.tokenRegistry()).to.equal(alice.address);
    });

    it("setTokenRegistry rejects non-owner + zero-address", async () => {
      const { subscription, alice, deployer } = await loadFixture(
        deploySubscriptionFixture
      );
      await expect(
        subscription.connect(alice).setTokenRegistry(alice.address)
      ).to.be.revertedWithCustomError(subscription, "OnlyOwner");
      await expect(
        subscription.connect(deployer).setTokenRegistry(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "ZeroAddress");
    });

    it("setPUSDC rotates + emits; rejects non-owner + zero-address", async () => {
      const { subscription, deployer, alice } = await loadFixture(
        deploySubscriptionFixture
      );
      await expect(subscription.connect(deployer).setPUSDC(alice.address))
        .to.emit(subscription, "PUSDCUpdated")
        .withArgs(alice.address);
      expect(await subscription.pusdc()).to.equal(alice.address);

      await expect(
        subscription.connect(alice).setPUSDC(alice.address)
      ).to.be.revertedWithCustomError(subscription, "OnlyOwner");
      await expect(
        subscription.connect(deployer).setPUSDC(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "ZeroAddress");
    });

    it("setIdentityRegistry rotates + emits; supersedes KYC gate", async () => {
      const {
        subscription,
        deployer,
        investor,
        investorClient,
        token,
        eph,
      } = await loadFixture(deploySubscriptionFixture);

      // Wire a stub IdentityRegistry that denies everyone. The investor is
      // whitelisted on the legacy `kycGate`, so the happy path still works
      // before the setter fires; after wiring, `purchase` must consult the
      // identity registry (deny-all) and revert `NotEligible`, proving
      // supersession.
      const Factory = await hre.ethers.getContractFactory("DenyAllIdentityRegistry");
      const stub = await Factory.deploy();

      await expect(
        subscription
          .connect(deployer)
          .setIdentityRegistry(await stub.getAddress())
      )
        .to.emit(subscription, "IdentityRegistryUpdated")
        .withArgs(await stub.getAddress());

      const enc = await encUint128(investorClient, 1n);
      await expect(
        subscription
          .connect(investor)
          .purchase(await token.getAddress(), enc, HINT_CAP, eph.address)
      ).to.be.revertedWithCustomError(subscription, "NotEligible");
    });

    it("setKYCGate / setModularCompliance rotate + emit events", async () => {
      const { subscription, deployer, alice } = await loadFixture(
        deploySubscriptionFixture
      );

      await expect(subscription.connect(deployer).setKYCGate(alice.address))
        .to.emit(subscription, "KYCGateUpdated")
        .withArgs(alice.address);
      expect(await subscription.kycGate()).to.equal(alice.address);

      // setKYCGate rejects zero — prevents bricking purchase when owner
      // accidentally zero-wipes the fallback gate before wiring an
      // identity registry.
      await expect(
        subscription.connect(deployer).setKYCGate(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "ZeroAddress");

      await expect(
        subscription.connect(deployer).setModularCompliance(alice.address)
      )
        .to.emit(subscription, "ModularComplianceUpdated")
        .withArgs(alice.address);
      expect(await subscription.modularCompliance()).to.equal(alice.address);
    });

    it("transferOwnership rotates + emits; rejects non-owner + zero-address", async () => {
      const { subscription, deployer, alice, stranger } =
        await loadFixture(deploySubscriptionFixture);

      await expect(
        subscription.connect(deployer).transferOwnership(alice.address)
      )
        .to.emit(subscription, "OwnershipTransferred")
        .withArgs(deployer.address, alice.address);
      expect(await subscription.owner()).to.equal(alice.address);

      await expect(
        subscription.connect(stranger).transferOwnership(stranger.address)
      ).to.be.revertedWithCustomError(subscription, "OnlyOwner");
      await expect(
        subscription.connect(alice).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(subscription, "ZeroAddress");
    });
  });

  // ── views ───────────────────────────────────────────────────────────────

  describe("views", () => {
    it("getCurrentEpoch reflects block.timestamp / epochDuration", async () => {
      const { subscription, token } = await loadFixture(
        deploySubscriptionFixture
      );
      const now = (await hre.ethers.provider.getBlock("latest"))!.timestamp;
      const expected = BigInt(Math.floor(now / EPOCH_DURATION));
      expect(
        await subscription.getCurrentEpoch(await token.getAddress())
      ).to.equal(expected);
    });

    it("getInstantCapRemaining returns the full cap before any redeem", async () => {
      const { subscription, token } = await loadFixture(
        deploySubscriptionFixture
      );
      expect(
        await subscription.getInstantCapRemaining(await token.getAddress())
      ).to.equal(INSTANT_CAP);
    });

    it("getInstantCapRemaining returns 0 for an unregistered token", async () => {
      const { subscription } = await loadFixture(deploySubscriptionFixture);
      const bogus = "0x2222222222222222222222222222222222222222";
      expect(await subscription.getInstantCapRemaining(bogus)).to.equal(0n);
    });
  });

  // ── redeem() ────────────────────────────────────────────────────────────
  // The full redeem behaviour now lives in `test/MuHavenSubscriptionRedeem.test.ts`.
  // This file's leftover stub assertion was retired when the body landed in
  // sub-phase 8.
});
