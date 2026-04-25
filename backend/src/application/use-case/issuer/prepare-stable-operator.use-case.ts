import { encodeFunctionData } from 'viem';
import type { StableOperatorActionDto } from '../../dto/issuer/stable-operator.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getEnv } from '../../../core/config.js';

const STABLE_ABI = [
  {
    name: 'setOperator',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'until', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface PreparedCallDto {
  contract_address: string;
  abi_signature: string;
  calldata: string;
}

/**
 * Phase 7.5 — prepare calldata for `MuHavenStable.setOperator`.
 *
 * Wave 3.5 contracts that pull mhUSDC from a holder (Subscription,
 * RedemptionQueue settlement leg, YieldSnapshot fundEpoch) need an
 * operator grant on the holder. The frontend's SDK can call this
 * directly, but exposing the calldata via this endpoint keeps backend-
 * orchestrated flows (e.g. issuer-side pre-flight scripts that batch
 * operator grants across tokens) consistent with how
 * `prepare-snapshot.use-case` stages other Wave 3.5 admin calls.
 *
 * No on-chain pre-validation — `MuHavenStable` accepts any non-zero
 * operator; the holder's intent is captured by the signature on the
 * eventual UserOp.
 */
export class PrepareStableOperatorUseCase {
  async execute(
    dto: StableOperatorActionDto,
  ): Promise<{ calls: PreparedCallDto[] }> {
    const env = getEnv();
    const stableAddress = env.STABLE_ADDRESS;
    if (!stableAddress) {
      throw ApplicationHttpError.serviceUnavailable(
        'STABLE_ADDRESS not configured — Phase 7.5 wrapper not yet deployed',
      );
    }
    // `until` is a uint48 — viem encodes it as `number`, not `bigint`. The
    // DTO already validated that the value fits in 2^48, so `Number()` is
    // safe here.
    const calldata = encodeFunctionData({
      abi: STABLE_ABI,
      functionName: 'setOperator',
      args: [dto.spender as `0x${string}`, Number(dto.until)],
    });
    return {
      calls: [
        {
          contract_address: stableAddress,
          abi_signature: 'setOperator(address,uint48)',
          calldata,
        },
      ],
    };
  }
}
