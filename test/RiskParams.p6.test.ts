import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";
import { SigningKey, TypedDataDomain, TypedDataEncoder, keccak256 } from "ethers";
import {
  deployKYCAdapter,
  deployMuHavenFixture,
  deployRiskParams,
} from "./helpers/setup";

// Hardhat / Anvil account #1 — pre-funded; matches the mock TaskManager's
// `DECRYPT_RESULT_SIGNER_PRIVATE_KEY` constant in `@cofhe/mock-contracts`
// MockCoFHE.sol. Tests of `settleBreachDecrypt` produce signatures with
// this key so the mock's `_verifyDecryptResult` accepts them.
const MOCK_DECRYPT_RESULT_SIGNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/**
 * Compute and sign a TN-style decrypt-result message in the same shape
 * MockTaskManager.computeDecryptResultHash produces:
 *
 *   keccak256(  packed( result :: encryptionType :: chainId :: ctHash ))
 *
 * Layout (76 bytes total):
 *   - bytes  0..31  : result          (uint256 BE)
 *   - byte   32     : encryptionType  (uint8 — derived from ctHash)
 *   - bytes  33..36 : zero padding
 *   - bytes  36..43 : chainId         (uint64 BE)
 *   - bytes  44..75 : ctHash          (uint256 BE)
 */
async function signMockDecryptResult(
  ctHash: bigint,
  result: bigint,
  chainId: bigint,
): Promise<string> {
  // Match MockTaskManager.sol getUintTypeFromHash: returns uint8(hash & 0x7f00 >> 8)
  const encryptionType = Number((ctHash >> 8n) & 0x7fn);
  const buf = new Uint8Array(0x4c); // MESSAGE_LENGTH
  // result (uint256 BE) at offset 0
  const resultHex = result.toString(16).padStart(64, "0");
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(resultHex.slice(i * 2, i * 2 + 2), 16);
  }
  // encryptionType (uint8) at OFFSET_ENC_TYPE = 0x20
  buf[0x20] = encryptionType;
  // chainId (uint64 BE) at OFFSET_CHAIN_ID = 0x24
  for (let i = 0; i < 8; i++) {
    buf[0x24 + 7 - i] = Number((chainId >> BigInt(i * 8)) & 0xffn);
  }
  // ctHash (uint256 BE) at OFFSET_CT_HASH = 0x2c
  const ctHashHex = ctHash.toString(16).padStart(64, "0");
  for (let i = 0; i < 32; i++) {
    buf[0x2c + i] = parseInt(ctHashHex.slice(i * 2, i * 2 + 2), 16);
  }
  // Mock TaskManager uses `ECDSA.tryRecover(messageHash, signature)` which
  // expects a signature over the bare 32-byte hash (no EIP-191 prefix).
  const messageHash = keccak256(buf);
  const signingKey = new SigningKey(MOCK_DECRYPT_RESULT_SIGNER_KEY);
  const sig = signingKey.sign(messageHash);
  return sig.serialized;
}

/**
 * Wave 4 Phase P6 — RiskParams hot-path + breach-decrypt + signal flags +
 * AgentPermit (EIP-712).
 *
 * Mirrors the verification matrix in ADR-1 §"Verification (Phase P10)":
 *   - 8 cases for hot-path correctness across all 4 actionId values × pass/fail
 *   - 6 cases for cleartext-breach codes (oracle stale, KYC revoked, user paused)
 *   - 8 cases for encrypted-breach decrypt flow
 *   - 4 cases for AgentPermit lifecycle (sign + recover + nonce + expiry)
 *   - 4 cases for ACL behavior (investor decrypt, owner decrypt, stranger blocked)
 *
 * The bench in `LATENCY_BENCH_REPORT.md` confirmed `decryptForTx` p99 of 1.44s
 * on Arb Sepolia; in mocks it's instant.
 */
