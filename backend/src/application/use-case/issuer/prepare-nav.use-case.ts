import { encodeFunctionData } from 'viem';
import type { IRwaTokenRepository } from '../../../domain/token-registry/repository/rwa-token.repository.js';
import type { NavActionDto } from '../../dto/issuer/nav.dto.js';
import { ApplicationHttpError } from '../../../core/errors.js';
import { getEnv } from '../../../core/config.js';

const ORACLE_ABI = [
  {
    name: 'setNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'newNAV', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'requestNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'acceptPendingNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    name: 'rejectPendingNAV',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
] as const;

export interface PreparedCallDto {
  contract_address: string;
  abi_signature: string;
  calldata: string;
}

/**
 * Prepares calldata for the four NAV management actions. Mirrors the SDK
 * `OracleClient` write surface so consumers without the SDK (issuer
 * dashboard, automation) can route through one HTTP endpoint.
 *
 * Validation layered here:
 *   1. The token must exist in `rwa_tokens` (issuer ownership lookup).
 *   2. The caller must be the token's issuer (UX hint).
 *   3. `ORACLE_ADDRESS` must be configured for this environment.
 *
 * **Note on on-chain authority** — the issuer-ownership check is a UX
 * filter, NOT the source of truth. On-chain:
 *   - `setNAV` is gated by per-token `navWriter` (often the issuer, but
 *     the issuer may delegate to a worker EOA via `setNavWriter`).
 *   - `acceptPendingNAV` / `rejectPendingNAV` are `onlyOwner` (oracle
 *     deployer multisig) — the issuer prepping calldata for these will
 *     bounce on submit unless they themselves are the oracle owner.
 *   - `requestNAV` (ChainlinkFunctionsOracle) is gated by per-token
 *     `navRequester`, separate from issuer.
 *
 * The endpoint deliberately doesn't enforce these on-chain checks — the
 * calldata is identical to what the SDK would emit, and the on-chain
 * authorisation layer is authoritative. The DB lookup is just a
 * "wrong button on issuer dashboard" guard.
 */
export class PrepareNavUseCase {
  constructor(private readonly tokenRepo: IRwaTokenRepository) {}

  async execute(dto: NavActionDto, issuerAddress: string): Promise<{ calls: PreparedCallDto[] }> {
    const token = await this.tokenRepo.findByAddress(dto.token_address);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not found at address ${dto.token_address}`);
    }
    if (token.issuerAddress.toLowerCase() !== issuerAddress.toLowerCase()) {
      throw ApplicationHttpError.forbidden('You are not the issuer of this token');
    }

    const oracleAddress = getEnv().ORACLE_ADDRESS;
    if (!oracleAddress) {
      throw ApplicationHttpError.internalError('ORACLE_ADDRESS not configured');
    }

    const calldata =
      dto.action === 'set'
        ? encodeFunctionData({
            abi: ORACLE_ABI,
            functionName: 'setNAV',
            args: [dto.token_address as `0x${string}`, BigInt(dto.new_nav)],
          })
        : dto.action === 'request'
          ? encodeFunctionData({
              abi: ORACLE_ABI,
              functionName: 'requestNAV',
              args: [dto.token_address as `0x${string}`],
            })
          : dto.action === 'accept'
            ? encodeFunctionData({
                abi: ORACLE_ABI,
                functionName: 'acceptPendingNAV',
                args: [dto.token_address as `0x${string}`],
              })
            : encodeFunctionData({
                abi: ORACLE_ABI,
                functionName: 'rejectPendingNAV',
                args: [dto.token_address as `0x${string}`],
              });

    const signature =
      dto.action === 'set'
        ? 'setNAV(address,uint256)'
        : dto.action === 'request'
          ? 'requestNAV(address)'
          : dto.action === 'accept'
            ? 'acceptPendingNAV(address)'
            : 'rejectPendingNAV(address)';

    return {
      calls: [
        {
          contract_address: oracleAddress,
          abi_signature: signature,
          calldata,
        },
      ],
    };
  }
}
