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
