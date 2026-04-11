import { encodeFunctionData } from 'viem';
import type { AddWhitelistDto } from '../../dto/issuer/whitelist.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getEnv } from '../../../core/config.js';

const KYC_ADAPTER_ABI = [
  {
    name: 'setWhitelisted',
    type: 'function',
    inputs: [
      { name: 'investor', type: 'address' },
      { name: 'status', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'setAccreditedTier',
    type: 'function',
    inputs: [
      { name: 'investor', type: 'address' },
      { name: 'tier', type: 'uint8' },
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

export class PrepareAddWhitelistUseCase {
  async execute(dto: AddWhitelistDto): Promise<{ calls: PreparedCallDto[] }> {
    const env = getEnv();
    const kycAddress = env.KYC_ADAPTER_ADDRESS;
    if (!kycAddress) {
      throw ApplicationHttpError.internalError('KYC_ADAPTER_ADDRESS not configured');
    }

    const calls: PreparedCallDto[] = [
      {
        contract_address: kycAddress,
        abi_signature: 'setWhitelisted(address,bool)',
        calldata: encodeFunctionData({
          abi: KYC_ADAPTER_ABI,
          functionName: 'setWhitelisted',
          args: [dto.address as `0x${string}`, true],
        }),
      },
    ];

    if (dto.tier > 0) {
      calls.push({
        contract_address: kycAddress,
        abi_signature: 'setAccreditedTier(address,uint8)',
        calldata: encodeFunctionData({
          abi: KYC_ADAPTER_ABI,
          functionName: 'setAccreditedTier',
          args: [dto.address as `0x${string}`, dto.tier],
        }),
      });
    }

    return { calls };
  }
}

export class PrepareRemoveWhitelistUseCase {
  async execute(address: string): Promise<{ calls: PreparedCallDto[] }> {
    const env = getEnv();
    const kycAddress = env.KYC_ADAPTER_ADDRESS;
    if (!kycAddress) {
      throw ApplicationHttpError.internalError('KYC_ADAPTER_ADDRESS not configured');
    }

    return {
      calls: [
        {
          contract_address: kycAddress,
          abi_signature: 'setWhitelisted(address,bool)',
          calldata: encodeFunctionData({
            abi: KYC_ADAPTER_ABI,
            functionName: 'setWhitelisted',
            args: [address as `0x${string}`, false],
          }),
        },
      ],
    };
  }
}
