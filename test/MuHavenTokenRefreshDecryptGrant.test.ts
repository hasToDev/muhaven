/**
 * Phase 7 — `MuHavenToken.refreshDecryptGrant(ephemeralEOA)` primitive.
 *
 * Closes the PERMIT_DECRYPT_LIFECYCLE §8 Q4 gap surfaced by the Phase 7
 * audit: the balance handle carries a kernel grant after every mint /
 * transfer-in / return-to-investor, but the kernel cannot sign permits
 * (ADR-009). A holder on a fresh session (or a passive P2P recipient)
 * therefore cannot bind decrypt rights to their session-scoped ephemeral
 * EOA until they self-trigger a refresh. This primitive is that self-
 * trigger.
 *
 * Verification approach mirrors `MuHavenSubscriptionPermit.test.ts` —
 * read the mock ACL directly via `hre.cofhe.getMockACL()` rather than
 * inferring grant state from the absence of a decrypt revert.
 */

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

import {
  deployKYCAdapter,
  deployRegistry,
  deployToken,
} from "./helpers/setup";
import { createEphemeralEOA } from "./helpers/fixturesV2";

function handleToUint(handle: any): bigint {
  return BigInt(handle);
}

async function deployRefreshFixture() {
  await hre.run("task:cofhe-mocks:deploy");

  const [deployer, issuer, holder, recipient, stranger] =
    await hre.ethers.getSigners();

  const kyc = await deployKYCAdapter();
  await kyc.addToWhitelist(holder.address);
  await kyc.addToWhitelist(recipient.address);

  const registry = await deployRegistry();

  const token = await deployToken(
    await kyc.getAddress(),
    await registry.getAddress(),
    issuer.address
  );
  await registry.setAuthorizedCaller(await token.getAddress(), true);

  // Each encrypted input is scoped to the transaction sender that produced
  // it — `verifyInput` rejects if the prover identity doesn't match
  // msg.sender. The `mint` caller is `issuer`, so seed encryption is done
  // with the issuer's client. The holder's own transfer path uses its own
  // client.
  const issuerClient = await hre.cofhe.createClientWithBatteries(issuer);
  const holderClient = await hre.cofhe.createClientWithBatteries(holder);
  const acl = await hre.cofhe.mocks.getMockACL();

  return {
    deployer,
    issuer,
    holder,
    recipient,
    stranger,
    token,
    issuerClient,
    holderClient,
    acl,
  };
}

