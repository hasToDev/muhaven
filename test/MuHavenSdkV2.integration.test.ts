/**
 * MuHaven SDK — Wave 3.5 Phase 6 integration tests.
 *
 * Exercises the new client surface end-to-end against real Wave 3.5 contracts
 * deployed on the in-process Hardhat network with the CoFHE mock coprocessor.
 *
 * Mirrors the MuHavenSdk.integration.test.ts bridging strategy:
 *   - ethers + hardhat-upgrades drive the proxy deploys
 *   - viem PublicClient + WalletClient talk to the in-process provider via
 *     `custom()` (EIP-1193)
 *   - Hardhat deterministic private keys let us reuse the same signer for
 *     tx-sending + contract state assertions
 *
 * Tests cover the full investor + issuer flows documented in
 * `development/PRODUCTION_DESIGN/FLOWS.md` (F2 purchase, F4 instant redeem,
 * F5 queued redeem + settle + claim, F6 yield claim, F7 NAV publish,
 * F8 processEpoch, F9 snapshot/fund/sweep). Each section asserts the
 * tx lands, on-chain state moves, and for encrypted balances the CoFHE
 * mock's plaintext matches the expected amount.
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat as hardhatChain } from "viem/chains";
import {
  SubscriptionClient,
  TreasuryClient,
  RedemptionQueueClient,
  YieldSnapshotClient,
  OracleClient,
  IdentityRegistryClient,
  ConfigError,
  walletClientToSender,
  type MuHavenClientContext,
} from "@muhaven/sdk";
import {
  deployKYCAdapter,
  deployRegistry,
  deployToken,
  deployMockPUSDC,
  ZERO_ADDRESS,
} from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_PUSDC = 1_000_000n;
const DEFAULT_NAV = ONE_PUSDC;
const HINT = 1_000_000n;
const EPOCH_DURATION = 60 * 60;
const INSTANT_CAP = 1_000_000_000n * ONE_PUSDC;

/** Hardhat's deterministic private keys (accounts 0..4). */
const HARDHAT_PK_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HARDHAT_PK_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const HARDHAT_PK_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const HARDHAT_PK_3 = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;

function makeViemClients(privateKey: `0x${string}`): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  address: Address;
} {
  const account = privateKeyToAccount(privateKey);
  const transport = custom(hre.network.provider);
  const publicClient = createPublicClient({ chain: hardhatChain, transport });
  const walletClient = createWalletClient({ chain: hardhatChain, transport, account });
  return { publicClient, walletClient, address: account.address };
}

/**
 * Build an SDK context whose `cofheClient` is bound to the same Hardhat
 * signer as the viem wallet. `FHE.verifyInput` in the CoFHE mock compares
 * the input-proof signer against `msg.sender` at call time, so encrypt-
 * via-signer-A / send-via-signer-B reverts with `InvalidInputSignature`.
 */
async function makeContext(
  pk: `0x${string}`,
  signerIndex: number,
): Promise<MuHavenClientContext> {
  const signers = await hre.ethers.getSigners();
  const signer = signers[signerIndex]!;
  const cofheClient = await hre.cofhe.createClientWithBatteries(signer);
  const { publicClient, walletClient } = makeViemClients(pk);
  return {
    publicClient,
    sender: walletClientToSender(walletClient),
    cofheClient: cofheClient as any,
  };
}

