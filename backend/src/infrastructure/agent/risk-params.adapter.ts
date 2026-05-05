import type { ActionId } from '../../domain/agent/model/action-id.enum.js';

/**
 * Cleartext breach codes returned by `RiskParams.checkAndExecute` per
 * ADR-1. Encrypted breaches surface only via the breach-decrypt path
 * and are NOT signaled by these codes.
 */
export const BreachCode = {
  None: 0,
  OracleStale: 1,
  KycRevoked: 2,
  UserPaused: 3,
} as const;

export type BreachCode = (typeof BreachCode)[keyof typeof BreachCode];

export interface CheckAndExecuteResult {
  /**
   * Encrypted boolean handle returned by the on-chain check. The cron
   * engine submits this to `decryptForTx` (off-chain TN) only when the
   * cleartext gates didn't already report a breach — this is the
   * "encrypted breach" path.
   */
  ePassedHandle: string | null;
  /** Cleartext breach code; 0 = no cleartext breach detected. */
  breachCode: BreachCode;
}

/**
 * Adapter sitting between the cron engine and `RiskParams.sol`. P6 ships
 * the on-chain implementation; until then, P1 wires a stub that always
 * reports no-breach so the rest of the engine (retry policy, audit
 * logging, pause cascade) can be built and tested.
 */
export interface IRiskParamsAdapter {
  checkAndExecute(
    investor: string,
    eAmountInput: unknown,
    actionId: ActionId,
  ): Promise<CheckAndExecuteResult>;

  /**
   * Off-chain `decryptForTx` against the Threshold Network. Called only
   * when the engine wants to materialize a cleartext breach signal from
   * an encrypted handle — i.e., after `ePassedHandle` came back falsey.
   */
  decryptBreachFlag(handle: string): Promise<{ cleartext: 0 | 1; signature: string }>;
}

/**
 * Always-pass stub. Replaced in P6 by an adapter that calls
 * `RiskParams.checkAndExecute` over RPC and `cofheClient.decryptForTx`
 * for the breach-decrypt step.
 */
export class StubRiskParamsAdapter implements IRiskParamsAdapter {
  async checkAndExecute(): Promise<CheckAndExecuteResult> {
    return { ePassedHandle: null, breachCode: BreachCode.None };
  }

  async decryptBreachFlag(): Promise<{ cleartext: 0 | 1; signature: string }> {
    return { cleartext: 0, signature: '0x' };
  }
}
