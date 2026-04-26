/**
 * Phase 7.5-A — `MuHavenStable` confidential-USDC wrapper.
 *
 * Covers `MHUSD_WRAPPER_PLAN.md` §"Phase 7.5-A — Contract + tests" — wrap /
 * unwrap, confidential transfer (modern + legacy shims), operator model,
 * admin, `refreshDecryptGrant`, and a wrap → transfer → unwrap round-trip
 * locking in the 1:1 invariant.
 *
 * Verification approach:
 *   - Mock ACL is read directly via `hre.cofhe.mocks.getMockACL().isAllowed`
 *     to assert decrypt grants — same pattern as `MuHavenSubscriptionPermit`
 *     and `MuHavenTokenRefreshDecryptGrant`.
 *   - 1:1 invariant: after every mutation that touches the wrapper's PUSDC
 *     balance, `mhUSDC.confidentialTotalSupply` matches
 *     `legacyPusdc.confidentialBalanceOf(mhUSDC)` in plaintext.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre, { upgrades } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import { deployMockPUSDC } from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

const ONE_PUSDC = 1_000_000n;
const FOREVER = 2n ** 47n - 1n; // uint48 max-ish

async function encUint64(client: any, value: bigint) {
  const [enc] = await client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

function handleToUint(handle: any): bigint {
  return BigInt(handle);
}

async function deployStableFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, alice, bob, carol, stranger] = await hre.ethers.getSigners();

  const pusdc = await deployMockPUSDC();

  const Stable = await hre.ethers.getContractFactory("MuHavenStable");
  const stable = await upgrades.deployProxy(
    Stable,
    [
      "MuHaven Confidential USD",
      "mhUSDC",
      deployer.address,
      await pusdc.getAddress(),
    ],
    { kind: "transparent", initializer: "initialize" }
  );

  // Per-signer CoFHE clients — each `verifyInput` is scoped to msg.sender.
  const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
  const bobClient = await hre.cofhe.createClientWithBatteries(bob);
  const carolClient = await hre.cofhe.createClientWithBatteries(carol);

  const acl = await hre.cofhe.mocks.getMockACL();

  return {
    deployer,
    alice,
    bob,
    carol,
    stranger,
    pusdc,
    stable,
    aliceClient,
    bobClient,
    carolClient,
    acl,
  };
}

/**
 * Seed `holder` with `amount` legacy PUSDC and approve `stable` as operator
 * so subsequent `wrap` / `wrapHandle` calls can pull.
 */
async function seedAndApprove(
  pusdc: any,
  stable: any,
  holder: any,
  amount: bigint
) {
  await pusdc.mint(holder.address, amount);
  await pusdc.connect(holder).setOperator(await stable.getAddress(), FOREVER);
}

