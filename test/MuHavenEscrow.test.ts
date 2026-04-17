import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import {
  deployEscrowFixture,
  deployMuHavenEscrow,
  deployYieldGate,
  deployMockPUSDC,
  deployTestEscrowFunder,
  deployTestCanRedeemChecker,
  ZERO_ADDRESS,
  ONE_TOKEN,
} from "./helpers/setup";

/// @dev PUSDC has 6 decimals. 1 PUSDC = 1_000_000 units.
const ONE_PUSDC = 1_000_000n;

/// @dev Encode abi.encode(address) resolverData payload for YieldGate.
function encodeBeneficiary(addr: string): string {
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]);
}

describe("MuHavenEscrow", function () {
  // ────────────────────────────────────────────────────────────────────────────
  // initialize()
  // ────────────────────────────────────────────────────────────────────────────

  describe("initialize()", function () {
    it("sets contractOwner and paymentToken", async function () {
      const { escrow, pusdc, deployer } = await loadFixture(deployEscrowFixture);
      expect(await escrow.contractOwner()).to.equal(deployer.address);
      expect(await escrow.paymentToken()).to.equal(await pusdc.getAddress());
    });

    it("allows zero paymentToken at construction (set later)", async function () {
      const { deployer } = await loadFixture(deployEscrowFixture);
      const escrow = await deployMuHavenEscrow(deployer.address, ZERO_ADDRESS);
      expect(await escrow.paymentToken()).to.equal(ZERO_ADDRESS);
    });

    it("reverts on zero owner", async function () {
      await expect(deployMuHavenEscrow(ZERO_ADDRESS, ZERO_ADDRESS))
        .to.be.reverted;
    });

    it("cannot be re-initialized", async function () {
      const { escrow, deployer, pusdc } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.initialize(deployer.address, await pusdc.getAddress())
      ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // batchCreate()
  // ────────────────────────────────────────────────────────────────────────────

  describe("batchCreate()", function () {
    it("creates a single escrow with sequential ID starting at 1", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);

      expect(await escrow.total()).to.equal(1n);
      expect(await escrow.exists(1)).to.be.true;
      expect(await escrow.exists(2)).to.be.false;
    });

    it("creates multiple escrows with sequential IDs", async function () {
      const { escrow, yieldGate, investor, alice, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encA, encB] = await client
        .encryptInputs([Encryptable.address(investor.address), Encryptable.address(alice.address)])
        .execute();

      await escrow.batchCreate(
        [encA, encB],
        await yieldGate.getAddress(),
        [encodeBeneficiary(investor.address), encodeBeneficiary(alice.address)]
      );

      expect(await escrow.total()).to.equal(2n);
      expect(await escrow.exists(1)).to.be.true;
      expect(await escrow.exists(2)).to.be.true;
    });

    it("returns the array of newly-assigned escrow IDs in order", async function () {
      const { escrow, yieldGate, investor, alice, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encA, encB] = await client
        .encryptInputs([Encryptable.address(investor.address), Encryptable.address(alice.address)])
        .execute();

      // staticCall to capture return value without committing state
      const ids = await escrow.batchCreate.staticCall(
        [encA, encB],
        await yieldGate.getAddress(),
        [encodeBeneficiary(investor.address), encodeBeneficiary(alice.address)]
      );
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(1n);
      expect(ids[1]).to.equal(2n);
    });

    it("stores the encrypted owner decryptable to msg.sender's address", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);

      const storedOwner = await escrow.getOwner(1);
      // eaddress plaintext is the uint160 of the address
      await hre.cofhe.mocks.expectPlaintext(storedOwner, BigInt(investor.address));
    });

    it("emits EscrowCreated with only escrowId + resolver (NO beneficiary)", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await expect(
        escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)])
      )
        .to.emit(escrow, "EscrowCreated")
        .withArgs(1n, await yieldGate.getAddress());
    });

    it("calls resolver.onConditionSet for each escrow", async function () {
      const { escrow, yieldGate, investor, alice, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encA, encB] = await client
        .encryptInputs([Encryptable.address(investor.address), Encryptable.address(alice.address)])
        .execute();

      const tx = escrow.batchCreate(
        [encA, encB],
        await yieldGate.getAddress(),
        [encodeBeneficiary(investor.address), encodeBeneficiary(alice.address)]
      );
      // Each escrow emits one ConditionSet on the gate
      await expect(tx).to.emit(yieldGate, "ConditionSet").withArgs(1n);
      await expect(tx).to.emit(yieldGate, "ConditionSet").withArgs(2n);
    });

    it("reverts on zero resolver", async function () {
      const { escrow, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await expect(
        escrow.batchCreate([encOwner], ZERO_ADDRESS, [encodeBeneficiary(investor.address)])
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("reverts on empty batch", async function () {
      const { escrow, yieldGate } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow.batchCreate([], await yieldGate.getAddress(), [])
      ).to.be.revertedWithCustomError(escrow, "EmptyBatch");
    });

    it("reverts on length mismatch between owners and resolverData", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await expect(
        escrow.batchCreate([encOwner], await yieldGate.getAddress(), [])
      ).to.be.revertedWithCustomError(escrow, "LengthMismatch");
    });

    it("reverts when caller is not authorized", async function () {
      const { escrow, yieldGate, investor, alice } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(alice);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await expect(
        escrow
          .connect(alice)
          .batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)])
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("reverts BatchTooLarge when owners.length > MAX_BATCH_SIZE", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      // The BatchTooLarge check runs before FHE.asEaddress(), so we can reuse
      // the same encrypted handle 201 times. (Encrypting 201 unique addresses
      // would exceed the CoFHE SDK's per-call bit limit of 2048.)
      const [encOne] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      const encOwners = Array(201).fill(encOne);
      const data = Array(201).fill(encodeBeneficiary(investor.address));
      await expect(
        escrow.batchCreate(encOwners, await yieldGate.getAddress(), data)
      ).to.be.revertedWithCustomError(escrow, "BatchTooLarge");
    });

    it("reverts ResolverCallbackFailed when resolver callback reverts", async function () {
      // Use a gate whose authorizedEscrow is NOT set — onConditionSet reverts AuthorizedEscrowNotSet
      const { investor, deployer, token, kyc } = await loadFixture(deployEscrowFixture);
      const unwiredGate = await deployYieldGate(await token.getAddress(), await kyc.getAddress());
      const pusdc = await deployMockPUSDC();
      const standaloneEscrow = await deployMuHavenEscrow(deployer.address, await pusdc.getAddress());
      await standaloneEscrow.setAuthorizedCaller(deployer.address, true);

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await expect(
        standaloneEscrow.batchCreate(
          [encOwner],
          await unwiredGate.getAddress(),
          [encodeBeneficiary(investor.address)]
        )
      ).to.be.revertedWithCustomError(standaloneEscrow, "ResolverCallbackFailed");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // fundFrom()
  // ────────────────────────────────────────────────────────────────────────────

  describe("fundFrom()", function () {
    async function createFundedEscrow() {
      const ctx = await loadFixture(deployEscrowFixture);
      const { escrow, yieldGate, investor, deployer, funder } = ctx;
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);
      return ctx;
    }

    it("sets paidAmount on first fund", async function () {
      const { escrow, funder, deployer } = await createFundedEscrow();
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const amount = 3n * ONE_PUSDC;
      const [encAmount] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();

      await funder.fundEscrow(await escrow.getAddress(), 1, encAmount);

      const paid = await escrow.getPaidAmount(1);
      await hre.cofhe.mocks.expectPlaintext(paid, amount);
    });

    it("accumulates paidAmount across multiple funds", async function () {
      const { escrow, funder, deployer } = await createFundedEscrow();
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const a = 2n * ONE_PUSDC;
      const b = 5n * ONE_PUSDC;
      const [encA] = await client.encryptInputs([Encryptable.uint64(a)]).execute();
      const [encB] = await client.encryptInputs([Encryptable.uint64(b)]).execute();

      await funder.fundEscrow(await escrow.getAddress(), 1, encA);
      await funder.fundEscrow(await escrow.getAddress(), 1, encB);

      const paid = await escrow.getPaidAmount(1);
      await hre.cofhe.mocks.expectPlaintext(paid, a + b);
    });

    it("emits EscrowFunded on each call", async function () {
      const { escrow, funder, deployer } = await createFundedEscrow();
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await client.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();

      await expect(funder.fundEscrow(await escrow.getAddress(), 1, encAmount))
        .to.emit(escrow, "EscrowFunded")
        .withArgs(1n);
    });

    it("reverts on non-existent escrow", async function () {
      const { escrow, funder, deployer } = await createFundedEscrow();
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await client.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();

      await expect(
        funder.fundEscrow(await escrow.getAddress(), 999, encAmount)
      ).to.be.revertedWithCustomError(escrow, "EscrowDoesNotExist");
    });

    it("reverts when caller is not authorized", async function () {
      // Deploy a fresh funder that is NOT authorized on the escrow
      const { escrow, deployer } = await createFundedEscrow();
      const rogueFunder = await deployTestEscrowFunder();
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await client.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();

      await expect(
        rogueFunder.fundEscrow(await escrow.getAddress(), 1, encAmount)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("stays uninitialized (paidAmount==0 handle) when no fund called", async function () {
      const { escrow } = await createFundedEscrow();
      const paid = await escrow.getPaidAmount(1);
      // Uninitialized euint64 == bytes32(0)
      expect(paid).to.equal(hre.ethers.ZeroHash);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // redeem()
  // ────────────────────────────────────────────────────────────────────────────

  describe("redeem()", function () {
    async function setupFunded(amount: bigint = 5n * ONE_PUSDC) {
      const ctx = await loadFixture(deployEscrowFixture);
      const { escrow, yieldGate, investor, deployer, funder, pusdc } = ctx;
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);

      const [encAmount] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
      await funder.fundEscrow(await escrow.getAddress(), 1, encAmount);

      // Fund the escrow contract's PUSDC balance so it can pay out
      await pusdc.mint(await escrow.getAddress(), Number(amount));

      return { ...ctx, amount };
    }

    it("transfers paidAmount to caller on success", async function () {
      const { escrow, pusdc, investor, amount } = await setupFunded();
      await escrow.connect(investor).redeem(1);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, amount);
    });

    it("marks isRedeemed=true on success", async function () {
      const { escrow, investor } = await setupFunded();
      await escrow.connect(investor).redeem(1);
      const flag = await escrow.getIsRedeemed(1);
      await hre.cofhe.mocks.expectPlaintext(flag, 1n);
    });

    it("emits EscrowRedeemed on success", async function () {
      const { escrow, investor } = await setupFunded();
      await expect(escrow.connect(investor).redeem(1))
        .to.emit(escrow, "EscrowRedeemed")
        .withArgs(1n);
    });

    it("silent-fails (payout=0) when caller is not owner", async function () {
      const { escrow, pusdc, alice } = await setupFunded();
      await escrow.connect(alice).redeem(1);
      const bal = await pusdc.confidentialBalanceOf(alice.address);
      // Zero-amount transfer still initialized alice's balance handle
      await hre.cofhe.mocks.expectPlaintext(bal, 0n);
    });

    it("still emits EscrowRedeemed on silent-fail (backend must verify encrypted state)", async function () {
      // Contract-level behavior: the event fires regardless of the silent
      // canRedeem chain's result. Off-chain pollers must decrypt
      // `getIsRedeemed` / observe PUSDC movement before marking the yield
      // record as claimed. This test locks the emission shape in so any
      // future "optimization" that conditionally emits is caught.
      const { escrow, alice } = await setupFunded();
      await expect(escrow.connect(alice).redeem(1))
        .to.emit(escrow, "EscrowRedeemed")
        .withArgs(1n);
    });

    it("silent-fails does NOT corrupt escrow for real owner", async function () {
      const { escrow, pusdc, alice, investor, amount } = await setupFunded();
      await escrow.connect(alice).redeem(1);
      await escrow.connect(investor).redeem(1);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, amount);
    });

    it("double-redeem: second call silently pays 0", async function () {
      const { escrow, pusdc, investor, amount } = await setupFunded();
      await escrow.connect(investor).redeem(1);
      await escrow.connect(investor).redeem(1);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      // Only first redeem moved funds
      await hre.cofhe.mocks.expectPlaintext(bal, amount);
    });

    it("silent-fails when beneficiary is not KYC-eligible", async function () {
      const { escrow, yieldGate, pusdc, funder, kyc, deployer } = await loadFixture(deployEscrowFixture);
      const [, , , , nonKyc] = await hre.ethers.getSigners();

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(nonKyc.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(nonKyc.address)]);

      const [encAmount] = await client.encryptInputs([Encryptable.uint64(ONE_PUSDC)]).execute();
      await funder.fundEscrow(await escrow.getAddress(), 1, encAmount);
      await pusdc.mint(await escrow.getAddress(), Number(ONE_PUSDC));

      await escrow.connect(nonKyc).redeem(1);
      const bal = await pusdc.confidentialBalanceOf(nonKyc.address);
      // KYC check fails → resolver returns false → silent-fail → zero payout
      await hre.cofhe.mocks.expectPlaintext(bal, 0n);
      // nonKyc ∉ whitelist, confirm
      expect(await kyc.isEligible(nonKyc.address)).to.be.false;
    });

    it("reverts on non-existent escrow", async function () {
      const { escrow, investor } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(investor).redeem(1))
        .to.be.revertedWithCustomError(escrow, "EscrowDoesNotExist");
    });

    it("reverts when paymentToken is not set", async function () {
      const { investor, deployer, yieldGate } = await loadFixture(deployEscrowFixture);
      const bareEscrow = await deployMuHavenEscrow(deployer.address, ZERO_ADDRESS);
      await bareEscrow.setAuthorizedCaller(deployer.address, true);
      // Re-point the gate at the fresh escrow so onConditionSet succeeds
      await yieldGate.setAuthorizedEscrow(await bareEscrow.getAddress());

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      await bareEscrow.batchCreate(
        [encOwner],
        await yieldGate.getAddress(),
        [encodeBeneficiary(investor.address)]
      );

      await expect(bareEscrow.connect(investor).redeem(1))
        .to.be.revertedWithCustomError(bareEscrow, "PaymentTokenNotSet");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // redeemMultiple()
  // ────────────────────────────────────────────────────────────────────────────

  describe("redeemMultiple()", function () {
    async function setupTwoFundedForInvestor(a: bigint = 2n * ONE_PUSDC, b: bigint = 3n * ONE_PUSDC) {
      const ctx = await loadFixture(deployEscrowFixture);
      const { escrow, yieldGate, investor, deployer, funder, pusdc } = ctx;
      const client = await hre.cofhe.createClientWithBatteries(deployer);

      const [encOwner1] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      const [encOwner2] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();

      await escrow.batchCreate(
        [encOwner1, encOwner2],
        await yieldGate.getAddress(),
        [encodeBeneficiary(investor.address), encodeBeneficiary(investor.address)]
      );

      const [encA] = await client.encryptInputs([Encryptable.uint64(a)]).execute();
      const [encB] = await client.encryptInputs([Encryptable.uint64(b)]).execute();
      await funder.fundEscrow(await escrow.getAddress(), 1, encA);
      await funder.fundEscrow(await escrow.getAddress(), 2, encB);

      await pusdc.mint(await escrow.getAddress(), Number(a + b));
      return { ...ctx, a, b };
    }

    it("accumulates payouts into a single transfer for same owner", async function () {
      const { escrow, pusdc, investor, a, b } = await setupTwoFundedForInvestor();
      await escrow.connect(investor).redeemMultiple([1, 2]);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, a + b);
    });

    it("silent-skips non-existent IDs in the batch", async function () {
      const { escrow, pusdc, investor, a, b } = await setupTwoFundedForInvestor();
      // 999 is nonexistent — should be skipped
      await escrow.connect(investor).redeemMultiple([1, 999, 2]);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, a + b);
    });

    it("silent-skips already-redeemed escrows (no double payout)", async function () {
      const { escrow, pusdc, investor, a, b } = await setupTwoFundedForInvestor();
      await escrow.connect(investor).redeem(1);
      await escrow.connect(investor).redeemMultiple([1, 2]);
      const bal = await pusdc.confidentialBalanceOf(investor.address);
      await hre.cofhe.mocks.expectPlaintext(bal, a + b);
    });

    it("reverts on empty array", async function () {
      const { escrow, investor } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(investor).redeemMultiple([]))
        .to.be.revertedWithCustomError(escrow, "EmptyBatch");
    });

    it("reverts BatchTooLarge when ids.length > MAX_BATCH_SIZE", async function () {
      const { escrow, investor } = await loadFixture(deployEscrowFixture);
      const tooMany = Array(201).fill(0).map((_, i) => i + 1);
      await expect(escrow.connect(investor).redeemMultiple(tooMany))
        .to.be.revertedWithCustomError(escrow, "BatchTooLarge");
    });

    it("emits one EscrowRedeemed event per processed escrow", async function () {
      const { escrow, investor } = await setupTwoFundedForInvestor();
      const tx = escrow.connect(investor).redeemMultiple([1, 2]);
      await expect(tx).to.emit(escrow, "EscrowRedeemed").withArgs(1n);
      await expect(tx).to.emit(escrow, "EscrowRedeemed").withArgs(2n);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Admin
  // ────────────────────────────────────────────────────────────────────────────

  describe("admin", function () {
    it("setAuthorizedCaller: only owner, emits event", async function () {
      const { escrow, deployer, alice } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(deployer).setAuthorizedCaller(alice.address, true))
        .to.emit(escrow, "AuthorizedCallerUpdated")
        .withArgs(alice.address, true);
      expect(await escrow.authorizedCallers(alice.address)).to.be.true;
    });

    it("setAuthorizedCaller: non-owner reverts", async function () {
      const { escrow, alice } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(alice).setAuthorizedCaller(alice.address, true))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("setPaymentToken: only owner, emits event", async function () {
      const { escrow, deployer, pusdc } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(deployer).setPaymentToken(await pusdc.getAddress()))
        .to.emit(escrow, "PaymentTokenUpdated")
        .withArgs(await pusdc.getAddress());
    });

    it("setPaymentToken: reverts on zero address", async function () {
      const { escrow, deployer } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(deployer).setPaymentToken(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("transferOwnership: emits event, updates owner", async function () {
      const { escrow, deployer, alice } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(deployer).transferOwnership(alice.address))
        .to.emit(escrow, "OwnershipTransferred")
        .withArgs(deployer.address, alice.address);
      expect(await escrow.contractOwner()).to.equal(alice.address);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // EIP-165
  // ────────────────────────────────────────────────────────────────────────────

  describe("supportsInterface", function () {
    it("declares support for IMuHavenEscrow (XOR of all function selectors)", async function () {
      const { escrow } = await loadFixture(deployEscrowFixture);
      // Canonical ABI signatures — euint/eaddress/ebool all wrap bytes32,
      // InEaddress is (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature).
      const signatures = [
        "batchCreate((uint256,uint8,uint8,bytes)[],address,bytes[])",
        "fundFrom(uint256,bytes32)",
        "redeem(uint256)",
        "redeemMultiple(uint256[])",
        "exists(uint256)",
        "getOwner(uint256)",
        "getPaidAmount(uint256)",
        "getIsRedeemed(uint256)",
        "getResolver(uint256)",
        "total()",
      ];
      let xor = 0n;
      for (const sig of signatures) {
        xor ^= BigInt(hre.ethers.id(sig).slice(0, 10));
      }
      const interfaceId = "0x" + xor.toString(16).padStart(8, "0");
      expect(await escrow.supportsInterface(interfaceId)).to.be.true;
      // ERC-165 base interface
      expect(await escrow.supportsInterface("0x01ffc9a7")).to.be.true;
      // Guaranteed-invalid per ERC-165
      expect(await escrow.supportsInterface("0xffffffff")).to.be.false;
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// YieldGate (as IConditionResolver)
// ────────────────────────────────────────────────────────────────────────────

describe("YieldGate", function () {
  describe("access control", function () {
    it("onConditionSet reverts AuthorizedEscrowNotSet before setAuthorizedEscrow is called", async function () {
      const { deployer, token, kyc, investor } = await loadFixture(deployEscrowFixture);
      const unwired = await deployYieldGate(await token.getAddress(), await kyc.getAddress());
      await expect(unwired.onConditionSet(1, encodeBeneficiary(investor.address)))
        .to.be.revertedWithCustomError(unwired, "AuthorizedEscrowNotSet");
    });

    it("onConditionSet reverts Unauthorized when msg.sender != authorizedEscrow", async function () {
      const { yieldGate, alice, investor } = await loadFixture(deployEscrowFixture);
      // authorizedEscrow was set to the real escrow in the fixture — alice is not it
      await expect(yieldGate.connect(alice).onConditionSet(1, encodeBeneficiary(investor.address)))
        .to.be.revertedWithCustomError(yieldGate, "Unauthorized");
    });

    it("onConditionSet rejects rewrites (AlreadySet)", async function () {
      const { escrow, yieldGate, investor, alice, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);

      // Now attempt a second batchCreate reusing escrow ID — impossible via batchCreate (IDs
      // are monotonic). Instead simulate the attack: the escrow tries to overwrite via a
      // second onConditionSet call for the same id. Direct-call attempt is blocked by
      // access control; the happy path already proved one-shot write worked.
      // For the AlreadySet path specifically, we need the authorized escrow to re-call —
      // which MuHavenEscrow doesn't do, but we can impersonate.
      const escrowAddr = await escrow.getAddress();
      await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [escrowAddr] });
      // Fund the impersonated account so it can send tx
      await hre.network.provider.send("hardhat_setBalance", [escrowAddr, "0x1000000000000000000"]);
      const escrowSigner = await hre.ethers.getSigner(escrowAddr);
      await expect(
        yieldGate.connect(escrowSigner).onConditionSet(1, encodeBeneficiary(alice.address))
      ).to.be.revertedWithCustomError(yieldGate, "AlreadySet");
      await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [escrowAddr] });
    });

    it("setAuthorizedEscrow: only owner, emits event", async function () {
      const { yieldGate, deployer, alice } = await loadFixture(deployEscrowFixture);
      await expect(yieldGate.connect(deployer).setAuthorizedEscrow(alice.address))
        .to.emit(yieldGate, "AuthorizedEscrowUpdated")
        .withArgs(alice.address);
    });

    it("setAuthorizedEscrow: non-owner reverts", async function () {
      const { yieldGate, alice } = await loadFixture(deployEscrowFixture);
      await expect(yieldGate.connect(alice).setAuthorizedEscrow(alice.address))
        .to.be.revertedWithCustomError(yieldGate, "Unauthorized");
    });
  });

  describe("canRedeem", function () {
    it("returns true (encrypted) for KYC investor with token balance", async function () {
      const { escrow, yieldGate, investor, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(investor.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(investor.address)]);

      const checker = await deployTestCanRedeemChecker();
      await checker.check(await yieldGate.getAddress(), 1);
      const result = await checker.lastResult();
      await hre.cofhe.mocks.expectPlaintext(result, 1n);
    });

    it("returns false for non-KYC beneficiary", async function () {
      const { escrow, yieldGate, kyc, deployer } = await loadFixture(deployEscrowFixture);
      const [, , , , nonKyc] = await hre.ethers.getSigners();
      // Defensive: fixture currently whitelists only investor+alice. If that
      // changes and signer[4] becomes KYC-eligible, this test's premise breaks
      // silently — guard it explicitly.
      expect(await kyc.isEligible(nonKyc.address)).to.be.false;

      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(nonKyc.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(nonKyc.address)]);

      const checker = await deployTestCanRedeemChecker();
      await checker.check(await yieldGate.getAddress(), 1);
      const result = await checker.lastResult();
      await hre.cofhe.mocks.expectPlaintext(result, 0n);
    });

    it("returns false when KYC investor has no token balance", async function () {
      // Alice is KYC-whitelisted by deployMuHavenFixture but has no token balance
      // (only investor is minted in deployEscrowFixture).
      const { escrow, yieldGate, alice, deployer } = await loadFixture(deployEscrowFixture);
      const client = await hre.cofhe.createClientWithBatteries(deployer);
      const [encOwner] = await client.encryptInputs([Encryptable.address(alice.address)]).execute();
      await escrow.batchCreate([encOwner], await yieldGate.getAddress(), [encodeBeneficiary(alice.address)]);

      const checker = await deployTestCanRedeemChecker();
      await checker.check(await yieldGate.getAddress(), 1);
      const result = await checker.lastResult();
      await hre.cofhe.mocks.expectPlaintext(result, 0n);
    });

    it("reverts UnknownEscrow for unregistered escrow IDs", async function () {
      const { yieldGate } = await loadFixture(deployEscrowFixture);
      await expect(yieldGate.canRedeem(999))
        .to.be.revertedWithCustomError(yieldGate, "UnknownEscrow");
    });
  });

  describe("supportsInterface", function () {
    it("declares IConditionResolver support", async function () {
      const { yieldGate } = await loadFixture(deployEscrowFixture);
      // IConditionResolver selector = onConditionSet(uint256,bytes) ^ canRedeem(uint256)
      const onSet = hre.ethers.id("onConditionSet(uint256,bytes)").slice(0, 10);
      const canR = hre.ethers.id("canRedeem(uint256)").slice(0, 10);
      // XOR the two 4-byte selectors
      const id = "0x" +
        (BigInt(onSet) ^ BigInt(canR)).toString(16).padStart(8, "0");
      expect(await yieldGate.supportsInterface(id)).to.be.true;
      // ERC-165 base
      expect(await yieldGate.supportsInterface("0x01ffc9a7")).to.be.true;
    });
  });
});