describe("MuHavenToken.refreshDecryptGrant (Phase 7 — PERMIT_DECRYPT_LIFECYCLE §8 Q4)", () => {
  it("grants a fresh ephemeralEOA on the caller's current balance handle", async () => {
    const { token, issuer, holder, issuerClient, acl } =
      await loadFixture(deployRefreshFixture);

    // Seed a balance via the Wave 3 legacy mint path (no ephemeralEOA grant).
    // Encryption is scoped to the tx sender — use issuer's client.
    const [enc] = await issuerClient
      .encryptInputs([Encryptable.uint128(100n)])
      .execute();
    await token.connect(issuer).mint(holder.address, enc);

    const balHandle = await token.encryptedBalanceOf(holder.address);

    // Baseline: fresh session EOA has no ACL on the existing handle.
    const freshEOA = createEphemeralEOA();
    expect(
      await acl.isAllowed(handleToUint(balHandle), freshEOA.address)
    ).to.equal(false);

    // Holder calls refreshDecryptGrant → ACL granted on the same handle.
    await expect(token.connect(holder).refreshDecryptGrant(freshEOA.address))
      .to.emit(token, "DecryptGrantRefreshed")
      .withArgs(holder.address, freshEOA.address);

    expect(
      await acl.isAllowed(handleToUint(balHandle), freshEOA.address)
    ).to.equal(true);
  });

  it("zero-balance caller is a no-op: emits event but grants nothing", async () => {
    const { token, recipient, acl } = await loadFixture(deployRefreshFixture);

    const freshEOA = createEphemeralEOA();

    // Pre-state: recipient has never held the token. `_balances[recipient]`
    // is uninitialised; we can't read its handle because the encrypted
    // balanceOf returns the zero-hash default.
    await expect(
      token.connect(recipient).refreshDecryptGrant(freshEOA.address)
    )
      .to.emit(token, "DecryptGrantRefreshed")
      .withArgs(recipient.address, freshEOA.address);

    // The encryptedBalanceOf getter returns the raw storage slot — zero-
    // hash when uninitialised. No ACL grant exists because the short-
    // circuit skipped the FHE.allow call.
    const balHandle = await token.encryptedBalanceOf(recipient.address);
    expect(handleToUint(balHandle)).to.equal(0n);
  });

  it("rejects a zero ephemeralEOA with InvalidEphemeralEOA", async () => {
    const { token, holder } = await loadFixture(deployRefreshFixture);

    await expect(
      token.connect(holder).refreshDecryptGrant(hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
  });

  it("recipient of a P2P transfer can self-refresh ACL to decrypt their balance", async () => {
    const {
      token,
      issuer,
      holder,
      recipient,
      issuerClient,
      holderClient,
      acl,
    } = await loadFixture(deployRefreshFixture);

    // 1. Holder gets an initial balance (issuer is the mint tx sender).
    const [mintEnc] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, mintEnc);

    // 2. Holder transfers 10 tokens to recipient (Wave 3 legacy 2-arg path —
    //    simulates the ADR-028 recipient-only-kernel-grant gap).
    const [xferEnc] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    // Wave 3 legacy 2-arg overload — ethers resolves on arity.
    await (token.connect(holder) as any).transfer(
      recipient.address,
      xferEnc
    );

    const recipBalHandle = await token.encryptedBalanceOf(recipient.address);

    // 3. Recipient on a fresh session EOA cannot decrypt yet.
    const recipEph = createEphemeralEOA();
    expect(
      await acl.isAllowed(handleToUint(recipBalHandle), recipEph.address)
    ).to.equal(false);

    // 4. Recipient calls refreshDecryptGrant — ACL granted on the
    //    *current* handle (post-transfer).
    await token.connect(recipient).refreshDecryptGrant(recipEph.address);
    expect(
      await acl.isAllowed(handleToUint(recipBalHandle), recipEph.address)
    ).to.equal(true);
  });

  it("refreshing to a new EOA does not revoke prior EOAs", async () => {
    const { token, issuer, holder, issuerClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [enc] = await issuerClient
      .encryptInputs([Encryptable.uint128(42n)])
      .execute();
    await token.connect(issuer).mint(holder.address, enc);
    const balHandle = await token.encryptedBalanceOf(holder.address);

    const eph1 = createEphemeralEOA();
    const eph2 = createEphemeralEOA();

    await token.connect(holder).refreshDecryptGrant(eph1.address);
    await token.connect(holder).refreshDecryptGrant(eph2.address);

    // Both grants survive — the CoFHE ACL is additive. Only a handle
    // rotation (new FHE op) invalidates stale grants.
    expect(await acl.isAllowed(handleToUint(balHandle), eph1.address)).to.equal(
      true
    );
    expect(await acl.isAllowed(handleToUint(balHandle), eph2.address)).to.equal(
      true
    );
  });

  it("does not grant access to other holders' balances", async () => {
    const { token, issuer, holder, recipient, issuerClient, acl } =
      await loadFixture(deployRefreshFixture);

    // Holder gets a balance; recipient does not touch it at all.
    const [enc] = await issuerClient
      .encryptInputs([Encryptable.uint128(7n)])
      .execute();
    await token.connect(issuer).mint(holder.address, enc);
    const holderBalHandle = await token.encryptedBalanceOf(holder.address);

    // Recipient calls refreshDecryptGrant with their own fresh EOA.
    const eph = createEphemeralEOA();
    await token.connect(recipient).refreshDecryptGrant(eph.address);

    // Recipient's EOA MUST NOT gain access to holder's balance handle.
    expect(
      await acl.isAllowed(handleToUint(holderBalHandle), eph.address)
    ).to.equal(false);
  });
});

// ── Phase 9.A · Option Z follow-up — refreshAuditGrant ─────────────────
//
// Mirrors `MuHavenStable.refreshAuditGrant` for Transfer audit handles. The
// broadened `Transfer(from, to, amount)` event carries the encrypted amount
// (`euint128 → bytes32`); both `from` and `to` had `FHE.allow(amount, ...)`
// stamped at emit time so either party can later re-grant ACL on the
// historical handle to a fresh ephemeral EOA. Strangers passing in someone
// else's audit handle bounce on the `FHE.isAllowed(handle, msg.sender)` gate.

function extractTransferAmount(token: any, receipt: any): string {
  const iface = token.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "Transfer") {
        return parsed.args[2] as string;
      }
    } catch {
      // Not from this contract — skip.
    }
  }
  throw new Error("No Transfer event in receipt");
}