async function deployV2IntegrationFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, alice, bob] = await hre.ethers.getSigners();

  // KYC + InvestorRegistry + Token (Wave 3 carry-over — Wave 3.5 still uses
  // them as the compliance + holder tracker under dev-mode).
  const kyc = await deployKYCAdapter();
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

  // Real IssuerControlledOracle so the NAV deviation/accept/reject paths
  // can be exercised.
  const OracleFactory = await hre.ethers.getContractFactory("IssuerControlledOracle");
  const oracle = await upgrades.deployProxy(
    OracleFactory,
    [deployer.address, ZERO_ADDRESS],
    { kind: "transparent", initializer: "initialize" }
  );

  // IdentityRegistry in dev-mode (ADR-023 default) so purchase/redeem
  // compliance passes without claim issuance.
  const IR = await hre.ethers.getContractFactory("MuHavenIdentityRegistry");
  const identityRegistry = await upgrades.deployProxy(
    IR,
    [deployer.address, ZERO_ADDRESS, ZERO_ADDRESS, true],
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
  await subscription.setIdentityRegistry(await identityRegistry.getAddress());

  const QueueFactory = await hre.ethers.getContractFactory("RedemptionQueue");
  const queue = await upgrades.deployProxy(
    QueueFactory,
    [
      deployer.address,
      await token.getAddress(),
      await tokenRegistry.getAddress(),
      await subscription.getAddress(),
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );
  await queue.setIdentityRegistry(await identityRegistry.getAddress());

  const TreasuryFactory = await hre.ethers.getContractFactory("MuHavenTreasury");
  const treasury = await upgrades.deployProxy(
    TreasuryFactory,
    [
      await token.getAddress(),
      await subscription.getAddress(),
      await queue.getAddress(),
      issuer.address,
      await pusdc.getAddress(),
      0n,
      deployer.address,
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  const YSFactory = await hre.ethers.getContractFactory("YieldSnapshot");
  const yieldSnapshot = await upgrades.deployProxy(
    YSFactory,
    [deployer.address, await tokenRegistry.getAddress(), await pusdc.getAddress()],
    { kind: "transparent", initializer: "initialize" }
  );

  await tokenRegistry.registerToken(await token.getAddress(), {
    active: true,
    treasury: await treasury.getAddress(),
    queue: await queue.getAddress(),
    oracle: await oracle.getAddress(),
    issuer: issuer.address,
    minInvestment: 0n,
    instantRedeemCap: INSTANT_CAP,
    epochDuration: EPOCH_DURATION,
    paused: false,
  });

  await token.setSubscription(await subscription.getAddress());
  await token.setQueue(await queue.getAddress());
  await token.setYieldSnapshot(await yieldSnapshot.getAddress());

  await oracle.setNavWriter(await token.getAddress(), issuer.address);
  await oracle.setMaxDeviationBps(await token.getAddress(), 25n);
  await oracle.connect(issuer).setNAV(await token.getAddress(), DEFAULT_NAV);

  // Seed PUSDC for investors + operator approvals so purchase/redeem/queue
  // can pull without additional calls. Treasury starts at zero — redeem-side
  // tests that need a payable treasury seed it inline.
  for (const s of [alice, bob]) {
    await pusdc.mint(s.address, 1000n * ONE_PUSDC);
    await pusdc.connect(s).setOperator(await subscription.getAddress(), 2n ** 47n - 1n);
  }

  // Issuer PUSDC funding headroom for yield distribution + treasury seed.
  await pusdc.mint(issuer.address, 100_000n * ONE_PUSDC);
  await pusdc
    .connect(issuer)
    .setOperator(await yieldSnapshot.getAddress(), 2n ** 47n - 1n);

  return {
    deployer,
    issuer,
    alice,
    bob,
    kyc,
    registry,
    token,
    pusdc,
    oracle,
    identityRegistry,
    tokenRegistry,
    subscription,
    queue,
    treasury,
    yieldSnapshot,
  };
}

describe("MuHaven SDK Wave 3.5 clients (integration)", function () {
  // ────────────────────────────────────────────────────────────────────────
  // Constructor guards
  // ────────────────────────────────────────────────────────────────────────

  describe("constructor", function () {
    it("SubscriptionClient rejects missing context", async function () {
      const { subscription } = await loadFixture(deployV2IntegrationFixture);
      expect(() =>
        new SubscriptionClient(undefined as any, (subscription as any).target as Address)
      ).to.throw(ConfigError);
    });

    it("SubscriptionClient rejects missing address", async function () {
      const { deployer } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      expect(() => new SubscriptionClient(ctx, undefined as any))
        .to.throw(ConfigError, /subscription/);
    });

    it("TreasuryClient rejects missing context fields", async function () {
      const { treasury } = await loadFixture(deployV2IntegrationFixture);
      expect(() =>
        new TreasuryClient(
          { publicClient: undefined as any, sender: undefined as any, cofheClient: undefined as any },
          (treasury as any).target as Address,
        )
      ).to.throw(ConfigError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // OracleClient + IdentityRegistryClient (reads + writes)
  // ────────────────────────────────────────────────────────────────────────

  describe("OracleClient", function () {
    it("getNAV + isFresh + getMaxStaleness reflect seeded state", async function () {
      const { deployer, oracle, token } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new OracleClient(ctx, (oracle as any).target as Address);
      const tokenAddr = (await token.getAddress()) as Address;

      const { nav, updatedAt } = await client.getNAV(tokenAddr);
      expect(nav).to.equal(DEFAULT_NAV);
      expect(updatedAt).to.be.greaterThan(0n);
      expect(await client.isFresh(tokenAddr)).to.equal(true);
      expect(await client.getMaxStaleness(tokenAddr)).to.be.greaterThan(0n);
      expect(await client.getMaxDeviationBps(tokenAddr)).to.equal(25n);
    });

    it("setNAV from non-writer rejects with TxFailedError", async function () {
      const { deployer, oracle, token } = await loadFixture(deployV2IntegrationFixture);
      // Deployer is the oracle owner, not the navWriter for this token —
      // only the wired issuer may write NAV. Use deployer's client here.
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new OracleClient(ctx, (oracle as any).target as Address);
      const tokenAddr = (await token.getAddress()) as Address;

      await expect(client.setNAV(tokenAddr, 2n * ONE_PUSDC)).to.be.rejected;
    });

    it("setNAV from the wired NAV writer commits the new quote", async function () {
      const { deployer, oracle, token } = await loadFixture(deployV2IntegrationFixture);
      // Issuer (signer[1]) is the wired navWriter.
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new OracleClient(ctx, (oracle as any).target as Address);
      const tokenAddr = (await token.getAddress()) as Address;

      // ≤25 bps deviation — commits directly (no pending park).
      const fresh = DEFAULT_NAV + (DEFAULT_NAV * 20n) / 10_000n;
      await client.setNAV(tokenAddr, fresh);

      const { nav } = await client.getNAV(tokenAddr);
      expect(nav).to.equal(fresh);
    });

    it("setNAV rejects zero with ConfigError (pre-flight)", async function () {
      const { deployer, oracle, token } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new OracleClient(ctx, (oracle as any).target as Address);
      await expect(
        client.setNAV((await token.getAddress()) as Address, 0n),
      ).to.be.rejectedWith(ConfigError, /newNAV/);
    });

    it("setNAV over-deviation parks pendingNAV; acceptPendingNAV commits it", async function () {
      const { deployer, oracle, token } = await loadFixture(deployV2IntegrationFixture);
      const writerCtx = await makeContext(HARDHAT_PK_1, 1);
      const ownerCtx = await makeContext(HARDHAT_PK_0, 0);
      const writerClient = new OracleClient(writerCtx, (oracle as any).target as Address);
      const ownerClient = new OracleClient(ownerCtx, (oracle as any).target as Address);
      const tokenAddr = (await token.getAddress()) as Address;

      // 100 bps move vs 25 bps cap → parks.
      const far = DEFAULT_NAV + (DEFAULT_NAV * 100n) / 10_000n;
      await writerClient.setNAV(tokenAddr, far);

      const pending = await writerClient.getPendingNAV(tokenAddr);
      expect(pending.pendingNAV).to.equal(far);
      // The committed NAV is unchanged.
      expect((await writerClient.getNAV(tokenAddr)).nav).to.equal(DEFAULT_NAV);

      // Owner accepts → committed NAV moves to `far`.
      await ownerClient.acceptPendingNAV(tokenAddr);
      expect((await writerClient.getNAV(tokenAddr)).nav).to.equal(far);
    });
  });

  describe("IdentityRegistryClient", function () {
    it("isVerified true under devMode default", async function () {
      const { deployer, identityRegistry, alice } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new IdentityRegistryClient(
        ctx,
        (identityRegistry as any).target as Address,
      );
      expect(await client.devMode()).to.equal(true);
      expect(await client.isVerified(alice.address as Address)).to.equal(true);
    });

    it("addWhitelisted + setDevMode(false) still verifies listed accounts", async function () {
      const { deployer, identityRegistry, alice, bob } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new IdentityRegistryClient(
        ctx,
        (identityRegistry as any).target as Address,
      );
      await client.addWhitelisted([alice.address as Address, bob.address as Address]);
      await client.setDevMode(false);
      expect(await client.devMode()).to.equal(false);
      expect(await client.isVerified(alice.address as Address)).to.equal(true);
      // A fresh EOA not on the whitelist → not verified.
      const fresh = createEphemeralEOA();
      expect(await client.isVerified(fresh.address as Address)).to.equal(false);
    });

    it("addWhitelisted rejects empty list with ConfigError", async function () {
      const { deployer, identityRegistry } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new IdentityRegistryClient(
        ctx,
        (identityRegistry as any).target as Address,
      );
      await expect(client.addWhitelisted([])).to.be.rejectedWith(ConfigError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // SubscriptionClient — purchase + redeem
  // ────────────────────────────────────────────────────────────────────────

  describe("SubscriptionClient", function () {
    it("purchase: investor shares balance + treasury PUSDC move as expected", async function () {
      const { deployer, alice, subscription, token, pusdc, treasury } =
        await loadFixture(deployV2IntegrationFixture);

      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new SubscriptionClient(
        ctx,
        (subscription as any).target as Address,
      );
      const eph = createEphemeralEOA();

      const shares = 100n;
      const tokenAddr = (await token.getAddress()) as Address;

      const txHash = await client.purchase(tokenAddr, shares, HINT, eph.address as Address);
      expect(txHash).to.match(/^0x[0-9a-f]{64}$/);

      // Investor's encrypted fhERC-20 balance should be `shares`.
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(alice.address),
        shares,
      );
      // Treasury holds the equivalent PUSDC.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await treasury.getAddress()),
        shares * DEFAULT_NAV,
      );
    });

    it("purchase: rejects zero-address ephemeralEOA", async function () {
      const { deployer, subscription, token } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new SubscriptionClient(
        ctx,
        (subscription as any).target as Address,
      );
      await expect(
        client.purchase(
          (await token.getAddress()) as Address,
          10n,
          HINT,
          ZERO_ADDRESS as Address,
        ),
      ).to.be.rejectedWith(ConfigError, /ephemeralEOA/);
    });

    it("purchase: rejects shares > maxSharesHint pre-flight", async function () {
      const { deployer, subscription, token } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new SubscriptionClient(
        ctx,
        (subscription as any).target as Address,
      );
      const eph = createEphemeralEOA();
      await expect(
        client.purchase(
          (await token.getAddress()) as Address,
          HINT + 1n,
          HINT,
          eph.address as Address,
        ),
      ).to.be.rejectedWith(ConfigError, /shares/);
    });

    it("purchase then instant-redeem: PUSDC round-trips", async function () {
      const { deployer, alice, subscription, token, pusdc, treasury } =
        await loadFixture(deployV2IntegrationFixture);

      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new SubscriptionClient(
        ctx,
        (subscription as any).target as Address,
      );
      const eph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;

      await client.purchase(tokenAddr, 100n, HINT, eph.address as Address);

      // Sanity — investor has shares, treasury has PUSDC.
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(alice.address),
        100n,
      );

      // Redeem 50 shares → treasury pays back 50 PUSDC.
      await client.redeem(tokenAddr, 50n, HINT, eph.address as Address);

      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(alice.address),
        50n,
      );
      // Treasury has 100-50 = 50 PUSDC left.
      await hre.cofhe.mocks.expectPlaintext(
        await pusdc.confidentialBalanceOf(await treasury.getAddress()),
        50n * DEFAULT_NAV,
      );
    });

    it("views: getInstantCapRemaining + getCurrentEpoch return sensible values", async function () {
      const { deployer, subscription, token } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new SubscriptionClient(
        ctx,
        (subscription as any).target as Address,
      );
      const tokenAddr = (await token.getAddress()) as Address;
      expect(await client.getInstantCapRemaining(tokenAddr)).to.equal(INSTANT_CAP);
      expect(await client.getCurrentEpoch(tokenAddr)).to.be.a("bigint");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // TreasuryClient — withdraw silent-fail floor + views
  // ────────────────────────────────────────────────────────────────────────

  describe("TreasuryClient", function () {
    it("views return the initial wiring", async function () {
      const { deployer, treasury, token, issuer } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new TreasuryClient(ctx, (treasury as any).target as Address);
      expect((await client.getToken()).toLowerCase()).to.equal(
        (await token.getAddress()).toLowerCase(),
      );
      expect((await client.getIssuer()).toLowerCase()).to.equal(
        issuer.address.toLowerCase(),
      );
      expect(await client.getMinFloat()).to.equal(0n);
    });

    it("deposit + withdraw emit events (issuer-only)", async function () {
      const {
        deployer, alice, subscription, token, pusdc, treasury,
      } = await loadFixture(deployV2IntegrationFixture);

      // Fund treasury via an investor purchase.
      const investorCtx = await makeContext(HARDHAT_PK_2, 2);
      const subClient = new SubscriptionClient(
        investorCtx,
        (subscription as any).target as Address,
      );
      const eph = createEphemeralEOA();
      await subClient.purchase(
        (await token.getAddress()) as Address,
        100n,
        HINT,
        eph.address as Address,
      );

      // Issuer withdraws 10 PUSDC via the client.
      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const treasuryClient = new TreasuryClient(
        issuerCtx,
        (treasury as any).target as Address,
      );
      const issuerAddr = (await treasuryClient.getIssuer()) as Address;
      const before = await pusdc.confidentialBalanceOf(issuerAddr);
      await treasuryClient.withdraw(10n * DEFAULT_NAV);
      const after = await pusdc.confidentialBalanceOf(issuerAddr);

      // Issuer's PUSDC balance bumped by ≤ 10 * nav (silent-fail floor could
      // clip to 0 — with minFloat=0 + fully-funded treasury it will be
      // exactly 10).
      const beforeVal = await hre.cofhe.mocks.getPlaintext(before);
      const afterVal = await hre.cofhe.mocks.getPlaintext(after);
      expect(afterVal - beforeVal).to.equal(10n * DEFAULT_NAV);
    });

    it("setMinFloat + setIssuer admin writes land (issuer-only)", async function () {
      const { deployer, treasury, alice } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1); // issuer
      const client = new TreasuryClient(ctx, (treasury as any).target as Address);
      await client.setMinFloat(123n);
      expect(await client.getMinFloat()).to.equal(123n);

      // Owner rotates issuer to alice.
      const ownerCtx = await makeContext(HARDHAT_PK_0, 0);
      const ownerClient = new TreasuryClient(ownerCtx, (treasury as any).target as Address);
      await ownerClient.setIssuer(alice.address as Address);
      expect((await client.getIssuer()).toLowerCase()).to.equal(
        alice.address.toLowerCase(),
      );
    });

    it("deposit rejects zero amount with ConfigError", async function () {
      const { deployer, treasury } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new TreasuryClient(ctx, (treasury as any).target as Address);
      await expect(client.deposit(0n)).to.be.rejectedWith(ConfigError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // RedemptionQueueClient — submit + processEpoch + claim
  // ────────────────────────────────────────────────────────────────────────

  describe("RedemptionQueueClient", function () {
    it("submit → processEpoch: end-to-end single-tx payout (Phase 7.6 / ADR-043)", async function () {
      // Phase 7.6 / ADR-043: settlement collapses into processEpoch — the
      // legacy claim() round-trip is vestigial. The SDK's `claim` method
      // still ships for ABI / cutover compatibility but the cash payout
      // happens in processEpoch and any subsequent claim() reverts
      // AlreadyClaimed.
      const {
        deployer, issuer, alice, subscription, token, pusdc, queue, treasury,
      } = await loadFixture(deployV2IntegrationFixture);

      // Investor buys 100 shares so the queue has something to pull.
      const investorCtx = await makeContext(HARDHAT_PK_2, 2);
      const subClient = new SubscriptionClient(
        investorCtx,
        (subscription as any).target as Address,
      );
      const eph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;
      await subClient.purchase(tokenAddr, 100n, HINT, eph.address as Address);

      // Queue calls `token.pullFromInvestor` under the wired `onlyQueue`
      // role — no operator approval required from the investor.

      // Alice submits 30 shares to the queue.
      const queueClient = new RedemptionQueueClient(
        investorCtx,
        (queue as any).target as Address,
      );
      const { requestId } = await queueClient.submit(30n, HINT, eph.address as Address);
      expect(requestId).to.equal(1n);

      // Token balance dropped to 70; queue holds 30.
      await hre.cofhe.mocks.expectPlaintext(
        await token.encryptedBalanceOf(alice.address),
        70n,
      );

      // Snapshot pre-process Alice PUSDC balance.
      const aliceBefore = await pusdc.confidentialBalanceOf(alice.address);

      // Issuer processes the epoch through the SDK — pays cash leg in
      // the same tx (Phase 7.6).
      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const issuerQueueClient = new RedemptionQueueClient(
        issuerCtx,
        (queue as any).target as Address,
      );
      const epochRequests = await queueClient.getEpochRequests(
        await queueClient.getCurrentEpoch(),
      );
      expect(epochRequests.length).to.equal(1);
      await issuerQueueClient.processEpoch(
        await queueClient.getCurrentEpoch(),
        0n,
        BigInt(epochRequests.length),
      );

      // Post-processEpoch: settled AND claimed flipped atomically.
      const afterProcess = await queueClient.getRequest(requestId);
      expect(afterProcess.settled).to.equal(true);
      expect(afterProcess.claimed).to.equal(true);

      // Alice received the PUSDC inside processEpoch (no claim() needed).
      const aliceAfter = await pusdc.confidentialBalanceOf(alice.address);
      const beforeVal = await hre.cofhe.mocks.getPlaintext(aliceBefore);
      const afterVal = await hre.cofhe.mocks.getPlaintext(aliceAfter);
      expect(afterVal - beforeVal).to.equal(30n * DEFAULT_NAV);

      // Vestigial claim() call reverts AlreadyClaimed.
      await expect(queueClient.claim(requestId)).to.be.rejected;
    });

    it("submit rejects shares > hint pre-flight", async function () {
      const { deployer, queue } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new RedemptionQueueClient(ctx, (queue as any).target as Address);
      const eph = createEphemeralEOA();
      await expect(
        client.submit(HINT + 1n, HINT, eph.address as Address),
      ).to.be.rejectedWith(ConfigError);
    });

    it("processEpoch rejects invalid range pre-flight", async function () {
      const { deployer, queue } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new RedemptionQueueClient(ctx, (queue as any).target as Address);
      await expect(client.processEpoch(1n, 5n, 0n)).to.be.rejectedWith(ConfigError);
    });

    it("processAllEpoch paginates + resolves endIdx from the epoch request list", async function () {
      const {
        deployer, alice, bob, subscription, token, queue,
      } = await loadFixture(deployV2IntegrationFixture);

      // Two investors, two submissions into the same epoch.
      const aliceCtx = await makeContext(HARDHAT_PK_2, 2);
      const bobCtx = await makeContext(HARDHAT_PK_3, 3);
      const aliceSub = new SubscriptionClient(aliceCtx, (subscription as any).target as Address);
      const bobSub = new SubscriptionClient(bobCtx, (subscription as any).target as Address);
      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;
      await aliceSub.purchase(tokenAddr, 40n, HINT, aliceEph.address as Address);
      await bobSub.purchase(tokenAddr, 30n, HINT, bobEph.address as Address);

      const aliceQ = new RedemptionQueueClient(aliceCtx, (queue as any).target as Address);
      const bobQ = new RedemptionQueueClient(bobCtx, (queue as any).target as Address);
      await aliceQ.submit(20n, HINT, aliceEph.address as Address);
      await bobQ.submit(15n, HINT, bobEph.address as Address);

      const epoch = await aliceQ.getCurrentEpoch();
      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const issuerQ = new RedemptionQueueClient(issuerCtx, (queue as any).target as Address);

      // batchSize=1 → 2 txs covering the 2 requests, endIdx auto-resolved.
      const hashes = await issuerQ.processAllEpoch(epoch, { batchSize: 1 });
      expect(hashes).to.have.length(2);

      // Both requests marked settled.
      const ids = await issuerQ.getEpochRequests(epoch);
      for (const rid of ids) {
        expect((await issuerQ.getRequest(rid)).settled).to.equal(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // YieldSnapshotClient — open + snapshot + fund + claim + sweep
  // ────────────────────────────────────────────────────────────────────────

  describe("YieldSnapshotClient", function () {
    it("openEpoch → snapshotBatch → finalizeSnapshot → fundEpoch → claimYield", async function () {
      const {
        deployer, issuer, alice, bob, subscription, token, yieldSnapshot, pusdc,
      } = await loadFixture(deployV2IntegrationFixture);

      // Both alice + bob buy so the registry has two holders.
      const aliceCtx = await makeContext(HARDHAT_PK_2, 2);
      const bobCtx = await makeContext(HARDHAT_PK_3, 3);
      const aliceSub = new SubscriptionClient(
        aliceCtx,
        (subscription as any).target as Address,
      );
      const bobSub = new SubscriptionClient(
        bobCtx,
        (subscription as any).target as Address,
      );
      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;
      await aliceSub.purchase(tokenAddr, 60n, HINT, aliceEph.address as Address);
      await bobSub.purchase(tokenAddr, 40n, HINT, bobEph.address as Address);

      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const ysClient = new YieldSnapshotClient(
        issuerCtx,
        (yieldSnapshot as any).target as Address,
      );

      const { epochId } = await ysClient.openEpoch(tokenAddr);
      expect(epochId).to.equal(1n);

      await ysClient.snapshotBatch(epochId, [
        alice.address as Address,
        bob.address as Address,
      ]);
      const snapshotBefore = await ysClient.getEpoch(epochId);
      expect(snapshotBefore.holderCount).to.equal(2n);
      expect(snapshotBefore.finalized).to.equal(false);

      await ysClient.finalizeSnapshot(epochId);
      const snapshotFinalized = await ysClient.getEpoch(epochId);
      expect(snapshotFinalized.finalized).to.equal(true);

      // Fund with 1000 PUSDC. ratePerShare = 1000e6 / 100 = 10e6 per share.
      const totalYield = 1000n * ONE_PUSDC;
      await ysClient.fundEpoch(epochId, totalYield, totalYield / 100n);
      const funded = await ysClient.getEpoch(epochId);
      expect(funded.funded).to.equal(true);

      // Alice claims: should receive 60 * 10e6 = 600 PUSDC.
      const aliceInvestorYS = new YieldSnapshotClient(
        aliceCtx,
        (yieldSnapshot as any).target as Address,
      );
      const aliceBefore = await pusdc.confidentialBalanceOf(alice.address);
      await aliceInvestorYS.claimYield(epochId, aliceEph.address as Address);
      const aliceAfter = await pusdc.confidentialBalanceOf(alice.address);
      const aBefore = await hre.cofhe.mocks.getPlaintext(aliceBefore);
      const aAfter = await hre.cofhe.mocks.getPlaintext(aliceAfter);
      expect(aAfter - aBefore).to.equal(600n * ONE_PUSDC);

      expect(await ysClient.hasClaimed(epochId, alice.address as Address)).to.equal(true);
      expect(await ysClient.hasClaimed(epochId, bob.address as Address)).to.equal(false);
    });

    it("snapshotAll paginates a long investor list across multiple txs", async function () {
      const {
        deployer, alice, bob, subscription, token, yieldSnapshot,
      } = await loadFixture(deployV2IntegrationFixture);

      const aliceCtx = await makeContext(HARDHAT_PK_2, 2);
      const bobCtx = await makeContext(HARDHAT_PK_3, 3);
      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;
      await new SubscriptionClient(
        aliceCtx,
        (subscription as any).target as Address,
      ).purchase(tokenAddr, 10n, HINT, aliceEph.address as Address);
      await new SubscriptionClient(
        bobCtx,
        (subscription as any).target as Address,
      ).purchase(tokenAddr, 10n, HINT, bobEph.address as Address);

      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const ysClient = new YieldSnapshotClient(
        issuerCtx,
        (yieldSnapshot as any).target as Address,
      );

      const { epochId } = await ysClient.openEpoch(tokenAddr);
      // batchSize = 1 → 2 separate txs.
      const hashes = await ysClient.snapshotAll(
        epochId,
        [alice.address as Address, bob.address as Address],
        { batchSize: 1 },
      );
      expect(hashes).to.have.length(2);
      expect((await ysClient.getEpoch(epochId)).holderCount).to.equal(2n);
    });

    it("sweepExpired reclaims unclaimed PUSDC after claim window", async function () {
      const {
        deployer, alice, subscription, token, yieldSnapshot,
      } = await loadFixture(deployV2IntegrationFixture);

      const aliceCtx = await makeContext(HARDHAT_PK_2, 2);
      const aliceEph = createEphemeralEOA();
      const tokenAddr = (await token.getAddress()) as Address;
      await new SubscriptionClient(
        aliceCtx,
        (subscription as any).target as Address,
      ).purchase(tokenAddr, 50n, HINT, aliceEph.address as Address);

      const issuerCtx = await makeContext(HARDHAT_PK_1, 1);
      const ysClient = new YieldSnapshotClient(
        issuerCtx,
        (yieldSnapshot as any).target as Address,
      );

      const { epochId } = await ysClient.openEpoch(tokenAddr);
      await ysClient.snapshotBatch(epochId, [alice.address as Address]);
      await ysClient.finalizeSnapshot(epochId);
      // Single-investor 50 shares: ratePerShare = 100e6/50 = 2e6.
      await ysClient.fundEpoch(epochId, 100n * ONE_PUSDC, 2n * ONE_PUSDC);

      // Fast-forward past claimExpiry (default 365d).
      await time.increase(400 * 24 * 60 * 60);
      await ysClient.sweepExpired(epochId);
      expect(await ysClient.isSwept(epochId)).to.equal(true);
    });

    it("fundEpoch rejects zero yield pre-flight", async function () {
      const { deployer, yieldSnapshot } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new YieldSnapshotClient(
        ctx,
        (yieldSnapshot as any).target as Address,
      );
      await expect(client.fundEpoch(1n, 0n, 1n)).to.be.rejectedWith(ConfigError);
      // Phase 9.B / Option A — also rejects zero ratePerShare.
      await expect(client.fundEpoch(1n, 100n, 0n)).to.be.rejectedWith(ConfigError);
    });

    it("claimYield rejects zero ephemeralEOA pre-flight", async function () {
      const { deployer, yieldSnapshot } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_2, 2);
      const client = new YieldSnapshotClient(
        ctx,
        (yieldSnapshot as any).target as Address,
      );
      await expect(
        client.claimYield(1n, ZERO_ADDRESS as Address),
      ).to.be.rejectedWith(ConfigError);
    });

    it("snapshotAll: empty investor list is a no-op", async function () {
      const { deployer, yieldSnapshot } = await loadFixture(deployV2IntegrationFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new YieldSnapshotClient(
        ctx,
        (yieldSnapshot as any).target as Address,
      );
      expect(await client.snapshotAll(1n, [])).to.deep.equal([]);
    });
  });
});
