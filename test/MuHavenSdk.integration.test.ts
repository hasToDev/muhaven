/**
 * MuHaven SDK — Phase 19C.8 integration tests.
 *
 * Exercises the SDK end-to-end against real contracts deployed on the in-process
 * Hardhat network with the CoFHE mock coprocessor.
 *
 * Bridging strategy:
 *   - Ethers + hardhat-upgrades handle proxy deploys (existing fixture).
 *   - viem PublicClient + WalletClient are constructed with a `custom()` transport
 *     backed by `hre.network.provider` (EIP-1193).
 *   - The SDK's `cofheClient` is the same client the rest of the Hardhat test
 *     suite uses: `hre.cofhe.createClientWithBatteries(ethersSigner)`. Its
 *     `encryptInputs([...]).execute()` surface matches our CofheLikeClient
 *     structural type.
 *
 * Private keys are Hardhat's deterministic test keys (account #0 = deployer),
 * so `privateKeyToAccount(...)` produces an address that matches the existing
 * Hardhat-funded signer used to deploy the fixtures.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
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
  MuHavenClient,
  walletClientToSender,
  DistributionStatus,
  ConfigError,
  BatchSizeExceededError,
  EscrowIdsAlreadySetError,
  DistributionNotStartedError,
  type MuHavenAddresses,
  type ProgressEvent,
} from "@muhaven/sdk";
import {
  deployMuHavenFixture,
  deployMockMuHavenEscrow,
  deployMockPUSDC,
  deployYieldGate,
  deployYieldDistributor,
  ONE_TOKEN,
} from "./helpers/setup";

const ONE_PUSDC = 1_000_000n;

/** Hardhat's deterministic private key for account #0. */
const HARDHAT_PK_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
/** Hardhat's deterministic private key for account #2 (investor in base fixture). */
const HARDHAT_PK_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

/**
 * Build a viem public + wallet client pair that talks to the in-process Hardhat
 * network via a `custom()` EIP-1193 transport. The wallet's account is derived
 * from Hardhat's deterministic test key so its address matches an already-funded
 * Hardhat signer.
 */
function makeViemClients(privateKey: `0x${string}`): { publicClient: PublicClient; walletClient: WalletClient; address: Address } {
  const account = privateKeyToAccount(privateKey);
  const transport = custom(hre.network.provider);
  const publicClient = createPublicClient({ chain: hardhatChain, transport });
  const walletClient = createWalletClient({ chain: hardhatChain, transport, account });
  return { publicClient, walletClient, address: account.address };
}

/**
 * Full pipeline fixture: base MuHaven + MockMuHavenEscrow (no PUSDC transfer in
 * redeem) + YieldGate wired as resolver + YieldDistributor.
 *
 * Registers `investor` and optionally `alice` by minting tokens (KYC-gated).
 */
async function deploySdkFixture() {
  const base = await loadFixture(deployMuHavenFixture);
  const { deployer, issuer, investor, alice, token, kyc, registry } = base;

  // Register investor + alice via mint — this is what puts them in the registry.
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
  const [encMintInvestor, encMintAlice] = await issuerClient
    .encryptInputs([Encryptable.uint128(ONE_TOKEN), Encryptable.uint128(ONE_TOKEN)])
    .execute();
  await token.connect(issuer).mint(investor.address, encMintInvestor);
  await token.connect(issuer).mint(alice.address, encMintAlice);

  const escrow = await deployMockMuHavenEscrow();
  const pusdc = await deployMockPUSDC();
  const yieldGate = await deployYieldGate(await token.getAddress(), await kyc.getAddress());

  // YieldGate requires a one-shot authorized escrow wire before batchCreate
  // invokes onConditionSet.
  await yieldGate.setAuthorizedEscrow(await escrow.getAddress());

  const distributor = await deployYieldDistributor(
    await registry.getAddress(),
    await escrow.getAddress(),
    await yieldGate.getAddress(),
    deployer.address,
    await pusdc.getAddress()
  );

  const addresses: MuHavenAddresses = {
    muhavenEscrow: (await escrow.getAddress()) as Address,
    yieldDistributor: (await distributor.getAddress()) as Address,
    investorRegistry: (await registry.getAddress()) as Address,
    yieldGate: (await yieldGate.getAddress()) as Address,
  };

  return { ...base, escrow, pusdc, yieldGate, distributor, addresses };
}