describe("MuHavenToken.refreshAuditGrant (Phase 9.A · Option Z follow-up)", () => {
  it("rightful sender can re-grant a historical Transfer amount handle to a fresh session EOA", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    // Seed holder with a balance.
    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    // P2P transfer with the canonical 3-arg overload — sender's eph gets a
    // grant on the amount handle at emit time.
    const wrapEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        wrapEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    // Pre-state: a hypothetical fresh-session EOA has no ACL on the
    // transfer-time amount handle.
    const freshEph = createEphemeralEOA();
    expect(
      await acl.isAllowed(handleToUint(amountHandle), freshEph.address),
    ).to.equal(false);

    // Re-grant from the rightful sender (holder = sender's kernel).
    await expect(
      token.connect(holder).refreshAuditGrant(amountHandle, freshEph.address),
    )
      .to.emit(token, "AuditGrantRefreshed")
      .withArgs(holder.address, freshEph.address, amountHandle);

    expect(
      await acl.isAllowed(handleToUint(amountHandle), freshEph.address),
    ).to.equal(true);
    // Sender's kernel grant from the original transfer survives (additive).
    expect(
      await acl.isAllowed(handleToUint(amountHandle), holder.address),
    ).to.equal(true);
    // The wrap-time ephemeral was deliberately NOT stamped on the audit
    // handle — `_stampTransferAuditAcl` grants kernels only because the
    // amount handle aliases `_balances[recipient]` on first-recipient
    // transfers, and granting `fromEph` would expose the recipient's
    // fresh balance to the sender's session. Both parties bind their
    // session via `refreshAuditGrant` on first-decrypt instead.
    expect(
      await acl.isAllowed(handleToUint(amountHandle), wrapEph.address),
    ).to.equal(false);
  });

  it("transfer-time event handle is NOT granted to the sender's ephemeralEOA (privacy boundary)", async () => {
    // Regression-guard for the aliasing concern documented in
    // `_stampTransferAuditAcl`: when the recipient is a fresh holder, the
    // amount handle and `_balances[to]` are the same FHE handle by direct
    // assignment. A grant on the amount handle would leak the recipient's
    // new balance to the sender. We assert the sender's eph never lands
    // on the audit handle from the emit alone.
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    expect(
      await acl.isAllowed(handleToUint(amountHandle), senderEph.address),
    ).to.equal(false);
  });

  it("rightful recipient can re-grant the same handle to their own fresh session EOA (cross-session decrypt)", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    // Recipient's brand-new session EOA — no transfer-time grant.
    const recipFreshEph = createEphemeralEOA();
    expect(
      await acl.isAllowed(handleToUint(amountHandle), recipFreshEph.address),
    ).to.equal(false);

    // Recipient calls refreshAuditGrant — gate is `FHE.isAllowed(handle,
    // recipient)`, which passes because the emit stamped
    // `FHE.allow(amount, to)` at transfer time.
    await token
      .connect(recipient)
      .refreshAuditGrant(amountHandle, recipFreshEph.address);

    expect(
      await acl.isAllowed(handleToUint(amountHandle), recipFreshEph.address),
    ).to.equal(true);
  });

  it("stranger trying to re-grant someone else's Transfer audit handle reverts with NotAuditHandleOwner", async () => {
    const { token, issuer, holder, recipient, stranger, issuerClient, holderClient } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    // Stranger never participated in this transfer — no ACL on the handle.
    const strangerEph = createEphemeralEOA();
    await expect(
      token
        .connect(stranger)
        .refreshAuditGrant(amountHandle, strangerEph.address),
    ).to.be.revertedWithCustomError(token, "NotAuditHandleOwner");
  });

  it("rejects zero ephemeralEOA with InvalidEphemeralEOA", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    await expect(
      token
        .connect(holder)
        .refreshAuditGrant(amountHandle, hre.ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(token, "InvalidEphemeralEOA");
  });

  it("amount handle decrypts to the silent-fail-bounded actual transfer amount", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient } =
      await loadFixture(deployRefreshFixture);

    // Holder has 50 tokens. Tries to send 200 — silent-fail bounds to 0.
    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXferOver] = await holderClient
      .encryptInputs([Encryptable.uint128(200n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXferOver,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    // Transfer overshot balance — emitted handle is silent-fail-bounded to 0.
    await hre.cofhe.mocks.expectPlaintext(amountHandle, 0n);

    // Holder's balance is unchanged because the transfer was nullified.
    const holderBal = await token.encryptedBalanceOf(holder.address);
    await hre.cofhe.mocks.expectPlaintext(holderBal, 50n);
  });

  // ── Handle-aliasing privacy invariant (2026-05-09 hardening) ──────────
  //
  // Pre-2026-05-09, the first-receipt path did `_balances[to] =
  // transferAmount`, aliasing the storage slot to the audit handle. When
  // `_stampTransferAuditAcl(transferAmount, from, to)` then granted
  // `from` (sender's kernel) ACL on the audit handle, that grant
  // implicitly extended to `_balances[to]` (handles are keyed by ID).
  // Sender could call `getDecryptResultSafe(_balances[recipient])`
  // off-chain via the cofhe SDK and read the recipient's post-transfer
  // balance — privacy leak.
  //
  // Fix: the first-receipt branch wraps the assignment with
  // `FHE.add(zero, transferAmount)` so `_balances[to]` is a fresh
  // handle ID, distinct from the audit handle. Same shape applied in
  // `pullFromInvestor` and `returnToInvestor` for consistency.

  it("first-receipt path: recipient's balance handle is DISTINCT from the Transfer audit handle (no aliasing)", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    // Recipient has zero prior balance — this is the first-receipt path.
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);
    const recipientBal = await token.encryptedBalanceOf(recipient.address);

    // Pre-fix: these would be the SAME handle ID (direct alias).
    // Post-fix: `_balances[to] = FHE.add(zero, transferAmount)` mints a
    // fresh handle, so the IDs differ.
    expect(handleToUint(amountHandle)).to.not.equal(handleToUint(recipientBal));
    // Both decrypt to the same plaintext value (10) — fresh handle,
    // logically equivalent.
    await hre.cofhe.mocks.expectPlaintext(recipientBal, 10n);
    await hre.cofhe.mocks.expectPlaintext(amountHandle, 10n);
  });

  it("first-receipt path: sender's kernel does NOT have ACL on the recipient's balance handle (privacy invariant)", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const recipientBal = await token.encryptedBalanceOf(recipient.address);

    // Sender's kernel must NOT have ACL on the recipient's balance.
    // (Pre-fix this was `true` because of the aliasing leak.)
    expect(
      await acl.isAllowed(handleToUint(recipientBal), holder.address),
    ).to.equal(false);
    // Sender's eph is also not on the recipient's balance.
    expect(
      await acl.isAllowed(handleToUint(recipientBal), senderEph.address),
    ).to.equal(false);
    // Recipient's kernel IS allowed (legitimate balance owner).
    expect(
      await acl.isAllowed(handleToUint(recipientBal), recipient.address),
    ).to.equal(true);
  });

  it("first-receipt path: sender CAN still decrypt their own audit row (the fix doesn't break audit)", async () => {
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    const [encXfer] = await holderClient
      .encryptInputs([Encryptable.uint128(10n)])
      .execute();
    const tx = await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer,
        senderEph.address,
      );
    const receipt = await tx.wait();
    const amountHandle = extractTransferAmount(token, receipt);

    // The audit-handle ACL stamps still work post-fix:
    //  - sender's kernel can re-grant their own session via refreshAuditGrant.
    //  - recipient's kernel can re-grant their own session.
    // (We don't double-test the refresh path here — covered above —
    // we just verify the kernel grant survives, which is the entry
    // condition for `refreshAuditGrant`'s `FHE.isAllowed(handle,
    // msg.sender)` gate.)
    expect(
      await acl.isAllowed(handleToUint(amountHandle), holder.address),
    ).to.equal(true);
    expect(
      await acl.isAllowed(handleToUint(amountHandle), recipient.address),
    ).to.equal(true);
  });

  it("subsequent-receipt path also keeps the balance handle distinct (regression guard against the FHE.add organic-fresh assumption)", async () => {
    // Recipient already has shares from a prior transfer; the second
    // transfer hits the `Common.isInitialized(_balances[to])` branch
    // (`_balances[to] = FHE.add(_balances[to], transferAmount)`). This
    // path was never aliased — `FHE.add` always returns a fresh
    // handle — but the privacy invariant (sender's kernel must NOT
    // have ACL on the new recipient balance) is the same. Lock it in
    // to prevent a future refactor from accidentally re-introducing
    // an alias on this branch too.
    const { token, issuer, holder, recipient, issuerClient, holderClient, acl } =
      await loadFixture(deployRefreshFixture);

    const [encMint] = await issuerClient
      .encryptInputs([Encryptable.uint128(50n)])
      .execute();
    await token.connect(issuer).mint(holder.address, encMint);

    const senderEph = createEphemeralEOA();
    // First transfer — primes recipient balance.
    const [encXfer1] = await holderClient
      .encryptInputs([Encryptable.uint128(5n)])
      .execute();
    await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer1,
        senderEph.address,
      );
    // Second transfer — recipient balance is already initialised, so
    // we exercise the `FHE.add(_balances[to], transferAmount)` branch.
    const [encXfer2] = await holderClient
      .encryptInputs([Encryptable.uint128(7n)])
      .execute();
    await token
      .connect(holder)
      .getFunction("transfer(address,(uint256,uint8,uint8,bytes),address)")(
        recipient.address,
        encXfer2,
        senderEph.address,
      );
    const recipientBal = await token.encryptedBalanceOf(recipient.address);
    await hre.cofhe.mocks.expectPlaintext(recipientBal, 12n);

    // Sender remains locked out of the recipient's balance.
    expect(
      await acl.isAllowed(handleToUint(recipientBal), holder.address),
    ).to.equal(false);
  });
});
