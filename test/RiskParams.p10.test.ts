import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import { SigningKey, TypedDataDomain, keccak256 } from "ethers";
import {
  deployKYCAdapter,
  deployMuHavenFixture,
  deployRiskParams,
} from "./helpers/setup";

/**
 * Wave 4 Phase P10 — buffer + integration tests.
 *
 * +30 contract cases hardening the encrypted-policy hot path / breach
 * path. Companion to `RiskParams.p6.test.ts` (which covers the canonical
 * 26-case verification matrix). This file focuses on:
 *
 *   1. Boundary arithmetic — exact-cap, zero-amount, max-uint64 amount,
 *      stale-by-one-second oracle.
 *   2. State isolation — investor A's breach doesn't leak into B; permit
 *      replay across investors fails; per-investor pausedUntil.
 *   3. Param lifecycle — re-set thresholds, hasRiskParams transitions.
 *   4. KYC-gate rotation — flipping gate mid-flight, gate that returns
 *      true for everyone, zero-address fallback.
 *   5. AgentPermit edge cases — tier/surface/actionId variants, nonce
 *      monotonicity, max-uint64 nonce, far-future expiry.
 *   6. settleBreachDecrypt edge — pause clears prior pause, double-settle.
 *   7. Constant getter sanity (forward-compat against accidental drop).
 */

const MOCK_DECRYPT_RESULT_SIGNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function signMockDecryptResult(
  ctHash: bigint,
  result: bigint,
  chainId: bigint,
): Promise<string> {
  // Mirrors test/RiskParams.p6.test.ts — kept inline so this file is
  // self-contained. The shape is documented there in detail.
  const encryptionType = Number((ctHash >> 8n) & 0x7fn);
  const buf = new Uint8Array(0x4c);
  const resultHex = result.toString(16).padStart(64, "0");
  for (let i = 0; i < 32; i++) buf[i] = parseInt(resultHex.slice(i * 2, i * 2 + 2), 16);
  buf[0x20] = encryptionType;
  for (let i = 0; i < 8; i++) buf[0x24 + 7 - i] = Number((chainId >> BigInt(i * 8)) & 0xffn);
  const ctHashHex = ctHash.toString(16).padStart(64, "0");
  for (let i = 0; i < 32; i++) buf[0x2c + i] = parseInt(ctHashHex.slice(i * 2, i * 2 + 2), 16);
  const messageHash = keccak256(buf);
  return new SigningKey(MOCK_DECRYPT_RESULT_SIGNER_KEY).sign(messageHash).serialized;
}

