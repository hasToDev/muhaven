import { encodeFunctionData } from 'viem';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { QueueProcessDto } from '../../dto/issuer/queue-process.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';

const QUEUE_ABI = [
  {
    name: 'processEpoch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epochId', type: 'uint256' },
      { name: 'startIdx', type: 'uint256' },
      { name: 'endIdx', type: 'uint256' },
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
 * Prepares calldata for `RedemptionQueue.processEpoch(epochId, startIdx, endIdx)`.
 * The queue address is per-token — the caller passes both the token (for
 * issuer-ownership validation) and the queue address (for routing).
 *
 * Range validation is `start_idx <= end_idx`. The on-chain end is exclusive
 * but the backend doesn't pin to the actual epoch length — callers should
 * read `getEpochRequests(epochId).length` upstream.
 */
export class PrepareQueueProcessUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(dto: QueueProcessDto, issuerAddress: string): Promise<{ calls: PreparedCallDto[] }> {
    const startIdx = BigInt(dto.start_idx);
    const endIdx = BigInt(dto.end_idx);
    if (startIdx > endIdx) {
      throw ApplicationHttpError.badRequest(`start_idx (${startIdx}) > end_idx (${endIdx})`);
    }

    const token = await this.tokenRepo.findByAddress(dto.token_address);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not found at address ${dto.token_address}`);
    }
    if (token.issuerAddress.toLowerCase() !== issuerAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden('You are not the issuer of this token');
    }

    const calldata = encodeFunctionData({
      abi: QUEUE_ABI,
      functionName: 'processEpoch',
      args: [BigInt(dto.epoch_id), startIdx, endIdx],
    });

    return {
      calls: [
        {
          contract_address: dto.queue_address,
          abi_signature: 'processEpoch(uint256,uint256,uint256)',
          calldata,
        },
      ],
    };
  }
}
