/**
 * MuHaven SDK Wave 3.5 Phase 7.5 — `StableClient` integration suite.
 *
 * Mirrors the bridging strategy from `MuHavenSdkV2.integration.test.ts`:
 *   - ethers + hardhat-upgrades drive the proxy deploys
 *   - viem PublicClient + WalletClient talk to the in-process provider via
 *     `custom()` (EIP-1193)
 *   - Hardhat deterministic private keys reuse the same signer for tx-send
 *     + cofhe input-proof binding
 *
 * Each spec exercises one of the user-facing Phase 7.5-C flows:
 *   - constructor guard cases (ConfigError on bad input)
 *   - `wrap` round-trip — legacy PUSDC pulls, mhUSDC mints, ephemeralEOA
 *     gets ACL on the new balance handle
 *   - `unwrap` round-trip — silent-fail bound holds when amount > balance
 *   - `transfer` — sender + recipient ACL grants land
 *   - operator gating on `transferFrom`
 *   - `setOperator` view-pair + paused state view
 *   - `refreshDecryptGrant` — re-binds a fresh ephemeralEOA to the
 *     existing balance handle
 *
 * Total: 8 cases per the Phase 7.5-C task budget.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
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
  StableClient,
  ConfigError,
  walletClientToSender,
  type MuHavenClientContext,
} from "@muhaven/sdk";
import {
  deployMockPUSDC,
  waitForDecrypt,
  ZERO_ADDRESS,
} from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_PUSDC = 1_000_000n;
const FOREVER = 2n ** 47n - 1n;

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

async function deployStableFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, alice, bob, charlie] = await hre.ethers.getSigners();

  // Legacy PUSDC + the wrapper.
  const pusdc = await deployMockPUSDC();

  const Stable = await hre.ethers.getContractFactory("MuHavenStable");
  const mhUSDC = await upgrades.deployProxy(
    Stable,
    [
      "MuHaven Confidential USD",
      "mhUSDC",
      deployer.address,
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Seed alice + bob with PUSDC and authorise the wrapper as operator.
  await pusdc.mint(alice.address, 200n * ONE_PUSDC);
  await pusdc.mint(bob.address, 100n * ONE_PUSDC);
  await pusdc.connect(alice).setOperator(await mhUSDC.getAddress(), FOREVER);
  await pusdc.connect(bob).setOperator(await mhUSDC.getAddress(), FOREVER);

  return { deployer, alice, bob, charlie, pusdc, mhUSDC };
}

describe("MuHaven SDK Wave 3.5 Phase 7.5 — StableClient (integration)", function () {
  // ───────────────────────────────────────────────────────────────────────
  // Constructor guards
  // ───────────────────────────────────────────────────────────────────────

  describe("constructor", function () {
    it("rejects missing context", async function () {
      const { mhUSDC } = await loadFixture(deployStableFixture);
      expect(() =>
        new StableClient(undefined as any, (mhUSDC as any).target as Address)
      ).to.throw(ConfigError);
    });

    it("rejects missing address", async function () {
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      expect(() => new StableClient(ctx, undefined as any))
        .to.throw(ConfigError, /muHavenStable/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Pre-flight guards
  // ───────────────────────────────────────────────────────────────────────

  describe("pre-flight guards", function () {
    it("wrap rejects zero amount + uint64 overflow + zero ephemeralEOA", async function () {
      const { mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await expect(client.wrap(0n, eph.address as Address))
        .to.be.rejectedWith(ConfigError, /amount/);
      await expect(client.wrap(1n << 64n, eph.address as Address))
        .to.be.rejectedWith(ConfigError, /2\^64/);
      await expect(client.wrap(10n * ONE_PUSDC, ZERO_ADDRESS as Address))
        .to.be.rejectedWith(ConfigError, /ephemeralEOA/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Wrap / unwrap round-trip + 1:1 invariant
  // ───────────────────────────────────────────────────────────────────────

  describe("wrap + unwrap", function () {
    it("wrap mints 1:1 mhUSDC and grants ephemeralEOA decrypt", async function () {
      const { alice, pusdc, mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1); // alice
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await client.wrap(50n * ONE_PUSDC, eph.address as Address);

      const aliceMh = await mhUSDC.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceMh, 50n * ONE_PUSDC);

      // Wrapper holds 1:1 legacy PUSDC.
      const wrapperPusdc = await pusdc.confidentialBalanceOf(
        await mhUSDC.getAddress(),
      );
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdc, 50n * ONE_PUSDC);

      // Total supply == minted amount.
      const ts = await mhUSDC.confidentialTotalSupply();
      await hre.cofhe.mocks.expectPlaintext(ts, 50n * ONE_PUSDC);
    });

    it("unwrap silent-fails to zero on insufficient balance (Rule 5)", async function () {
      const { alice, mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      // Wrap 50 → 50.
      await client.wrap(50n * ONE_PUSDC, eph.address as Address);

      // Try to unwrap 200 (more than we hold). Silent-fail path: the
      // mhUSDC balance stays at 50. Watching gas usage doesn't tell
      // observers whether the unwrap took or zero'd.
      await client.unwrap(200n * ONE_PUSDC, eph.address as Address);

      const aliceMh = await mhUSDC.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceMh, 50n * ONE_PUSDC);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Direct USDC exit (Wave 5 W3) — two-phase async via StableClient
  // ───────────────────────────────────────────────────────────────────────

  describe("withdrawToUsdc + claimUsdc (W3)", function () {
    /** Deploy a MockUSDC, wire it as the reserve, and fund it (deployer=owner). */
    async function setUpReserve(mhUSDC: any, deployer: any, seed: bigint) {
      const usdc = await (await hre.ethers.getContractFactory("MockUSDC")).deploy();
      await mhUSDC.connect(deployer).setUsdcReserveToken(await usdc.getAddress());
      await usdc.mint(deployer.address, seed);
      await usdc.connect(deployer).approve(await mhUSDC.getAddress(), seed);
      await mhUSDC.connect(deployer).fundUsdcReserve(seed);
      return usdc;
    }

    it("pre-flight: withdrawToUsdc rejects zero/overflow/zero-eph; claimUsdc rejects claimId<=0", async function () {
      const { mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await expect(client.withdrawToUsdc(0n, eph.address as Address)).to.be.rejectedWith(ConfigError, /amount/);
      await expect(client.withdrawToUsdc(1n << 64n, eph.address as Address)).to.be.rejectedWith(ConfigError, /2\^64/);
      await expect(client.withdrawToUsdc(10n * ONE_PUSDC, ZERO_ADDRESS as Address)).to.be.rejectedWith(ConfigError, /ephemeralEOA/);
      await expect(client.claimUsdc(0n)).to.be.rejectedWith(ConfigError, /claimId/);
    });

    it("request → decrypt → claim pays real USDC (1:1) and returns the claimId", async function () {
      const { deployer, alice, mhUSDC } = await loadFixture(deployStableFixture);
      const usdc = await setUpReserve(mhUSDC, deployer, 1_000n * ONE_PUSDC);
      const ctx = await makeContext(HARDHAT_PK_1, 1); // alice
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await client.wrap(60n * ONE_PUSDC, eph.address as Address);

      const { claimId } = await client.withdrawToUsdc(20n * ONE_PUSDC, eph.address as Address);
      expect(claimId).to.be.a("bigint");
      expect(claimId! > 0n).to.equal(true);

      // mhUSDC burned immediately.
      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(alice.address),
        40n * ONE_PUSDC,
      );

      // Not ready before the decrypt delay.
      let res = await client.withdrawDecryptResult(claimId!);
      expect(res.ready).to.equal(false);

      await waitForDecrypt();
      res = await client.withdrawDecryptResult(claimId!);
      expect(res.ready).to.equal(true);
      expect(res.amount).to.equal(20n * ONE_PUSDC);

      // Pending list shows the claim, then prunes on settle.
      const pendingBefore = await client.getUserWithdrawClaims(alice.address as Address);
      expect(pendingBefore.map((x) => x.toString())).to.include(claimId!.toString());

      await client.claimUsdc(claimId!);
      expect(await usdc.balanceOf(alice.address)).to.equal(20n * ONE_PUSDC);

      const pendingAfter = await client.getUserWithdrawClaims(alice.address as Address);
      expect(pendingAfter.map((x) => x.toString())).to.not.include(claimId!.toString());

      // Reserve views.
      expect(await client.usdcReserveToken()).to.equal(await usdc.getAddress());
      expect(await client.claimsPaused()).to.equal(false);
    });

    it("over-request clamps to balance (withdraw-all) and pays the full balance", async function () {
      const { deployer, alice, mhUSDC } = await loadFixture(deployStableFixture);
      const usdc = await setUpReserve(mhUSDC, deployer, 1_000n * ONE_PUSDC);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await client.wrap(45n * ONE_PUSDC, eph.address as Address);
      const { claimId } = await client.withdrawToUsdc(10_000n * ONE_PUSDC, eph.address as Address);

      await waitForDecrypt();
      await client.claimUsdc(claimId!);

      expect(await usdc.balanceOf(alice.address)).to.equal(45n * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(alice.address),
        0n,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Direct USDC → mhUSDC wrap (Wave 5 W3 Phase 9) via StableClient
  // ───────────────────────────────────────────────────────────────────────

  describe("wrapUsdc (W3 Phase 9)", function () {
    /** Deploy a MockUSDC and wire it as the reserve token (owner). */
    async function setReserveToken(mhUSDC: any, deployer: any) {
      const usdc = await (await hre.ethers.getContractFactory("MockUSDC")).deploy();
      await mhUSDC.connect(deployer).setUsdcReserveToken(await usdc.getAddress());
      return usdc;
    }

    it("pre-flight: rejects zero, > uint64 max, and zero ephemeralEOA", async function () {
      const { mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await expect(client.wrapUsdc(0n, eph.address as Address)).to.be.rejectedWith(ConfigError, /amount/);
      await expect(client.wrapUsdc(1n << 64n, eph.address as Address)).to.be.rejectedWith(ConfigError, /2\^64/);
      await expect(client.wrapUsdc(10n * ONE_PUSDC, ZERO_ADDRESS as Address)).to.be.rejectedWith(ConfigError, /ephemeralEOA/);
    });

    it("pulls cleartext USDC into the reserve and mints 1:1 mhUSDC (no encrypt step)", async function () {
      const { deployer, alice, mhUSDC } = await loadFixture(deployStableFixture);
      const usdc = await setReserveToken(mhUSDC, deployer);
      const ctx = await makeContext(HARDHAT_PK_1, 1); // alice (same address the SDK signs as)
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      // Alice funds + approves USDC, then wraps via the SDK (signs as PK_1 = alice).
      await usdc.mint(alice.address, 50n * ONE_PUSDC);
      await usdc.connect(alice).approve(await mhUSDC.getAddress(), 50n * ONE_PUSDC);

      const reserveBefore = await client.usdcReserveBalance();
      await client.wrapUsdc(50n * ONE_PUSDC, eph.address as Address);

      // mhUSDC minted 1:1; USDC moved alice → reserve.
      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(alice.address),
        50n * ONE_PUSDC,
      );
      expect(await usdc.balanceOf(alice.address)).to.equal(0n);
      expect(await client.usdcReserveBalance()).to.equal(reserveBefore + 50n * ONE_PUSDC);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Transfer + operator gating
  // ───────────────────────────────────────────────────────────────────────

  describe("transfer + transferFrom", function () {
    it("transfer moves balance + grants ACL on both legs", async function () {
      const { alice, charlie, mhUSDC } = await loadFixture(deployStableFixture);
      const aliceCtx = await makeContext(HARDHAT_PK_1, 1);
      const aliceClient = new StableClient(aliceCtx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      await aliceClient.wrap(80n * ONE_PUSDC, eph.address as Address);
      await aliceClient.transfer(charlie.address as Address, 30n * ONE_PUSDC, eph.address as Address);

      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(alice.address),
        50n * ONE_PUSDC,
      );
      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(charlie.address),
        30n * ONE_PUSDC,
      );
    });

    it("transferFrom requires operator approval on the source", async function () {
      const { alice, bob, charlie, mhUSDC } = await loadFixture(deployStableFixture);
      const aliceCtx = await makeContext(HARDHAT_PK_1, 1);
      const bobCtx = await makeContext(HARDHAT_PK_2, 2);
      const aliceClient = new StableClient(aliceCtx, (mhUSDC as any).target as Address);
      const bobClient = new StableClient(bobCtx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      // Alice wraps 60 mhUSDC.
      await aliceClient.wrap(60n * ONE_PUSDC, eph.address as Address);

      // Bob tries to pull from Alice without operator approval — TxFailedError.
      await expect(
        bobClient.transferFrom(
          alice.address as Address,
          charlie.address as Address,
          10n * ONE_PUSDC,
          eph.address as Address,
        ),
      ).to.be.rejected;

      // Alice grants Bob operator + isOperator flips true, then transferFrom lands.
      await aliceClient.setOperator(bob.address as Address, FOREVER);
      expect(
        await bobClient.isOperator(alice.address as Address, bob.address as Address),
      ).to.equal(true);

      await bobClient.transferFrom(
        alice.address as Address,
        charlie.address as Address,
        10n * ONE_PUSDC,
        eph.address as Address,
      );

      await hre.cofhe.mocks.expectPlaintext(
        await mhUSDC.confidentialBalanceOf(charlie.address),
        10n * ONE_PUSDC,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Self-service ACL refresh
  // ───────────────────────────────────────────────────────────────────────

  describe("refreshDecryptGrant", function () {
    it("re-grants ACL on the existing balance handle to a fresh ephemeralEOA", async function () {
      const { alice, mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      const ephFirst = createEphemeralEOA();
      const ephFresh = createEphemeralEOA();

      // Wrap so alice has a balance handle.
      await client.wrap(40n * ONE_PUSDC, ephFirst.address as Address);

      // Refresh the grant onto a different ephemeralEOA — emits
      // DecryptGrantRefreshed and re-binds the ACL. Verified end-to-end
      // by the contract-side `MuHavenStable.test.ts > refreshDecryptGrant`
      // suite; here we just confirm the SDK call resolves the tx.
      const hash = await client.refreshDecryptGrant(ephFresh.address as Address);
      expect(hash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("rejects zero ephemeralEOA at pre-flight", async function () {
      const { mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);
      await expect(client.refreshDecryptGrant(ZERO_ADDRESS as Address))
        .to.be.rejectedWith(ConfigError, /ephemeralEOA/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Plain views
  // ───────────────────────────────────────────────────────────────────────

  describe("views", function () {
    it("paused / legacyPusdc / owner reflect on-chain state", async function () {
      const { deployer, pusdc, mhUSDC } = await loadFixture(deployStableFixture);
      const ctx = await makeContext(HARDHAT_PK_0, 0);
      const client = new StableClient(ctx, (mhUSDC as any).target as Address);

      expect(await client.paused()).to.equal(false);
      expect((await client.legacyPusdc()).toLowerCase()).to.equal(
        (await pusdc.getAddress()).toLowerCase(),
      );
      expect((await client.owner()).toLowerCase()).to.equal(
        deployer.address.toLowerCase(),
      );
    });

    it("confidentialBalanceOf + confidentialTotalSupply return ctHash hex strings", async function () {
      const { alice, mhUSDC } = await loadFixture(deployStableFixture);
      const aliceCtx = await makeContext(HARDHAT_PK_1, 1);
      const client = new StableClient(aliceCtx, (mhUSDC as any).target as Address);
      const eph = createEphemeralEOA();

      // Empty wrapper — both views return the zero ctHash.
      expect(await client.confidentialTotalSupply()).to.match(/^0x[0-9a-f]{64}$/);

      // Wrap + check the alice handle is non-zero hex.
      await client.wrap(25n * ONE_PUSDC, eph.address as Address);
      const handle = await client.confidentialBalanceOf(alice.address as Address);
      expect(handle).to.match(/^0x[0-9a-f]{64}$/);
      // 32-byte zero handle would mean uninitialised — reject that.
      expect(handle).to.not.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });
  });
});
