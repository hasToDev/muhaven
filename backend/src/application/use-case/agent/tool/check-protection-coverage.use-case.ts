import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import type { IRwaTokenRepository } from '../../../../domain/token-registry/repository/rwa-token.repository.js';
import { ApplicationHttpError } from '../../../../core/errors.js';
import type {
  CheckProtectionCoverageDto,
  CheckProtectionCoverageResponseDto,
} from '../../../dto/agent/p11-tool.dto.js';

/**
 * Wave 4 P11 — `muhaven_check_protection_coverage`.
 *
 * Read-only tool. Pulls the public protection-coverage state from the
 * `DefaultProtection` contract and packages it for the LLM. Backend
 * never decrypts encrypted reserve balances — only the public
 * `reserveRateBps` + status enum get exposed.
 *
 * P11.A is not yet deployed to Arb Sepolia at Wave 4 close. When
 * `DEFAULT_PROTECTION_ADDRESS` is unset, the tool returns a structured
 * `not_deployed` payload + a static narrative the LLM can use to
 * explain the absence to the user without throwing.
 */

export const PROTECTION_STATUS_LABELS = ['inactive', 'active', 'triggered', 'distributing', 'completed'] as const;

const DEFAULT_PROTECTION_VIEW_ABI = [
  {
    name: 'tokenProtection',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'getProtection',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'protectionId', type: 'uint256' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'issuer', type: 'address' },
      { name: 'reserveRateBps', type: 'uint256' },
      { name: 'encReserveBalance', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'triggeredAt', type: 'uint256' },
    ],
  },
  {
    name: 'getPayoutDistribution',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'protectionId', type: 'uint256' }],
    outputs: [
      { name: 'encTotalPayout', type: 'uint256' },
      { name: 'encPerInvestorPayout', type: 'uint256' },
      { name: 'investorCount', type: 'uint256' },
      { name: 'processedCount', type: 'uint256' },
      { name: 'escrowsCreated', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
  },
] as const;

export interface CheckProtectionCoverageDeps {
  rpcUrl?: string;
  defaultProtectionAddress?: string;
  rwaTokenRepo: IRwaTokenRepository;
  /** Override hook — tests inject a fake viem PublicClient. */
  publicClientFactory?: (rpcUrl: string) => PublicClient;
}

export class CheckProtectionCoverageToolUseCase {
  constructor(private readonly deps: CheckProtectionCoverageDeps) {}

  async execute(input: CheckProtectionCoverageDto): Promise<CheckProtectionCoverageResponseDto> {
    const tokenAddress = input.tokenAddress.toLowerCase();
    const token = await this.deps.rwaTokenRepo.findByAddress(tokenAddress);
    if (!token) {
      throw ApplicationHttpError.notFound(`Token not registered: ${input.tokenAddress}`);
    }

    if (!this.deps.defaultProtectionAddress) {
      return {
        tool: 'muhaven_check_protection_coverage',
        tokenAddress,
        status: 'not_deployed',
        protectionId: null,
        reserveRateBps: null,
        issuerAddress: null,
        explanation:
          'DefaultProtection (Wave 4 P11.A) is not yet deployed to Arbitrum Sepolia. ' +
          'Coverage will become readable once the issuer onboards a reserve via the protection module.',
      };
    }

    if (!this.deps.rpcUrl) {
      // Hard-fail if address is set but RPC is missing — partial config is
      // worse than no config because the LLM gets no signal at all.
      throw ApplicationHttpError.serviceUnavailable(
        'P11_RPC_NOT_CONFIGURED: DEFAULT_PROTECTION_ADDRESS set without RPC_URL',
      );
    }

    const client =
      this.deps.publicClientFactory?.(this.deps.rpcUrl) ??
      createPublicClient({ chain: arbitrumSepolia, transport: http(this.deps.rpcUrl) });

    const protectionId = (await client.readContract({
      abi: DEFAULT_PROTECTION_VIEW_ABI,
      address: this.deps.defaultProtectionAddress as Address,
      functionName: 'tokenProtection',
      args: [tokenAddress as Address],
    })) as bigint;

    if (protectionId === 0n) {
      return {
        tool: 'muhaven_check_protection_coverage',
        tokenAddress,
        status: 'no_protection',
        protectionId: null,
        reserveRateBps: null,
        issuerAddress: null,
        explanation:
          'No first-loss protection has been opened for this token. The issuer has not deposited a reserve.',
      };
    }

    const [_token, issuer, reserveRateBps, _encReserve, statusCode] =
      (await client.readContract({
        abi: DEFAULT_PROTECTION_VIEW_ABI,
        address: this.deps.defaultProtectionAddress as Address,
        functionName: 'getProtection',
        args: [protectionId],
      })) as readonly [Address, Address, bigint, bigint, number, bigint, bigint];

    // ProtectionStatus enum mirrors the P11.A contract: 0 INACTIVE,
    // 1 ACTIVE, 2 TRIGGERED, 3 DISTRIBUTING, 4 COMPLETED.
    let status: CheckProtectionCoverageResponseDto['status'];
    switch (statusCode) {
      case 0:
        status = 'inactive';
        break;
      case 1:
        status = 'active';
        break;
      case 2:
        status = 'triggered';
        break;
      case 3:
        status = 'distributing';
        break;
      case 4:
        status = 'completed';
        break;
      default:
        // Unknown status — surface as `inactive` rather than blowing up the
        // tool. Downstream LLM gets a coherent answer; operator can fix.
        status = 'inactive';
    }

    const explanation = buildExplanation({
      tokenSymbol: token.symbol,
      reserveRateBps: Number(reserveRateBps),
      status,
    });

    return {
      tool: 'muhaven_check_protection_coverage',
      tokenAddress,
      status,
      protectionId: protectionId.toString(),
      reserveRateBps: Number(reserveRateBps),
      issuerAddress: (issuer as string).toLowerCase(),
      explanation,
    };
  }
}

function buildExplanation(args: {
  tokenSymbol: string;
  reserveRateBps: number;
  status: CheckProtectionCoverageResponseDto['status'];
}): string {
  const pct = (args.reserveRateBps / 100).toFixed(2);
  switch (args.status) {
    case 'inactive':
      return `${args.tokenSymbol} has a protection record at ${pct}% but no reserve has been deposited yet.`;
    case 'active':
      return `${args.tokenSymbol} carries a ${pct}% first-loss reserve. On default, all current investors share the reserve proportionally via MuHavenEscrow.`;
    case 'triggered':
      return `${args.tokenSymbol}'s protection has been triggered. The reserve is being distributed to investors — watch your inbox / Activity log for an escrow id.`;
    case 'distributing':
      return `${args.tokenSymbol}'s protection payout is in flight. Some investors have already received their share; the rest will land as the operator processes the next batches.`;
    case 'completed':
      return `${args.tokenSymbol}'s protection payout has fully settled.`;
    default:
      return `${args.tokenSymbol} protection state could not be characterised.`;
  }
}
