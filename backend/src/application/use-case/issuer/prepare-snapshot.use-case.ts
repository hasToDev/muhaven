import { encodeFunctionData } from 'viem';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { SnapshotActionDto } from '../../dto/issuer/snapshot.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

const SNAPSHOT_ABI = [
  {
    name: 'openEpoch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'epochId', type: 'uint256' }],
  },
  {
    name: 'finalizeSnapshot',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'sweepExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'epochId', type: 'uint256' }],
    outputs: [],
  },
] as const;

export interface PreparedCallDto {
  contract_address: string;
  abi_signature: string;
  calldata: string;
}

/**
 * Prepares calldata for the snapshot lifecycle actions that don't carry
 * encrypted inputs: `openEpoch`, `finalizeSnapshot`, `sweepExpired`.
 *
 * `snapshotBatch` is intentionally excluded — large investor arrays don't
 * fit cleanly in a JSON HTTP body, and the SDK's `snapshotAll` helper
 * already handles pagination + progress callbacks. `fundEpoch` is also
 * excluded because the encrypted-yield input has to be encrypted with the
 * caller's cofhe permit (which the backend doesn't hold).
 */
export class PrepareSnapshotUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(
    dto: SnapshotActionDto,
    issuerAddress: string,
  ): Promise<{ calls: PreparedCallDto[] }> {
    const token = await this.tokenRepo.findByAddress(dto.token_address);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not found at address ${dto.token_address}`);
    }
    if (token.issuerAddress.toLowerCase() !== issuerAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden('You are not the issuer of this token');
    }

    if (dto.action === 'open') {
      const calldata = encodeFunctionData({
        abi: SNAPSHOT_ABI,
        functionName: 'openEpoch',
        args: [dto.token_address as `0x${string}`],
      });
      return {
        calls: [
          {
            contract_address: dto.snapshot_address,
            abi_signature: 'openEpoch(address)',
            calldata,
          },
        ],
      };
    }

    if (dto.action === 'finalize') {
      const calldata = encodeFunctionData({
        abi: SNAPSHOT_ABI,
        functionName: 'finalizeSnapshot',
        args: [BigInt(dto.epoch_id)],
      });
      return {
        calls: [
          {
            contract_address: dto.snapshot_address,
            abi_signature: 'finalizeSnapshot(uint256)',
            calldata,
          },
        ],
      };
    }

    // sweep
    const calldata = encodeFunctionData({
      abi: SNAPSHOT_ABI,
      functionName: 'sweepExpired',
      args: [BigInt(dto.epoch_id)],
    });
    return {
      calls: [
        {
          contract_address: dto.snapshot_address,
          abi_signature: 'sweepExpired(uint256)',
          calldata,
        },
      ],
    };
  }
}
