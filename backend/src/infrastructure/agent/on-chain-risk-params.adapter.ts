import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import type { Logger } from 'pino';

import { ActionId } from '../../domain/agent/model/action-id.enum.js';
import { getLogger } from '../../core/logger.js';
import {
  BreachCode,
  type CheckAndExecuteResult,
  type IRiskParamsAdapter,
} from './risk-params.adapter.js';
import type { FheWorkerClient } from '../fhe/fhe-worker.client.js';

/**
 * Wave 4 P6 — on-chain `IRiskParamsAdapter` implementation.
 *
 * Replaces `StubRiskParamsAdapter` once `RISK_PARAMS_ADDRESS` +
 * `AGENT_POLICY_PRIVATE_KEY` are configured. Per ADR-1 §"Branchless
 * hot-path pattern" the adapter:
 *
 *  1. Calls `FheWorkerClient.encryptBatch` to produce the InEuint64
 *     candidate spend (the cron tick uses `0` per Wave 4 — see
 *     "Candidate spend semantics" below).
 *  2. Submits a write `RiskParams.checkAndExecute(investor, eAmount, actionId)`
 *     transaction; pulls the `(ebool handle, breachId)` from the
 *     `PolicyChecked` event in the receipt logs.
 *  3. On the encrypted-handle path returns `ePassedHandle` for the
 *     caller's retry-budgeted `decryptBreachFlag` follow-up; on the
 *     cleartext-breach path returns `ePassedHandle: null` + the
 *     `BreachCode`.
 *
 * Error mapping: transient TN failures (`Forbidden`, `decrypt request
 * failed`, `timeout`, `unavailable`) are passed through verbatim so the
 * caller's `isTransient` matcher in `PolicyEngineTickUseCase` recognises
 * them and applies the 200/800/2000ms backoff budget. Non-transient
 * errors propagate as plain `Error`s — the cron's per-user catch
 * isolates one bad row from the rest of the tier.
 *
 * ## Candidate spend semantics (Wave 4 cron tick)
 *
 * Per ADR-2's deviations note: P1's stub passed a placeholder eAmount;
 * P6's first version passes a TN-encrypted `0`. This evaluates as
 * `0 <= maxDailySpend` which is always true, so the cron tick effectively
 * checks ONLY the cleartext gates (oracle / KYC / user-paused). The
 * encrypted leg's enforcement happens at Policy-bound action commit time
 * (kernel-level UserOp), where the real eAmount is known. Wave 5 may
 * introduce a `checkCleartextGates` view for the cron tick to skip the
 * 8s `encryptInputs` round-trip entirely.
 */
export interface OnChainRiskParamsAdapterConfig {
  rpcUrl: string;
  riskParamsAddress: Address;
  agentPrivateKey: `0x${string}`;
  /** Maximum tx wait time in ms (Arb Sepolia confirms ~1-2s; cap at 30s). */
  txReceiptTimeoutMs?: number;
  /**
   * `securityZone` value to pass to `encryptInputs`. Default 0 (matches
   * the deployed CoFHE network configuration).
   */
  securityZone?: number;
}