describe("MuHavenStable — Phase 7.5-A", () => {
  // ── Wrap / unwrap ────────────────────────────────────────────────────

  describe("wrap / unwrap", () => {
    it("wrap pulls PUSDC and mints equivalent mhUSDC", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();
      const enc = await encUint64(aliceClient, 50n * ONE_PUSDC);

      await expect(stable.connect(alice).wrap(enc, eph.address))
        .to.emit(stable, "Wrap")
        .withArgs(alice.address, eph.address);

      const aliceMhBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceMhBal, 50n * ONE_PUSDC);

      const totalSupply = await stable.confidentialTotalSupply();
      await hre.cofhe.mocks.expectPlaintext(totalSupply, 50n * ONE_PUSDC);

      const wrapperPusdcBal = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdcBal, 50n * ONE_PUSDC);
    });

    it("wrap reverts WrapFailed when caller has not granted operator approval", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      // Mint PUSDC but DO NOT setOperator.
      await pusdc.mint(alice.address, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();
      const enc = await encUint64(aliceClient, 10n * ONE_PUSDC);

      await expect(
        stable.connect(alice).wrap(enc, eph.address)
      ).to.be.revertedWithCustomError(stable, "WrapFailed");
    });

    it("wrap rejects InvalidEphemeralEOA on zero address", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const enc = await encUint64(aliceClient, 10n * ONE_PUSDC);

      await expect(
        stable.connect(alice).wrap(enc, hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "InvalidEphemeralEOA");
    });

    it("wrap grants ephemeralEOA decrypt access on the mhUSDC balance handle", async () => {
      const { stable, pusdc, alice, aliceClient, acl } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();
      const enc = await encUint64(aliceClient, 25n * ONE_PUSDC);
      await stable.connect(alice).wrap(enc, eph.address);

      const balHandle = await stable.confidentialBalanceOf(alice.address);
      expect(
        await acl.isAllowed(handleToUint(balHandle), eph.address)
      ).to.equal(true);
    });

    it("1:1 invariant holds after multiple wraps", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();

      const enc1 = await encUint64(aliceClient, 30n * ONE_PUSDC);
      await stable.connect(alice).wrap(enc1, eph.address);

      const enc2 = await encUint64(aliceClient, 25n * ONE_PUSDC);
      await stable.connect(alice).wrap(enc2, eph.address);

      const totalSupply = await stable.confidentialTotalSupply();
      const wrapperPusdcBal = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(totalSupply, 55n * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdcBal, 55n * ONE_PUSDC);
    });

    it("unwrap burns mhUSDC and pushes legacy PUSDC back to caller", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();

      // Wrap 60.
      const wrapEnc = await encUint64(aliceClient, 60n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, eph.address);

      // Unwrap 20.
      const unwrapEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await expect(stable.connect(alice).unwrap(unwrapEnc, eph.address))
        .to.emit(stable, "Unwrap")
        .withArgs(alice.address, eph.address);

      const mhBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(mhBal, 40n * ONE_PUSDC);

      const totalSupply = await stable.confidentialTotalSupply();
      await hre.cofhe.mocks.expectPlaintext(totalSupply, 40n * ONE_PUSDC);

      const wrapperPusdcBal = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdcBal, 40n * ONE_PUSDC);

      // Alice's legacy PUSDC: started 100, wrapped 60, unwrapped 20 → 60.
      const alicePusdc = await pusdc.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(alicePusdc, 60n * ONE_PUSDC);
    });

    it("unwrap silent-fails when caller's mhUSDC balance is short", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const eph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, eph.address);

      // Try to unwrap 50 (only have 10) — should silent-fail to zero.
      const unwrapEnc = await encUint64(aliceClient, 50n * ONE_PUSDC);
      await stable.connect(alice).unwrap(unwrapEnc, eph.address);

      // Balance unchanged; total supply unchanged; PUSDC unchanged.
      const mhBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(mhBal, 10n * ONE_PUSDC);

      const totalSupply = await stable.confidentialTotalSupply();
      await hre.cofhe.mocks.expectPlaintext(totalSupply, 10n * ONE_PUSDC);

      const alicePusdc = await pusdc.confidentialBalanceOf(alice.address);
      // Wrapped 10 of original 100 → 90 PUSDC remaining (silent-fail
      // returned nothing).
      await hre.cofhe.mocks.expectPlaintext(alicePusdc, 90n * ONE_PUSDC);
    });

    it("unwrap reverts NoBalance when caller has never held mhUSDC", async () => {
      const { stable, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      const eph = createEphemeralEOA();
      const enc = await encUint64(aliceClient, 1n * ONE_PUSDC);

      await expect(
        stable.connect(alice).unwrap(enc, eph.address)
      ).to.be.revertedWithCustomError(stable, "NoBalance");
    });

    it("pause blocks wrap and unwrap", async () => {
      const { stable, pusdc, alice, aliceClient, deployer } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      // Wrap once so unwrap has something to bite.
      const eph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, eph.address);

      await stable.connect(deployer).pause();

      const enc2 = await encUint64(aliceClient, 1n * ONE_PUSDC);
      await expect(
        stable.connect(alice).wrap(enc2, eph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");
      await expect(
        stable.connect(alice).unwrap(enc2, eph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");
    });
  });

  // ── Confidential transfer (modern + legacy) ───────────────────────────

  describe("confidential transfer", () => {
    it("modern transfer grants ephemeralEOA on both legs", async () => {
      const { stable, pusdc, alice, bob, aliceClient, acl } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 50n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Modern 3-arg overload — ethers resolves on arity.
      const xferEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await (stable.connect(alice) as any)["transfer(address,(uint256,uint8,uint8,bytes),address)"](
        bob.address,
        xferEnc,
        aliceEph.address
      );

      const aliceBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceBal, 30n * ONE_PUSDC);

      const bobBal = await stable.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(bobBal, 20n * ONE_PUSDC);

      // Sender's new balance handle gets aliceEph grant.
      expect(
        await acl.isAllowed(handleToUint(aliceBal), aliceEph.address)
      ).to.equal(true);
      // Recipient's new balance handle ALSO gets aliceEph grant — modern
      // surface keeps sender's session aware of the recipient's resulting
      // state too.
      expect(
        await acl.isAllowed(handleToUint(bobBal), aliceEph.address)
      ).to.equal(true);
    });

    it("modern transfer silent-fails on insufficient sender balance", async () => {
      const { stable, pusdc, alice, bob, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 5n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Try to send 20, only have 5.
      const xferEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await (stable.connect(alice) as any)["transfer(address,(uint256,uint8,uint8,bytes),address)"](
        bob.address,
        xferEnc,
        aliceEph.address
      );

      // Both balances unchanged.
      const aliceBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceBal, 5n * ONE_PUSDC);

      const bobBal = await stable.confidentialBalanceOf(bob.address);
      // Bob received zero — handle exists but plaintext is 0.
      await hre.cofhe.mocks.expectPlaintext(bobBal, 0n);
    });

    it("legacy uint256 confidentialTransfer routes through the silent-fail path", async () => {
      const { stable, pusdc, alice, bob, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 30n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Read alice's balance handle to use as the transfer amount input —
      // the legacy uint256 selector takes a raw ciphertext hash. To match
      // the calling pattern of Wave 3.5 contracts (Subscription/Treasury)
      // we encode the value via FHE.asEuint64 inside a contract path; for
      // a unit test we just send `aliceBalanceHandle` itself. The point
      // here is that the selector dispatches correctly.
      // Use the modern handle overload via the stable ABI under the hood:
      // we go through modern transfer and assert legacy SHIM is callable
      // by encoding a low-level call directly with the legacy selector.
      const sel = hre.ethers.id("confidentialTransfer(address,uint256)").slice(0, 10);

      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);
      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [bob.address, aliceBalHandle]
      ).slice(2);

      // Alice transfers her entire balance handle to bob via legacy selector.
      // This routes through `_doTransfer(alice, bob, balHandle, 0)` —
      // silent-fail bound trims requested to balance, so actual = balance.
      await alice.sendTransaction({
        to: await stable.getAddress(),
        data,
      });

      const bobBal = await stable.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(bobBal, 30n * ONE_PUSDC);

      const aliceBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceBal, 0n);
    });

    it("legacy uint256 transfer leaves only kernel grant on recipient (no eph)", async () => {
      const { stable, pusdc, alice, bob, aliceClient, acl } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      const sel = hre.ethers.id("confidentialTransfer(address,uint256)").slice(0, 10);
      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);
      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [bob.address, aliceBalHandle]
      ).slice(2);
      await alice.sendTransaction({ to: await stable.getAddress(), data });

      const bobBal = await stable.confidentialBalanceOf(bob.address);

      // Recipient has kernel grant only; no eph grant from the legacy path.
      expect(
        await acl.isAllowed(handleToUint(bobBal), bob.address)
      ).to.equal(true);
      expect(
        await acl.isAllowed(handleToUint(bobBal), aliceEph.address)
      ).to.equal(false);
    });

    it("transferFrom requires operator approval", async () => {
      const { stable, pusdc, alice, bob, carol, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      const xferEnc = await encUint64(aliceClient, 5n * ONE_PUSDC);

      // Bob is not approved as operator on alice's mhUSDC — must revert.
      await expect(
        (stable.connect(bob) as any)[
          "transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"
        ](alice.address, carol.address, xferEnc, createEphemeralEOA().address)
      ).to.be.revertedWithCustomError(stable, "NotOperator");
    });

    it("transferFrom succeeds for an approved operator", async () => {
      const { stable, pusdc, alice, bob, carol, aliceClient, bobClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Alice approves Bob as operator on her mhUSDC.
      await stable.connect(alice).setOperator(bob.address, FOREVER);

      // Encryption proof scoped to msg.sender (Bob).
      const xferEnc = await encUint64(bobClient, 7n * ONE_PUSDC);
      const carolEph = createEphemeralEOA();

      await (stable.connect(bob) as any)[
        "transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"
      ](alice.address, carol.address, xferEnc, carolEph.address);

      const aliceBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceBal, 13n * ONE_PUSDC);

      const carolBal = await stable.confidentialBalanceOf(carol.address);
      await hre.cofhe.mocks.expectPlaintext(carolBal, 7n * ONE_PUSDC);
    });

    it("transferFrom expired operator reverts NotOperator", async () => {
      const { stable, pusdc, alice, bob, carol, aliceClient, bobClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Approve Bob as operator BUT set `until` to 1 (already expired).
      await stable.connect(alice).setOperator(bob.address, 1n);

      const xferEnc = await encUint64(bobClient, 5n * ONE_PUSDC);
      await expect(
        (stable.connect(bob) as any)[
          "transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"
        ](alice.address, carol.address, xferEnc, createEphemeralEOA().address)
      ).to.be.revertedWithCustomError(stable, "NotOperator");
    });

    it("transferFrom self-as-operator works without explicit approval", async () => {
      const { stable, pusdc, alice, bob, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 20n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      // Alice spends her own balance via transferFrom — no operator needed.
      const xferEnc = await encUint64(aliceClient, 5n * ONE_PUSDC);
      await (stable.connect(alice) as any)[
        "transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"
      ](alice.address, bob.address, xferEnc, aliceEph.address);

      const aliceBal = await stable.confidentialBalanceOf(alice.address);
      await hre.cofhe.mocks.expectPlaintext(aliceBal, 15n * ONE_PUSDC);
    });

    it("transfer rejects zero recipient", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      const xferEnc = await encUint64(aliceClient, 1n * ONE_PUSDC);
      await expect(
        (stable.connect(alice) as any)[
          "transfer(address,(uint256,uint8,uint8,bytes),address)"
        ](hre.ethers.ZeroAddress, xferEnc, aliceEph.address)
      ).to.be.revertedWithCustomError(stable, "ZeroAddress");
    });

    it("transfer reverts NoBalance when sender never held mhUSDC", async () => {
      const { stable, alice, bob, aliceClient } =
        await loadFixture(deployStableFixture);
      const aliceEph = createEphemeralEOA();
      const xferEnc = await encUint64(aliceClient, 1n * ONE_PUSDC);
      await expect(
        (stable.connect(alice) as any)[
          "transfer(address,(uint256,uint8,uint8,bytes),address)"
        ](bob.address, xferEnc, aliceEph.address)
      ).to.be.revertedWithCustomError(stable, "NoBalance");
    });

    it("pause blocks transfer and transferFrom", async () => {
      const { stable, pusdc, alice, bob, deployer, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, aliceEph.address);

      await stable.connect(deployer).pause();

      const xferEnc = await encUint64(aliceClient, 1n * ONE_PUSDC);
      await expect(
        (stable.connect(alice) as any)[
          "transfer(address,(uint256,uint8,uint8,bytes),address)"
        ](bob.address, xferEnc, aliceEph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");

      await expect(
        (stable.connect(alice) as any)[
          "transferFrom(address,address,(uint256,uint8,uint8,bytes),address)"
        ](alice.address, bob.address, xferEnc, aliceEph.address)
      ).to.be.revertedWithCustomError(stable, "PausedSurface");
    });

    // ── Phase 7.6-E / ADR-044 — split-grant 5-arg transferFrom ────────
    //
    // Closes audit-prep §A-9: contract-mediated callers must be able to
    // suppress the counterparty's `ephemeralEOA` ACL grant. The 4-arg
    // overload's both-leg behavior is intentionally preserved (P2P EOA
    // calls go through it); the 5-arg variant is the new entrypoint for
    // Subscription / Queue.

    it("5-arg transferFrom: fromEph-only suppresses recipient leg's eph grant", async () => {
      // Used by `MuHavenSubscription.purchase` shape: investor →
      // treasury, only investor's eph relevant. Treasury's resulting
      // mhUSDC balance handle stays kernel-only — investor's session
      // gains zero decrypt access on the treasury's mhUSDC float.
      const { stable, pusdc, alice, bob, aliceClient, bobClient, acl } =
        await loadFixture(deployStableFixture);

      // Alice (sender) holds mhUSDC; bob (recipient, stand-in for
      // treasury) needs an existing balance for the recipient-leg ACL
      // assertion to be meaningful (a fresh mint creates a NEW handle
      // either way; but with an existing balance the post-add handle is
      // also fresh and we can directly assert the missing eph grant).
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);
      await seedAndApprove(pusdc, stable, bob, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();
      await stable
        .connect(alice)
        .wrap(await encUint64(aliceClient, 50n * ONE_PUSDC), aliceEph.address);
      await stable
        .connect(bob)
        .wrap(await encUint64(bobClient, 50n * ONE_PUSDC), bobEph.address);

      // Alice spends her own balance via the 5-arg variant (self-as-
      // operator works without explicit approval — see existing test).
      // Pass aliceEph for fromEph, address(0) for toEph.
      const xferAmount = 20n * ONE_PUSDC;

      // Need an on-chain euint64 handle as the second-overload input.
      // Wrap-then-spend: encrypt off-chain, then run a contract path
      // that gives us a handle. Use existing modern transfer to bob to
      // generate a handle, then call the 5-arg variant ourselves.
      // Simpler: use the InEuint64 4-arg overload first to set up state
      // and then the 5-arg overload directly via low-level call with
      // alice's current balance handle as input.
      //
      // But the 5-arg overload accepts euint64 (on-chain handle), so we
      // need a handle to feed in. The cleanest way: use the InEuint64
      // 4-arg overload to do a separate transfer, then assert ACL on
      // resulting balances. But that's the BOTH-leg path. To exercise
      // the 5-arg variant we need to call it via low-level call.

      const sel = hre.ethers.id(
        "transferFrom(address,address,bytes32,address,address)"
      ).slice(0, 10);

      // The on-chain handle for the transfer amount: encrypt off-chain
      // via aliceClient, then materialise via a no-op contract path.
      // CoFHE mock allows raw input via the uint256 → bytes32 wrap of
      // the encrypted ciphertext hash, but the modern surface needs a
      // handle that's already passed `verifyInput`. The simplest way is
      // to use alice's own balance handle (silent-fail bound trims to
      // requested anyway when balance >= amount).
      //
      // Since we want a SPECIFIC amount (not "all of alice"), we'll
      // first do a 4-arg transferFrom to get a verified amount handle
      // (via CoFHE's input pipeline), then re-encrypt the same amount
      // for the 5-arg call. CoFHE mock content-addresses handles, so
      // the same input across two encrypts produces the same handle.
      const handleEnc = await encUint64(aliceClient, xferAmount);

      // Use the InEuint64 4-arg overload to materialise the handle on-
      // chain (via the trivial encrypt path in the mock). The actual
      // call we want to test is the 5-arg euint64 variant — invoke it
      // by ABI encoding directly. To get the on-chain handle without
      // performing the actual transfer, we re-use alice's balance
      // handle as a known on-chain handle for the bytes32 slot.
      //
      // For the test purpose: invoke the 5-arg variant with alice's
      // balance handle as the amount (silent-fail bound caps at the
      // available balance). This validates the per-leg eph grant
      // behavior even though the amount = alice's whole balance.
      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);

      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "bytes32", "address", "address"],
        [alice.address, bob.address, aliceBalHandle, aliceEph.address, hre.ethers.ZeroAddress]
      ).slice(2);

      await alice.sendTransaction({ to: await stable.getAddress(), data });

      const aliceBalAfter = await stable.confidentialBalanceOf(alice.address);
      const bobBalAfter = await stable.confidentialBalanceOf(bob.address);

      // Sender's new balance: aliceEph granted (fromEph != 0).
      expect(
        await acl.isAllowed(handleToUint(aliceBalAfter), aliceEph.address)
      ).to.equal(true);
      // Recipient's new balance: aliceEph NOT granted (toEph == 0).
      // This is the audit-prep §A-9 invariant — investor-side eph
      // does not gain decrypt access on the recipient's mhUSDC handle.
      expect(
        await acl.isAllowed(handleToUint(bobBalAfter), aliceEph.address)
      ).to.equal(false);
      // Recipient's own kernel grant still fires (per Rule 2 baseline).
      expect(
        await acl.isAllowed(handleToUint(bobBalAfter), bob.address)
      ).to.equal(true);
      // Recipient's own existing eph grant unchanged on bob's side
      // (bobEph was granted on bob's pre-transfer balance handle, not
      // on this new post-add handle).
      expect(
        await acl.isAllowed(handleToUint(bobBalAfter), bobEph.address)
      ).to.equal(false);
    });

    it("5-arg transferFrom: toEph-only suppresses sender leg's eph grant", async () => {
      // Used by `MuHavenSubscription._settleRedeem` and
      // `RedemptionQueue._pullAndMirror` shape: treasury → investor,
      // only investor's eph relevant. Treasury's resulting mhUSDC
      // balance handle stays kernel-only.
      const { stable, pusdc, alice, bob, aliceClient, bobClient, acl } =
        await loadFixture(deployStableFixture);

      // Alice = "treasury" (sender, contract-side). Bob = "investor"
      // (recipient, gets the toEph grant).
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);
      await seedAndApprove(pusdc, stable, bob, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();
      await stable
        .connect(alice)
        .wrap(await encUint64(aliceClient, 50n * ONE_PUSDC), aliceEph.address);
      await stable
        .connect(bob)
        .wrap(await encUint64(bobClient, 50n * ONE_PUSDC), bobEph.address);

      const sel = hre.ethers.id(
        "transferFrom(address,address,bytes32,address,address)"
      ).slice(0, 10);

      // Use bob as the spender — bob's session calls transferFrom on
      // alice's balance with alice's pre-existing operator approval.
      // For this test, alice (self-operator) calls transferFrom from
      // alice → bob with toEph = bobEph, fromEph = address(0).
      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);

      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "bytes32", "address", "address"],
        [alice.address, bob.address, aliceBalHandle, hre.ethers.ZeroAddress, bobEph.address]
      ).slice(2);

      await alice.sendTransaction({ to: await stable.getAddress(), data });

      const aliceBalAfter = await stable.confidentialBalanceOf(alice.address);
      const bobBalAfter = await stable.confidentialBalanceOf(bob.address);

      // Sender's new balance: aliceEph NOT granted (fromEph == 0).
      // The treasury-leak-fixed direction.
      expect(
        await acl.isAllowed(handleToUint(aliceBalAfter), aliceEph.address)
      ).to.equal(false);
      // Sender's own kernel grant still fires.
      expect(
        await acl.isAllowed(handleToUint(aliceBalAfter), alice.address)
      ).to.equal(true);
      // Recipient's new balance: bobEph granted (toEph != 0).
      expect(
        await acl.isAllowed(handleToUint(bobBalAfter), bobEph.address)
      ).to.equal(true);
      // Bob also gets his kernel grant.
      expect(
        await acl.isAllowed(handleToUint(bobBalAfter), bob.address)
      ).to.equal(true);
    });

    it("5-arg transferFrom: rejects (fromEph=0, toEph=0) as InvalidEphemeralEOA", async () => {
      // Defence-in-depth — passing both as zero would lose the
      // session's decrypt access on both legs. The 4-arg overload
      // rejects `eph == 0` for the same reason; the 5-arg variant
      // rejects only the fully-zero case (one-leg-zero is the
      // intended split-grant entry).
      const { stable, pusdc, alice, bob, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      await stable
        .connect(alice)
        .wrap(await encUint64(aliceClient, 10n * ONE_PUSDC), aliceEph.address);

      const sel = hre.ethers.id(
        "transferFrom(address,address,bytes32,address,address)"
      ).slice(0, 10);
      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);

      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "bytes32", "address", "address"],
        [alice.address, bob.address, aliceBalHandle, hre.ethers.ZeroAddress, hre.ethers.ZeroAddress]
      ).slice(2);

      await expect(
        alice.sendTransaction({ to: await stable.getAddress(), data })
      ).to.be.reverted;
    });

    it("5-arg transferFrom: rejects zero recipient", async () => {
      const { stable, pusdc, alice, aliceClient } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      await stable
        .connect(alice)
        .wrap(await encUint64(aliceClient, 10n * ONE_PUSDC), aliceEph.address);

      const sel = hre.ethers.id(
        "transferFrom(address,address,bytes32,address,address)"
      ).slice(0, 10);
      const aliceBalHandle = await stable.confidentialBalanceOf(alice.address);

      const data = sel + hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "bytes32", "address", "address"],
        [alice.address, hre.ethers.ZeroAddress, aliceBalHandle, aliceEph.address, hre.ethers.ZeroAddress]
      ).slice(2);

      await expect(
        alice.sendTransaction({ to: await stable.getAddress(), data })
      ).to.be.reverted;
    });
  });

  // ── Operator / admin / refresh ────────────────────────────────────────

  describe("operator / admin / refresh", () => {
    it("setOperator + isOperator flow", async () => {
      const { stable, alice, bob } = await loadFixture(deployStableFixture);
      expect(await stable.isOperator(alice.address, bob.address)).to.equal(false);

      await expect(stable.connect(alice).setOperator(bob.address, FOREVER))
        .to.emit(stable, "OperatorSet")
        .withArgs(alice.address, bob.address, FOREVER);

      expect(await stable.isOperator(alice.address, bob.address)).to.equal(true);

      // Setting `until = 0` revokes (any current block timestamp > 0).
      await stable.connect(alice).setOperator(bob.address, 0n);
      expect(await stable.isOperator(alice.address, bob.address)).to.equal(false);
    });

    it("setOperator rejects zero address", async () => {
      const { stable, alice } = await loadFixture(deployStableFixture);
      await expect(
        stable.connect(alice).setOperator(hre.ethers.ZeroAddress, FOREVER)
      ).to.be.revertedWithCustomError(stable, "ZeroAddress");
    });

    it("setLegacyPusdc owner-only rotation", async () => {
      const { stable, deployer, alice } =
        await loadFixture(deployStableFixture);
      const next = hre.ethers.Wallet.createRandom();

      await expect(stable.connect(alice).setLegacyPusdc(next.address))
        .to.be.revertedWithCustomError(stable, "OnlyOwner");

      await expect(stable.connect(deployer).setLegacyPusdc(next.address))
        .to.emit(stable, "LegacyPusdcUpdated")
        .withArgs(next.address);

      expect(await stable.legacyPusdc()).to.equal(next.address);
    });

    it("setLegacyPusdc rejects zero address", async () => {
      const { stable, deployer } = await loadFixture(deployStableFixture);
      await expect(
        stable.connect(deployer).setLegacyPusdc(hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "ZeroAddress");
    });

    it("pause / unpause flow with state-already-set guard", async () => {
      const { stable, deployer } = await loadFixture(deployStableFixture);
      expect(await stable.paused()).to.equal(false);

      await expect(stable.connect(deployer).pause())
        .to.emit(stable, "Paused");
      expect(await stable.paused()).to.equal(true);

      await expect(
        stable.connect(deployer).pause()
      ).to.be.revertedWithCustomError(stable, "PauseStateAlreadySet");

      await expect(stable.connect(deployer).unpause())
        .to.emit(stable, "Unpaused");
      expect(await stable.paused()).to.equal(false);

      await expect(
        stable.connect(deployer).unpause()
      ).to.be.revertedWithCustomError(stable, "PauseStateAlreadySet");
    });

    it("transferOwnership with zero-address guard", async () => {
      const { stable, deployer, alice } =
        await loadFixture(deployStableFixture);

      await expect(
        stable.connect(deployer).transferOwnership(hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "ZeroAddress");

      await expect(stable.connect(deployer).transferOwnership(alice.address))
        .to.emit(stable, "OwnershipTransferred")
        .withArgs(deployer.address, alice.address);

      expect(await stable.owner()).to.equal(alice.address);
    });

    it("refreshDecryptGrant grants ACL on caller's current balance handle", async () => {
      const { stable, pusdc, alice, aliceClient, acl } =
        await loadFixture(deployStableFixture);
      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      // Wrap so alice has a balance handle.
      const initialEph = createEphemeralEOA();
      const wrapEnc = await encUint64(aliceClient, 10n * ONE_PUSDC);
      await stable.connect(alice).wrap(wrapEnc, initialEph.address);

      const balHandle = await stable.confidentialBalanceOf(alice.address);
      const freshEph = createEphemeralEOA();

      // Pre-state: fresh EOA has no grant.
      expect(
        await acl.isAllowed(handleToUint(balHandle), freshEph.address)
      ).to.equal(false);

      await expect(stable.connect(alice).refreshDecryptGrant(freshEph.address))
        .to.emit(stable, "DecryptGrantRefreshed")
        .withArgs(alice.address, freshEph.address);

      expect(
        await acl.isAllowed(handleToUint(balHandle), freshEph.address)
      ).to.equal(true);
    });

    it("refreshDecryptGrant on zero-balance caller is a no-op + event", async () => {
      const { stable, alice } = await loadFixture(deployStableFixture);
      const eph = createEphemeralEOA();

      await expect(stable.connect(alice).refreshDecryptGrant(eph.address))
        .to.emit(stable, "DecryptGrantRefreshed")
        .withArgs(alice.address, eph.address);
    });

    it("refreshDecryptGrant rejects zero ephemeralEOA", async () => {
      const { stable, alice } = await loadFixture(deployStableFixture);
      await expect(
        stable.connect(alice).refreshDecryptGrant(hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(stable, "InvalidEphemeralEOA");
    });
  });

  // ── EIP-165 ────────────────────────────────────────────────────────────

  describe("EIP-165", () => {
    /// XOR of all function selectors in an ABI — ERC-165 interfaceId.
    /// Uses the full function signature (not bare name) so overloads
    /// resolve unambiguously.
    function interfaceIdFromAbi(abi: string[]): string {
      const iface = new hre.ethers.Interface(abi);
      let id = 0n;
      for (const frag of iface.fragments) {
        if (frag.type === "function") {
          id ^= BigInt((frag as any).selector);
        }
      }
      return "0x" + id.toString(16).padStart(8, "0");
    }

    it("supports IERC165", async () => {
      const { stable } = await loadFixture(deployStableFixture);
      expect(await stable.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("does not advertise the invalid 0xffffffff sentinel", async () => {
      const { stable } = await loadFixture(deployStableFixture);
      expect(await stable.supportsInterface("0xffffffff")).to.equal(false);
    });

    it("supports IMuHavenStable interface id", async () => {
      const { stable } = await loadFixture(deployStableFixture);
      // Mirror MuHavenToken's EIP-165 test: derive from ABI dynamically so
      // adding new interface functions doesn't require hardcoded tweaks.
      // euint64 = bytes32, InEuint64 = (uint256,uint8,uint8,bytes).
      const interfaceId = interfaceIdFromAbi([
        "function wrap((uint256,uint8,uint8,bytes),address)",
        "function wrapHandle(bytes32,address)",
        "function unwrap((uint256,uint8,uint8,bytes),address)",
        "function transfer(address,(uint256,uint8,uint8,bytes),address) returns (bytes32)",
        "function transfer(address,bytes32,address) returns (bytes32)",
        "function transferFrom(address,address,(uint256,uint8,uint8,bytes),address) returns (bytes32)",
        "function transferFrom(address,address,bytes32,address) returns (bytes32)",
        // Phase 7.6-E / ADR-044 — split-grant 5-arg variant.
        "function transferFrom(address,address,bytes32,address,address) returns (bytes32)",
        "function setOperator(address,uint48)",
        "function isOperator(address,address) view returns (bool)",
        "function confidentialBalanceOf(address) view returns (bytes32)",
        "function confidentialTotalSupply() view returns (bytes32)",
        "function refreshDecryptGrant(address)",
        "function pause()",
        "function unpause()",
        "function setLegacyPusdc(address)",
        "function transferOwnership(address)",
        "function owner() view returns (address)",
        "function legacyPusdc() view returns (address)",
        "function paused() view returns (bool)",
      ]);
      expect(await stable.supportsInterface(interfaceId)).to.equal(true);
    });
  });

  // ── Integration: wrap → transfer → unwrap round-trip ───────────────────

  describe("integration round-trip", () => {
    it("wrap → P2P transfer → unwrap preserves the 1:1 invariant on every leg", async () => {
      const { stable, pusdc, alice, bob, aliceClient, bobClient } =
        await loadFixture(deployStableFixture);

      await seedAndApprove(pusdc, stable, alice, 100n * ONE_PUSDC);

      const aliceEph = createEphemeralEOA();
      const bobEph = createEphemeralEOA();

      // 1. Alice wraps 80.
      let enc = await encUint64(aliceClient, 80n * ONE_PUSDC);
      await stable.connect(alice).wrap(enc, aliceEph.address);

      let supply = await stable.confidentialTotalSupply();
      let wrapperPusdc = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(supply, 80n * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdc, 80n * ONE_PUSDC);

      // 2. Alice sends 30 mhUSDC to bob via modern transfer.
      enc = await encUint64(aliceClient, 30n * ONE_PUSDC);
      await (stable.connect(alice) as any)[
        "transfer(address,(uint256,uint8,uint8,bytes),address)"
      ](bob.address, enc, aliceEph.address);

      // Total supply unchanged on P2P. PUSDC custody also unchanged.
      supply = await stable.confidentialTotalSupply();
      wrapperPusdc = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(supply, 80n * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdc, 80n * ONE_PUSDC);

      // 3. Bob unwraps 25.
      enc = await encUint64(bobClient, 25n * ONE_PUSDC);
      await stable.connect(bob).unwrap(enc, bobEph.address);

      // Supply -25, wrapper PUSDC -25 (1:1 invariant).
      supply = await stable.confidentialTotalSupply();
      wrapperPusdc = await pusdc.confidentialBalanceOf(
        await stable.getAddress()
      );
      await hre.cofhe.mocks.expectPlaintext(supply, 55n * ONE_PUSDC);
      await hre.cofhe.mocks.expectPlaintext(wrapperPusdc, 55n * ONE_PUSDC);

      // Bob's mhUSDC: 30 received - 25 unwrapped = 5. Bob's legacy PUSDC = 25.
      const bobMh = await stable.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(bobMh, 5n * ONE_PUSDC);
      const bobPusdc = await pusdc.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(bobPusdc, 25n * ONE_PUSDC);
    });
  });
});