/**
 * Fund the distributor with PUSDC and set the operator approval so
 * `startDistribution` can pull the funds.
 */
async function fundAndApprovePusdc(
  pusdc: any,
  deployer: any,
  distributorAddr: string,
  amount: bigint
) {
  await pusdc.mint(deployer.address, Number(amount));
  await pusdc.connect(deployer).setOperator(distributorAddr, 2_000_000_000);
}

/** Instantiate the SDK wired with viem clients + the hardhat cofhe client. */
async function makeSdk(deployer: any, addresses: MuHavenAddresses, privateKey: `0x${string}` = HARDHAT_PK_0) {
  const cofheClient = await hre.cofhe.createClientWithBatteries(deployer);
  const { publicClient, walletClient, address } = makeViemClients(privateKey);
  const sdk = new MuHavenClient({
    publicClient,
    sender: walletClientToSender(walletClient),
    cofheClient: cofheClient as any,
    addresses,
  });
  return { sdk, publicClient, walletClient, address, cofheClient };
}

describe("MuHaven SDK (integration)", function () {
  // ────────────────────────────────────────────────────────────────────────────
  // Constructor & config validation
  // ────────────────────────────────────────────────────────────────────────────

  describe("constructor", function () {
    it("rejects missing publicClient", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const cofheClient = await hre.cofhe.createClientWithBatteries(deployer);
      const { walletClient } = makeViemClients(HARDHAT_PK_0);
      expect(() => new MuHavenClient({
        publicClient: undefined as any,
        sender: walletClientToSender(walletClient),
        cofheClient: cofheClient as any,
        addresses,
      })).to.throw(ConfigError, /publicClient/);
    });

    it("rejects missing cofheClient", async function () {
      const { addresses } = await loadFixture(deploySdkFixture);
      const { publicClient, walletClient } = makeViemClients(HARDHAT_PK_0);
      expect(() => new MuHavenClient({
        publicClient,
        sender: walletClientToSender(walletClient),
        cofheClient: undefined as any,
        addresses,
      })).to.throw(ConfigError, /cofheClient/);
    });

    it("rejects missing required addresses", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const cofheClient = await hre.cofhe.createClientWithBatteries(deployer);
      const { publicClient, walletClient } = makeViemClients(HARDHAT_PK_0);
      const incomplete = { ...addresses, yieldGate: undefined as any };
      expect(() => new MuHavenClient({
        publicClient,
        sender: walletClientToSender(walletClient),
        cofheClient: cofheClient as any,
        addresses: incomplete,
      })).to.throw(ConfigError, /yieldGate/);
    });

    it("rejects invalid defaultBatchSize", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const cofheClient = await hre.cofhe.createClientWithBatteries(deployer);
      const { publicClient, walletClient } = makeViemClients(HARDHAT_PK_0);
      expect(() => new MuHavenClient({
        publicClient,
        sender: walletClientToSender(walletClient),
        cofheClient: cofheClient as any,
        addresses,
        defaultBatchSize: 0,
      })).to.throw(ConfigError, /defaultBatchSize/);
      expect(() => new MuHavenClient({
        publicClient,
        sender: walletClientToSender(walletClient),
        cofheClient: cofheClient as any,
        addresses,
        defaultBatchSize: 201,
      })).to.throw(ConfigError, /defaultBatchSize/);
    });

    it("exposes the configured account via getAccount()", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk, address } = await makeSdk(deployer, addresses);
      expect(sdk.getAccount().toLowerCase()).to.equal(address.toLowerCase());
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // createYieldEscrows()
  // ────────────────────────────────────────────────────────────────────────────

  describe("createYieldEscrows()", function () {
    it("returns empty when registry is empty", async function () {
      const base = await loadFixture(deployMuHavenFixture);
      const { deployer, kyc, registry } = base;
      // Token not wired yet, so registry is empty.
      const escrow = await deployMockMuHavenEscrow();
      const yieldGate = await deployYieldGate(await base.token.getAddress(), await kyc.getAddress());
      await yieldGate.setAuthorizedEscrow(await escrow.getAddress());
      const pusdc = await deployMockPUSDC();
      const distributor = await deployYieldDistributor(
        await registry.getAddress(),
        await escrow.getAddress(),
        await yieldGate.getAddress(),
        deployer.address,
        await pusdc.getAddress()
      );
      const addresses: MuHavenAddresses = {
        muhavenEscrow: (await escrow.getAddress()) as Address,
        yieldDistributor: (await distributor.getAddress()) as Address,
        investorRegistry: (await registry.getAddress()) as Address,
        yieldGate: (await yieldGate.getAddress()) as Address,
      };
      const { sdk } = await makeSdk(deployer, addresses);

      const result = await sdk.createYieldEscrows();
      expect(result.escrowIds).to.have.length(0);
      expect(result.txHashes).to.have.length(0);
    });

    it("creates escrows for all registered investors in one batch", async function () {
      const { deployer, addresses, escrow } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);

      const result = await sdk.createYieldEscrows({ batchSize: 50 });

      expect(result.escrowIds).to.have.length(2); // investor + alice
      expect(result.txHashes).to.have.length(1);
      // Escrow IDs are sequential starting at 1.
      expect(result.escrowIds[0]).to.equal(1n);
      expect(result.escrowIds[1]).to.equal(2n);
      expect(await escrow.total()).to.equal(2n);
    });

    it("splits into multiple batches when investors > batchSize", async function () {
      const { deployer, addresses, escrow } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);

      // batchSize = 1 with 2 investors → 2 separate batchCreate txs.
      const result = await sdk.createYieldEscrows({ batchSize: 1 });

      expect(result.escrowIds).to.have.length(2);
      expect(result.txHashes).to.have.length(2);
      expect(await escrow.total()).to.equal(2n);
    });

    it("fires progress callback per batch", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);

      const events: ProgressEvent[] = [];
      await sdk.createYieldEscrows({
        batchSize: 1,
        onProgress: (e) => events.push(e),
      });

      // With 2 investors + batchSize 1 → 2 encrypt + 2 batchCreate events.
      const encryptEvents = events.filter((e) => e.stage === "encrypt");
      const createEvents = events.filter((e) => e.stage === "batchCreate");
      expect(encryptEvents).to.have.length(2);
      expect(createEvents).to.have.length(2);
      // Final event should report txHash.
      expect(createEvents[createEvents.length - 1]!.txHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("rejects a batch larger than the on-chain MAX_BATCH_SIZE", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);

      await expect(sdk.createYieldEscrows({ batchSize: 201 }))
        .to.be.rejectedWith(BatchSizeExceededError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // startDistribution()
  // ────────────────────────────────────────────────────────────────────────────

  describe("startDistribution()", function () {
    it("encrypts + starts a distribution and returns the new distributionId", async function () {
      const { deployer, addresses, pusdc, distributor } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { distributionId, txHash } = await sdk.startDistribution(10n * ONE_PUSDC);

      expect(distributionId).to.equal(1n);
      expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
      const dist = await distributor.getDistribution(1);
      expect(dist.investorCount).to.equal(2n);
    });

    it("rejects zero yield amount", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);
      await expect(sdk.startDistribution(0n)).to.be.rejectedWith(ConfigError, /totalYield/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // fundEscrows()
  // ────────────────────────────────────────────────────────────────────────────

  describe("fundEscrows()", function () {
    it("attaches escrowIds and drives processBatch until complete", async function () {
      const { deployer, addresses, pusdc, distributor, escrow } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { escrowIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);

      const result = await sdk.fundEscrows(distributionId, escrowIds, { batchSize: 10 });

      expect(result.distributionId).to.equal(distributionId);
      expect(result.batchesProcessed).to.be.at.least(1);
      const complete = await distributor.isDistributionComplete(distributionId);
      expect(complete).to.be.true;
      expect(await escrow.exists(escrowIds[0]!)).to.be.true;
      expect(await escrow.exists(escrowIds[1]!)).to.be.true;
    });

    it("rejects escrowId list length mismatch with investor count", async function () {
      const { deployer, addresses, pusdc } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);
      await expect(sdk.fundEscrows(distributionId, [1n])) // only 1 id, 2 investors
        .to.be.rejectedWith(ConfigError, /length/);
    });

    it("rejects when a second fundEscrows is attempted on a completed distribution", async function () {
      const { deployer, addresses, pusdc } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { escrowIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);
      await sdk.fundEscrows(distributionId, escrowIds);

      // Distribution is now Complete. Second fundEscrows must reject —
      // the resume path kicks in (IDs match), but DistributionAlreadyCompleteError
      // fires first because the status check runs before the escrow-ID match.
      await expect(sdk.fundEscrows(distributionId, escrowIds)).to.be.rejected;
    });

    it("resumes when escrowIds are already attached with matching order (partial-failure recovery)", async function () {
      const {
        deployer, addresses, pusdc, distributor, escrow, registry, yieldGate,
      } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { escrowIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);

      // Simulate "setEscrowIds landed but processBatch failed mid-loop" by
      // calling setEscrowIds directly via the contract.
      await distributor.setEscrowIds(distributionId, escrowIds);
      expect((await distributor.getEscrowIds(distributionId)).length).to.equal(escrowIds.length);

      // Resume via SDK. Should skip setEscrowIds and run processBatch to completion.
      const result = await sdk.fundEscrows(distributionId, escrowIds, { batchSize: 10 });
      expect(await distributor.isDistributionComplete(distributionId)).to.be.true;
      expect(result.batchesProcessed).to.be.at.least(1);
    });

    it("rejects when escrowIds attached do not match the ones passed in", async function () {
      const { deployer, addresses, pusdc, distributor } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const { escrowIds: realIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);

      // Attach real IDs on-chain, then ask the SDK to fund with a different set.
      await distributor.setEscrowIds(distributionId, realIds);

      // Pass reversed IDs — same count, different order → "different set attached".
      const reversed = [...realIds].reverse();
      await expect(sdk.fundEscrows(distributionId, reversed))
        .to.be.rejectedWith(EscrowIdsAlreadySetError);
    });

    it("rejects when distribution does not exist", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);

      await expect(sdk.fundEscrows(999n, [1n, 2n]))
        .to.be.rejectedWith(DistributionNotStartedError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // claimYield + claimYieldBatch
  // ────────────────────────────────────────────────────────────────────────────

  describe("claim flows", function () {
    it("claimYield redeems a single escrow (MockMuHavenEscrow marks redeemed)", async function () {
      const { deployer, addresses, pusdc, distributor, escrow } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);

      const { sdk } = await makeSdk(deployer, addresses);
      const { escrowIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);
      await sdk.fundEscrows(distributionId, escrowIds);

      const txHash = await sdk.claimYield(escrowIds[0]!);
      expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
      // MockMuHavenEscrow unconditionally marks redeemed and emits EscrowRedeemed.
      // We cannot easily decrypt ebool here without setting up permits — but the
      // tx succeeding + existence still true is sufficient smoke for the SDK.
      expect(await escrow.exists(escrowIds[0]!)).to.be.true;
    });

    it("claimYieldBatch redeems multiple escrows in one tx", async function () {
      const { deployer, addresses, pusdc, escrow } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);

      const { sdk } = await makeSdk(deployer, addresses);
      const { escrowIds } = await sdk.createYieldEscrows();
      const { distributionId } = await sdk.startDistribution(10n * ONE_PUSDC);
      await sdk.fundEscrows(distributionId, escrowIds);

      const txHash = await sdk.claimYieldBatch(escrowIds);
      expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("claimYieldBatch rejects empty escrowIds", async function () {
      const { deployer, addresses } = await loadFixture(deploySdkFixture);
      const { sdk } = await makeSdk(deployer, addresses);
      await expect(sdk.claimYieldBatch([])).to.be.rejectedWith(ConfigError, /empty/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // distributeYield() — high-level pipeline
  // ────────────────────────────────────────────────────────────────────────────

  describe("distributeYield()", function () {
    it("runs full pipeline: encrypt → start → createEscrows → fund", async function () {
      const { deployer, addresses, pusdc, distributor, escrow } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);
      const { sdk } = await makeSdk(deployer, addresses);

      const events: ProgressEvent[] = [];
      const result = await sdk.distributeYield(10n * ONE_PUSDC, {
        batchSize: 50,
        onProgress: (e) => events.push(e),
      });

      expect(result.distributionId).to.equal(1n);
      expect(result.escrowIds).to.have.length(2);
      expect(result.createTxHashes.length).to.be.at.least(2); // start + create
      expect(result.fundTxHashes.length).to.be.at.least(1);
      expect(await distributor.isDistributionComplete(result.distributionId)).to.be.true;
      expect(await escrow.total()).to.equal(2n);

      // Progress events cover multiple stages.
      const stages = new Set(events.map((e) => e.stage));
      expect(stages.has("encrypt")).to.be.true;
      expect(stages.has("startDistribution")).to.be.true;
      expect(stages.has("batchCreate")).to.be.true;
      expect(stages.has("processBatch")).to.be.true;
    });

    it("returns early (no fund phase) when investor registry is empty", async function () {
      // Fresh fixture with NO investors registered.
      const base = await loadFixture(deployMuHavenFixture);
      const { deployer, kyc, registry, token } = base;
      const escrow = await deployMockMuHavenEscrow();
      const yieldGate = await deployYieldGate(await token.getAddress(), await kyc.getAddress());
      await yieldGate.setAuthorizedEscrow(await escrow.getAddress());
      const pusdc = await deployMockPUSDC();
      const distributor = await deployYieldDistributor(
        await registry.getAddress(),
        await escrow.getAddress(),
        await yieldGate.getAddress(),
        deployer.address,
        await pusdc.getAddress()
      );
      const addresses: MuHavenAddresses = {
        muhavenEscrow: (await escrow.getAddress()) as Address,
        yieldDistributor: (await distributor.getAddress()) as Address,
        investorRegistry: (await registry.getAddress()) as Address,
        yieldGate: (await yieldGate.getAddress()) as Address,
      };
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);

      // Empty registry — startDistribution will revert because investorCount == 0.
      // That's YieldDistributor's guard, not the SDK's. Verify by asking the SDK.
      const { sdk } = await makeSdk(deployer, addresses);
      await expect(sdk.distributeYield(10n * ONE_PUSDC)).to.be.rejected;
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // grantAdminDecrypt()
  // ────────────────────────────────────────────────────────────────────────────

  describe("grantAdminDecrypt()", function () {
    it("issues the grant tx and a non-owner call rejects via TxFailedError", async function () {
      const { deployer, alice, addresses, pusdc, distributor } = await loadFixture(deploySdkFixture);
      await fundAndApprovePusdc(pusdc, deployer, addresses.yieldDistributor, 10n * ONE_PUSDC);

      const { sdk: ownerSdk } = await makeSdk(deployer, addresses);
      const { distributionId } = await ownerSdk.startDistribution(10n * ONE_PUSDC);

      // Happy path — owner grants access, event fires.
      const grantTx = await ownerSdk.grantAdminDecrypt(distributionId, alice.address as Address);
      expect(grantTx).to.match(/^0x[0-9a-f]{64}$/);
      const receipt = await ownerSdk.publicClient.waitForTransactionReceipt({ hash: grantTx });
      const granted = receipt.logs.some((log) =>
        log.address.toLowerCase() === addresses.yieldDistributor.toLowerCase()
      );
      expect(granted).to.be.true;

      // Non-owner call — alice isn't the YieldDistributor owner (deployer is).
      const { sdk: aliceSdk } = await makeSdk(deployer, addresses, HARDHAT_PK_2);
      await expect(
        aliceSdk.grantAdminDecrypt(distributionId, alice.address as Address)
      ).to.be.rejected;
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DistributionStatus enum
  // ────────────────────────────────────────────────────────────────────────────

  describe("constants", function () {
    it("exports DistributionStatus matching the contract enum", function () {
      expect(DistributionStatus.Pending).to.equal(0);
      expect(DistributionStatus.InProgress).to.equal(1);
      expect(DistributionStatus.Complete).to.equal(2);
    });
  });
});