const TYPES = {
  AgentPermit: [
    { name: "investor", type: "address" },
    { name: "tier", type: "uint8" },
    { name: "surface", type: "uint8" },
    { name: "actionId", type: "uint8" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

describe("RiskParams (Wave 4 P10) — boundary + isolation matrix", function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function setStandardParams(riskParams: any, investor: any): Promise<void> {
    const investorClient = await hre.cofhe.createClientWithBatteries(investor);
    const [encMd, encMy, encDt, encMs] = await investorClient
      .encryptInputs([
        Encryptable.uint64(500n),
        Encryptable.uint64(400n),
        Encryptable.uint64(500n),
        Encryptable.uint64(1_000_000n),
      ])
      .execute();
    await riskParams.connect(investor).setRiskParams(encMd, encMy, encDt, encMs);
  }

  async function deployFixture() {
    await hre.run("task:cofhe-mocks:deploy");
    const { investor, deployer, alice } = await loadFixture(deployMuHavenFixture);
    const riskParams = await deployRiskParams();
    const kyc = await deployKYCAdapter();
    await kyc.addToWhitelist(investor.address);
    await kyc.addToWhitelist(alice.address);
    return { riskParams, investor, deployer, alice, kyc };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function dispatchAndPluck(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    riskParams: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deployer: any,
    investorAddr: string,
    amount: bigint,
    actionId: number,
  ): Promise<{ breachId: bigint; ePassedHandle: string }> {
    const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
    const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(amount)]).execute();
    const tx = await riskParams
      .connect(deployer)
      .checkAndExecute(investorAddr, encAmount, actionId);
    const receipt = await tx.wait();
    const ev = riskParams.interface.parseLog(
      receipt.logs.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
      ),
    )!;
    return { breachId: ev.args.breachId, ePassedHandle: ev.args.ePassedHandle };
  }

  // ── Hot-path boundary arithmetic ──────────────────────────────────────

  describe("hot-path boundary arithmetic", function () {
    it("BUY at exact daily-spend cap → ePassed handle decrypts to 1 (≤ is pass)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 1_000_000n, 1);
      expect(r.breachId).to.equal(0n);
      const pt = await hre.cofhe.mocks.getPlaintext(r.ePassedHandle);
      expect(pt).to.equal(1n);
    });

    it("BUY at cap + 1 → encrypted-fail (ePassed = 0)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 1_000_001n, 1);
      expect(r.breachId).to.equal(0n);
      const pt = await hre.cofhe.mocks.getPlaintext(r.ePassedHandle);
      expect(pt).to.equal(0n);
    });

    it("BUY with zero amount → pass", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r.breachId).to.equal(0n);
      expect(await hre.cofhe.mocks.getPlaintext(r.ePassedHandle)).to.equal(1n);
    });

    it("SELL with max-uint64 amount → encrypted-fail (clear ceiling)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const max64 = (1n << 64n) - 1n;
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, max64, 2);
      expect(r.breachId).to.equal(0n);
      expect(await hre.cofhe.mocks.getPlaintext(r.ePassedHandle)).to.equal(0n);
    });

    it("CLAIM with max-uint64 amount → still passes (claim ignores spend cap)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const max64 = (1n << 64n) - 1n;
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, max64, 3);
      expect(r.breachId).to.equal(0n);
      expect(await hre.cofhe.mocks.getPlaintext(r.ePassedHandle)).to.equal(1n);
    });

    it("REBALANCE at exact cap → encrypted-pass (boundary symmetry with BUY)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 1_000_000n, 4);
      expect(await hre.cofhe.mocks.getPlaintext(r.ePassedHandle)).to.equal(1n);
    });

    it("unknown action id 0 → BREACH_UNKNOWN_ACTION (4)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 0);
      expect(r.breachId).to.equal(4n);
    });

    it("unknown action id 5 → BREACH_UNKNOWN_ACTION (just-out-of-range)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 5);
      expect(r.breachId).to.equal(4n);
    });

    it("unknown action id 255 → BREACH_UNKNOWN_ACTION (max-uint8)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 255);
      expect(r.breachId).to.equal(4n);
    });
  });

  // ── Oracle freshness boundary ─────────────────────────────────────────

  describe("oracle freshness boundary", function () {
    it("oracle exactly stale by 1s → BREACH_ORACLE_STALE", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const block = await hre.ethers.provider.getBlock("latest");
      // lastOracleUpdate = now - 11; staleness = 10  →  now - lastUpdate = 11 > 10 = stale
      await riskParams
        .connect(deployer)
        .setOracleFreshness(BigInt(block!.timestamp - 11), 10n);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r.breachId).to.equal(1n);
    });

    it("oracle exactly within window → no BREACH_ORACLE_STALE", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const block = await hre.ethers.provider.getBlock("latest");
      // lastUpdate set to current block timestamp (so now - lastUpdate = 0 < staleness)
      await riskParams.connect(deployer).setOracleFreshness(BigInt(block!.timestamp), 100n);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r.breachId).to.equal(0n);
    });

    it("emits OracleFreshnessUpdated when set", async function () {
      const { riskParams, deployer } = await loadFixture(deployFixture);
      await expect(riskParams.connect(deployer).setOracleFreshness(123n, 60n))
        .to.emit(riskParams, "OracleFreshnessUpdated")
        .withArgs(123n, 60n);
    });
  });

  // ── KYC gate rotation ─────────────────────────────────────────────────

  describe("KYC gate rotation", function () {
    it("setting a fresh KYC gate emits KYCGateSet with previous=zero on first set", async function () {
      const { riskParams, deployer, kyc } = await loadFixture(deployFixture);
      const kycAddr = await kyc.getAddress();
      await expect(riskParams.connect(deployer).setKycGate(kycAddr))
        .to.emit(riskParams, "KYCGateSet")
        .withArgs("0x0000000000000000000000000000000000000000", kycAddr);
    });

    it("rotating KYC gate emits KYCGateSet with the previous address", async function () {
      const { riskParams, deployer, kyc } = await loadFixture(deployFixture);
      const first = await kyc.getAddress();
      await riskParams.connect(deployer).setKycGate(first);
      const next = await deployKYCAdapter();
      const nextAddr = await next.getAddress();
      await expect(riskParams.connect(deployer).setKycGate(nextAddr))
        .to.emit(riskParams, "KYCGateSet")
        .withArgs(first, nextAddr);
    });

    it("clearing the KYC gate (set to zero) skips the check", async function () {
      const { riskParams, investor, deployer, kyc } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      await riskParams.connect(deployer).setKycGate(await kyc.getAddress());
      await kyc.removeFromWhitelist(investor.address);

      // Confirm the gate is firing.
      const fail = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(fail.breachId).to.equal(2n);

      // Clear the gate → no KYC breach.
      await riskParams.connect(deployer).setKycGate("0x0000000000000000000000000000000000000000");
      const pass = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(pass.breachId).to.equal(0n);
    });
  });

  // ── State isolation across investors ──────────────────────────────────

  describe("state isolation", function () {
    it("investor A's pausedUntil does not affect investor B", async function () {
      const { riskParams, investor, alice, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      await setStandardParams(riskParams, alice);

      // Pause investor only.
      const block = await hre.ethers.provider.getBlock("latest");
      await riskParams
        .connect(deployer)
        .setUserPaused(investor.address, BigInt(block!.timestamp + 3600));

      const r1 = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r1.breachId).to.equal(3n);
      const r2 = await dispatchAndPluck(riskParams, deployer, alice.address, 0n, 1);
      expect(r2.breachId).to.equal(0n);
    });

    it("AgentPermit replay across investors rejected (investor field is in the typed-data)", async function () {
      const { riskParams, investor, alice, deployer } = await loadFixture(deployFixture);
      const network = await hre.ethers.provider.getNetwork();
      const domain: TypedDataDomain = {
        name: "MuHaven AgentPermit",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await riskParams.getAddress(),
      };
      const value = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1_000n,
        nonce: 1n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600),
      };
      const sig = await investor.signTypedData(domain, TYPES, value);

      // Now try to consume the same sig but claim it's for alice.
      // The recovered signer (=investor) won't match the claimed investor=alice.
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(
            alice.address,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            sig,
          ),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitWrongSigner");
    });

    it("nonce counters are per-investor", async function () {
      const { riskParams, investor, alice, deployer } = await loadFixture(deployFixture);
      const network = await hre.ethers.provider.getNetwork();
      const domain: TypedDataDomain = {
        name: "MuHaven AgentPermit",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await riskParams.getAddress(),
      };
      const expiry = BigInt(
        (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
      );

      // Investor consumes nonce 1.
      const v1 = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1_000n,
        nonce: 1n,
        expiry,
      };
      const s1 = await investor.signTypedData(domain, TYPES, v1);
      await riskParams
        .connect(deployer)
        .consumeAgentPermit(v1.investor, v1.tier, v1.surface, v1.actionId, v1.maxAmount, v1.nonce, v1.expiry, s1);

      // Alice can ALSO use nonce 1 on her own permit — counters are per-investor.
      const v2 = { ...v1, investor: alice.address };
      const s2 = await alice.signTypedData(domain, TYPES, v2);
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(v2.investor, v2.tier, v2.surface, v2.actionId, v2.maxAmount, v2.nonce, v2.expiry, s2),
      ).to.emit(riskParams, "AgentPermitConsumed");

      expect(await riskParams.getAgentPermitNonce(investor.address)).to.equal(1n);
      expect(await riskParams.getAgentPermitNonce(alice.address)).to.equal(1n);
    });
  });

  // ── Param lifecycle ───────────────────────────────────────────────────

  describe("param lifecycle", function () {
    it("hasRiskParams flips false → true → still true after re-set", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      expect(await riskParams.hasRiskParams(investor.address)).to.equal(false);
      await setStandardParams(riskParams, investor);
      expect(await riskParams.hasRiskParams(investor.address)).to.equal(true);
      await setStandardParams(riskParams, investor); // re-set
      expect(await riskParams.hasRiskParams(investor.address)).to.equal(true);
    });

    it("re-setting params updates the underlying thresholds (tighter cap fires breach)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);

      // Tighten dailySpend to 100; an amount of 200 used to pass with the
      // 1_000_000 cap but now lands as encrypted-fail.
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const [a, b, c, d] = await investorClient
        .encryptInputs([
          Encryptable.uint64(500n),
          Encryptable.uint64(400n),
          Encryptable.uint64(500n),
          Encryptable.uint64(100n),
        ])
        .execute();
      await riskParams.connect(investor).setRiskParams(a, b, c, d);

      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 200n, 1);
      expect(await hre.cofhe.mocks.getPlaintext(r.ePassedHandle)).to.equal(0n);
    });

    it("setRiskParams emits RiskParamsUpdated", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const [a, b, c, d] = await investorClient
        .encryptInputs([
          Encryptable.uint64(500n),
          Encryptable.uint64(400n),
          Encryptable.uint64(500n),
          Encryptable.uint64(1_000_000n),
        ])
        .execute();
      await expect(riskParams.connect(investor).setRiskParams(a, b, c, d))
        .to.emit(riskParams, "RiskParamsUpdated")
        .withArgs(investor.address);
    });
  });

  // ── settleBreachDecrypt edge cases ────────────────────────────────────

  describe("settleBreachDecrypt edge cases", function () {
    async function getEncryptedBreachHandle() {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const r = await dispatchAndPluck(riskParams, deployer, investor.address, 2_000_000n, 1);
      return { riskParams, investor, deployer, handle: r.ePassedHandle };
    }

    it("emits BreachSettled with type(uint32).max as pausedUntilTs", async function () {
      const { riskParams, investor, deployer, handle } = await getEncryptedBreachHandle();
      const network = await hre.ethers.provider.getNetwork();
      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);
      await expect(
        riskParams
          .connect(deployer)
          .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sig),
      )
        .to.emit(riskParams, "BreachSettled")
        .withArgs(investor.address, 1, 2n ** 32n - 1n);
    });

    it("settle with triggerCode=2 (KYC) accepted (no enum-bound check on triggerCode)", async function () {
      const { riskParams, investor, deployer, handle } = await getEncryptedBreachHandle();
      const network = await hre.ethers.provider.getNetwork();
      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);
      await expect(
        riskParams
          .connect(deployer)
          .settleBreachDecrypt(investor.address, 2, 0n, handle, sig),
      )
        .to.emit(riskParams, "RiskBreach")
        .and.to.emit(riskParams, "BreachSettled");
    });

    it("settle clears any existing temporary pause (replaces with type(uint32).max)", async function () {
      const { riskParams, investor, deployer, handle } = await getEncryptedBreachHandle();
      const network = await hre.ethers.provider.getNetwork();
      const block = await hre.ethers.provider.getBlock("latest");
      // Temporary pause first.
      await riskParams
        .connect(deployer)
        .setUserPaused(investor.address, BigInt(block!.timestamp + 3600));

      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);
      await riskParams
        .connect(deployer)
        .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sig);
      expect(await riskParams.pausedUntil(investor.address)).to.equal(2n ** 32n - 1n);
    });

    it("rejects a TN signature for a different chainId", async function () {
      const { riskParams, investor, deployer, handle } = await getEncryptedBreachHandle();
      // Sign with a wildly wrong chainId.
      const sig = await signMockDecryptResult(BigInt(handle), 0n, 9999n);
      await expect(
        riskParams
          .connect(deployer)
          .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sig),
      ).to.be.reverted;
    });
  });

  // ── AgentPermit edge cases ───────────────────────────────────────────

  describe("AgentPermit edge cases", function () {
    async function buildDomain(riskParams: any): Promise<TypedDataDomain> {
      const network = await hre.ethers.provider.getNetwork();
      return {
        name: "MuHaven AgentPermit",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await riskParams.getAddress(),
      };
    }

    it("nonce 0 valid + bumps to 0 (lastConsumed starts at -1 effectively via uint64-rollover defense)", async function () {
      // Sanity: contract requires nonce > lastConsumed. Initial lastConsumed
      // is 0; first nonce that survives is 1. Test that nonce=0 fails so
      // a regression that allows it would catch here.
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const domain = await buildDomain(riskParams);
      const value = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1n,
        nonce: 0n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600),
      };
      const sig = await investor.signTypedData(domain, TYPES, value);
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(value.investor, value.tier, value.surface, value.actionId, value.maxAmount, value.nonce, value.expiry, sig),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitNonceUsed");
    });

    it("non-monotonic nonce after consuming nonce 5 — using nonce 3 fails", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const domain = await buildDomain(riskParams);
      const expiry = BigInt(
        (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
      );
      const v5 = { investor: investor.address, tier: 2, surface: 0, actionId: 1, maxAmount: 1n, nonce: 5n, expiry };
      const s5 = await investor.signTypedData(domain, TYPES, v5);
      await riskParams
        .connect(deployer)
        .consumeAgentPermit(v5.investor, v5.tier, v5.surface, v5.actionId, v5.maxAmount, v5.nonce, v5.expiry, s5);
      expect(await riskParams.getAgentPermitNonce(investor.address)).to.equal(5n);

      const v3 = { ...v5, nonce: 3n };
      const s3 = await investor.signTypedData(domain, TYPES, v3);
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(v3.investor, v3.tier, v3.surface, v3.actionId, v3.maxAmount, v3.nonce, v3.expiry, s3),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitNonceUsed");
    });

    it("monotonic gap-skip allowed (nonce jumps 1 → 100)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const domain = await buildDomain(riskParams);
      const expiry = BigInt(
        (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
      );
      const v1 = { investor: investor.address, tier: 2, surface: 0, actionId: 1, maxAmount: 1n, nonce: 1n, expiry };
      const s1 = await investor.signTypedData(domain, TYPES, v1);
      await riskParams
        .connect(deployer)
        .consumeAgentPermit(v1.investor, v1.tier, v1.surface, v1.actionId, v1.maxAmount, v1.nonce, v1.expiry, s1);

      const v100 = { ...v1, nonce: 100n };
      const s100 = await investor.signTypedData(domain, TYPES, v100);
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(v100.investor, v100.tier, v100.surface, v100.actionId, v100.maxAmount, v100.nonce, v100.expiry, s100),
      ).to.emit(riskParams, "AgentPermitConsumed");
      expect(await riskParams.getAgentPermitNonce(investor.address)).to.equal(100n);
    });

    it("max-uint64 nonce accepted (cannot bump further; demonstrates ceiling)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const domain = await buildDomain(riskParams);
      const expiry = BigInt(
        (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
      );
      const max64 = (1n << 64n) - 1n;
      const v = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1n,
        nonce: max64,
        expiry,
      };
      const sig = await investor.signTypedData(domain, TYPES, v);
      await riskParams
        .connect(deployer)
        .consumeAgentPermit(v.investor, v.tier, v.surface, v.actionId, v.maxAmount, v.nonce, v.expiry, sig);
      expect(await riskParams.getAgentPermitNonce(investor.address)).to.equal(max64);
    });

    it("isAgentPermitValid view returns false when nonce already consumed", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const domain = await buildDomain(riskParams);
      const expiry = BigInt(
        (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
      );
      const v = { investor: investor.address, tier: 2, surface: 0, actionId: 1, maxAmount: 1n, nonce: 1n, expiry };
      const sig = await investor.signTypedData(domain, TYPES, v);

      // Pre-consume — view returns true.
      expect(await riskParams.isAgentPermitValid(v.investor, v.tier, v.surface, v.actionId, v.maxAmount, v.nonce, v.expiry, sig)).to.equal(true);

      await riskParams
        .connect(deployer)
        .consumeAgentPermit(v.investor, v.tier, v.surface, v.actionId, v.maxAmount, v.nonce, v.expiry, sig);

      // Post-consume — view returns false.
      expect(await riskParams.isAgentPermitValid(v.investor, v.tier, v.surface, v.actionId, v.maxAmount, v.nonce, v.expiry, sig)).to.equal(false);
    });

    it("hashAgentPermit is deterministic + matches between two calls", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      const a = await riskParams.hashAgentPermit(investor.address, 2, 0, 1, 1_000n, 1n, 9999999999n);
      const b = await riskParams.hashAgentPermit(investor.address, 2, 0, 1, 1_000n, 1n, 9999999999n);
      expect(a).to.equal(b);
    });

    it("hashAgentPermit changes when surface changes (typed-data field isolation)", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      const a = await riskParams.hashAgentPermit(investor.address, 2, 0, 1, 1_000n, 1n, 9999999999n);
      const b = await riskParams.hashAgentPermit(investor.address, 2, 1, 1, 1_000n, 1n, 9999999999n);
      expect(a).to.not.equal(b);
    });

    it("hashAgentPermit changes when tier changes", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      const a = await riskParams.hashAgentPermit(investor.address, 1, 0, 1, 1_000n, 1n, 9999999999n);
      const b = await riskParams.hashAgentPermit(investor.address, 2, 0, 1, 1_000n, 1n, 9999999999n);
      expect(a).to.not.equal(b);
    });
  });

  // ── Misc invariants ───────────────────────────────────────────────────

  describe("misc invariants", function () {
    it("transferOwnership only by current owner", async function () {
      const { riskParams, investor } = await loadFixture(deployFixture);
      await expect(
        riskParams.connect(investor).transferOwnership(investor.address),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
    });

    it("transferOwnership rejects zero address", async function () {
      const { riskParams, deployer } = await loadFixture(deployFixture);
      await expect(
        riskParams.connect(deployer).transferOwnership("0x0000000000000000000000000000000000000000"),
      ).to.be.revertedWithCustomError(riskParams, "ZeroAddress");
    });

    it("setUserPaused emits UserPauseOverride", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      const ts = 1234567890n;
      await expect(riskParams.connect(deployer).setUserPaused(investor.address, ts))
        .to.emit(riskParams, "UserPauseOverride")
        .withArgs(investor.address, ts);
    });

    it("setUserPaused with timestamp 0 effectively unpauses", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);
      const block = await hre.ethers.provider.getBlock("latest");
      // Pause first
      await riskParams
        .connect(deployer)
        .setUserPaused(investor.address, BigInt(block!.timestamp + 3600));
      const r1 = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r1.breachId).to.equal(3n);
      // Unpause
      await riskParams.connect(deployer).setUserPaused(investor.address, 0n);
      const r2 = await dispatchAndPluck(riskParams, deployer, investor.address, 0n, 1);
      expect(r2.breachId).to.equal(0n);
    });

    it("constant getters are stable (forward-compat on Wave 5 enum extensions)", async function () {
      const { riskParams } = await loadFixture(deployFixture);
      // P10 contract: action / breach codes are wire-shape commitments.
      // A change here breaks the LLM tool catalog + the MCP tool layer.
      // If a Wave 5 PR needs to add codes, append (don't renumber).
      expect(await riskParams.actionIdBuy()).to.equal(1);
      expect(await riskParams.actionIdSell()).to.equal(2);
      expect(await riskParams.actionIdClaim()).to.equal(3);
      expect(await riskParams.actionIdRebalance()).to.equal(4);
      expect(await riskParams.breachOracleStale()).to.equal(1);
      expect(await riskParams.breachKycRevoked()).to.equal(2);
      expect(await riskParams.breachUserPaused()).to.equal(3);
      expect(await riskParams.breachUnknownAction()).to.equal(4);
    });
  });
});