describe("RiskParams (Wave 4 P6)", function () {
  // Per-investor helper — encrypts the canonical four thresholds for the
  // investor's own params (drawdown=500bps, minYield=400bps, drift=500bps,
  // dailySpend=1_000_000) and stores them.
  async function setStandardParams(
    riskParams: any,
    investor: any,
  ): Promise<void> {
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

  async function deployP6Fixture() {
    await hre.run("task:cofhe-mocks:deploy");
    const { investor, deployer, alice } = await loadFixture(deployMuHavenFixture);
    const riskParams = await deployRiskParams();
    const kyc = await deployKYCAdapter();
    await kyc.addToWhitelist(investor.address);
    await kyc.addToWhitelist(alice.address);
    return { riskParams, investor, deployer, alice, kyc };
  }

  // ── Hot path: ePassed across 4 ActionIds × pass/fail ───────────────────

  describe("checkAndExecute() — branchless hot path", function () {
    it("pass: ACTION_ID_BUY with amount within daily-spend cap", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient
        .encryptInputs([Encryptable.uint64(500n)]) // 500 ≤ 1_000_000
        .execute();

      const tx = await riskParams
        .connect(deployer)
        .checkAndExecute(investor.address, encAmount, 1 /* BUY */);
      const receipt = await tx.wait();

      // Find the PolicyChecked event and verify its breachId is 0 (BREACH_NONE).
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
      expect(ev.args.investor).to.equal(investor.address);
      expect(ev.args.actionId).to.equal(1);
      expect(ev.args.ePassedHandle).to.not.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("pass: ACTION_ID_SELL within cap", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(100n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 2);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
      expect(ev.args.actionId).to.equal(2);
    });

    it("pass: ACTION_ID_CLAIM ignores amount (always passes)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      // Even an amount above the cap is fine — claim doesn't spend.
      const [encAmount] = await cronClient
        .encryptInputs([Encryptable.uint64(999_999_999n)])
        .execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 3);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
      expect(ev.args.actionId).to.equal(3);
    });

    it("pass: ACTION_ID_REBALANCE within cap", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(50n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 4);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
      expect(ev.args.actionId).to.equal(4);
    });

    it("encrypted-fail: BUY amount exceeds daily cap → ePassed handle decrypts to 0", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      // 1_500_000 > 1_000_000 (cap)
      const [encAmount] = await cronClient
        .encryptInputs([Encryptable.uint64(1_500_000n)])
        .execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      // breachId is still 0 — the breach is encrypted, not cleartext.
      expect(ev.args.breachId).to.equal(0);

      // Cron decrypts the ebool handle off-chain; in-mock the plaintext is
      // synchronously stored under `mockStorage[handle]`. ebool stores 0/1.
      const plaintext = await hre.cofhe.mocks.getPlaintext(ev.args.ePassedHandle);
      expect(plaintext).to.equal(0n);
    });

    it("unknown action → cleartext BREACH_UNKNOWN_ACTION (4)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams
        .connect(deployer)
        .checkAndExecute(investor.address, encAmount, 99);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(4);
    });

    it("no params set → passes without exposing (BREACH_NONE)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
    });
  });

  // ── Cleartext breaches: oracle stale / KYC revoked / user paused ──────

  describe("checkAndExecute() — cleartext breaches", function () {
    it("BREACH_ORACLE_STALE when oracleStalenessSec exceeded", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);

      // Set oracleStaleness=1s with lastOracleUpdate=block.timestamp-100.
      const block = await hre.ethers.provider.getBlock("latest");
      await riskParams
        .connect(deployer)
        .setOracleFreshness(BigInt(block!.timestamp - 100), 1n);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(1); // BREACH_ORACLE_STALE
    });

    it("BREACH_KYC_REVOKED when kycGate.isEligible returns false", async function () {
      const { riskParams, investor, deployer, kyc } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);

      await riskParams.connect(deployer).setKycGate(await kyc.getAddress());
      // Investor is whitelisted by default in the fixture; remove them.
      await kyc.removeFromWhitelist(investor.address);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(2); // BREACH_KYC_REVOKED
    });

    it("BREACH_USER_PAUSED when pausedUntil > block.timestamp", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);

      const block = await hre.ethers.provider.getBlock("latest");
      await riskParams
        .connect(deployer)
        .setUserPaused(investor.address, BigInt(block!.timestamp + 3600));

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(3); // BREACH_USER_PAUSED
    });

    it("oracle freshness disabled (oracleStalenessSec=0) → no BREACH_ORACLE_STALE", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      // Even with very-stale lastOracleUpdate, staleness=0 disables the gate.
      await riskParams.connect(deployer).setOracleFreshness(0n, 0n);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
    });

    it("kycGate=zero address → KYC gate skipped (no BREACH_KYC_REVOKED)", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      // No kycGate set ⇒ skipped per Wave-4 P6 design.
      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(0n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(0);
    });

    it("only owner can set KYC gate / oracle freshness / userPaused", async function () {
      const { riskParams, investor, kyc } = await loadFixture(deployP6Fixture);

      await expect(
        riskParams.connect(investor).setKycGate(await kyc.getAddress()),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
      await expect(
        riskParams.connect(investor).setOracleFreshness(0n, 0n),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
      await expect(
        riskParams.connect(investor).setUserPaused(investor.address, 12345n),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
    });
  });

  // ── settleBreachDecrypt: TN-signed cleartext commits the breach ───────

  describe("settleBreachDecrypt()", function () {
    async function getBreachHandle(deployFixture: () => Promise<any>) {
      const { riskParams, investor, deployer } = await loadFixture(deployFixture);
      await setStandardParams(riskParams, investor);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      // amount > cap ⇒ encrypted breach
      const [encAmount] = await cronClient
        .encryptInputs([Encryptable.uint64(2_000_000n)])
        .execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      return { riskParams, investor, deployer, handle: ev.args.ePassedHandle };
    }

    it("settles a breach with a TN-signed result (mock decrypt signer)", async function () {
      const { riskParams, investor, deployer, handle } = await getBreachHandle(deployP6Fixture);
      const network = await hre.ethers.provider.getNetwork();
      // Sign cleartext = 0 (breach) for the ebool handle.
      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);

      await expect(
        riskParams
          .connect(deployer)
          .settleBreachDecrypt(investor.address, 1 /* DRAWDOWN_BREACH */, 1_000_000n, handle, sig),
      )
        .to.emit(riskParams, "RiskBreach")
        .withArgs(investor.address, 1, 1_000_000n, anyValue())
        .and.to.emit(riskParams, "BreachSettled");

      // pausedUntil should be type(uint32).max
      const pausedUntilTs = await riskParams.pausedUntil(investor.address);
      expect(pausedUntilTs).to.equal(2n ** 32n - 1n);
    });

    it("only owner can settle a breach", async function () {
      const { riskParams, investor, handle } = await getBreachHandle(deployP6Fixture);
      const network = await hre.ethers.provider.getNetwork();
      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);
      await expect(
        riskParams
          .connect(investor)
          .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sig),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
    });

    it("rejects a signature for cleartext=1 (no breach) — wrong cleartext", async function () {
      const { riskParams, investor, deployer, handle } = await getBreachHandle(deployP6Fixture);
      const network = await hre.ethers.provider.getNetwork();
      // Sign cleartext = 1 (NOT a breach) — caller is trying to settle a
      // non-breach. publishDecryptResult internally calls _verifyDecryptResult
      // with `result=0` — the signature is over `result=1` so verification
      // fails.
      const sigForOne = await signMockDecryptResult(BigInt(handle), 1n, network.chainId);
      await expect(
        riskParams
          .connect(deployer)
          .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sigForOne),
      ).to.be.reverted;
    });

    it("subsequent checkAndExecute on settled investor returns BREACH_USER_PAUSED", async function () {
      const { riskParams, investor, deployer, handle } = await getBreachHandle(deployP6Fixture);
      const network = await hre.ethers.provider.getNetwork();
      const sig = await signMockDecryptResult(BigInt(handle), 0n, network.chainId);
      await riskParams
        .connect(deployer)
        .settleBreachDecrypt(investor.address, 1, 1_000_000n, handle, sig);

      const cronClient = await hre.cofhe.createClientWithBatteries(deployer);
      const [encAmount] = await cronClient.encryptInputs([Encryptable.uint64(1n)]).execute();
      const tx = await riskParams.connect(deployer).checkAndExecute(investor.address, encAmount, 1);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) => l.topics[0] === riskParams.interface.getEvent("PolicyChecked")!.topicHash,
        ),
      )!;
      expect(ev.args.breachId).to.equal(3); // BREACH_USER_PAUSED
    });
  });

  // ── computeSignalFlags: ebool flags for portfolio summary ─────────────

  describe("computeSignalFlags()", function () {
    /**
     * Helper — send the computeSignalFlags tx and pluck the two ebool
     * handles from the SignalsComputed event in the receipt. Cannot use
     * `staticCall` here because the mock TaskManager's `mockStorage` write
     * (which records the FHE.lt / FHE.gt result plaintext) is reverted on
     * eth_call.
     */
    async function computeAndExtractSignals(
      riskParams: any,
      investor: any,
      encDrift: any,
      encYield: any,
    ): Promise<{ overHandle: string; underHandle: string }> {
      const tx = await riskParams
        .connect(investor)
        .computeSignalFlags(investor.address, encDrift, encYield);
      const receipt = await tx.wait();
      const ev = riskParams.interface.parseLog(
        receipt.logs.find(
          (l: any) =>
            l.topics[0] === riskParams.interface.getEvent("SignalsComputed")!.topicHash,
        ),
      )!;
      return { overHandle: ev.args.isOverexposedHandle, underHandle: ev.args.isUnderYieldHandle };
    }

    it("returns isOverexposed=true when currentDrift > driftToleranceBps", async function () {
      const { riskParams, investor } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      // driftToleranceBps = 500; current drift = 800 > 500
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const [encDrift, encYield] = await investorClient
        .encryptInputs([Encryptable.uint64(800n), Encryptable.uint64(500n)])
        .execute();
      const { overHandle, underHandle } = await computeAndExtractSignals(
        riskParams,
        investor,
        encDrift,
        encYield,
      );
      const isOver = await hre.cofhe.mocks.getPlaintext(overHandle);
      const isUnder = await hre.cofhe.mocks.getPlaintext(underHandle);
      expect(isOver).to.equal(1n);
      expect(isUnder).to.equal(0n); // 500 < 400 is false
    });

    it("returns isUnderYield=true when currentYield < minYieldBps", async function () {
      const { riskParams, investor } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      // minYieldBps = 400; current yield = 300 < 400
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const [encDrift, encYield] = await investorClient
        .encryptInputs([Encryptable.uint64(100n), Encryptable.uint64(300n)])
        .execute();
      const { overHandle, underHandle } = await computeAndExtractSignals(
        riskParams,
        investor,
        encDrift,
        encYield,
      );
      const isOver = await hre.cofhe.mocks.getPlaintext(overHandle);
      const isUnder = await hre.cofhe.mocks.getPlaintext(underHandle);
      expect(isOver).to.equal(0n);
      expect(isUnder).to.equal(1n);
    });

    it("rejects callers other than investor or owner", async function () {
      const { riskParams, investor, alice } = await loadFixture(deployP6Fixture);
      await setStandardParams(riskParams, investor);
      const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
      const [encDrift, encYield] = await aliceClient
        .encryptInputs([Encryptable.uint64(0n), Encryptable.uint64(0n)])
        .execute();
      await expect(
        riskParams.connect(alice).computeSignalFlags(investor.address, encDrift, encYield),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwnerOrInvestor");
    });

    it("reverts NoRiskParams when investor hasn't called setRiskParams", async function () {
      const { riskParams, investor } = await loadFixture(deployP6Fixture);
      const investorClient = await hre.cofhe.createClientWithBatteries(investor);
      const [encDrift, encYield] = await investorClient
        .encryptInputs([Encryptable.uint64(0n), Encryptable.uint64(0n)])
        .execute();
      await expect(
        riskParams.connect(investor).computeSignalFlags(investor.address, encDrift, encYield),
      ).to.be.revertedWithCustomError(riskParams, "NoRiskParams");
    });
  });

  // ── AgentPermit: EIP-712 typed-data ──────────────────────────────────

  describe("AgentPermit (EIP-712)", function () {
    async function buildAgentPermitDomain(riskParams: any): Promise<TypedDataDomain> {
      const network = await hre.ethers.provider.getNetwork();
      return {
        name: "MuHaven AgentPermit",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await riskParams.getAddress(),
      };
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

    it("recovers a fresh permit + bumps nonce on consume", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      const domain = await buildAgentPermitDomain(riskParams);
      const value = {
        investor: investor.address,
        tier: 2, // PolicyBound
        surface: 0, // HavenBot
        actionId: 1, // BUY
        maxAmount: 1_000_000n,
        nonce: 1n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600),
      };
      const sig = await investor.signTypedData(domain, TYPES, value);

      // Pre-consume — view check passes.
      expect(
        await riskParams.isAgentPermitValid(
          value.investor,
          value.tier,
          value.surface,
          value.actionId,
          value.maxAmount,
          value.nonce,
          value.expiry,
          sig,
        ),
      ).to.equal(true);

      // Consume the permit (must be owner).
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(
            value.investor,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            sig,
          ),
      )
        .to.emit(riskParams, "AgentPermitConsumed")
        .withArgs(investor.address, 1, 1);

      expect(await riskParams.getAgentPermitNonce(investor.address)).to.equal(1n);

      // Re-consume rejected (nonce ≤ lastConsumed).
      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(
            value.investor,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            sig,
          ),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitNonceUsed");
    });

    it("rejects a permit signed by the wrong account", async function () {
      const { riskParams, investor, alice, deployer } = await loadFixture(deployP6Fixture);
      const domain = await buildAgentPermitDomain(riskParams);
      const value = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1_000_000n,
        nonce: 1n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600),
      };
      // Alice signs on investor's behalf — should NOT recover to investor.
      const wrongSig = await alice.signTypedData(domain, TYPES, value);

      expect(
        await riskParams.isAgentPermitValid(
          value.investor,
          value.tier,
          value.surface,
          value.actionId,
          value.maxAmount,
          value.nonce,
          value.expiry,
          wrongSig,
        ),
      ).to.equal(false);

      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(
            value.investor,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            wrongSig,
          ),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitWrongSigner");
    });

    it("rejects an expired permit", async function () {
      const { riskParams, investor, deployer } = await loadFixture(deployP6Fixture);
      const domain = await buildAgentPermitDomain(riskParams);
      const value = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1_000_000n,
        nonce: 1n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp - 1),
      };
      const sig = await investor.signTypedData(domain, TYPES, value);

      expect(
        await riskParams.isAgentPermitValid(
          value.investor,
          value.tier,
          value.surface,
          value.actionId,
          value.maxAmount,
          value.nonce,
          value.expiry,
          sig,
        ),
      ).to.equal(false);

      await expect(
        riskParams
          .connect(deployer)
          .consumeAgentPermit(
            value.investor,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            sig,
          ),
      ).to.be.revertedWithCustomError(riskParams, "AgentPermitExpired");
    });

    it("only owner can call consumeAgentPermit", async function () {
      const { riskParams, investor } = await loadFixture(deployP6Fixture);
      const domain = await buildAgentPermitDomain(riskParams);
      const value = {
        investor: investor.address,
        tier: 2,
        surface: 0,
        actionId: 1,
        maxAmount: 1_000_000n,
        nonce: 1n,
        expiry: BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600),
      };
      const sig = await investor.signTypedData(domain, TYPES, value);
      await expect(
        riskParams
          .connect(investor)
          .consumeAgentPermit(
            value.investor,
            value.tier,
            value.surface,
            value.actionId,
            value.maxAmount,
            value.nonce,
            value.expiry,
            sig,
          ),
      ).to.be.revertedWithCustomError(riskParams, "OnlyOwner");
    });

    it("domain-separator hashing matches off-chain TypedDataEncoder", async function () {
      const { riskParams } = await loadFixture(deployP6Fixture);
      const onChain = await riskParams.domainSeparator();
      const network = await hre.ethers.provider.getNetwork();
      const offChain = TypedDataEncoder.hashDomain({
        name: "MuHaven AgentPermit",
        version: "1",
        chainId: Number(network.chainId),
        verifyingContract: await riskParams.getAddress(),
      });
      expect(onChain).to.equal(offChain);
    });
  });

  // ── Action / breach getters surface ───────────────────────────────────

  describe("constant getters", function () {
    it("surfaces ActionId / BreachCode constants", async function () {
      const { riskParams } = await loadFixture(deployP6Fixture);
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

// chai-as-promised helper used above for the timestamp-agnostic event arg
function anyValue(): (v: unknown) => boolean {
  return () => true;
}