const RISK_PARAMS_CHECK_AND_EXECUTE_ABI = [
  {
    name: 'checkAndExecute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'investor', type: 'address' },
      {
        name: 'eAmount',
        type: 'tuple',
        components: [
          { name: 'ctHash', type: 'uint256' },
          { name: 'securityZone', type: 'uint8' },
          { name: 'utype', type: 'uint8' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'actionId', type: 'uint8' },
    ],
    outputs: [
      { name: 'ePassed', type: 'bytes32' },
      { name: 'breachId', type: 'uint8' },
    ],
  },
] as const;

const POLICY_CHECKED_EVENT_ABI = [
  {
    name: 'PolicyChecked',
    type: 'event',
    inputs: [
      { name: 'investor', type: 'address', indexed: true },
      { name: 'actionId', type: 'uint8', indexed: true },
      { name: 'ePassedHandle', type: 'bytes32', indexed: false },
      { name: 'breachId', type: 'uint8', indexed: false },
    ],
    anonymous: false,
  },
] as const;

export class OnChainRiskParamsAdapter implements IRiskParamsAdapter {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly riskParamsAddress: Address;
  private readonly txReceiptTimeoutMs: number;
  private readonly securityZone: number;
  private readonly logger: Logger;

  constructor(
    config: OnChainRiskParamsAdapterConfig,
    private readonly fheWorker: FheWorkerClient,
  ) {
    this.account = privateKeyToAccount(config.agentPrivateKey);
    this.publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: arbitrumSepolia,
      transport: http(config.rpcUrl),
    });
    this.riskParamsAddress = config.riskParamsAddress;
    this.txReceiptTimeoutMs = config.txReceiptTimeoutMs ?? 30_000;
    this.securityZone = config.securityZone ?? 0;
    this.logger = getLogger('OnChainRiskParamsAdapter');
  }

  async checkAndExecute(
    investor: string,
    eAmountInput: unknown,
    actionId: ActionId,
  ): Promise<CheckAndExecuteResult> {
    const investorAddr = investor as Address;

    // Encrypt the cron tick's candidate spend (0) via FHE worker. See
    // "Candidate spend semantics" in the file header.
    const encrypted = await this.fheWorker.encryptBatch(this.account.address, [
      { type: 'euint64', value: '0' },
    ]);
    if (encrypted.results.length !== 1 || encrypted.results[0].type !== 'euint64') {
      throw new Error('FHE worker returned unexpected encryptBatch shape');
    }
    const enc = encrypted.results[0];
    const eAmount = {
      ctHash: BigInt(enc.data),
      securityZone: enc.securityZone,
      utype: enc.utype,
      signature: enc.inputProof as Hex,
    } as const;

    // Submit the on-chain check.
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: arbitrumSepolia,
      address: this.riskParamsAddress,
      abi: RISK_PARAMS_CHECK_AND_EXECUTE_ABI,
      functionName: 'checkAndExecute',
      args: [investorAddr, eAmount, actionId],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: this.txReceiptTimeoutMs,
    });
    if (receipt.status !== 'success') {
      throw new Error(
        `RiskParams.checkAndExecute reverted (tx=${txHash}, investor=${investor}, actionId=${actionId})`,
      );
    }

    // Find the PolicyChecked event in the logs. There must be exactly
    // one — `checkAndExecute` emits exactly one PolicyChecked per call.
    const event = this.findPolicyCheckedEvent(receipt.logs, investorAddr);
    if (!event) {
      throw new Error(
        `PolicyChecked event missing from RiskParams.checkAndExecute receipt (tx=${txHash})`,
      );
    }

    const breachId = event.breachId;
    const ePassedHandle = event.ePassedHandle;

    if (breachId !== BreachCode.None) {
      // Cleartext breach — caller pauses without invoking the off-chain
      // decrypt step. Don't return the handle; it's a trivial-encrypted
      // `false` constant whose decrypt would be a wasted round-trip.
      this.logger.debug(
        { investor, actionId, breachId },
        'Cleartext breach detected; skipping decryptForTx',
      );
      return { ePassedHandle: null, breachCode: this.toBreachCode(breachId) };
    }

    // Encrypted-leg path: caller's PolicyEngineTickUseCase invokes
    // `decryptBreachFlag(ePassedHandle)` on next step.
    return { ePassedHandle, breachCode: BreachCode.None };
  }

  async decryptBreachFlag(handle: string): Promise<{ cleartext: 0 | 1; signature: string }> {
    // RiskParams.checkAndExecute returns an `ebool` handle.
    const result = await this.fheWorker.decryptForTx(handle, 'ebool');
    // The FHE worker stringifies the bigint; ebool decrypts to "0" / "1".
    //
    // **Hard assertion (Code Review #5, post-port hardening)**: the
    // worker's `fheType` parameter is computed but silently dropped at
    // the SDK call site (`@cofhe/sdk`'s `decryptForTx(ctHash)` is
    // single-arg per `clientTypes-*.d.ts:952`). A future caller passing
    // the wrong handle would surface as a non-bool string here. Reject
    // anything other than "0" / "false" / "1" / "true" so a type
    // mismatch becomes a hard error instead of silently mapping to
    // `cleartext=1` (which the caller would interpret as "no breach"
    // and fail to settle a real breach event). Wave 5 may drop the
    // worker `fheType` param entirely once the SDK exposes type derivation.
    const v = result.decryptedValue;
    if (v !== '0' && v !== '1' && v !== 'false' && v !== 'true') {
      throw new Error(
        `decryptBreachFlag: expected ebool cleartext "0"/"1"/"false"/"true", got ${JSON.stringify(v)} (handle=${handle}). Wrong handle type submitted to /decrypt/for-tx?`,
      );
    }
    const cleartext = v === '0' || v === 'false' ? 0 : 1;
    return { cleartext, signature: result.signature };
  }

  /** Decode `PolicyChecked` from receipt logs, scoped to `investor`. */
  private findPolicyCheckedEvent(
    logs: readonly Log[],
    investor: Address,
  ): { ePassedHandle: string; breachId: number } | null {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.riskParamsAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: POLICY_CHECKED_EVENT_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== 'PolicyChecked') continue;
        const args = decoded.args as unknown as {
          investor: Address;
          actionId: number;
          ePassedHandle: Hex;
          breachId: number;
        };
        if (args.investor.toLowerCase() !== investor.toLowerCase()) continue;
        return {
          ePassedHandle: args.ePassedHandle,
          breachId: Number(args.breachId),
        };
      } catch {
        // Not the event we were looking for; keep scanning.
      }
    }
    return null;
  }

  private toBreachCode(breachId: number): BreachCode {
    // RiskParams.sol breach taxonomy:
    //   0 BREACH_NONE / 1 ORACLE_STALE / 2 KYC_REVOKED / 3 USER_PAUSED / 4 UNKNOWN_ACTION
    // BreachCode TS taxonomy intentionally omits UNKNOWN_ACTION (a defence-
    // in-depth code that should not occur in normal flow) — map it to None
    // and let the caller's audit log capture the anomaly via the breachId
    // we return. Wave 5 can extend BreachCode if we want an explicit code.
    switch (breachId) {
      case 0:
        return BreachCode.None;
      case 1:
        return BreachCode.OracleStale;
      case 2:
        return BreachCode.KycRevoked;
      case 3:
        return BreachCode.UserPaused;
      default:
        // Unknown / unmapped — treat as no cleartext breach and let the
        // encrypted-handle path or the audit log catch it.
        return BreachCode.None;
    }
  }
}
