import { encodeFunctionData } from 'viem';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { DistributeYieldDto } from '../../dto/issuer/distribute.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getEnv } from '../../../core/config.js';

const YIELD_DISTRIBUTOR_ABI = [
  {
    name: 'startDistribution',
    type: 'function',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'totalYield', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export interface PreparedCallDto {
  contract_address: string;
  abi_signature: string;
  calldata: string;
}

export class PrepareDistributionUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(dto: DistributeYieldDto, issuerAddress: string): Promise<{ calls: PreparedCallDto[] }> {
    const token = await this.tokenRepo.findByAddress(dto.token_address);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not found at address ${dto.token_address}`);
    }

    if (token.issuerAddress.toLowerCase() !== issuerAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden('You are not the issuer of this token');
    }

    if (token.status !== 'active') {
      throw ApplicationHttpError.badRequest(`Token is ${token.status} — cannot distribute yield`);
    }

    const env = getEnv();
    const distributorAddress = env.YIELD_DISTRIBUTOR_ADDRESS;
    if (!distributorAddress) {
      throw ApplicationHttpError.internalError('YIELD_DISTRIBUTOR_ADDRESS not configured');
    }

    const calldata = encodeFunctionData({
      abi: YIELD_DISTRIBUTOR_ABI,
      functionName: 'startDistribution',
      args: [dto.token_address as `0x${string}`, BigInt(dto.amount)],
    });

    return {
      calls: [
        {
          contract_address: distributorAddress,
          abi_signature: 'startDistribution(address,uint256)',
          calldata,
        },
      ],
    };
  }
}
